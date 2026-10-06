-- Stolen Breaker is a material pickup. It is kept separate from Breaker Swap
-- and contributes positive quantities to the shared daily report.
create table if not exists private.stolen_breaker_pickups (
  id uuid primary key default gen_random_uuid(),
  address text not null check (length(btrim(address)) between 2 and 300),
  supervisor text not null check (length(btrim(supervisor)) between 2 and 160),
  service_technician text not null check (length(btrim(service_technician)) between 2 and 160),
  work_order text not null check (work_order ~ '^[0-9]+$'),
  pickup_date date not null,
  first_printed_at timestamptz not null default now(),
  last_printed_at timestamptz not null default now(),
  unique (address, work_order, pickup_date)
);

create table if not exists private.stolen_breaker_pickup_request_links (
  pickup_id uuid primary key references private.stolen_breaker_pickups(id) on delete cascade,
  request_id uuid not null unique references private.material_requests(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.stolen_breaker_pickups enable row level security;
alter table private.stolen_breaker_pickup_request_links enable row level security;
revoke all on table private.stolen_breaker_pickups from public, anon, authenticated;
revoke all on table private.stolen_breaker_pickup_request_links from public, anon, authenticated;

create or replace function private.save_stolen_breaker_pickup_internal(p_pickup jsonb, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_pickup_id uuid;
  v_request_id uuid;
  v_version_id uuid;
  v_request_code text;
  v_attempt integer;
  v_address text := btrim(coalesce(p_pickup->>'address', ''));
  v_supervisor text := btrim(coalesce(p_pickup->>'supervisor', ''));
  v_technician text := btrim(coalesce(p_pickup->>'serviceTechnician', ''));
  v_work_order text := btrim(coalesce(p_pickup->>'workOrder', ''));
  v_date date;
  v_items jsonb := coalesce(p_pickup->'items', '[]'::jsonb);
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  if length(v_address) not between 2 and 300 then raise exception 'Invalid address'; end if;
  if length(v_supervisor) not between 2 and 160 then raise exception 'Invalid supervisor'; end if;
  if length(v_technician) not between 2 and 160 then raise exception 'Invalid service technician'; end if;
  if v_work_order !~ '^[0-9]+$' then raise exception 'Invalid work order'; end if;
  begin v_date := (p_pickup->>'date')::date; exception when others then raise exception 'Invalid pickup date'; end;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 500 then raise exception 'Invalid materials payload'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) item
    where length(btrim(coalesce(item->>'code', ''))) = 0
       or length(btrim(coalesce(item->>'description', ''))) = 0
       or coalesce((item->>'quantity')::numeric, 0) <= 0
  ) then raise exception 'Invalid material item'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_address || '|' || v_work_order || '|' || v_date::text, 0));
  insert into private.stolen_breaker_pickups(address, supervisor, service_technician, work_order, pickup_date)
  values (v_address, v_supervisor, v_technician, v_work_order, v_date)
  on conflict (address, work_order, pickup_date) do update set
    supervisor = excluded.supervisor,
    service_technician = excluded.service_technician,
    last_printed_at = now()
  returning id into v_pickup_id;

  select request_id into v_request_id
  from private.stolen_breaker_pickup_request_links
  where pickup_id = v_pickup_id;

  if v_request_id is null then
    for v_attempt in 1..100 loop
      v_request_code := null;
      insert into private.material_request_code_reservations(code)
      select lpad(candidate.n::text, 4, '0')
      from generate_series(0, 9999) candidate(n)
      left join private.material_request_code_reservations reserved on reserved.code = lpad(candidate.n::text, 4, '0')
      where reserved.code is null
      order by random() limit 1
      on conflict (code) do nothing
      returning code into v_request_code;
      exit when v_request_code is not null;
    end loop;
    if v_request_code is null then raise exception 'No material request codes are available'; end if;
    insert into private.material_requests
      (request_code, requester_name, address, department, work_order, request_date, request_type, status, current_version, last_printed_at)
    values (v_request_code, v_technician, v_address, 'technical_service', v_work_order, v_date, 'request', 'printed', 1, now())
    returning id into v_request_id;
    insert into private.stolen_breaker_pickup_request_links(pickup_id, request_id) values (v_pickup_id, v_request_id);
  else
    update private.material_requests set requester_name = v_technician, address = v_address, work_order = v_work_order,
      request_date = v_date, request_type = 'request', status = 'printed', last_printed_at = now(), updated_at = now()
    where id = v_request_id;
    select request_code into v_request_code from private.material_requests where id = v_request_id;
  end if;

  insert into private.material_request_versions
    (request_id, version_number, requester_name, address, department, work_order, request_date, request_type, status)
  values (v_request_id, 1, v_technician, v_address, 'technical_service', v_work_order, v_date, 'request', 'printed')
  on conflict (request_id, version_number) do update set
    requester_name = excluded.requester_name, address = excluded.address, department = excluded.department,
    work_order = excluded.work_order, request_date = excluded.request_date, request_type = excluded.request_type, status = excluded.status
  returning id into v_version_id;

  delete from private.material_request_items where version_id = v_version_id;
  insert into private.material_request_items
    (version_id, material_key, source_row, group_index, material_code, line_number, description, category, quantity,
     requester_name, address, department, work_order, request_date)
  select v_version_id,
    'stolen-breaker:' || v_pickup_id::text || ':' || numbered.row_number::text,
    numbered.row_number, 0, left(btrim(numbered.item->>'code'), 60), numbered.row_number::text,
    left(btrim(numbered.item->>'description'), 300), 'STOLEN BREAKER PICKUP', abs((numbered.item->>'quantity')::numeric),
    v_technician, v_address, 'technical_service', v_work_order, v_date
  from (select value as item, row_number() over ()::integer as row_number from jsonb_array_elements(v_items)) numbered;

  insert into private.material_request_events(request_id, version_id, event_type) values (v_request_id, v_version_id, 'printed');
  return jsonb_build_object('pickupId', v_pickup_id, 'requestId', v_request_id, 'requestCode', v_request_code, 'transactionType', 'Stolen Breaker Pickup');
end;
$function$;

create or replace function public.save_stolen_breaker_pickup(p_pickup jsonb, p_app_token text)
returns jsonb language sql security definer set search_path = ''
as $function$ select private.save_stolen_breaker_pickup_internal(p_pickup, p_app_token); $function$;

revoke all on function private.save_stolen_breaker_pickup_internal(jsonb, text) from public, anon, authenticated;
revoke all on function public.save_stolen_breaker_pickup(jsonb, text) from public;
grant execute on function public.save_stolen_breaker_pickup(jsonb, text) to anon, authenticated, service_role;

create or replace function public.list_material_requests_for_reporting(p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
begin
  if p_app_token is null or not exists (select 1 from private.material_request_app_secrets s where s.active and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')) then raise exception 'Unauthorized application'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'code', r.request_code, 'name', v.requester_name, 'address', v.address,
      'departmentCode', v.department, 'department', case when v.department = 'subcontractor' then 'Subcontratista' else 'Servicio Técnico' end,
      'workOrder', v.work_order, 'requestDate', v.request_date, 'type', v.request_type,
      'transactionType', case when sp.pickup_id is not null then 'Stolen Breaker Pickup' when v.request_type = 'return' then 'Return' else 'Request' end,
      'sourceType', case when sp.pickup_id is not null then 'stolen_breaker_pickup' when bs.movement_id is not null then 'breaker_swap' else 'material_request' end,
      'supervisor', spickup.supervisor, 'serviceTechnician', spickup.service_technician,
      'status', v.status, 'version', v.version_number, 'printedAt', r.last_printed_at,
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'requestCode', r.request_code, 'version', v.version_number, 'type', v.request_type,
        'transactionType', case when sp.pickup_id is not null then 'Stolen Breaker Pickup' when v.request_type = 'return' then 'Return' else 'Request' end,
        'sourceType', case when sp.pickup_id is not null then 'stolen_breaker_pickup' when bs.movement_id is not null then 'breaker_swap' else 'material_request' end,
        'departmentCode', v.department, 'department', case when v.department = 'subcontractor' then 'Subcontratista' else 'Servicio Técnico' end,
        'supervisor', spickup.supervisor, 'serviceTechnician', spickup.service_technician,
        'materialCode', coalesce(nullif(i.material_code, ''), nullif(i.legacy_code, ''), i.material_key),
        'itemNumber', i.item_number, 'lineNumber', i.line_number, 'description', i.description, 'category', i.category,
        'quantity', case when v.request_type = 'return' then -abs(i.quantity) else abs(i.quantity) end
      ) order by i.category, i.material_code, i.id) from private.material_request_items i where i.version_id = v.id), '[]'::jsonb)
    ) order by r.request_date desc, r.request_code desc), '[]'::jsonb)
    from private.material_requests r
    join private.material_request_versions v on v.request_id = r.id and v.version_number = r.current_version
    left join private.breaker_swap_request_links bs on bs.request_id = r.id
    left join private.stolen_breaker_pickup_request_links sp on sp.request_id = r.id
    left join private.stolen_breaker_pickups spickup on spickup.id = sp.pickup_id
    where r.last_printed_at is not null and r.status = 'printed'
  );
end;
$function$;

select pg_notify('pgrst', 'reload schema');
