import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiPath = new URL("../app/api/material-requests/route.ts", import.meta.url);
const migrationPath = new URL("../supabase/migrations/20260903120000_material_reports_returns_and_departments.sql", import.meta.url);
const compatibilityMigrationPath = new URL("../supabase/migrations/20260903123000_enrich_material_reporting_extract.sql", import.meta.url);

test("the API persists returns as negative without changing PDF quantities", async () => {
  const source = await readFile(apiPath, "utf8");

  assert.match(source, /quantity:\s*type === "return" \? -Math\.abs\(Number\(item\.quantity\)\) : Math\.abs/);
  assert.match(source, /const emailItems:[\s\S]*?= rawItems\.map/);
  assert.match(source, /p_items:\s*items/);
});

test("the existing Material Reports RPC carries reporting fields on every item", async () => {
  const source = await readFile(compatibilityMigrationPath, "utf8");

  assert.match(source, /list_material_requests_for_reporting/);
  assert.match(source, /'requestCode', r\.request_code/);
  assert.match(source, /'version', v\.version_number/);
  assert.match(source, /'transactionType'/);
  assert.match(source, /'department', case when v\.department/);
  assert.match(source, /then -abs\(i\.quantity\) else abs\(i\.quantity\)/);
});

test("the database and reporting RPC enforce line-level transaction rules", async () => {
  const source = await readFile(migrationPath, "utf8");

  assert.match(source, /case when p_request_type = 'return' then -abs\(x\.quantity\)/);
  assert.match(source, /p_requester_name,p_address,p_department,p_work_order,p_request_date/);
  assert.match(source, /list_material_request_lines_for_reporting/);
  assert.match(source, /as transaction_type/);
  assert.match(source, /as department/);
  assert.match(source, /as traceability_source/);
  assert.match(source, /abs\(i\.quantity\)/);
});

