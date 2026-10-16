import { clearSession, getAccessToken } from "./auth";
import { getConfig } from "./config";

export class AuthRequiredError extends Error {
  constructor() {
    super("Entre na sua conta para continuar.");
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const [cfg, token] = await Promise.all([getConfig(), getAccessToken()]);
  if (!token) throw new AuthRequiredError();
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearSession();
    throw new AuthRequiredError();
  }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Erro ${res.status}`);
  return data as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
