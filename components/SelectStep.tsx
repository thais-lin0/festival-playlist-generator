"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { genreOf, includedArtists, type AppState } from "@/lib/state";
import type { Lineup, LineupArtist, Ordering, PlaylistMode, Preference } from "@/lib/types";

const MODES: { id: PlaylistMode; k: string; title: string; hint: string }[] = [
  { id: "full", k: "A", title: "Line-up completo", hint: "Todos os artistas do cartaz" },
  { id: "selection", k: "B", title: "Minha seleção", hint: "Só quem você marcar" },
  { id: "day", k: "C", title: "Por dia", hint: "Os artistas de um dia" },
  { id: "discover", k: "D", title: "Descobrir", hint: "Quem você quer conhecer" },
];

const ORDERINGS: { id: Ordering; label: string }[] = [
  { id: "popular", label: "Destaques primeiro" },
  { id: "balanced", label: "Mix equilibrado" },
  { id: "festival", label: "Ordem do cartaz" },
];

interface Props {
  state: AppState;
  update: (patch: Partial<AppState>) => void;
  onNext: () => void;
  onBack: () => void;
}

export function SelectStep({ state, update, onNext, onBack }: Props) {
  const lineup = state.lineup!;
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const included = includedArtists(state);
  const includedIds = new Set(included.map((a) => a.id));

  const genres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of lineup.artists) {
      const g = genreOf(a, lineup);
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  }, [lineup]);

  const effectiveDay = state.mode === "day" ? state.modeDay : dayFilter;
  const visible = lineup.artists.filter(
    (a) =>
      (!effectiveDay || a.day === effectiveDay) &&
      (!genreFilter || genreOf(a, lineup) === genreFilter) &&
      (!query || a.name.toLowerCase().includes(query.toLowerCase())),
  );

  const groupByDay = lineup.days.length > 1 && !effectiveDay;
  const groups: [string | null, LineupArtist[]][] = groupByDay
    ? [...lineup.days.map((d) => [d, visible.filter((a) => a.day === d)] as [string, LineupArtist[]]), [null, visible.filter((a) => !a.day)]]
    : [[null, visible]];

  function toggle(id: string) {
    const base = state.mode === "selection" ? state.selected : [...includedIds];
    const selected = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    update({ mode: "selection", selected });
  }

  function setPref(id: string, pref: Preference) {
    update({ prefs: { ...state.prefs, [id]: state.prefs[id] === pref ? "none" : pref } });
  }

  function selectVisible(on: boolean) {
    const ids = new Set(state.mode === "selection" ? state.selected : [...includedIds]);
    for (const a of visible) on ? ids.add(a.id) : ids.delete(a.id);
    update({ mode: "selection", selected: [...ids] });
  }

  // Optimistic update, then take the server's copy (it re-matches renamed/new artists on Spotify).
  function saveArtists(artists: LineupArtist[], patch: Partial<AppState> = {}) {
    update({ ...patch, lineup: { ...lineup, artists } });
    setSaveError(null);
    api<Lineup>(`/lineups/${lineup.id}`, { method: "PUT", body: JSON.stringify({ artists }) })
      .then((saved) => update({ lineup: saved }))
      .catch(() => setSaveError("Não foi possível salvar a alteração. Tente de novo."));
  }

  function rename(id: string, name: string) {
    const clean = name.trim();
    setEditing(null);
    if (!clean || clean === lineup.artists.find((a) => a.id === id)?.name) return;
    saveArtists(lineup.artists.map((a) => (a.id === id ? { ...a, name: clean } : a)));
  }

  function remove(id: string) {
    saveArtists(lineup.artists.filter((a) => a.id !== id), { selected: state.selected.filter((x) => x !== id) });
  }

  function addArtist() {
    const name = newName.trim();
    if (!name) return;
    const order = Math.max(-1, ...lineup.artists.map((a) => a.order)) + 1;
    const artist: LineupArtist = { id: `m${Date.now()}`, name, day: dayFilter ?? null, genre: null, tier: "undercard", order };
    saveArtists([...lineup.artists, artist], { selected: [...state.selected, artist.id] });
    setNewName("");
  }

  const discoverCount = Object.values(state.prefs).filter((p) => p === "discover").length;
  const estimate = included.length * state.tracksPerArtist;

  return (
    <>
      <section className="fest-head">
        <h2 className="display misreg reveal">{lineup.festival ?? "Seu festival"}</h2>
        <div className="meta reveal" style={{ ["--i" as string]: 1 }}>
          {lineup.edition && <div>Edição {lineup.edition}</div>}
          <div>{lineup.artists.length} artistas identificados</div>
          {lineup.demo && <div style={{ color: "#b0135f" }}>Line-up de demonstração</div>}
          <button className="linkish" onClick={onBack}>← enviar outro cartaz</button>
        </div>
      </section>

      <div className="modes reveal" style={{ ["--i" as string]: 2 }} role="group" aria-label="Tipo de playlist">
        {MODES.map((m) => (
          <button key={m.id} className="mode" aria-pressed={state.mode === m.id} onClick={() => update({ mode: m.id })}>
            <span className="k">{m.k}</span>
            <b>{m.title}</b>
            <span>{m.id === "discover" ? `${discoverCount} marcados com ✦` : m.hint}</span>
          </button>
        ))}
      </div>

      <div className="filters reveal" style={{ ["--i" as string]: 3 }}>
        {lineup.days.length > 0 && (
          <div className="filter-group">
            <span className="label">Dia</span>
            {state.mode !== "day" && (
              <button className="chip day" aria-pressed={dayFilter === null} onClick={() => setDayFilter(null)}>
                Todos
              </button>
            )}
            {lineup.days.map((d) => (
              <button
                key={d}
                className="chip day"
                aria-pressed={effectiveDay === d}
                onClick={() => (state.mode === "day" ? update({ modeDay: d }) : setDayFilter(dayFilter === d ? null : d))}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        {genres.length > 0 && (
          <div className="filter-group">
            <span className="label">Gênero</span>
            {genres.slice(0, 10).map((g) => (
              <button key={g} className="chip" aria-pressed={genreFilter === g} onClick={() => setGenreFilter(genreFilter === g ? null : g)}>
                {g}
              </button>
            ))}
          </div>
        )}
        <input className="search" placeholder="Buscar artista…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar artista" />
      </div>

      <div className="bulk mono">
        <span>{visible.length} visíveis</span>
        <button className="linkish" onClick={() => selectVisible(true)}>marcar visíveis</button>
        <button className="linkish" onClick={() => selectVisible(false)}>desmarcar visíveis</button>
        {state.mode === "discover" && discoverCount === 0 && <span style={{ color: "#b0135f" }}>Marque artistas com ✦ quero conhecer</span>}
      </div>

      {visible.length === 0 ? (
        <div className="empty">Nenhum artista com esses filtros.</div>
      ) : (
        <div className="grid">
          {groups.map(([day, artists]) =>
            artists.length === 0 ? null : (
              <Group key={day ?? "none"} day={groupByDay ? day ?? "Sem dia definido" : null}>
                {artists.map((a, i) => {
                  const r = lineup.resolved[a.id];
                  const isIn = includedIds.has(a.id);
                  const pref = state.prefs[a.id] ?? "none";
                  return (
                    <article key={a.id} className={`card ${a.tier} ${isIn ? "in" : ""} reveal`} style={{ ["--i" as string]: Math.min(i, 12) }}>
                      <div className="art" onClick={() => toggle(a.id)} role="button" aria-pressed={isIn} aria-label={`Incluir ${a.name}`}>
                        {r?.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <div className="initials">{initials(a.name)}</div>}
                        <span className="pick">{isIn ? "✓" : "+"}</span>
                        {r && <span className="match">{r.match === "exact" ? "no spotify" : r.match === "close" ? "nome aproximado" : "não encontrado"}</span>}
                      </div>
                      <div className="body">
                        {editing === a.id ? (
                          <input
                            className="name-input"
                            defaultValue={a.name}
                            autoFocus
                            onBlur={(e) => rename(a.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") rename(a.id, e.currentTarget.value);
                              if (e.key === "Escape") setEditing(null);
                            }}
                          />
                        ) : (
                          <div className="name">{a.name}</div>
                        )}
                        <div className="sub">
                          {a.day && <span>{a.day}</span>}
                          {genreOf(a, lineup) && <span>· {genreOf(a, lineup)}</span>}
                          {r?.match === "close" && r.spotifyName && <span>· = {r.spotifyName}</span>}
                        </div>
                        <div className="row">
                          <button className="pref fav" aria-pressed={pref === "favorite"} onClick={() => setPref(a.id, "favorite")}>
                            ♥ favorito
                          </button>
                          <button className="pref disc" aria-pressed={pref === "discover"} onClick={() => setPref(a.id, "discover")}>
                            ✦ quero conhecer
                          </button>
                          <button className="icon-btn" title="Corrigir nome" onClick={() => setEditing(a.id)}>
                            ✎
                          </button>
                          <button className="icon-btn" style={{ marginLeft: 0 }} title="Remover" onClick={() => remove(a.id)}>
                            ✕
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </Group>
            ),
          )}
        </div>
      )}

      {saveError && <div className="error">{saveError}</div>}
      <div className="add-artist">
        <input
          className="search"
          placeholder="Faltou alguém? Adicione um artista"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addArtist()}
        />
        <button className="btn alt" style={{ fontSize: 16, padding: "8px 14px" }} onClick={addArtist}>
          + Adicionar
        </button>
      </div>

      <div className="dock" role="region" aria-label="Resumo da playlist">
        <div className="count">
          {included.length}
          <small>artistas · ~{estimate} músicas</small>
        </div>
        <div className="opts">
          <div className="opt">
            <span>Músicas por artista</span>
            <div className="seg">
              {([3, 5, 10] as const).map((n) => (
                <button key={n} aria-pressed={state.tracksPerArtist === n} onClick={() => update({ tracksPerArtist: n })}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="opt">
            <span>Ordem</span>
            <div className="seg">
              {ORDERINGS.map((o) => (
                <button key={o.id} aria-pressed={state.ordering === o.id} onClick={() => update({ ordering: o.id })}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button className="btn" disabled={included.length === 0} onClick={onNext}>
          Continuar →
        </button>
      </div>
    </>
  );
}

function Group({ day, children }: { day: string | null; children: React.ReactNode }) {
  return (
    <>
      {day && (
        <div className="daybreak">
          <h3 className="display misreg">{day}</h3>
          <hr />
        </div>
      )}
      {children}
    </>
  );
}

function initials(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
