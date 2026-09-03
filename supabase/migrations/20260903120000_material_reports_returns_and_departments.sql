-- Canonical reporting rules:
--   Request quantities are positive.
--   Return quantities are negative.
--   Department is copied to every version and material line.

update private.material_request_items as i
set
  quantity = case when v.request_type = 'return' then -abs(i.quantity) else abs(i.quantity) end,
  department = v.department
from private.material_request_versions as v
where v.id = i.version_id
  and (
    i.quantity is distinct from case when v.request_type = 'return' then -abs(i.quantity) else abs(i.quantity) end
    or i.department is distinct from v.department
  );

create index if not exists material_request_versions_request_version_idx
  on private.material_request_versions(request_id, version_number);

create index if not exists material_request_items_version_idx
  on private.material_request_items(version_id);

create or replace function private.save_material_request_internal(
  p_request_code text,
  p_requester_name text,
  p_address text,
  p_department text,
  p_work_order text,
  p_request_date date,
  p_request_type text,
  p_status text,
  p_version integer,
  p_items jsonb,
  p_event_type text,
  p_app_token text
)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_request_id uuid;
  v_version_id uuid;
  v_event_type text;
begin
  if p_app_token is null or not exists (
    select 1 from private.material_request_app_secrets s
    where s.active and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then raise exception 'Unauthorized application'; end if;

  p_request_code := upper(trim(p_request_code));
  p_requester_name := trim(p_requester_name);
  p_address := trim(p_address);
  p_department := lower(trim(p_department));
  p_work_order := trim(p_work_order);
  v_event_type := coalesce(nullif(trim(p_event_type), ''), 'saved');

  if p_request_code !~ '^([0-9]{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$' then raise exception 'Invalid request code'; end if;
  if p_request_code ~ '^[0-9]{4}$' and not exists (
    select 1 from private.material_request_code_reservations c where c.code = p_request_code
  ) then raise exception 'Request code was not allocated'; end if;
  if length(p_requester_name) < 2 or length(p_requester_name) > 160 then raise exception 'Invalid requester name'; end if;
  if length(p_address) < 2 or length(p_address) > 300 then raise exception 'Invalid address'; end if;
  if p_department not in ('technical_service','subcontractor') then raise exception 'Invalid department'; end if;
  if p_department = 'technical_service' and p_work_order !~ '^[0-9]+$' then raise exception 'Invalid work order'; end if;
  if p_department = 'subcontractor' and p_work_order <> '' and p_work_order !~ '^[0-9]+$' then raise exception 'Invalid work order'; end if;
  if length(p_work_order) > 100 then raise exception 'Invalid work order'; end if;
  if p_request_date is null then raise exception 'Invalid request date'; end if;
  if p_request_type not in ('request','return') then raise exception 'Invalid request type'; end if;
  if p_status not in ('draft','printed','needs_changes','approved','cancelled') then raise exception 'Invalid status'; end if;
  if p_version is null or p_version < 1 then raise exception 'Invalid version'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'Invalid items payload'; end if;
  if v_event_type not in ('saved','printed','modified') then raise exception 'Invalid event type'; end if;

  insert into private.material_requests
    (request_code,requester_name,address,department,work_order,request_date,request_type,status,current_version,last_printed_at)
  values
    (p_request_code,p_requester_name,p_address,p_department,p_work_order,p_request_date,p_request_type,p_status,p_version,
     case when p_status='printed' then now() else null end)
  on conflict (request_code) do update set
    requester_name=excluded.requester_name, address=excluded.address, department=excluded.department,
    work_order=excluded.work_order, request_date=excluded.request_date, request_type=excluded.request_type,
    status=excluded.status,
    current_version=greatest(private.material_requests.current_version,excluded.current_version),
    updated_at=now(),
    last_printed_at=case when excluded.status='printed' then now() else private.material_requests.last_printed_at end
  returning id into v_request_id;

  insert into private.material_request_versions
    (request_id,version_number,requester_name,address,department,work_order,request_date,request_type,status)
  values
    (v_request_id,p_version,p_requester_name,p_address,p_department,p_work_order,p_request_date,p_request_type,p_status)
  on conflict (request_id,version_number) do update set
    requester_name=excluded.requester_name, address=excluded.address, department=excluded.department,
    work_order=excluded.work_order, request_date=excluded.request_date,
    request_type=excluded.request_type, status=excluded.status
  returning id into v_version_id;

  delete from private.material_request_items where version_id=v_version_id;
  insert into private.material_request_items
    (version_id,material_key,source_row,group_index,legacy_code,material_code,item_number,line_number,
     description,category,quantity,requester_name,address,department,work_order,request_date)
  select
    v_version_id,x.material_key,x.source_row,x.group_index,nullif(x.legacy_code,''),nullif(x.material_code,''),
    nullif(x.item_number,''),nullif(x.line_number,''),coalesce(x.description,''),coalesce(x.category,''),
    case when p_request_type = 'return' then -abs(x.quantity) else abs(x.quantity) end,
    p_requester_name,p_address,p_department,p_work_order,p_request_date
  from jsonb_to_recordset(p_items) as x(
    material_key text, source_row integer, group_index smallint, legacy_code text, material_code text,
    item_number text, line_number text, description text, category text, quantity numeric
  )
  where x.quantity is not null and x.quantity <> 0;

  insert into private.material_request_events(request_id,version_id,event_type)
  values(v_request_id,v_version_id,v_event_type);

  return jsonb_build_object(
    'code',p_request_code,'version',p_version,'status',p_status,
    'department',p_department,'savedAt',now()
  );
end;
$function$;

create or replace function private.get_material_request_internal(p_request_code text, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if p_app_token is null or not exists (
    select 1 from private.material_request_app_secrets s
    where s.active and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then raise exception 'Unauthorized application'; end if;

  p_request_code := upper(trim(p_request_code));
  if p_request_code !~ '^([0-9]{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$' then raise exception 'Invalid request code'; end if;

  select jsonb_build_object(
    'code',r.request_code,'name',r.requester_name,'address',r.address,
    'department',r.department,'workOrder',r.work_order,'requestDate',r.request_date,
    'type',r.request_type,'status',r.status,'version',r.current_version,'updatedAt',r.updated_at,
    'quantities',coalesce((
      select jsonb_object_agg(i.material_key, trim(to_char(abs(i.quantity), 'FM999999999990.##')))
      from private.material_request_versions v
      join private.material_request_items i on i.version_id=v.id
      where v.request_id=r.id and v.version_number=r.current_version
    ),'{}'::jsonb)
  ) into v_result
  from private.material_requests r
  where r.request_code=p_request_code;

  if v_result is null then raise exception using errcode='P0002', message='Request not found'; end if;
  return v_result;
end;
$function$;

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
    (request_code, requester_name, address, department, work_order, request_date, request_type, status, current_version, last_printed_at)
  values
    (v_request_code, v_supervisor, v_address, 'technical_service', v_work_order, v_swap_date, v_request_type, 'printed', 1, now())
  returning id into v_request_id;

  insert into private.material_request_versions
    (request_id, version_number, requester_name, address, department, work_order, request_date, request_type, status)
  values
    (v_request_id, 1, v_supervisor, v_address, 'technical_service', v_work_order, v_swap_date, v_request_type, 'printed')
  returning id into v_version_id;

  insert into private.material_request_items
    (version_id, material_key, source_row, group_index, legacy_code, material_code, item_number,
     line_number, description, category, quantity, requester_name, address, department, work_order, request_date)
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
    case when v_request_type = 'return' then -abs(numbered.quantity) else abs(numbered.quantity) end,
    v_supervisor,
    v_address,
    'technical_service',
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

create or replace function private.list_material_request_lines_for_reporting_internal(p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if p_app_token is null or not exists (
    select 1 from private.material_request_app_secrets s
    where s.active and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then raise exception 'Unauthorized application'; end if;

  select coalesce(jsonb_agg(to_jsonb(lines) order by lines.request_date desc, lines.request_code, lines.line_number), '[]'::jsonb)
  into v_result
  from (
    select
      r.id as request_id,
      v.id as version_id,
      i.id as item_id,
      r.request_code,
      v.version_number as version,
      v.request_type as transaction_type_code,
      case when v.request_type = 'return' then 'Return' else 'Request' end as transaction_type,
      v.department as department_code,
      case when v.department = 'subcontractor' then 'Subcontratista' else 'Servicio Técnico' end as department,
      v.requester_name,
      v.address,
      v.work_order,
      v.request_date,
      v.status,
      i.material_key,
      i.source_row,
      i.group_index,
      i.legacy_code,
      i.material_code,
      i.item_number,
      i.line_number,
      i.description,
      i.category,
      case when v.request_type = 'return' then -abs(i.quantity) else abs(i.quantity) end as quantity,
      case when b.movement_id is null then 'material_request' else 'breaker_swap' end as traceability_source,
      b.movement_id as source_movement_id,
      r.created_at,
      r.updated_at
    from private.material_requests r
    join private.material_request_versions v
      on v.request_id = r.id and v.version_number = r.current_version
    join private.material_request_items i on i.version_id = v.id
    left join private.breaker_swap_request_links b on b.request_id = r.id
  ) as lines;

  return v_result;
end;
$function$;

create or replace function public.list_material_request_lines_for_reporting(p_app_token text)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.list_material_request_lines_for_reporting_internal(p_app_token);
$function$;

revoke all on function private.create_breaker_swap_material_request_internal(uuid) from public, anon, authenticated;
revoke all on function public.list_material_request_lines_for_reporting(text) from public;
grant execute on function public.list_material_request_lines_for_reporting(text) to anon, authenticated, service_role;

select pg_notify('pgrst', 'reload schema');

