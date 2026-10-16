// Shared by the Next.js front-end and the Lambda back-end (backend/ imports this file).

export type Tier = "headliner" | "main" | "undercard";

export interface LineupArtist {
  id: string;
  name: string;
  day: string | null;
  genre: string | null;
  tier: Tier;
  /** Position on the poster, top to bottom; used for "ordem do cartaz". */
  order: number;
}

export interface ResolvedArtist {
  lineupId: string;
  spotifyId: string | null;
  spotifyName: string | null;
  imageUrl: string | null;
  genres: string[];
  match: "exact" | "close" | "none";
}

export type Preference = "none" | "favorite" | "discover";
export type PlaylistMode = "full" | "selection" | "day" | "discover";
export type Ordering = "popular" | "balanced" | "festival";

export interface Selection {
  selected: string[];
  prefs: Record<string, Preference>;
  mode: PlaylistMode;
  modeDay: string | null;
  tracksPerArtist: 3 | 5 | 10;
  ordering: Ordering;
}

export type LineupStatus = "WAITING_UPLOAD" | "PROCESSING" | "READY" | "FAILED";
export type LineupStage = "ocr" | "extracting" | "matching" | null;

export interface Lineup {
  id: string;
  status: LineupStatus;
  stage: LineupStage;
  error: string | null;
  createdAt: string;
  festival: string | null;
  edition: string | null;
  days: string[];
  artists: LineupArtist[];
  resolved: Record<string, ResolvedArtist>;
  selection: Selection | null;
}

export interface LineupSummary {
  id: string;
  status: LineupStatus;
  festival: string | null;
  edition: string | null;
  artistCount: number;
  createdAt: string;
}

export interface CreateLineupResponse {
  lineup: Lineup;
  upload: { url: string; fields: Record<string, string> };
}

export interface PlaylistArtistInput {
  name: string;
  spotifyId: string | null;
  order: number;
  tier: Tier;
}

export interface PlaylistRequest {
  lineupId: string;
  name: string;
  description: string;
  isPublic: boolean;
  artists: PlaylistArtistInput[];
  tracksPerArtist: 3 | 5 | 10;
  ordering: Ordering;
}

export interface PlaylistTrack {
  uri: string;
  title: string;
  artist: string;
}

export interface PlaylistResult {
  playlistName: string;
  playlistUrl: string;
  artistsRequested: number;
  artistsWithTracks: number;
  tracksAdded: number;
  shortfalls: { name: string; found: number; wanted: number }[];
  tracks: PlaylistTrack[];
}

export type PlaylistJobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface PlaylistJob {
  id: string;
  status: PlaylistJobStatus;
  progress: { done: number; total: number };
  result: PlaylistResult | null;
  error: string | null;
  createdAt: string;
}

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  user: { name: string } | null;
}

export interface AppConfig {
  region: string;
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
}
