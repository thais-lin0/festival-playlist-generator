import { getConfig } from "./config";

// Cognito managed login, authorization code + PKCE, no client secret (public SPA client).
const SESSION_KEY = "fpg_auth_v1";
const PENDING_KEY = "fpg_auth_pending";

interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AuthUser {
  email: string;
}

const redirectUri = () => `${window.location.origin}/auth/callback/`;

function read<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown | null) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the user will just need to sign in again */
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(part))));
}

export async function startLogin(mode: "login" | "signup" = "login"): Promise<void> {
  const cfg = await getConfig();
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  write(sessionStorage, PENDING_KEY, { verifier, state });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.userPoolClientId,
    redirect_uri: redirectUri(),
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    lang: "pt-BR",
  });
  window.location.href = `https://${cfg.authDomain}/${mode === "signup" ? "signup" : "oauth2/authorize"}?${params}`;
}

export async function completeLogin(code: string, state: string): Promise<void> {
  const cfg = await getConfig();
  const pending = read<{ verifier: string; state: string }>(sessionStorage, PENDING_KEY);
  write(sessionStorage, PENDING_KEY, null);
  if (!pending || pending.state !== state) throw new Error("Sessão de login inválida. Tente entrar novamente.");
  const res = await fetch(`https://${cfg.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.userPoolClientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: pending.verifier,
    }),
  });
  if (!res.ok) throw new Error("Não foi possível concluir o login.");
  const t = await res.json();
  write(localStorage, SESSION_KEY, {
    idToken: t.id_token,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
  } satisfies Session);
}

/** A valid access token, refreshing it when it's about to expire; null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  const session = read<Session>(localStorage, SESSION_KEY);
  if (!session) return null;
  if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
  const cfg = await getConfig();
  const res = await fetch(`https://${cfg.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.userPoolClientId, refresh_token: session.refreshToken }),
  }).catch(() => null);
  if (!res?.ok) {
    clearSession();
    return null;
  }
  const t = await res.json();
  const next: Session = { ...session, idToken: t.id_token, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  write(localStorage, SESSION_KEY, next);
  return next.accessToken;
}

export function currentUser(): AuthUser | null {
  const session = read<Session>(localStorage, SESSION_KEY);
  if (!session) return null;
  try {
    return { email: String(decodeJwt(session.idToken).email ?? "") };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  write(localStorage, SESSION_KEY, null);
}

export async function logout(): Promise<void> {
  const cfg = await getConfig();
  clearSession();
  const params = new URLSearchParams({ client_id: cfg.userPoolClientId, logout_uri: `${window.location.origin}/` });
  window.location.href = `https://${cfg.authDomain}/logout?${params}`;
}
