create table if not exists private.material_request_code_reservations (
  code text primary key check (code ~ '^[0-9]{4}$'),
  created_at timestamptz not null default now()
);

alter table private.material_request_code_reservations enable row level security;
revoke all on table private.material_request_code_reservations from public, anon, authenticated;

insert into private.material_request_code_reservations(code)
select request_code
from private.material_requests
where request_code ~ '^[0-9]{4}$'
on conflict (code) do nothing;

alter table private.material_request_items
  add column if not exists item_number text;

create or replace function private.allocate_material_request_code_internal(p_app_token text)
returns text
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_code text;
  v_attempt integer;
begin
  if p_app_token is null or not exists (
    select 1
    from private.material_request_app_secrets s
    where s.active
      and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then
    raise exception 'Unauthorized application';
  end if;

  for v_attempt in 1..50 loop
    v_code := null;
    insert into private.material_request_code_reservations(code)
    select lpad(candidate.n::text, 4, '0')
    from generate_series(0, 9999) as candidate(n)
    left join private.material_request_code_reservations reserved
      on reserved.code = lpad(candidate.n::text, 4, '0')
    where reserved.code is null
    order by random()
    limit 1
    on conflict (code) do nothing
    returning private.material_request_code_reservations.code into v_code;

    if v_code is not null then
      return v_code;
    end if;
  end loop;

  raise exception 'No request codes available';
end;
$function$;

create or replace function public.allocate_material_request_code(p_app_token text)
returns text
language sql
security definer
set search_path = ''
as $function$
  select private.allocate_material_request_code_internal(p_app_token);
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
  ) then
    raise exception 'Unauthorized application';
  end if;

  p_request_code := upper(trim(p_request_code));
  if p_request_code !~ '^([0-9]{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$' then
    raise exception 'Invalid request code';
  end if;

  select jsonb_build_object(
    'code', r.request_code,
    'name', r.requester_name,
    'address', r.address,
    'workOrder', r.work_order,
    'requestDate', r.request_date,
    'type', r.request_type,
    'status', r.status,
    'version', r.current_version,
    'updatedAt', r.updated_at,
    'quantities', coalesce((
      select jsonb_object_agg(i.material_key, trim(to_char(i.quantity, 'FM999999999990.##')))
      from private.material_request_versions v
      join private.material_request_items i on i.version_id = v.id
      where v.request_id = r.id and v.version_number = r.current_version
    ), '{}'::jsonb)
  )
  into v_result
  from private.material_requests r
  where r.request_code = p_request_code;

  if v_result is null then
    raise exception using errcode = 'P0002', message = 'Request not found';
  end if;

  return v_result;
end;
$function$;

create or replace function private.save_material_request_internal(
  p_request_code text,
  p_requester_name text,
  p_address text,
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
  ) then
    raise exception 'Unauthorized application';
  end if;

  p_request_code := upper(trim(p_request_code));
  p_requester_name := trim(p_requester_name);
  p_address := trim(p_address);
  p_work_order := trim(p_work_order);
  v_event_type := coalesce(nullif(trim(p_event_type), ''), 'saved');

  if p_request_code !~ '^([0-9]{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$' then
    raise exception 'Invalid request code';
  end if;
  if p_request_code ~ '^[0-9]{4}$' and not exists (
    select 1 from private.material_request_code_reservations c where c.code = p_request_code
  ) then
    raise exception 'Request code was not allocated';
  end if;
  if length(p_requester_name) < 2 or length(p_requester_name) > 160 then raise exception 'Invalid requester name'; end if;
  if length(p_address) < 2 or length(p_address) > 300 then raise exception 'Invalid address'; end if;
  if length(p_work_order) < 1 or length(p_work_order) > 100 then raise exception 'Invalid work order'; end if;
  if p_request_date is null then raise exception 'Invalid request date'; end if;
  if p_request_type not in ('request','return') then raise exception 'Invalid request type'; end if;
  if p_status not in ('draft','printed','needs_changes','approved','cancelled') then raise exception 'Invalid status'; end if;
  if p_version is null or p_version < 1 then raise exception 'Invalid version'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'Invalid items payload'; end if;
  if v_event_type not in ('saved','printed','modified') then raise exception 'Invalid event type'; end if;

  insert into private.material_requests
    (request_code,requester_name,address,work_order,request_date,request_type,status,current_version,last_printed_at)
  values
    (p_request_code,p_requester_name,p_address,p_work_order,p_request_date,p_request_type,p_status,p_version,
     case when p_status='printed' then now() else null end)
  on conflict (request_code) do update set
    requester_name=excluded.requester_name,
    address=excluded.address,
    work_order=excluded.work_order,
    request_date=excluded.request_date,
    request_type=excluded.request_type,
    status=excluded.status,
    current_version=greatest(private.material_requests.current_version,excluded.current_version),
    updated_at=now(),
    last_printed_at=case when excluded.status='printed' then now() else private.material_requests.last_printed_at end
  returning id into v_request_id;

  insert into private.material_request_versions
    (request_id,version_number,requester_name,address,work_order,request_date,request_type,status)
  values
    (v_request_id,p_version,p_requester_name,p_address,p_work_order,p_request_date,p_request_type,p_status)
  on conflict (request_id,version_number) do update set
    requester_name=excluded.requester_name,
    address=excluded.address,
    work_order=excluded.work_order,
    request_date=excluded.request_date,
    request_type=excluded.request_type,
    status=excluded.status
  returning id into v_version_id;

  delete from private.material_request_items where version_id=v_version_id;
  insert into private.material_request_items
    (version_id,material_key,source_row,group_index,legacy_code,material_code,item_number,line_number,description,category,quantity,requester_name,address,work_order,request_date)
  select
    v_version_id,
    x.material_key,
    x.source_row,
    x.group_index,
    nullif(x.legacy_code,''),
    nullif(x.material_code,''),
    nullif(x.item_number,''),
    nullif(x.line_number,''),
    coalesce(x.description,''),
    coalesce(x.category,''),
    x.quantity,
    p_requester_name,
    p_address,
    p_work_order,
    p_request_date
  from jsonb_to_recordset(p_items) as x(
    material_key text,
    source_row integer,
    group_index smallint,
    legacy_code text,
    material_code text,
    item_number text,
    line_number text,
    description text,
    category text,
    quantity numeric
  )
  where x.quantity > 0;

  insert into private.material_request_events(request_id,version_id,event_type)
  values(v_request_id,v_version_id,v_event_type);

  return jsonb_build_object('code',p_request_code,'version',p_version,'status',p_status,'savedAt',now());
end;
$function$;

create or replace function private.delete_material_request_internal(p_request_code text, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_request_id uuid;
begin
  if p_app_token is null or not exists (
    select 1 from private.material_request_app_secrets s
    where s.active and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then
    raise exception 'Unauthorized application';
  end if;

  p_request_code := upper(trim(p_request_code));
  if p_request_code !~ '^([0-9]{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$' then
    raise exception 'Invalid request code';
  end if;

  select id into v_request_id
  from private.material_requests
  where request_code = p_request_code
  for update;

  if v_request_id is null then
    raise exception using errcode = 'P0002', message = 'Request not found';
  end if;

  delete from private.material_request_events where request_id = v_request_id;
  delete from private.material_request_items
  where version_id in (
    select id from private.material_request_versions where request_id = v_request_id
  );
  delete from private.material_request_versions where request_id = v_request_id;
  delete from private.material_requests where id = v_request_id;

  return jsonb_build_object('code', p_request_code, 'deleted', true);
end;
$function$;

create or replace function public.delete_material_request(p_request_code text, p_app_token text)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.delete_material_request_internal(p_request_code, p_app_token);
$function$;

revoke all on function public.allocate_material_request_code(text) from public;
revoke all on function public.delete_material_request(text,text) from public;
grant execute on function public.allocate_material_request_code(text) to anon, authenticated, service_role;
grant execute on function public.delete_material_request(text,text) to anon, authenticated, service_role;

