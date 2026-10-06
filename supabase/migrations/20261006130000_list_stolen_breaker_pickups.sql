-- Daily history for the Stolen Breaker Material Pickup module.
create or replace function private.list_stolen_breaker_pickups_internal(p_pickup_date date, p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = 'private', 'public', 'extensions', 'pg_temp'
as $function$
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  if p_pickup_date is null then raise exception 'Invalid pickup date'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'address', pickup.address,
      'workOrder', pickup.work_order,
      'supervisor', pickup.supervisor,
      'serviceTechnician', pickup.service_technician,
      'date', pickup.pickup_date,
      'requestCode', request.request_code,
      'itemCount', coalesce(lines.item_count, 0),
      'unitCount', coalesce(lines.unit_count, 0)
    ) order by pickup.last_printed_at desc, pickup.address), '[]'::jsonb)
    from private.stolen_breaker_pickups pickup
    left join private.stolen_breaker_pickup_request_links link on link.pickup_id = pickup.id
    left join private.material_requests request on request.id = link.request_id
    left join lateral (
      select count(*)::integer as item_count, coalesce(sum(abs(item.quantity)), 0)::numeric as unit_count
      from private.material_request_versions version
      join private.material_request_items item on item.version_id = version.id
      where version.request_id = link.request_id and version.version_number = 1
    ) lines on true
    where pickup.pickup_date = p_pickup_date
  );
end;
$function$;

create or replace function public.list_stolen_breaker_pickups(p_pickup_date date, p_app_token text)
returns jsonb language sql security definer set search_path = ''
as $function$ select private.list_stolen_breaker_pickups_internal(p_pickup_date, p_app_token); $function$;

revoke all on function private.list_stolen_breaker_pickups_internal(date, text) from public, anon, authenticated;
revoke all on function public.list_stolen_breaker_pickups(date, text) from public;
grant execute on function public.list_stolen_breaker_pickups(date, text) to anon, authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
