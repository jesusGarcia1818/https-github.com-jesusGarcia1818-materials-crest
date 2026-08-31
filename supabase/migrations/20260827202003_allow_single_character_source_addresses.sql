alter table private.breaker_swap_addresses drop constraint breaker_swap_addresses_address_check;
alter table private.breaker_swap_addresses add constraint breaker_swap_addresses_address_check check (length(btrim(address)) between 1 and 300);

alter table private.breaker_swap_jobs drop constraint breaker_swap_jobs_address_check;
alter table private.breaker_swap_jobs add constraint breaker_swap_jobs_address_check check (length(btrim(address)) between 1 and 300);

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef('private.sync_breaker_swap_addresses_internal(jsonb,text)'::regprocedure) into v_definition;
  execute replace(v_definition, 'not between 2 and 300', 'not between 1 and 300');

  select pg_get_functiondef('private.save_breaker_swap_print_internal(jsonb,text)'::regprocedure) into v_definition;
  execute replace(v_definition, 'not between 2 and 300', 'not between 1 and 300');
end;
$migration$;
