-- Search the catalog on demand instead of sending every address to the browser.
create or replace function private.search_breaker_swap_addresses_internal(p_search text, p_limit integer, p_app_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = private, public, extensions, pg_temp
as $$
declare
  v_search text := btrim(coalesce(p_search, ''));
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 50));
begin
  if not private.breaker_swap_app_authorized(p_app_token) then raise exception 'Unauthorized application'; end if;
  if char_length(v_search) < 2 then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'address', matched.address,
      'status', matched.source_status,
      'outgoing', coalesce(outgoing.items, '[]'::jsonb),
      'returns', coalesce(returns.items, '[]'::jsonb)
    ) order by matched.address)
    from (
      select a.id, a.address, a.source_status
      from private.breaker_swap_addresses a
      where a.address ilike '%' || v_search || '%'
      order by a.address
      limit v_limit
    ) matched
    left join lateral (
      select jsonb_agg(jsonb_build_object('description', m.description, 'code', m.material_code, 'quantity', m.quantity, 'sourceMaterial', m.source_material) order by m.id) as items
      from private.breaker_swap_address_materials m
      where m.address_id = matched.id and m.movement_kind = 'outgoing'
    ) outgoing on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('description', m.description, 'code', m.material_code, 'quantity', m.quantity, 'sourceMaterial', m.source_material) order by m.id) as items
      from private.breaker_swap_address_materials m
      where m.address_id = matched.id and m.movement_kind = 'return'
    ) returns on true
  ), '[]'::jsonb);
end;
$$;

create or replace function public.search_breaker_swap_addresses(p_search text, p_limit integer, p_app_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.search_breaker_swap_addresses_internal(p_search, p_limit, p_app_token);
$$;
