alter table private.breaker_swap_address_materials
  drop constraint breaker_swap_address_material_address_id_movement_kind_mate_key;
create unique index breaker_swap_address_materials_line_uidx
  on private.breaker_swap_address_materials(address_id, movement_kind, material_code, description, coalesce(source_material, ''));

alter table private.breaker_swap_movement_items
  drop constraint breaker_swap_movement_items_movement_id_material_code_descr_key;
create unique index breaker_swap_movement_items_line_uidx
  on private.breaker_swap_movement_items(movement_id, material_code, description, coalesce(source_material, ''));
