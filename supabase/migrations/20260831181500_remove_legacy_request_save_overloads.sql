drop function if exists public.save_material_request(
  text,text,text,text,date,text,text,integer,jsonb,text,text
);

drop function if exists private.save_material_request_internal(
  text,text,text,text,date,text,text,integer,jsonb,text,text
);

select pg_notify('pgrst', 'reload schema');
