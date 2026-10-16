import type { LineupArtist, Tier } from "../../../lib/types";

// Fictional festival with real artists: lets people try the flow without a poster.
const RAW: [string, string, string, Tier][] = [
  ["Sexta", "Charli xcx", "pop", "headliner"],
  ["Sexta", "Tame Impala", "alternativo", "headliner"],
  ["Sexta", "Kaytranada", "eletrônico", "main"],
  ["Sexta", "Marina Sena", "mpb", "main"],
  ["Sexta", "Wet Leg", "indie", "main"],
  ["Sexta", "Jadsa", "mpb", "undercard"],
  ["Sexta", "Fred again..", "eletrônico", "undercard"],
  ["Sexta", "Boogarins", "rock", "undercard"],
  ["Sábado", "Tyler, The Creator", "rap", "headliner"],
  ["Sábado", "Olivia Rodrigo", "pop", "headliner"],
  ["Sábado", "Anitta", "funk", "main"],
  ["Sábado", "Fontaines D.C.", "rock", "main"],
  ["Sábado", "Barry Can't Swim", "eletrônico", "main"],
  ["Sábado", "Tasha & Tracie", "rap", "undercard"],
  ["Sábado", "Japanese Breakfast", "indie", "undercard"],
  ["Sábado", "Teto Preto", "eletrônico", "undercard"],
  ["Domingo", "SZA", "r&b", "headliner"],
  ["Domingo", "The Strokes", "rock", "headliner"],
  ["Domingo", "Liniker", "mpb", "main"],
  ["Domingo", "Peggy Gou", "eletrônico", "main"],
  ["Domingo", "Mitski", "indie", "main"],
  ["Domingo", "BK'", "rap", "undercard"],
  ["Domingo", "Clairo", "indie", "undercard"],
  ["Domingo", "Black Pantera", "metal", "undercard"],
];

export const DEMO = {
  festival: "Festival Maré Alta",
  edition: "2027",
  days: ["Sexta", "Sábado", "Domingo"],
  artists: RAW.map(([day, name, genre, tier], i): LineupArtist => ({ id: `a${i}`, name, day, genre, tier, order: i })),
};
