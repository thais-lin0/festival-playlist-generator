import { getJob, updateJob } from "../lib/db";
import { log } from "../lib/log";
import { metric } from "../lib/metrics";
import { arrange } from "../lib/ordering";
import { addItems, collectForArtist, createPlaylist, mapLimited, SpotifyError, userAccessToken } from "../lib/spotify";
import type { PlaylistResult, PlaylistTrack } from "../../../lib/types";

interface Payload {
  sub: string;
  jobId: string;
}

/** Invoked asynchronously by the API: playlists with many artists outlast API Gateway's 30 s limit. */
export async function handler({ sub, jobId }: Payload): Promise<void> {
  const job = await getJob(sub, jobId);
  if (!job || job.status !== "QUEUED") {
    log.warn("job not queued; skipping", { jobId, status: job?.status });
    return;
  }
  const req = job.request;
  const started = Date.now();

  try {
    await updateJob(sub, jobId, { status: "RUNNING" });
    const token = await userAccessToken(sub);
    if (!token) throw new SpotifyError(401, "Sua conexão com o Spotify expirou. Conecte novamente.");

    let done = 0;
    let lastWrite = 0;
    const perArtist: PlaylistTrack[][] = await mapLimited(req.artists, 4, async (artist) => {
      const tracks = await collectForArtist(token, artist, req.tracksPerArtist).catch((e) => {
        if (e instanceof SpotifyError && e.status === 401) throw e;
        log.warn("artist lookup failed", { jobId, artist: artist.name, error: e instanceof Error ? e.message : String(e) });
        return [];
      });
      done++;
      if (Date.now() - lastWrite > 1500 || done === req.artists.length) {
        lastWrite = Date.now();
        await updateJob(sub, jobId, { progress: { done, total: req.artists.length } });
      }
      return tracks;
    });

    const tracks = arrange(req.artists, perArtist, req.ordering);
    if (tracks.length === 0) throw new SpotifyError(422, "Não encontramos músicas para os artistas selecionados.");

    const playlist = await createPlaylist(token, req.name, req.description, req.isPublic);
    await addItems(token, playlist.id, tracks.map((t) => t.uri));

    const result: PlaylistResult = {
      playlistName: req.name,
      playlistUrl: playlist.url,
      artistsRequested: req.artists.length,
      artistsWithTracks: perArtist.filter((t) => t.length > 0).length,
      tracksAdded: tracks.length,
      shortfalls: req.artists
        .map((a, i) => ({ name: a.name, found: perArtist[i].length, wanted: req.tracksPerArtist }))
        .filter((s) => s.found < s.wanted),
      tracks,
    };
    await updateJob(sub, jobId, { status: "DONE", result, progress: { done: req.artists.length, total: req.artists.length } });

    metric("PlaylistsCreated", 1);
    metric("TracksAdded", tracks.length);
    metric("PlaylistGenerationTime", Date.now() - started, "Milliseconds");
    log.info("playlist created", { jobId, tracks: tracks.length, artists: req.artists.length, ms: Date.now() - started });
  } catch (e) {
    log.error("playlist job failed", e, { jobId });
    metric("PlaylistFailures", 1);
    await updateJob(sub, jobId, {
      status: "FAILED",
      error: e instanceof SpotifyError ? e.message : "Falha ao criar a playlist.",
    });
  }
}
