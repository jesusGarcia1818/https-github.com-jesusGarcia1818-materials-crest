import { NextResponse } from "next/server";
import materialCatalog from "../../materials-catalog.json";

function configuration() {
  const raw = process.env.SUPABASE_URL?.trim();
  let url: string | undefined;
  if (raw?.includes("|")) url = raw.split("|", 1)[0];
  else if (raw?.startsWith("{")) {
    try { url = (JSON.parse(raw) as { url?: string }).url; } catch { url = undefined; }
  } else url = raw;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const appToken = process.env.SUPABASE_APP_TOKEN;
  if (!url || !key || !appToken) throw new Error("Catalog connection is not configured");
  return { url, key, appToken };
}

export async function GET() {
  try {
    const { url, key, appToken } = configuration();
    const response = await fetch(`${url}/rest/v1/rpc/list_material_description_overrides`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_app_token: appToken }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Catalog overrides could not be read");
    const overrides = await response.json() as Record<string, string>;
    const materials = (materialCatalog as Array<Record<string, unknown>>).map((item) => {
      const code = String(item.code || "").toUpperCase();
      const description = overrides[code];
      return description ? { ...item, description } : item;
    });
    return NextResponse.json({ materials }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // The embedded catalog remains available even if the override service is temporarily unavailable.
    return NextResponse.json({ materials: materialCatalog, overridesUnavailable: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
