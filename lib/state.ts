import type { Lineup, LineupArtist, Ordering, PlaylistJob, PlaylistMode, Preference, Selection } from "./types";

export interface AppState {
  step: 1 | 2 | 3;
  lineup: Lineup | null;
  selected: string[];
  prefs: Record<string, Preference>;
  mode: PlaylistMode;
  modeDay: string | null;
  tracksPerArtist: 3 | 5 | 10;
  ordering: Ordering;
  playlistName: string;
  isPublic: boolean;
  job: PlaylistJob | null;
}

export const initialState: AppState = {
  step: 1,
  lineup: null,
  selected: [],
  prefs: {},
  mode: "full",
  modeDay: null,
  tracksPerArtist: 5,
  ordering: "balanced",
  playlistName: "",
  isPublic: false,
  job: null,
};

/** Opens a READY line-up, restoring the selection saved on the server if any. */
export function stateForLineup(lineup: Lineup): AppState {
  const s = lineup.selection;
  return {
    ...initialState,
    step: 2,
    lineup,
    selected: s?.selected ?? lineup.artists.map((a) => a.id),
    prefs: s?.prefs ?? {},
    mode: s?.mode ?? "full",
    modeDay: s?.modeDay ?? lineup.days[0] ?? null,
    tracksPerArtist: s?.tracksPerArtist ?? 5,
    ordering: s?.ordering ?? "balanced",
    playlistName: defaultPlaylistName(lineup),
  };
}

export function selectionOf(state: AppState): Selection {
  const { selected, prefs, mode, modeDay, tracksPerArtist, ordering } = state;
  return { selected, prefs, mode, modeDay, tracksPerArtist, ordering };
}

// Survives the round trip through Spotify's and Cognito's pages.
const KEY = "fpg_state_v2";

export function loadState(): AppState | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...initialState, ...(JSON.parse(raw) as AppState) } : null;
  } catch {
    return null;
  }
}

export function saveState(state: AppState): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: the flow still works, it just won't survive a reload */
  }
}

export function clearState(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export function includedArtists(state: AppState): LineupArtist[] {
  const artists = state.lineup?.artists ?? [];
  switch (state.mode) {
    case "full":
      return artists;
    case "selection":
      return artists.filter((a) => state.selected.includes(a.id));
    case "day":
      return artists.filter((a) => a.day !== null && a.day === state.modeDay);
    case "discover":
      return artists.filter((a) => state.prefs[a.id] === "discover");
  }
}

export function genreOf(artist: LineupArtist, lineup: Lineup | null): string | null {
  return artist.genre ?? lineup?.resolved[artist.id]?.genres[0] ?? null;
}

export function defaultPlaylistName(lineup: Lineup | null): string {
  const fest = [lineup?.festival, lineup?.edition].filter(Boolean).join(" ");
  return fest ? `${fest} — Minha preparação` : "Meu festival — Minha preparação";
}
