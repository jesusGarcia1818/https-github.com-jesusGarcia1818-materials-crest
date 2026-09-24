-- Descriptions edited in the reports panel apply only to future material requests.
-- Historical request items remain immutable.
create table if not exists private.material_description_overrides (
  material_code text primary key,
  description text not null check (char_length(description) between 1 and 300),
  updated_at timestamptz not null default now()
);

create or replace function public.list_material_description_overrides(p_app_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_app_token is null or not exists (
    select 1
    from private.material_request_app_secrets s
    where s.active
      and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then
    raise exception 'Unauthorized application';
  end if;

  return coalesce((
    select jsonb_object_agg(o.material_code, o.description)
    from private.material_description_overrides o
  ), '{}'::jsonb);
end;
$function$;

create or replace function public.set_material_description_override(
  p_material_code text,
  p_description text,
  p_app_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code text := upper(trim(coalesce(p_material_code, '')));
  v_description text := trim(coalesce(p_description, ''));
begin
  if p_app_token is null or not exists (
    select 1
    from private.material_request_app_secrets s
    where s.active
      and s.token_hash = encode(extensions.digest(p_app_token, 'sha256'), 'hex')
  ) then
    raise exception 'Unauthorized application';
  end if;

  if v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,59}$' then
    raise exception 'Invalid material code';
  end if;
  if char_length(v_description) not between 1 and 300 then
    raise exception 'Description must contain between 1 and 300 characters';
  end if;

  insert into private.material_description_overrides (material_code, description, updated_at)
  values (v_code, v_description, now())
  on conflict (material_code) do update
  set description = excluded.description,
      updated_at = excluded.updated_at;

  return jsonb_build_object('materialCode', v_code, 'description', v_description);
end;
$function$;

revoke all on function public.list_material_description_overrides(text) from public, anon, authenticated;
revoke all on function public.set_material_description_override(text, text, text) from public, anon, authenticated;
grant execute on function public.list_material_description_overrides(text) to anon;
grant execute on function public.set_material_description_override(text, text, text) to anon;

select pg_notify('pgrst', 'reload schema');
