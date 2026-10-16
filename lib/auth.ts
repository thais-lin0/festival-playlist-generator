import { getConfig } from "./config";

// Our own login form talking straight to the Cognito user pool API (no hosted UI).
// The password goes over TLS to Cognito only, never to our back-end.
const SESSION_KEY = "fpg_auth_v2";

interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AuthUser {
  email: string;
}

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  NotAuthorizedException: "E-mail ou senha incorretos.",
  UserNotFoundException: "E-mail ou senha incorretos.",
  UsernameExistsException: "Já existe uma conta com este e-mail. Tente entrar.",
  InvalidPasswordException: "A senha precisa ter pelo menos 8 caracteres.",
  InvalidParameterException: "Confira o e-mail e a senha.",
  CodeMismatchException: "Código incorreto. Confira o e-mail e tente de novo.",
  ExpiredCodeException: "Este código expirou. Peça um novo.",
  LimitExceededException: "Muitas tentativas. Aguarde alguns minutos.",
  TooManyRequestsException: "Muitas tentativas. Aguarde alguns minutos.",
  TooManyFailedAttemptsException: "Muitas tentativas. Aguarde alguns minutos.",
  CodeDeliveryFailureException: "Não conseguimos enviar o código. Tente novamente.",
};

async function cognito<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const cfg = await getConfig();
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}` },
    body: JSON.stringify({ ClientId: cfg.userPoolClientId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.__type ?? "Unknown").split("#").pop()!;
    throw new AuthError(code, MESSAGES[code] ?? "Algo deu errado. Tente novamente.");
  }
  return data as T;
}

interface AuthResult {
  AuthenticationResult?: { IdToken: string; AccessToken: string; RefreshToken?: string; ExpiresIn: number };
}

function store(result: AuthResult, refreshToken?: string): void {
  const r = result.AuthenticationResult;
  if (!r) throw new AuthError("Unknown", "Não foi possível entrar.");
  write({
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? refreshToken ?? "",
    expiresAt: Date.now() + r.ExpiresIn * 1000,
  });
}

const clean = (email: string) => email.trim().toLowerCase();

export async function signIn(email: string, password: string): Promise<void> {
  store(
    await cognito<AuthResult>("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: clean(email), PASSWORD: password },
    }),
  );
}

/** Creates the account; Cognito emails a 6-digit code that confirmSignUp checks. */
export async function signUp(email: string, password: string): Promise<void> {
  await cognito("SignUp", { Username: clean(email), Password: password, UserAttributes: [{ Name: "email", Value: clean(email) }] });
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  await cognito("ConfirmSignUp", { Username: clean(email), ConfirmationCode: code.trim() });
}

export async function resendCode(email: string): Promise<void> {
  await cognito("ResendConfirmationCode", { Username: clean(email) });
}

export async function forgotPassword(email: string): Promise<void> {
  await cognito("ForgotPassword", { Username: clean(email) });
}

export async function resetPassword(email: string, code: string, password: string): Promise<void> {
  await cognito("ConfirmForgotPassword", { Username: clean(email), ConfirmationCode: code.trim(), Password: password });
}

/** A valid access token, refreshing it when it's about to expire; null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  const session = read();
  if (!session) return null;
  if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
  try {
    store(
      await cognito<AuthResult>("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: session.refreshToken } }),
      session.refreshToken,
    );
    return read()?.accessToken ?? null;
  } catch {
    clearSession();
    return null;
  }
}

export function currentUser(): AuthUser | null {
  const session = read();
  if (!session) return null;
  try {
    const part = session.idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return { email: String(JSON.parse(decodeURIComponent(escape(atob(part)))).email ?? "") };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

export async function logout(): Promise<void> {
  const session = read();
  clearSession();
  if (session?.refreshToken) await cognito("RevokeToken", { Token: session.refreshToken }).catch(() => {});
}

function read(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function write(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage blocked: the user will need to sign in again next visit */
  }
}
