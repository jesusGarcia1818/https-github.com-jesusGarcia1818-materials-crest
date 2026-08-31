import { NextRequest, NextResponse } from "next/server";
import { getBreakerSwapUser } from "../../lib/breaker-swap-auth";

type MaterialInput = {
  description: string;
  code: string;
  quantity: number;
  sourceMaterial?: string;
};

function protectedRuntimeValues() {
  const raw = process.env.SUPABASE_URL?.trim();
  if (raw?.includes("|")) return { supabaseUrl: raw.split("|", 1)[0] };
  if (!raw?.startsWith("{")) return { supabaseUrl: raw };
  try {
    return { supabaseUrl: (JSON.parse(raw) as { url?: string }).url };
  } catch {
    return { supabaseUrl: undefined };
  }
}

function configuration() {
  const url = protectedRuntimeValues().supabaseUrl;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const appToken = process.env.SUPABASE_APP_TOKEN;
  if (!url || !key || !appToken) throw new Error("Database connection is not configured");
  return { url: url.replace(/\/$/, ""), key, appToken };
}

async function callRpc(functionName: string, body: Record<string, unknown> = {}) {
  const { url, key, appToken } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, p_app_token: appToken }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const notFound = payload?.message === "Pending return not found";
    throw new Error(notFound ? "Pending return not found" : "Database operation failed");
  }
  return payload;
}

function materialLines(value: unknown): MaterialInput[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const lines = value.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      description: String(item.description || "").trim().slice(0, 300),
      code: String(item.code || "").trim().slice(0, 60),
      quantity: Number(item.quantity),
      sourceMaterial: String(item.sourceMaterial || "").trim().slice(0, 300) || undefined,
    };
  });
  return lines.every((item) => item.description && item.code && Number.isFinite(item.quantity) && item.quantity > 0 && item.quantity <= 999999) ? lines : null;
}

export async function GET(request: NextRequest) {
  if (!await getBreakerSwapUser(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const resource = request.nextUrl.searchParams.get("resource");
  if (resource !== "addresses" && resource !== "ledger") {
    return NextResponse.json({ error: "Recurso inválido" }, { status: 400 });
  }
  try {
    const payload = await callRpc(resource === "addresses" ? "get_breaker_swap_addresses" : "get_breaker_swap_ledger");
    if (resource === "ledger" && Array.isArray(payload)) {
      return NextResponse.json(payload.map((movement: Record<string, unknown>) => ({
        ...movement,
        entryId: String(movement.jobId || ""),
      })), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: resource === "addresses" ? "No se pudieron cargar las direcciones desde Supabase" : "No se pudo cargar el registro central" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getBreakerSwapUser(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const input = await request.json() as { jobs?: unknown };
    if (!Array.isArray(input.jobs) || input.jobs.length === 0 || input.jobs.length > 250) {
      return NextResponse.json({ error: "La lista de trabajos no es válida" }, { status: 400 });
    }
    const jobs = input.jobs.map((raw) => {
      const job = raw as Record<string, unknown>;
      const outgoing = materialLines(job.outgoing);
      const returns = materialLines(job.returns);
      return {
        address: String(job.address || "").trim().slice(0, 300),
        supervisor: String(job.supervisor || "").trim().slice(0, 160),
        workOrder: String(job.workOrder || "").trim(),
        date: String(job.date || "").trim(),
        outgoing,
        return: returns,
      };
    });
    const invalid = jobs.some((job) => !job.address || job.supervisor.length < 2 || !/^\d+$/.test(job.workOrder) || !/^\d{4}-\d{2}-\d{2}$/.test(job.date) || job.outgoing === null || job.return === null || (!job.outgoing.length && !job.return.length));
    if (invalid) return NextResponse.json({ error: "Completa correctamente los datos de cada trabajo" }, { status: 400 });

    const saved = await callRpc("save_breaker_swap_print", { p_jobs: jobs });
    return NextResponse.json(saved, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "No se pudo registrar Breaker Swap en Supabase" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const currentUser = await getBreakerSwapUser(request);
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const input = await request.json() as { movementId?: unknown; confirmedBy?: unknown };
    const movementId = String(input.movementId || "").trim();
    const confirmedBy = String(currentUser.email || input.confirmedBy || "Office").trim().slice(0, 160);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(movementId) || confirmedBy.length < 2) {
      return NextResponse.json({ error: "La confirmación no es válida" }, { status: 400 });
    }
    const confirmed = await callRpc("confirm_breaker_swap_return", { p_movement_id: movementId, p_confirmed_by: confirmedBy });
    return NextResponse.json(confirmed, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const notFound = error instanceof Error && error.message === "Pending return not found";
    return NextResponse.json({ error: notFound ? "El retorno pendiente ya no está disponible" : "No se pudo confirmar el retorno en Supabase" }, { status: notFound ? 404 : 500 });
  }
}
