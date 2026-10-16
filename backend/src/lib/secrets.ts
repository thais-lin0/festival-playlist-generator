import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { env } from "./env";

export interface SpotifySecret {
  clientId: string;
  clientSecret: string;
  /** Random key used to encrypt Spotify refresh tokens at rest in DynamoDB. */
  tokenKey: string;
}

const client = new SecretsManagerClient({});
let cached: { value: SpotifySecret; at: number } | null = null;
const TTL = 5 * 60_000;

export async function spotifySecret(): Promise<SpotifySecret> {
  if (cached && Date.now() - cached.at < TTL) return cached.value;
  const out = await client.send(new GetSecretValueCommand({ SecretId: env("SPOTIFY_SECRET_ARN") }));
  const value = JSON.parse(out.SecretString ?? "{}") as SpotifySecret;
  cached = { value, at: Date.now() };
  return value;
}

/** False until the placeholder values created by the stack are replaced. */
export function isConfigured(s: SpotifySecret): boolean {
  return Boolean(s.clientId && s.clientSecret && !s.clientId.startsWith("PREENCHER") && !s.clientSecret.startsWith("PREENCHER"));
}
