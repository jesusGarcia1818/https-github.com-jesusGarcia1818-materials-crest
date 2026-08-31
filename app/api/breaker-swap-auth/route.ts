import { NextRequest, NextResponse } from "next/server";
import {
  authorizedBreakerUser,
  BREAKER_ACCESS_COOKIE,
  BREAKER_REFRESH_COOKIE,
  getBreakerSwapUser,
  supabaseAuthConfiguration,
} from "../../lib/breaker-swap-auth";

type AuthPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string; app_metadata?: Record<string, unknown> };
  error_description?: string;
  message?: string;
};

const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

function setSessionCookies(response: NextResponse, payload: AuthPayload) {
  if (payload.access_token) response.cookies.set(BREAKER_ACCESS_COOKIE, payload.access_token, { ...cookieBase, maxAge: Math.max(60, Number(payload.expires_in) || 3600) });
  if (payload.refresh_token) response.cookies.set(BREAKER_REFRESH_COOKIE, payload.refresh_token, { ...cookieBase, maxAge: 60 * 60 * 24 * 30 });
}

function clearSessionCookies(response: NextResponse) {
  response.cookies.set(BREAKER_ACCESS_COOKIE, "", { ...cookieBase, maxAge: 0 });
  response.cookies.set(BREAKER_REFRESH_COOKIE, "", { ...cookieBase, maxAge: 0 });
}

async function tokenRequest(grant: "password" | "refresh_token", body: Record<string, unknown>) {
  const { url, key } = supabaseAuthConfiguration();
  const response = await fetch(`${url}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return { response, payload: await response.json().catch(() => null) as AuthPayload | null };
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json() as { email?: unknown; password?: unknown };
    const email = String(input.email || "").trim().toLowerCase().slice(0, 254);
    const password = String(input.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 200) {
      return NextResponse.json({ error: "Enter a valid email and password" }, { status: 400 });
    }
    const { response: authResponse, payload } = await tokenRequest("password", { email, password });
    if (!authResponse.ok || !payload?.access_token || !authorizedBreakerUser(payload.user)) {
      return NextResponse.json({ error: "The email or password is not valid for Breaker Swap" }, { status: 401 });
    }
    const response = NextResponse.json({ authenticated: true, email: payload.user?.email });
    setSessionCookies(response, payload);
    return response;
  } catch {
    return NextResponse.json({ error: "Supabase authentication is not available" }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getBreakerSwapUser(request);
    if (currentUser) return NextResponse.json({ authenticated: true, email: currentUser.email }, { headers: { "Cache-Control": "no-store" } });

    const refreshToken = request.cookies.get(BREAKER_REFRESH_COOKIE)?.value;
    if (!refreshToken) return NextResponse.json({ authenticated: false }, { status: 401 });
    const { response: authResponse, payload } = await tokenRequest("refresh_token", { refresh_token: refreshToken });
    if (!authResponse.ok || !payload?.access_token || !authorizedBreakerUser(payload.user)) {
      const response = NextResponse.json({ authenticated: false }, { status: 401 });
      clearSessionCookies(response);
      return response;
    }
    const response = NextResponse.json({ authenticated: true, email: payload.user?.email }, { headers: { "Cache-Control": "no-store" } });
    setSessionCookies(response, payload);
    return response;
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const accessToken = request.cookies.get(BREAKER_ACCESS_COOKIE)?.value;
    if (accessToken) {
      const { url, key } = supabaseAuthConfiguration();
      await fetch(`${url}/auth/v1/logout`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    }
  } catch {
    // Local session cookies are cleared even if the upstream logout is unavailable.
  }
  const response = NextResponse.json({ authenticated: false });
  clearSessionCookies(response);
  return response;
}
