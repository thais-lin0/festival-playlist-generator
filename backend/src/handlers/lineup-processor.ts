import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Event } from "aws-lambda";
import { getLineup, updateLineup } from "../lib/db";
import { interpretPoster, ocrLines } from "../lib/extract";
import { log } from "../lib/log";
import { metric } from "../lib/metrics";
import { isConfigured, spotifySecret } from "../lib/secrets";
import { resolveArtists } from "../lib/spotify";

const s3 = new S3Client({});
const KEY = /^uploads\/([^/]+)\/([^/]+)\.jpg$/;

/** S3 ObjectCreated on uploads/<sub>/<lineupId>.jpg → OCR → Bedrock → Spotify lookup → DynamoDB. */
export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const m = KEY.exec(key);
    if (!m) {
      log.warn("ignoring unexpected key", { key });
      continue;
    }
    await processOne(bucket, key, m[1], m[2]);
  }
}

async function processOne(bucket: string, key: string, sub: string, lineupId: string): Promise<void> {
  const started = Date.now();
  const lineup = await getLineup(sub, lineupId);
  if (!lineup || lineup.status !== "WAITING_UPLOAD") {
    log.warn("lineup not waiting for upload; skipping", { lineupId, status: lineup?.status });
    return;
  }

  try {
    await updateLineup(sub, lineupId, { status: "PROCESSING", stage: "ocr" });
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const image = await obj.Body!.transformToByteArray();

    const ocr = await ocrLines(image);
    await updateLineup(sub, lineupId, { stage: "extracting" });
    const poster = await interpretPoster(image, "image/jpeg", ocr);
    if (poster.artists.length === 0) throw new UserFacingError("Não encontramos artistas nesta imagem. Tente uma foto mais nítida do cartaz.");

    await updateLineup(sub, lineupId, { stage: "matching" });
    let resolved = {};
    try {
      if (isConfigured(await spotifySecret())) resolved = await resolveArtists(poster.artists);
    } catch (e) {
      log.error("spotify artist lookup failed; continuing without it", e, { lineupId });
    }

    await updateLineup(sub, lineupId, { ...poster, resolved, status: "READY", stage: null, error: null });
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

    metric("LineupsProcessed", 1);
    metric("ArtistsExtracted", poster.artists.length);
    metric("LineupProcessingTime", Date.now() - started, "Milliseconds");
    log.info("lineup ready", { lineupId, artists: poster.artists.length, ocrLines: ocr.length, ms: Date.now() - started });
  } catch (e) {
    log.error("lineup processing failed", e, { lineupId });
    metric("LineupFailures", 1);
    await updateLineup(sub, lineupId, {
      status: "FAILED",
      stage: null,
      error: e instanceof UserFacingError ? e.message : "Não foi possível ler o cartaz. Tente novamente com outra imagem.",
    });
  }
}

class UserFacingError extends Error {}
