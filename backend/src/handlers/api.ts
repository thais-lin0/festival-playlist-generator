import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import type { CreateLineupResponse, Lineup, PlaylistJob, SpotifyStatus } from "../../../lib/types";
import { seal, unseal } from "../lib/crypto";
import {
  deleteSpotifyConnection,
  getJob,
  getLineup,
  getSpotifyConnection,
  listJobs,
  listLineups,
  newId,
  putJob,
  putLineup,
  putOAuthState,
  takeOAuthState,
  updateLineup,
} from "../lib/db";
import { env } from "../lib/env";
import { error, HttpError, json, redirect } from "../lib/http";
import { log } from "../lib/log";
import { metric } from "../lib/metrics";
import { isConfigured, spotifySecret } from "../lib/secrets";
import { authorizeUrl, connectUser, pkce, resolveArtists } from "../lib/spotify";

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Handler = (event: Event, sub: string) => Promise<APIGatewayProxyResultV2>;

// ---------- validation ----------

const Tier = z.enum(["headliner", "main", "undercard"]);
const ArtistSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  day: z.string().max(40).nullable(),
  genre: z.string().max(40).nullable(),
  tier: Tier,
  order: z.number().int(),
});
const SelectionSchema = z.object({
  selected: z.array(z.string().max(40)).max(300),
  prefs: z.record(z.string().max(40), z.enum(["none", "favorite", "discover"])),
  mode: z.enum(["full", "selection", "day", "discover"]),
  modeDay: z.string().max(40).nullable(),
  tracksPerArtist: z.union([z.literal(3), z.literal(5), z.literal(10)]),
  ordering: z.enum(["popular", "balanced", "festival"]),
});
const UpdateLineupSchema = z.object({ artists: z.array(ArtistSchema).max(300).optional(), selection: SelectionSchema.optional() });
const PlaylistSchema = z.object({
  lineupId: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(300),
  isPublic: z.boolean(),
  artists: z
    .array(z.object({ name: z.string().min(1).max(120), spotifyId: z.string().max(64).nullable(), order: z.number().int(), tier: Tier }))
    .min(1)
    .max(150),
  tracksPerArtist: z.union([z.literal(3), z.literal(5), z.literal(10)]),
  ordering: z.enum(["popular", "balanced", "festival"]),
});

function body<T>(event: Event, schema: z.ZodType<T>): T {
  let raw: unknown = {};
  try {
    const text = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Requisição inválida.");
  return parsed.data;
}

const allowedOrigins = () => env("ALLOWED_ORIGINS").split(",");
const callbackUri = (event: Event) => `https://${event.requestContext.domainName}/spotify/callback`;

async function spotifyReady(): Promise<boolean> {
  try {
    return isConfigured(await spotifySecret());
  } catch (e) {
    log.error("could not read spotify secret", e);
    return false;
  }
}

// ---------- lineups ----------

const createLineup: Handler = async (event, sub) => {
  const id = newId();
  const base: Lineup = {
    id,
    status: "WAITING_UPLOAD",
    stage: null,
    error: null,
    createdAt: new Date().toISOString(),
    festival: null,
    edition: null,
    days: [],
    artists: [],
    resolved: {},
    selection: null,
  };

  const key = `uploads/${sub}/${id}.jpg`;
  await putLineup(sub, base, key);
  const upload = await createPresignedPost(s3, {
    Bucket: env("UPLOAD_BUCKET"),
    Key: key,
    Conditions: [["content-length-range", 1, MAX_UPLOAD_BYTES], ["eq", "$Content-Type", "image/jpeg"]],
    Fields: { "Content-Type": "image/jpeg" },
    Expires: 300,
  });
  metric("UploadsRequested", 1);
  return json(201, { lineup: base, upload } satisfies CreateLineupResponse);
};

const listUserLineups: Handler = async (_event, sub) => json(200, { lineups: await listLineups(sub) });

const getUserLineup: Handler = async (event, sub) => {
  const lineup = await getLineup(sub, event.pathParameters!.id!);
  if (!lineup) return error(404, "Line-up não encontrado.");
  const { s3Key: _k, ...rest } = lineup;
  return json(200, rest);
};

const saveLineup: Handler = async (event, sub) => {
  const id = event.pathParameters!.id!;
  const patch = body(event, UpdateLineupSchema);
  const current = await getLineup(sub, id);
  if (!current) return error(404, "Line-up não encontrado.");
  if (current.status !== "READY") return error(409, "O line-up ainda está sendo processado.");

  const update: Partial<Lineup> = {};
  if (patch.selection) update.selection = patch.selection;
  if (patch.artists) {
    const before = new Map(current.artists.map((a) => [a.id, a.name]));
    const keep = new Set(patch.artists.map((a) => a.id));
    const resolved = Object.fromEntries(Object.entries(current.resolved).filter(([id]) => keep.has(id)));
    // Only look up artists that are new or were renamed.
    const changed = patch.artists.filter((a) => before.get(a.id) !== a.name);
    for (const a of changed) delete resolved[a.id];
    if (changed.length > 0 && (await spotifyReady())) {
      Object.assign(resolved, await resolveArtists(changed).catch(() => ({})));
    }
    update.artists = patch.artists;
    update.resolved = resolved;
  }
  await updateLineup(sub, id, update);
  const { s3Key: _k, ...rest } = { ...current, ...update };
  return json(200, rest);
};

// ---------- spotify ----------

const spotifyStatus: Handler = async (_event, sub) => {
  const configured = await spotifyReady();
  const conn = configured ? await getSpotifyConnection(sub) : null;
  return json(200, { configured, connected: Boolean(conn), user: conn ? { name: conn.displayName ?? "Spotify" } : null } satisfies SpotifyStatus);
};

const spotifyAuthorize: Handler = async (event, sub) => {
  const { returnTo } = body(event, z.object({ returnTo: z.string().url() }));
  const origin = new URL(returnTo).origin;
  if (!allowedOrigins().includes(origin)) return error(400, "Origem não permitida.");
  const secret = await spotifySecret();
  if (!isConfigured(secret)) return error(503, "O Spotify ainda não foi configurado no Secrets Manager.");
  const { verifier, challenge, state } = pkce();
  await putOAuthState(state, { sub, sealedVerifier: seal(verifier, secret.tokenKey), returnTo: origin });
  return json(200, { url: authorizeUrl(secret, callbackUri(event), state, challenge) });
};

/** Public route: Spotify redirects the browser here after the consent screen. */
async function spotifyCallback(event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {};
  const fallback = allowedOrigins()[0];
  const pending = q.state ? await takeOAuthState(q.state) : null;
  if (!pending) return redirect(`${fallback}/?spotify=error`);
  if (q.error || !q.code) return redirect(`${pending.returnTo}/?spotify=denied`);
  try {
    const secret = await spotifySecret();
    const verifier = unseal<string>(pending.sealedVerifier, secret.tokenKey);
    if (!verifier) return redirect(`${pending.returnTo}/?spotify=error`);
    await connectUser(pending.sub, q.code, verifier, callbackUri(event));
    metric("SpotifyConnections", 1);
    return redirect(`${pending.returnTo}/?spotify=connected`);
  } catch (e) {
    log.error("spotify callback failed", e);
    return redirect(`${pending.returnTo}/?spotify=error`);
  }
}

const spotifyDisconnect: Handler = async (_event, sub) => {
  await deleteSpotifyConnection(sub);
  return json(200, { ok: true });
};

// ---------- playlists ----------

const createPlaylistJob: Handler = async (event, sub) => {
  const request = body(event, PlaylistSchema);
  if (!(await getLineup(sub, request.lineupId))) return error(404, "Line-up não encontrado.");
  if (!(await getSpotifyConnection(sub))) return error(409, "Conecte sua conta do Spotify primeiro.");

  const job: PlaylistJob = {
    id: newId(),
    status: "QUEUED",
    progress: { done: 0, total: request.artists.length },
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  await putJob(sub, job, request);
  await lambda.send(
    new InvokeCommand({
      FunctionName: env("PLAYLIST_WORKER_ARN"),
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ sub, jobId: job.id })),
    }),
  );
  return json(202, job);
};

const listPlaylists: Handler = async (_event, sub) => json(200, { playlists: await listJobs(sub) });

const getPlaylistJob: Handler = async (event, sub) => {
  const job = await getJob(sub, event.pathParameters!.id!);
  if (!job) return error(404, "Playlist não encontrada.");
  const { request: _r, ...rest } = job;
  return json(200, rest);
};

// ---------- router ----------

const routes: Record<string, Handler> = {
  "POST /lineups": createLineup,
  "GET /lineups": listUserLineups,
  "GET /lineups/{id}": getUserLineup,
  "PUT /lineups/{id}": saveLineup,
  "GET /spotify/status": spotifyStatus,
  "POST /spotify/authorize": spotifyAuthorize,
  "DELETE /spotify/connection": spotifyDisconnect,
  "POST /playlists": createPlaylistJob,
  "GET /playlists": listPlaylists,
  "GET /playlists/{id}": getPlaylistJob,
};

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  const route = event.routeKey;
  try {
    if (route === "GET /health") return json(200, { ok: true });
    if (route === "GET /spotify/callback") return await spotifyCallback(event);

    const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (typeof sub !== "string") return error(401, "Não autenticado.");
    const fn = routes[route];
    if (!fn) return error(404, "Rota não encontrada.");
    return await fn(event, sub);
  } catch (e) {
    if (e instanceof HttpError) return error(e.statusCode, e.message);
    log.error("unhandled api error", e, { route });
    return error(500, "Erro interno.");
  }
}
