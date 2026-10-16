import { createHash, randomBytes } from "node:crypto";
import type { PlaylistArtistInput, PlaylistTrack, ResolvedArtist } from "../../../lib/types";
import { seal, unseal } from "./crypto";
import { getSpotifyConnection, putSpotifyConnection } from "./db";
import { normalize } from "./normalize";
import { spotifySecret, type SpotifySecret } from "./secrets";

const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
export const SCOPES = ["playlist-modify-private", "playlist-modify-public"];

// Dev Mode (Feb 2026): search returns at most 10 items per page, there is no
// top-tracks endpoint and no popularity field, so track selection relies on
// paginated search order (Spotify's relevance ranking) plus our own filtering.
const SEARCH_PAGE = 10;
const MAX_SEARCH_PAGES = 4;

export class SpotifyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// ---------- OAuth ----------

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: randomBytes(24).toString("base64url") };
}

export function authorizeUrl(secret: SpotifySecret, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: secret.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

async function tokenRequest(
  secret: SpotifySecret,
  body: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${secret.clientId}:${secret.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new SpotifyError(res.status, "Falha na autenticação com o Spotify.");
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

export async function connectUser(sub: string, code: string, verifier: string, redirectUri: string): Promise<void> {
  const secret = await spotifySecret();
  const t = await tokenRequest(secret, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  const tokens: Tokens = { accessToken: t.access_token, refreshToken: t.refresh_token!, expiresAt: Date.now() + t.expires_in * 1000 };
  const me = await api<{ id: string; display_name: string | null }>(tokens.accessToken, "/me");
  await putSpotifyConnection(sub, {
    sealedTokens: seal(tokens, secret.tokenKey),
    displayName: me.display_name ?? me.id,
    connectedAt: new Date().toISOString(),
  });
}

/** The user's access token, refreshed (and re-stored) when close to expiry. */
export async function userAccessToken(sub: string): Promise<string | null> {
  const conn = await getSpotifyConnection(sub);
  if (!conn) return null;
  const secret = await spotifySecret();
  const tokens = unseal<Tokens>(conn.sealedTokens, secret.tokenKey);
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 120_000) return tokens.accessToken;
  try {
    const t = await tokenRequest(secret, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    const next: Tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
    await putSpotifyConnection(sub, { ...conn, sealedTokens: seal(next, secret.tokenKey) });
    return next.accessToken;
  } catch {
    return null;
  }
}

let appToken: { value: string; expiresAt: number } | null = null;

/** Client-credentials token: artist lookups that don't need a user. */
export async function appAccessToken(): Promise<string> {
  if (appToken && appToken.expiresAt - Date.now() > 60_000) return appToken.value;
  const t = await tokenRequest(await spotifySecret(), { grant_type: "client_credentials" });
  appToken = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  return appToken.value;
}

// ---------- Web API ----------

async function api<T>(token: string, path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 1), 15) * 1000));
    return api(token, path, init, attempt + 1);
  }
  if (!res.ok) {
    const message =
      res.status === 403
        ? "O Spotify recusou a operação. Em modo de desenvolvimento, sua conta do Spotify precisa estar na lista de usuários do app."
        : `Erro do Spotify (${res.status}).`;
    throw new SpotifyError(res.status, message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres?: string[];
  images?: { url: string; width: number }[];
}

interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: { id: string; name: string }[];
  is_playable?: boolean;
}

export async function findArtist(token: string, name: string): Promise<Omit<ResolvedArtist, "lineupId">> {
  const q = new URLSearchParams({ q: name, type: "artist", limit: String(SEARCH_PAGE) });
  const data = await api<{ artists: { items: SpotifyArtist[] } }>(token, `/search?${q}`);
  const items = data.artists.items.filter(Boolean);
  const target = normalize(name);
  let match: ResolvedArtist["match"] = "none";
  let artist = items.find((a) => normalize(a.name) === target);
  if (artist) match = "exact";
  else if (items[0] && target.length > 3 && (normalize(items[0].name).includes(target) || target.includes(normalize(items[0].name)))) {
    artist = items[0];
    match = "close";
  }
  if (!artist) return { spotifyId: null, spotifyName: null, imageUrl: null, genres: [], match };
  const images = [...(artist.images ?? [])].sort((a, b) => a.width - b.width);
  return {
    spotifyId: artist.id,
    spotifyName: artist.name,
    imageUrl: (images.find((i) => i.width >= 160) ?? images.at(-1))?.url ?? null,
    genres: artist.genres ?? [],
    match,
  };
}

export async function resolveArtists(artists: { id: string; name: string }[]): Promise<Record<string, ResolvedArtist>> {
  const token = await appAccessToken();
  const resolved = await mapLimited(artists, 5, async (a): Promise<ResolvedArtist> => {
    try {
      return { lineupId: a.id, ...(await findArtist(token, a.name)) };
    } catch {
      return { lineupId: a.id, spotifyId: null, spotifyName: null, imageUrl: null, genres: [], match: "none" };
    }
  });
  return Object.fromEntries(resolved.map((r) => [r.lineupId, r]));
}

const UNWANTED = /\b(remix|remixed|live|ao vivo|en vivo|sped up|slowed|reverb|karaoke|instrumental|acapella|a cappella|8d)\b/i;

function baseTitle(title: string): string {
  return normalize(title.replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+.*$/, ""));
}

/**
 * Up to `count` tracks where the artist is the *primary* artist, skipping
 * remixes/live/sped-up versions and duplicate titles. Returns fewer than
 * `count` rather than padding with someone else's music.
 */
export async function tracksForArtist(token: string, artistId: string, artistName: string, count: number): Promise<PlaylistTrack[]> {
  const picked: PlaylistTrack[] = [];
  const titles = new Set<string>();
  for (let page = 0; page < MAX_SEARCH_PAGES && picked.length < count; page++) {
    const q = new URLSearchParams({
      q: `artist:"${artistName.replace(/"/g, "")}"`,
      type: "track",
      limit: String(SEARCH_PAGE),
      offset: String(page * SEARCH_PAGE),
    });
    const data = await api<{ tracks: { items: SpotifyTrack[]; next: string | null } }>(token, `/search?${q}`);
    for (const t of data.tracks.items) {
      if (!t || t.artists[0]?.id !== artistId || UNWANTED.test(t.name) || t.is_playable === false) continue;
      const key = baseTitle(t.name);
      if (titles.has(key)) continue;
      titles.add(key);
      picked.push({ uri: t.uri, title: t.name, artist: t.artists.map((a) => a.name).join(", ") });
      if (picked.length === count) break;
    }
    if (!data.tracks.next) break;
  }
  return picked;
}

export async function collectForArtist(token: string, artist: PlaylistArtistInput, count: number): Promise<PlaylistTrack[]> {
  let id = artist.spotifyId;
  let name = artist.name;
  if (!id) {
    const found = await findArtist(token, artist.name);
    if (!found.spotifyId) return [];
    id = found.spotifyId;
    name = found.spotifyName ?? name;
  }
  return tracksForArtist(token, id, name, count);
}

export async function createPlaylist(token: string, name: string, description: string, isPublic: boolean): Promise<{ id: string; url: string }> {
  const p = await api<{ id: string; external_urls: { spotify: string } }>(token, "/me/playlists", {
    method: "POST",
    body: JSON.stringify({ name, description, public: isPublic }),
  });
  return { id: p.id, url: p.external_urls.spotify };
}

export async function addItems(token: string, playlistId: string, uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    await api(token, `/playlists/${playlistId}/items`, { method: "POST", body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
