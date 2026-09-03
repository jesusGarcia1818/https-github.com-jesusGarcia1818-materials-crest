# Material Reports integration contract

This repository now defines the canonical line-level reporting source in:

- Migration: `supabase/migrations/20260903120000_material_reports_returns_and_departments.sql`
- Backward-compatible RPC used by the existing Material Reports app: `public.list_material_requests_for_reporting(p_app_token text)`
- Flat line-level RPC for future consumers: `public.list_material_request_lines_for_reporting(p_app_token text)`
- REST routes exposed by Supabase after migration: `POST /rest/v1/rpc/list_material_requests_for_reporting` and `POST /rest/v1/rpc/list_material_request_lines_for_reporting`

No remote database change is performed by adding this migration.

## Tables involved

- `private.material_requests`: request code, current version, and top-level traceability.
- `private.material_request_versions`: versioned Request/Return, Department, requester, address, Work Order, date, and status.
- `private.material_request_items`: one row per material, including Department and signed quantity.
- `private.material_request_events`: save/print/modify audit events.
- `private.breaker_swap_request_links`: links a reported line back to its Breaker Swap movement when applicable.

## Reporting and Excel columns

The existing nested RPC and the flat line-level RPC provide these fields on every material. Material Reports and its Excel download must keep them on every exported row:

`request_code`, `version`, `transaction_type`, `department`, `requester_name`, `address`, `work_order`, `request_date`, `status`, `material_code`, `item_number`, `line_number`, `description`, `category`, `quantity`, `traceability_source`, `source_movement_id`.

The RPC also supplies stable IDs and canonical machine values (`request_id`, `version_id`, `item_id`, `transaction_type_code`, and `department_code`).

Rules enforced by the migration:

- Request quantity is always positive.
- Return quantity is always negative.
- Department is present on every request, version, and material line.
- Department values stored internally are `technical_service` and `subcontractor`; report labels are `Servicio Técnico` and `Subcontratista`.
- Work Order remains required for `technical_service` and optional for `subcontractor`.
- Breaker Swap outgoing lines are Request; confirmed return lines are Return and negative.

## Separate Material Reports application

The Material Reports interface linked from this repository is a separate application (`crest-material-reports.crest-5017.chatgpt.site`) and its source is not included here. Its existing RPC remains compatible and now supplies the new fields inside every `items` entry. Its table and Excel writer must retain those fields when flattening rows. Future consumers can use `list_material_request_lines_for_reporting` directly. The Excel writer must use the signed `quantity` returned by the RPC and must not aggregate away `department`, `transaction_type`, `request_code`, or `version`.

