import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Lineup, LineupSummary, PlaylistJob, PlaylistRequest } from "../../../lib/types";
import { env } from "./env";

// Single-table design:
//   USER#<sub>   LINEUP#<id>   uploaded poster + extracted artists + saved selection
//   USER#<sub>   JOB#<id>      playlist generation job
//   USER#<sub>   SPOTIFY       encrypted Spotify tokens for this user
//   OAUTH#<state> OAUTH        pending Spotify authorization (expires via TTL)
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const table = () => env("TABLE_NAME");
const user = (sub: string) => `USER#${sub}`;

/** Time-sortable id, so SK order is creation order. */
export function newId(): string {
  return Date.now().toString(36).padStart(9, "0") + randomBytes(5).toString("hex");
}

const ttlIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

// ---------- Lineups ----------

export async function putLineup(sub: string, lineup: Lineup, s3Key: string | null): Promise<void> {
  await doc.send(new PutCommand({ TableName: table(), Item: { PK: user(sub), SK: `LINEUP#${lineup.id}`, entity: "lineup", s3Key, ...lineup } }));
}

export async function getLineup(sub: string, id: string): Promise<(Lineup & { s3Key: string | null }) | null> {
  const out = await doc.send(new GetCommand({ TableName: table(), Key: { PK: user(sub), SK: `LINEUP#${id}` } }));
  if (!out.Item) return null;
  const { PK: _pk, SK: _sk, entity: _e, ...lineup } = out.Item;
  return lineup as Lineup & { s3Key: string | null };
}

export async function updateLineup(sub: string, id: string, patch: Partial<Lineup>): Promise<void> {
  await update({ PK: user(sub), SK: `LINEUP#${id}` }, patch);
}

export async function listLineups(sub: string, limit = 20): Promise<LineupSummary[]> {
  const out = await doc.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": user(sub), ":sk": "LINEUP#" },
      ProjectionExpression: "id, #s, festival, edition, artists, createdAt",
      ExpressionAttributeNames: { "#s": "status" },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => ({
    id: i.id,
    status: i.status,
    festival: i.festival ?? null,
    edition: i.edition ?? null,
    artistCount: (i.artists ?? []).length,
    createdAt: i.createdAt,
  }));
}

// ---------- Playlist jobs ----------

export async function putJob(sub: string, job: PlaylistJob, request: PlaylistRequest): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: table(), Item: { PK: user(sub), SK: `JOB#${job.id}`, entity: "job", request, ttl: ttlIn(90 * 86400), ...job } }),
  );
}

export async function getJob(sub: string, id: string): Promise<(PlaylistJob & { request: PlaylistRequest }) | null> {
  const out = await doc.send(new GetCommand({ TableName: table(), Key: { PK: user(sub), SK: `JOB#${id}` } }));
  if (!out.Item) return null;
  const { PK: _pk, SK: _sk, entity: _e, ttl: _t, ...job } = out.Item;
  return job as PlaylistJob & { request: PlaylistRequest };
}

export async function updateJob(sub: string, id: string, patch: Partial<PlaylistJob>): Promise<void> {
  await update({ PK: user(sub), SK: `JOB#${id}` }, patch);
}

// ---------- Spotify connection ----------

export interface SpotifyConnectionItem {
  sealedTokens: string;
  displayName: string | null;
  connectedAt: string;
}

export async function getSpotifyConnection(sub: string): Promise<SpotifyConnectionItem | null> {
  const out = await doc.send(new GetCommand({ TableName: table(), Key: { PK: user(sub), SK: "SPOTIFY" } }));
  return (out.Item as SpotifyConnectionItem | undefined) ?? null;
}

export async function putSpotifyConnection(sub: string, item: SpotifyConnectionItem): Promise<void> {
  await doc.send(new PutCommand({ TableName: table(), Item: { PK: user(sub), SK: "SPOTIFY", entity: "spotify", ...item } }));
}

export async function deleteSpotifyConnection(sub: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: table(), Key: { PK: user(sub), SK: "SPOTIFY" } }));
}

// ---------- OAuth state (one-time use) ----------

export interface OAuthStateItem {
  sub: string;
  sealedVerifier: string;
  returnTo: string;
}

export async function putOAuthState(state: string, item: OAuthStateItem): Promise<void> {
  await doc.send(new PutCommand({ TableName: table(), Item: { PK: `OAUTH#${state}`, SK: "OAUTH", entity: "oauth", ttl: ttlIn(600), ...item } }));
}

/** Deletes and returns the state atomically, so a callback can't be replayed. */
export async function takeOAuthState(state: string): Promise<OAuthStateItem | null> {
  const out = await doc.send(
    new DeleteCommand({ TableName: table(), Key: { PK: `OAUTH#${state}`, SK: "OAUTH" }, ReturnValues: "ALL_OLD" }),
  );
  const item = out.Attributes;
  if (!item || (typeof item.ttl === "number" && item.ttl < Date.now() / 1000)) return null;
  return item as OAuthStateItem;
}

// ---------- helpers ----------

async function update(key: Record<string, string>, patch: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  await doc.send(
    new UpdateCommand({
      TableName: table(),
      Key: key,
      UpdateExpression: "SET " + entries.map((_, i) => `#k${i} = :v${i}`).join(", "),
      ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}
