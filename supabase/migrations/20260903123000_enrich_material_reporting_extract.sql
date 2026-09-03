create or replace function public.list_material_requests_for_reporting(p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if p_app_token is null or not exists (
    select 1
    from private.material_request_app_secrets s
    where s.active
      and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then
    raise exception 'Unauthorized application';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', r.request_code,
        'name', v.requester_name,
        'address', v.address,
        'departmentCode', v.department,
        'department', case when v.department = 'subcontractor' then 'Subcontratista' else 'Servicio Técnico' end,
        'workOrder', v.work_order,
        'requestDate', v.request_date,
        'type', v.request_type,
        'transactionType', case when v.request_type = 'return' then 'Return' else 'Request' end,
        'status', v.status,
        'version', v.version_number,
        'printedAt', r.last_printed_at,
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'requestCode', r.request_code,
              'version', v.version_number,
              'type', v.request_type,
              'transactionType', case when v.request_type = 'return' then 'Return' else 'Request' end,
              'departmentCode', v.department,
              'department', case when v.department = 'subcontractor' then 'Subcontratista' else 'Servicio Técnico' end,
              'materialCode', coalesce(nullif(i.material_code, ''), nullif(i.legacy_code, ''), i.material_key),
              'itemNumber', i.item_number,
              'lineNumber', i.line_number,
              'description', i.description,
              'category', i.category,
              'quantity', case when v.request_type = 'return' then -abs(i.quantity) else abs(i.quantity) end
            )
            order by i.category, i.material_code, i.id
          )
          from private.material_request_items i
          where i.version_id = v.id
        ), '[]'::jsonb)
      )
      order by r.request_date desc, r.request_code desc
    ),
    '[]'::jsonb
  )
  into v_result
  from private.material_requests r
  join private.material_request_versions v
    on v.request_id = r.id
   and v.version_number = r.current_version
  where r.last_printed_at is not null
    and r.status = 'printed';

  return v_result;
end;
$function$;

revoke all on function public.list_material_requests_for_reporting(text) from public;
grant execute on function public.list_material_requests_for_reporting(text) to anon, authenticated, service_role;

select pg_notify('pgrst', 'reload schema');

