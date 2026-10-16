import type { AppConfig } from "./types";

let pending: Promise<AppConfig> | null = null;

/** Written to the bucket by the CDK stack; `npm run config:pull` copies it for local dev. */
export function getConfig(): Promise<AppConfig> {
  pending ??= fetch("/config.json", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("config.json não encontrado. Rode `npm run config:pull` após o deploy.");
    return r.json() as Promise<AppConfig>;
  });
  pending.catch(() => (pending = null));
  return pending;
}
