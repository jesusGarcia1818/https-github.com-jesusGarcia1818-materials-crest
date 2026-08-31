do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef('private.sync_breaker_swap_addresses_internal(jsonb,text)'::regprocedure) into v_definition;
  execute replace(v_definition, 'on conflict (address_id, movement_kind, material_code, description) do nothing;', 'on conflict do nothing;');

  select pg_get_functiondef('private.save_breaker_swap_print_internal(jsonb,text)'::regprocedure) into v_definition;
  execute replace(v_definition, 'on conflict (movement_id, material_code, description) do nothing;', 'on conflict do nothing;');
end;
$migration$;
