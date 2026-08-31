import type { NextRequest } from "next/server";

export const BREAKER_ACCESS_COOKIE = "crest_breaker_access";
export const BREAKER_REFRESH_COOKIE = "crest_breaker_refresh";

type SupabaseAuthUser = {
  id?: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
};

export function supabaseAuthConfiguration() {
  const raw = process.env.SUPABASE_URL?.trim();
  let url: string | undefined;
  if (raw?.includes("|")) url = raw.split("|", 1)[0];
  else if (!raw?.startsWith("{")) url = raw;
  else {
    try { url = (JSON.parse(raw) as { url?: string }).url; } catch { url = undefined; }
  }
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Authentication is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

export function authorizedBreakerUser(user: SupabaseAuthUser | null | undefined) {
  return Boolean(user?.id && user.email && user.app_metadata?.breaker_swap === true);
}

export async function getBreakerSwapUser(request: NextRequest) {
  const accessToken = request.cookies.get(BREAKER_ACCESS_COOKIE)?.value;
  if (!accessToken) return null;
  const { url, key } = supabaseAuthConfiguration();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null) as SupabaseAuthUser | null;
  return authorizedBreakerUser(user) ? user : null;
}
