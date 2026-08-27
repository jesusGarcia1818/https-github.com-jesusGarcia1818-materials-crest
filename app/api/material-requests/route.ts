import { NextRequest, NextResponse } from "next/server";
import { createMaterialRequestPdf, type PdfMaterialItem } from "../../lib/material-request-pdf";

const allowedStatuses = new Set(["draft", "printed", "needs_changes", "approved", "cancelled"]);
const requestCodePattern = /^(?:\d{4}|MAT-[0-9]{8}-[A-Z0-9]{4,12})$/;

function protectedRuntimeValues() {
  const raw = process.env.SUPABASE_URL?.trim();
  if (raw?.includes("|")) {
    const [supabaseUrl, resendApiKey] = raw.split("|", 2);
    return { supabaseUrl, resendApiKey: process.env.RESEND_API_KEY || resendApiKey };
  }
  if (!raw?.trim().startsWith("{")) return { supabaseUrl: raw, resendApiKey: process.env.RESEND_API_KEY };
  try {
    const value = JSON.parse(raw) as { url?: string; resend?: string };
    return { supabaseUrl: value.url, resendApiKey: process.env.RESEND_API_KEY || value.resend };
  } catch {
    return { supabaseUrl: undefined, resendApiKey: process.env.RESEND_API_KEY };
  }
}

function configuration() {
  const url = protectedRuntimeValues().supabaseUrl;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const appToken = process.env.SUPABASE_APP_TOKEN;
  if (!url || !key || !appToken) throw new Error("Database connection is not configured");
  return { url, key, appToken };
}

function emailConfiguration() {
  const apiKey = protectedRuntimeValues().resendApiKey;
  if (!apiKey) throw new Error("Email delivery is not configured");
  return {
    apiKey,
    from: process.env.MATERIAL_REQUEST_EMAIL_FROM || "Crest Materials <onboarding@resend.dev>",
    to: "materials@dfwcrest.com",
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character] || character);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function sendRequestEmail(input: {
  type: "request" | "return";
  code: string;
  name: string;
  address: string;
  workOrder: string;
  requestDate: string;
  version: number;
  items: PdfMaterialItem[];
}) {
  const { apiKey, from, to } = emailConfiguration();
  const pdf = await createMaterialRequestPdf(input);
  const documentLabel = input.type === "return" ? "Material Return" : "Material Request";
  const subject = `${documentLabel} ${input.code} - WO ${input.workOrder}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `material-request/${input.code}/v${input.version}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html: `<h2>${documentLabel}</h2><p><strong>${input.type === "return" ? "Return" : "Request"}:</strong> ${escapeHtml(input.code)}</p><p><strong>Name:</strong> ${escapeHtml(input.name)}<br><strong>Address:</strong> ${escapeHtml(input.address)}<br><strong>Work Order:</strong> ${escapeHtml(input.workOrder)}<br><strong>Date:</strong> ${escapeHtml(input.requestDate)}</p><p>The complete material document is attached as a PDF.</p>`,
      text: `${documentLabel}\n${input.type === "return" ? "Return" : "Request"}: ${input.code}\nName: ${input.name}\nAddress: ${input.address}\nWork Order: ${input.workOrder}\nDate: ${input.requestDate}\n\nThe complete material document is attached as a PDF.`,
      attachments: [{
        content: bytesToBase64(pdf),
        filename: `${input.code}-V${input.version}.pdf`,
      }],
      tags: [{ name: "request_code", value: input.code.replace(/[^A-Za-z0-9_-]/g, "_") }],
    }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as { id?: string; message?: string } | null;
  if (!response.ok || !payload?.id) throw new Error(payload?.message || "Email delivery failed");
  return payload.id;
}

async function callRpc(functionName: string, body: unknown) {
  const { url, key, appToken } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...(body as Record<string, unknown>), p_app_token: appToken }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message === "Request not found" ? "Request not found" : "Database operation failed";
    throw new Error(message);
  }
  return payload;
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("allocate") === "1") {
    try {
      const allocated = await callRpc("allocate_material_request_code", {});
      return NextResponse.json({ code: String(allocated) }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "No se pudo generar un cÃ³digo Ãºnico" }, { status: 500 });
    }
  }
  const code = request.nextUrl.searchParams.get("code")?.trim().toUpperCase() || "";
  if (!requestCodePattern.test(code)) {
    return NextResponse.json({ error: "CÃ³digo invÃ¡lido" }, { status: 400 });
  }
  try {
    const record = await callRpc("get_material_request", { p_request_code: code });
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const notFound = error instanceof Error && error.message === "Request not found";
    return NextResponse.json({ error: notFound ? "Solicitud no encontrada" : "No se pudo consultar Supabase" }, { status: notFound ? 404 : 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim().toUpperCase() || "";
  if (!requestCodePattern.test(code)) {
    return NextResponse.json({ error: "CÃ³digo invÃ¡lido" }, { status: 400 });
  }
  try {
    const deleted = await callRpc("delete_material_request", { p_request_code: code });
    return NextResponse.json(deleted, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const notFound = error instanceof Error && error.message === "Request not found";
    return NextResponse.json({ error: notFound ? "Solicitud no encontrada" : "No se pudo eliminar la solicitud" }, { status: notFound ? 404 : 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json();
    const code = String(input.code || "").trim().toUpperCase();
    const name = String(input.name || "").trim();
    const address = String(input.address || "").trim();
    const workOrder = String(input.workOrder || "").trim();
    const requestDate = String(input.requestDate || "").trim();
    const type = input.type === "return" ? "return" : "request";
    const status = String(input.status || "draft");
    const version = Number(input.version);
    const rawItems = Array.isArray(input.items) ? input.items.slice(0, 500) : [];
    const items = rawItems.map((item: Record<string, unknown>) => ({
      ...item,
      quantity: type === "return" ? -Math.abs(Number(item.quantity)) : Math.abs(Number(item.quantity)),
    }));
    const eventType = status === "printed" ? "printed" : version > 1 ? "modified" : "saved";

    if (!requestCodePattern.test(code) || name.length < 2 || address.length < 2 || !/^\d+$/.test(workOrder) || !/^\d{4}-\d{2}-\d{2}$/.test(requestDate) || !allowedStatuses.has(status) || !Number.isInteger(version) || version < 1) {
      return NextResponse.json({ error: "Completa correctamente los datos requeridos" }, { status: 400 });
    }

    const emailItems: PdfMaterialItem[] = items.map((item: Record<string, unknown>) => ({
      category: String(item.category || "OTHER MATERIALS").slice(0, 120),
      material_code: String(item.material_code || "").slice(0, 60),
      item_number: String(item.item_number || "").slice(0, 120),
      line_number: String(item.line_number || "").slice(0, 30),
      description: String(item.description || "").slice(0, 300),
      quantity: Number(item.quantity),
    }));
    if (status === "printed" && (!emailItems.length || emailItems.some((item) => !Number.isFinite(item.quantity) || Math.abs(item.quantity) <= 0 || Math.abs(item.quantity) > 999999))) {
      return NextResponse.json({ error: "Selecciona al menos un material con una cantidad vÃ¡lida" }, { status: 400 });
    }

    let emailId: string | undefined;
    if (status === "printed") {
      emailId = await sendRequestEmail({ type, code, name, address, workOrder, requestDate, version, items: emailItems });
    }

    const saved = await callRpc("save_material_request", {
      p_request_code: code,
      p_requester_name: name,
      p_address: address,
      p_work_order: workOrder,
      p_request_date: requestDate,
      p_request_type: type,
      p_status: status,
      p_version: version,
      p_items: items,
      p_event_type: eventType,
    });
    return NextResponse.json({ ...(saved as Record<string, unknown>), emailId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Email delivery is not configured") {
      return NextResponse.json({ error: "El envÃ­o por correo todavÃ­a no estÃ¡ configurado" }, { status: 503 });
    }
    if (message === "Email delivery failed" || /resend|email|domain|recipient|rate/i.test(message)) {
      return NextResponse.json({ error: "No se pudo enviar el PDF por correo" }, { status: 502 });
    }
    return NextResponse.json({ error: "No se pudo guardar la solicitud en Supabase" }, { status: 500 });
  }
}

