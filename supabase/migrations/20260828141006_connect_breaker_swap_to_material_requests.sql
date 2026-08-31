create table if not exists private.breaker_swap_request_links (
  movement_id uuid primary key references private.breaker_swap_movements(id),
  request_id uuid not null unique references private.material_requests(id),
  request_type text not null check (request_type in ('request', 'return')),
  created_at timestamptz not null default now()
);

alter table private.breaker_swap_request_links enable row level security;
revoke all on table private.breaker_swap_request_links from public, anon, authenticated;

create or replace function private.create_breaker_swap_material_request_internal(p_movement_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_request_id uuid;
  v_version_id uuid;
  v_request_code text;
  v_request_type text;
  v_movement_kind text;
  v_movement_status text;
  v_supervisor text;
  v_address text;
  v_work_order text;
  v_swap_date date;
  v_attempt integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_movement_id::text, 0));

  select l.request_id into v_request_id
  from private.breaker_swap_request_links l
  where l.movement_id = p_movement_id;
  if v_request_id is not null then return v_request_id; end if;

  select m.movement_kind, m.status, j.supervisor, j.address, j.work_order, j.swap_date
  into v_movement_kind, v_movement_status, v_supervisor, v_address, v_work_order, v_swap_date
  from private.breaker_swap_movements m
  join private.breaker_swap_jobs j on j.id = m.job_id
  where m.id = p_movement_id;
  if not found then raise exception using errcode = 'P0002', message = 'Breaker Swap movement not found'; end if;

  if v_movement_kind = 'outgoing' and v_movement_status <> 'posted' then
    raise exception 'Outgoing Breaker Swap movement is not posted';
  elsif v_movement_kind = 'return' and v_movement_status <> 'confirmed' then
    raise exception 'Breaker Swap return is not confirmed';
  end if;
  if not exists (select 1 from private.breaker_swap_movement_items i where i.movement_id = p_movement_id) then
    raise exception 'Breaker Swap movement has no material items';
  end if;

  v_request_type := case when v_movement_kind = 'outgoing' then 'request' else 'return' end;
  for v_attempt in 1..100 loop
    v_request_code := null;
    insert into private.material_request_code_reservations(code)
    select lpad(candidate.n::text, 4, '0')
    from generate_series(0, 9999) as candidate(n)
    left join private.material_request_code_reservations reserved
      on reserved.code = lpad(candidate.n::text, 4, '0')
    where reserved.code is null
    order by random()
    limit 1
    on conflict (code) do nothing
    returning code into v_request_code;
    exit when v_request_code is not null;
  end loop;
  if v_request_code is null then raise exception 'No material request codes are available'; end if;

  insert into private.material_requests
    (request_code, requester_name, address, work_order, request_date, request_type, status, current_version, last_printed_at)
  values
    (v_request_code, v_supervisor, v_address, v_work_order, v_swap_date, v_request_type, 'printed', 1, now())
  returning id into v_request_id;

  insert into private.material_request_versions
    (request_id, version_number, requester_name, address, work_order, request_date, request_type, status)
  values
    (v_request_id, 1, v_supervisor, v_address, v_work_order, v_swap_date, v_request_type, 'printed')
  returning id into v_version_id;

  insert into private.material_request_items
    (version_id, material_key, source_row, group_index, legacy_code, material_code, item_number,
     line_number, description, category, quantity, requester_name, address, work_order, request_date)
  select
    v_version_id,
    'breaker-swap:' || p_movement_id::text || ':' || numbered.id::text,
    numbered.row_number::integer,
    0,
    null,
    numbered.material_code,
    null,
    numbered.row_number::text,
    numbered.description,
    'BREAKER SWAP',
    numbered.quantity,
    v_supervisor,
    v_address,
    v_work_order,
    v_swap_date
  from (
    select i.*, row_number() over (order by i.id) as row_number
    from private.breaker_swap_movement_items i
    where i.movement_id = p_movement_id
  ) numbered;

  insert into private.material_request_events(request_id, version_id, event_type)
  values (v_request_id, v_version_id, 'printed');

  insert into private.breaker_swap_request_links(movement_id, request_id, request_type)
  values (p_movement_id, v_request_id, v_request_type);
  return v_request_id;
end;
$function$;

revoke all on function private.create_breaker_swap_material_request_internal(uuid) from public, anon, authenticated;

create or replace function private.save_breaker_swap_print_internal(p_jobs jsonb, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_job jsonb;
  v_item jsonb;
  v_items jsonb;
  v_kind text;
  v_job_id uuid;
  v_movement_id uuid;
  v_saved integer := 0;
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) = 0 or jsonb_array_length(p_jobs) > 250 then raise exception 'Invalid jobs payload'; end if;

  for v_job in select value from jsonb_array_elements(p_jobs)
  loop
    if length(btrim(coalesce(v_job->>'address', ''))) not between 1 and 300 then raise exception 'Invalid address'; end if;
    if length(btrim(coalesce(v_job->>'supervisor', ''))) not between 2 and 160 then raise exception 'Invalid supervisor'; end if;
    if coalesce(v_job->>'workOrder', '') !~ '^[0-9]+$' then raise exception 'Invalid work order'; end if;

    insert into private.breaker_swap_jobs(address, supervisor, work_order, swap_date)
    values (btrim(v_job->>'address'), btrim(v_job->>'supervisor'), v_job->>'workOrder', (v_job->>'date')::date)
    on conflict (address, work_order, swap_date) do update set supervisor = excluded.supervisor, last_printed_at = now()
    returning id into v_job_id;

    foreach v_kind in array array['outgoing', 'return']
    loop
      v_items := coalesce(v_job->v_kind, '[]'::jsonb);
      if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 500 then raise exception 'Invalid materials payload'; end if;
      if jsonb_array_length(v_items) = 0 then continue; end if;

      insert into private.breaker_swap_movements(job_id, movement_kind, status)
      values (v_job_id, v_kind, case when v_kind = 'outgoing' then 'posted' else 'pending' end)
      on conflict (job_id, movement_kind) do update set printed_at = private.breaker_swap_movements.printed_at
      returning id into v_movement_id;

      for v_item in select value from jsonb_array_elements(v_items)
      loop
        if coalesce((v_item->>'quantity')::numeric, 0) <= 0 then continue; end if;
        insert into private.breaker_swap_movement_items(movement_id, material_code, description, quantity, source_material)
        values (
          v_movement_id,
          left(btrim(v_item->>'code'), 60),
          left(btrim(v_item->>'description'), 300),
          (v_item->>'quantity')::numeric,
          nullif(left(btrim(coalesce(v_item->>'sourceMaterial', '')), 300), '')
        )
        on conflict do nothing;
      end loop;

      if v_kind = 'outgoing' then
        perform private.create_breaker_swap_material_request_internal(v_movement_id);
      end if;
    end loop;
    v_saved := v_saved + 1;
  end loop;

  return jsonb_build_object('savedJobs', v_saved, 'receivedJobs', jsonb_array_length(p_jobs));
end;
$function$;

create or replace function private.confirm_breaker_swap_return_internal(p_movement_id uuid, p_confirmed_by text, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  update private.breaker_swap_movements
  set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(nullif(btrim(p_confirmed_by), ''), confirmed_by, 'Office')
  where id = p_movement_id and movement_kind = 'return' and status in ('pending', 'confirmed')
  returning jsonb_build_object('id', id, 'status', status, 'confirmedAt', confirmed_at, 'confirmedBy', confirmed_by) into v_result;
  if v_result is null then raise exception using errcode = 'P0002', message = 'Pending return not found'; end if;
  perform private.create_breaker_swap_material_request_internal(p_movement_id);
  return v_result;
end;
$function$;

do $backfill$
declare
  v_movement_id uuid;
begin
  for v_movement_id in
    select m.id
    from private.breaker_swap_movements m
    where m.movement_kind = 'outgoing'
       or (m.movement_kind = 'return' and m.status = 'confirmed')
  loop
    perform private.create_breaker_swap_material_request_internal(v_movement_id);
  end loop;
end;
$backfill$;

