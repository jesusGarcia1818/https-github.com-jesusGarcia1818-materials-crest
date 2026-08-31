create table private.breaker_swap_addresses (
  id uuid primary key default gen_random_uuid(),
  address text not null unique check (length(btrim(address)) between 2 and 300),
  source_status text not null default 'OK' check (length(source_status) between 1 and 40),
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table private.breaker_swap_address_materials (
  id bigint generated always as identity primary key,
  address_id uuid not null references private.breaker_swap_addresses(id) on delete cascade,
  movement_kind text not null check (movement_kind in ('outgoing', 'return')),
  material_code text not null check (length(btrim(material_code)) between 1 and 60),
  description text not null check (length(btrim(description)) between 1 and 300),
  quantity numeric not null check (quantity > 0),
  source_material text,
  created_at timestamptz not null default now(),
  unique (address_id, movement_kind, material_code, description)
);

create table private.breaker_swap_jobs (
  id uuid primary key default gen_random_uuid(),
  address text not null check (length(btrim(address)) between 2 and 300),
  supervisor text not null check (length(btrim(supervisor)) between 2 and 160),
  work_order text not null check (work_order ~ '^[0-9]+$'),
  swap_date date not null,
  first_printed_at timestamptz not null default now(),
  last_printed_at timestamptz not null default now(),
  unique (address, work_order, swap_date)
);

create table private.breaker_swap_movements (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references private.breaker_swap_jobs(id) on delete cascade,
  movement_kind text not null check (movement_kind in ('outgoing', 'return')),
  status text not null check (
    (movement_kind = 'outgoing' and status = 'posted') or
    (movement_kind = 'return' and status in ('pending', 'confirmed'))
  ),
  printed_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by text,
  unique (job_id, movement_kind)
);

create table private.breaker_swap_movement_items (
  id bigint generated always as identity primary key,
  movement_id uuid not null references private.breaker_swap_movements(id) on delete cascade,
  material_code text not null check (length(btrim(material_code)) between 1 and 60),
  description text not null check (length(btrim(description)) between 1 and 300),
  quantity numeric not null check (quantity > 0),
  source_material text,
  created_at timestamptz not null default now(),
  unique (movement_id, material_code, description)
);

create index breaker_swap_address_materials_address_idx on private.breaker_swap_address_materials(address_id, movement_kind);
create index breaker_swap_jobs_date_idx on private.breaker_swap_jobs(swap_date desc, first_printed_at desc);
create index breaker_swap_movements_status_idx on private.breaker_swap_movements(movement_kind, status, printed_at desc);
create index breaker_swap_movement_items_movement_idx on private.breaker_swap_movement_items(movement_id);

alter table private.breaker_swap_addresses enable row level security;
alter table private.breaker_swap_address_materials enable row level security;
alter table private.breaker_swap_jobs enable row level security;
alter table private.breaker_swap_movements enable row level security;
alter table private.breaker_swap_movement_items enable row level security;

revoke all on table private.breaker_swap_addresses from public, anon, authenticated;
revoke all on table private.breaker_swap_address_materials from public, anon, authenticated;
revoke all on table private.breaker_swap_jobs from public, anon, authenticated;
revoke all on table private.breaker_swap_movements from public, anon, authenticated;
revoke all on table private.breaker_swap_movement_items from public, anon, authenticated;

create or replace function private.breaker_swap_app_authorized(p_app_token text)
returns boolean
language sql
stable
security definer
set search_path = 'private', 'extensions', 'pg_temp'
as $function$
  select p_app_token is not null and exists (
    select 1
    from private.material_request_app_secrets s
    where s.active
      and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  );
$function$;

create or replace function private.sync_breaker_swap_addresses_internal(p_records jsonb, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_record jsonb;
  v_item record;
  v_address_id uuid;
  v_inserted integer := 0;
  v_skipped integer := 0;
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  if p_records is null or jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 10000 then
    raise exception 'Invalid address payload';
  end if;

  for v_record in select value from jsonb_array_elements(p_records)
  loop
    if length(btrim(coalesce(v_record->>'address', ''))) not between 2 and 300 then raise exception 'Invalid address'; end if;
    v_address_id := null;
    insert into private.breaker_swap_addresses(address, source_status)
    values (btrim(v_record->>'address'), left(coalesce(nullif(btrim(v_record->>'status'), ''), 'OK'), 40))
    on conflict (address) do nothing
    returning id into v_address_id;

    if v_address_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    for v_item in
      select 'outgoing'::text as movement_kind, value as item from jsonb_array_elements(coalesce(v_record->'outgoing', '[]'::jsonb))
      union all
      select 'return'::text as movement_kind, value as item from jsonb_array_elements(coalesce(v_record->'returns', '[]'::jsonb))
    loop
      if coalesce((v_item.item->>'quantity')::numeric, 0) <= 0 then continue; end if;
      insert into private.breaker_swap_address_materials(address_id, movement_kind, material_code, description, quantity, source_material)
      values (
        v_address_id,
        v_item.movement_kind,
        left(btrim(v_item.item->>'code'), 60),
        left(btrim(v_item.item->>'description'), 300),
        (v_item.item->>'quantity')::numeric,
        nullif(left(btrim(coalesce(v_item.item->>'sourceMaterial', '')), 300), '')
      );
    end loop;
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('insertedAddresses', v_inserted, 'skippedExistingAddresses', v_skipped, 'receivedAddresses', jsonb_array_length(p_records));
end;
$function$;

create or replace function private.get_breaker_swap_addresses_internal(p_app_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'address', a.address,
    'status', a.source_status,
    'outgoing', coalesce((select jsonb_agg(jsonb_build_object('description', m.description, 'code', m.material_code, 'quantity', m.quantity, 'sourceMaterial', m.source_material) order by m.id) from private.breaker_swap_address_materials m where m.address_id = a.id and m.movement_kind = 'outgoing'), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('description', m.description, 'code', m.material_code, 'quantity', m.quantity, 'sourceMaterial', m.source_material) order by m.id) from private.breaker_swap_address_materials m where m.address_id = a.id and m.movement_kind = 'return'), '[]'::jsonb)
  ) order by a.address), '[]'::jsonb)
  into v_result
  from private.breaker_swap_addresses a;
  return v_result;
end;
$function$;

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
    if length(btrim(coalesce(v_job->>'address', ''))) not between 2 and 300 then raise exception 'Invalid address'; end if;
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
        on conflict (movement_id, material_code, description) do nothing;
      end loop;
    end loop;
    v_saved := v_saved + 1;
  end loop;

  return jsonb_build_object('savedJobs', v_saved, 'receivedJobs', jsonb_array_length(p_jobs));
end;
$function$;

create or replace function private.get_breaker_swap_ledger_internal(p_app_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'jobId', j.id,
    'kind', m.movement_kind,
    'status', m.status,
    'date', j.swap_date,
    'address', j.address,
    'supervisor', j.supervisor,
    'workOrder', j.work_order,
    'createdAt', m.printed_at,
    'confirmedAt', m.confirmed_at,
    'confirmedBy', m.confirmed_by,
    'items', coalesce((select jsonb_agg(jsonb_build_object('description', i.description, 'code', i.material_code, 'quantity', i.quantity, 'sourceMaterial', i.source_material) order by i.id) from private.breaker_swap_movement_items i where i.movement_id = m.id), '[]'::jsonb)
  ) order by m.printed_at desc), '[]'::jsonb)
  into v_result
  from private.breaker_swap_movements m
  join private.breaker_swap_jobs j on j.id = m.job_id;
  return v_result;
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
  return v_result;
end;
$function$;

create or replace function public.sync_breaker_swap_addresses(p_records jsonb, p_app_token text)
returns jsonb language sql security definer set search_path = ''
as $function$ select private.sync_breaker_swap_addresses_internal(p_records, p_app_token); $function$;

create or replace function public.get_breaker_swap_addresses(p_app_token text)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.get_breaker_swap_addresses_internal(p_app_token); $function$;

create or replace function public.save_breaker_swap_print(p_jobs jsonb, p_app_token text)
returns jsonb language sql security definer set search_path = ''
as $function$ select private.save_breaker_swap_print_internal(p_jobs, p_app_token); $function$;

create or replace function public.get_breaker_swap_ledger(p_app_token text)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.get_breaker_swap_ledger_internal(p_app_token); $function$;

create or replace function public.confirm_breaker_swap_return(p_movement_id uuid, p_confirmed_by text, p_app_token text)
returns jsonb language sql security definer set search_path = ''
as $function$ select private.confirm_breaker_swap_return_internal(p_movement_id, p_confirmed_by, p_app_token); $function$;

revoke all on function private.breaker_swap_app_authorized(text) from public;
revoke all on function private.sync_breaker_swap_addresses_internal(jsonb, text) from public;
revoke all on function private.get_breaker_swap_addresses_internal(text) from public;
revoke all on function private.save_breaker_swap_print_internal(jsonb, text) from public;
revoke all on function private.get_breaker_swap_ledger_internal(text) from public;
revoke all on function private.confirm_breaker_swap_return_internal(uuid, text, text) from public;

revoke all on function public.sync_breaker_swap_addresses(jsonb, text) from public;
revoke all on function public.get_breaker_swap_addresses(text) from public;
revoke all on function public.save_breaker_swap_print(jsonb, text) from public;
revoke all on function public.get_breaker_swap_ledger(text) from public;
revoke all on function public.confirm_breaker_swap_return(uuid, text, text) from public;

grant execute on function public.sync_breaker_swap_addresses(jsonb, text) to anon, authenticated, service_role;
grant execute on function public.get_breaker_swap_addresses(text) to anon, authenticated, service_role;
grant execute on function public.save_breaker_swap_print(jsonb, text) to anon, authenticated, service_role;
grant execute on function public.get_breaker_swap_ledger(text) to anon, authenticated, service_role;
grant execute on function public.confirm_breaker_swap_return(uuid, text, text) to anon, authenticated, service_role;
