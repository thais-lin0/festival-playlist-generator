"use client";

import { useEffect, useState } from "react";
import { completeLogin } from "@/lib/auth";

export default function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(params.get("error_description") ?? "Login cancelado.");
      return;
    }
    completeLogin(code, state)
      .then(() => window.location.replace("/"))
      .catch((e) => setError(e instanceof Error ? e.message : "Falha no login."));
  }, []);

  return (
    <main className="shell" style={{ paddingTop: 80 }}>
      <h1 className="display misreg" style={{ fontSize: 72, margin: 0 }}>{error ? "Ops." : "Entrando…"}</h1>
      {error && (
        <p className="error">
          {error} <a href="/">Voltar</a>
        </p>
      )}
    </main>
  );
}
