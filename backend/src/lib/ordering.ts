import type { Ordering, Tier, PlaylistArtistInput, PlaylistTrack } from "../../../lib/types";

const TIER_RANK: Record<Tier, number> = { headliner: 0, main: 1, undercard: 2 };

/**
 * popular  — artist by artist (headliners first), each artist's tracks in search-relevance order
 * balanced — round-robin, so no single artist owns the start of the playlist
 * festival — artist by artist, in poster order
 */
export function arrange(artists: PlaylistArtistInput[], perArtist: PlaylistTrack[][], ordering: Ordering): PlaylistTrack[] {
  const groups = artists.map((a, i) => ({ order: a.order, rank: TIER_RANK[a.tier], tracks: perArtist[i] ?? [] }));
  if (ordering === "balanced") {
    const out: PlaylistTrack[] = [];
    const longest = Math.max(0, ...groups.map((g) => g.tracks.length));
    for (let round = 0; round < longest; round++) {
      for (const g of groups) if (g.tracks[round]) out.push(g.tracks[round]);
    }
    return dedupe(out);
  }
  const sorted = [...groups].sort((a, b) => (ordering === "popular" ? a.rank - b.rank : 0) || a.order - b.order);
  return dedupe(sorted.flatMap((g) => g.tracks));
}

function dedupe(tracks: PlaylistTrack[]): PlaylistTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => (seen.has(t.uri) ? false : (seen.add(t.uri), true)));
}
