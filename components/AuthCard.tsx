"use client";

import { useState, type FormEvent } from "react";
import { AuthError, confirmSignUp, forgotPassword, resendCode, resetPassword, signIn, signUp } from "@/lib/auth";

export type AuthMode = "signin" | "signup" | "confirm" | "forgot" | "reset";

const TITLES: Record<AuthMode, string> = {
  signin: "Entrar",
  signup: "Criar conta",
  confirm: "Confirme seu e-mail",
  forgot: "Esqueci a senha",
  reset: "Nova senha",
};

interface Props {
  mode: AuthMode;
  onMode: (mode: AuthMode) => void;
  onSignedIn: () => void;
}

export function AuthCard({ mode, onMode, onSignedIn }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const go = (next: AuthMode, message: string | null = null) => {
    setError(null);
    setInfo(message);
    setCode("");
    onMode(next);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") {
        await signIn(email, password);
        onSignedIn();
      } else if (mode === "signup") {
        await signUp(email, password);
        go("confirm", `Enviamos um código para ${email}.`);
      } else if (mode === "confirm") {
        await confirmSignUp(email, code);
        if (!password) return go("signin", "Conta confirmada! Agora é só entrar.");
        await signIn(email, password);
        onSignedIn();
      } else if (mode === "forgot") {
        await forgotPassword(email);
        go("reset", `Se existir uma conta para ${email}, enviamos um código.`);
      } else {
        await resetPassword(email, code, password);
        await signIn(email, password);
        onSignedIn();
      }
    } catch (err) {
      if (err instanceof AuthError && err.code === "UserNotConfirmedException") {
        await resendCode(email).catch(() => {});
        go("confirm", `Sua conta ainda não foi confirmada. Enviamos um novo código para ${email}.`);
      } else {
        setError(err instanceof Error ? err.message : "Algo deu errado.");
      }
    } finally {
      setBusy(false);
    }
  }

  const needsPassword = mode === "signin" || mode === "signup" || mode === "reset";
  const needsCode = mode === "confirm" || mode === "reset";

  return (
    <form className="auth" onSubmit={submit}>
      {(mode === "signin" || mode === "signup") && (
        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => go("signin")}>
            Entrar
          </button>
          <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => go("signup")}>
            Criar conta
          </button>
        </div>
      )}
      {mode !== "signin" && mode !== "signup" && <div className="auth-title display">{TITLES[mode]}</div>}
      {info && <p className="auth-info">{info}</p>}

      {!needsCode || mode === "reset" ? (
        <label>
          <span>E-mail</span>
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={mode === "reset"} />
        </label>
      ) : null}
      {needsCode && (
        <label>
          <span>Código de 6 dígitos</span>
          <input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
        </label>
      )}
      {needsPassword && (
        <label>
          <span>{mode === "reset" ? "Nova senha" : "Senha"}</span>
          <div className="password-field">
            <input
              type={showPassword ? "text" : "password"}
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="reveal-password mono"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            >
              {showPassword ? "ocultar" : "mostrar"}
            </button>
          </div>
          {mode !== "signin" && <small>mínimo de 8 caracteres</small>}
        </label>
      )}

      {error && <div className="auth-error" role="alert">{error}</div>}

      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Aguarde…" : mode === "signup" ? "Criar conta" : mode === "signin" ? "Entrar" : "Continuar"}
      </button>

      <div className="auth-links">
        {mode === "signin" && (
          <button type="button" className="linkish" onClick={() => go("forgot")}>esqueci a senha</button>
        )}
        {mode === "confirm" && (
          <button type="button" className="linkish" onClick={() => resendCode(email).then(() => setInfo("Código reenviado.")).catch((e) => setError(e.message))}>
            reenviar código
          </button>
        )}
        {(mode === "confirm" || mode === "forgot" || mode === "reset") && (
          <button type="button" className="linkish" onClick={() => go("signin")}>voltar</button>
        )}
      </div>
    </form>
  );
}
