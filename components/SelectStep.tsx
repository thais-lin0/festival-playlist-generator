"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { genreOf, includedArtists, type AppState } from "@/lib/state";
import type { Lineup, LineupArtist, Ordering, PlaylistMode, Preference, ResolvedArtist } from "@/lib/types";

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

type View = "cards" | "list";
const VIEW_KEY = "fpg_view";

interface Props {
  state: AppState;
  update: (patch: Partial<AppState>) => void;
  onNext: () => void;
}

export function SelectStep({ state, update, onNext }: Props) {
  const lineup = state.lineup!;
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [view, setView] = useState<View>("cards");

  // Remember the preferred view on this device.
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "list") setView("list");
    } catch {}
  }, []);
  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

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
      (!query || a.name.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const groupByDay = lineup.days.length > 1 && !effectiveDay;
  const groups: [string | null, LineupArtist[]][] = groupByDay
    ? [...lineup.days.map((d) => [d, visible.filter((a) => a.day === d)] as [string, LineupArtist[]]), [null, visible.filter((a) => !a.day)]]
    : [[null, visible]];
  const filtersActive = Boolean(dayFilter || genreFilter || query);

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
    const { [id]: _gone, ...prefs } = state.prefs;
    saveArtists(
      lineup.artists.filter((a) => a.id !== id),
      { selected: state.selected.filter((x) => x !== id), prefs },
    );
  }

  function addArtist() {
    const name = newName.trim();
    if (!name) return;
    const order = Math.max(-1, ...lineup.artists.map((a) => a.order)) + 1;
    const artist: LineupArtist = { id: `m${Date.now()}`, name, day: effectiveDay ?? null, genre: null, tier: "undercard", order };
    saveArtists([...lineup.artists, artist], { selected: [...state.selected, artist.id] });
    setNewName("");
  }

  const discoverCount = Object.values(state.prefs).filter((p) => p === "discover").length;
  const estimate = included.length * state.tracksPerArtist;

  const itemProps = (a: LineupArtist) => ({
    artist: a,
    resolved: lineup.resolved[a.id],
    genre: genreOf(a, lineup),
    isIn: includedIds.has(a.id),
    pref: state.prefs[a.id] ?? "none",
    editing: editing === a.id,
    onToggle: () => toggle(a.id),
    onPref: (p: Preference) => setPref(a.id, p),
    onEdit: () => setEditing(a.id),
    onRename: (name: string) => rename(a.id, name),
    onCancelEdit: () => setEditing(null),
    onRemove: () => remove(a.id),
  });

  return (
    <>
      <section className="fest-head">
        <h2 className="display misreg reveal">{lineup.festival ?? "Seu festival"}</h2>
        <div className="meta reveal" style={{ ["--i" as string]: 1 }}>
          {lineup.edition && <div>Edição {lineup.edition}</div>}
          <div>{lineup.artists.length} artistas identificados</div>
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
        <input className="search" type="search" placeholder="Buscar artista…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar artista" />
      </div>

      <div className="bulk mono">
        <span>
          {visible.length} de {lineup.artists.length}
        </span>
        <button className="linkish" onClick={() => selectVisible(true)}>marcar visíveis</button>
        <button className="linkish" onClick={() => selectVisible(false)}>desmarcar visíveis</button>
        {filtersActive && (
          <button
            className="linkish"
            onClick={() => {
              setDayFilter(null);
              setGenreFilter(null);
              setQuery("");
            }}
          >
            limpar filtros
          </button>
        )}
        {state.mode === "discover" && discoverCount === 0 && <span className="hint-warn">Marque artistas com ✦ quero conhecer</span>}
        <div className="view-toggle" role="group" aria-label="Exibição">
          <button aria-pressed={view === "cards"} onClick={() => changeView("cards")}>▦ Fotos</button>
          <button aria-pressed={view === "list"} onClick={() => changeView("list")}>☰ Lista</button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty">Nenhum artista com esses filtros.</div>
      ) : (
        <div className={view === "cards" ? "grid" : "list"}>
          {groups.map(([day, artists]) =>
            artists.length === 0 ? null : (
              <Group key={day ?? "none"} day={groupByDay ? day ?? "Sem dia definido" : null} count={artists.length}>
                {artists.map((a, i) =>
                  view === "cards" ? <ArtistCard key={a.id} index={i} {...itemProps(a)} /> : <ArtistRow key={a.id} {...itemProps(a)} />,
                )}
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
        <button className="btn alt small" onClick={addArtist} disabled={!newName.trim()}>
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

// ---------- artist views ----------

interface ItemProps {
  artist: LineupArtist;
  resolved: ResolvedArtist | undefined;
  genre: string | null;
  isIn: boolean;
  pref: Preference;
  editing: boolean;
  onToggle: () => void;
  onPref: (p: Preference) => void;
  onEdit: () => void;
  onRename: (name: string) => void;
  onCancelEdit: () => void;
  onRemove: () => void;
}

function NameField({ artist, editing, onRename, onCancelEdit, className }: ItemProps & { className: string }) {
  if (!editing) return <div className={className}>{artist.name}</div>;
  return (
    <input
      className="name-input"
      defaultValue={artist.name}
      autoFocus
      aria-label={`Corrigir nome de ${artist.name}`}
      onBlur={(e) => onRename(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          // Restore the original so the blur that follows saves nothing.
          e.currentTarget.value = artist.name;
          onCancelEdit();
        }
      }}
    />
  );
}

function matchLabel(r: ResolvedArtist | undefined): string | null {
  if (!r) return null;
  return r.match === "exact" ? "no spotify" : r.match === "close" ? "nome aproximado" : "não encontrado";
}

function Actions({ artist, pref, onPref, onEdit, onRemove, compact }: ItemProps & { compact?: boolean }) {
  return (
    <>
      <button className="pref fav" aria-pressed={pref === "favorite"} onClick={() => onPref("favorite")} title="Favorito">
        ♥{compact ? "" : " favorito"}
      </button>
      <button className="pref disc" aria-pressed={pref === "discover"} onClick={() => onPref("discover")} title="Quero conhecer">
        ✦{compact ? "" : " quero conhecer"}
      </button>
      <button className="icon-btn" title="Corrigir nome" aria-label={`Corrigir nome de ${artist.name}`} onClick={onEdit}>
        ✎
      </button>
      <button className="icon-btn" title="Remover" aria-label={`Remover ${artist.name}`} onClick={onRemove}>
        ✕
      </button>
    </>
  );
}

function ArtistCard(props: ItemProps & { index: number }) {
  const { artist: a, resolved: r, genre, isIn, onToggle, index } = props;
  return (
    <article className={`card ${a.tier} ${isIn ? "in" : ""} reveal`} style={{ ["--i" as string]: Math.min(index, 12) }}>
      <button className="art" onClick={onToggle} aria-pressed={isIn} aria-label={`${isIn ? "Tirar" : "Incluir"} ${a.name}`}>
        {r?.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <div className="initials">{initials(a.name)}</div>}
        <span className="pick">{isIn ? "✓" : "+"}</span>
        {matchLabel(r) && <span className="match">{matchLabel(r)}</span>}
      </button>
      <div className="body">
        <NameField {...props} className="name" />
        <div className="sub">
          {a.day && <span>{a.day}</span>}
          {genre && <span>· {genre}</span>}
          {r?.match === "close" && r.spotifyName && <span>· = {r.spotifyName}</span>}
        </div>
        <div className="row">
          <Actions {...props} />
        </div>
      </div>
    </article>
  );
}

function ArtistRow(props: ItemProps) {
  const { artist: a, resolved: r, genre, isIn, onToggle } = props;
  return (
    <div className={`list-row ${a.tier} ${isIn ? "in" : ""}`}>
      <button className="list-check" onClick={onToggle} aria-pressed={isIn} aria-label={`${isIn ? "Tirar" : "Incluir"} ${a.name}`}>
        {isIn ? "✓" : ""}
      </button>
      <div className="list-main" onClick={props.editing ? undefined : onToggle}>
        <NameField {...props} className="list-name" />
        <div className="list-sub mono">
          {[a.day, genre, r?.match === "close" && r.spotifyName ? `= ${r.spotifyName}` : null, r?.match === "none" ? "não encontrado" : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="list-actions">
        <Actions {...props} compact />
      </div>
    </div>
  );
}

function Group({ day, count, children }: { day: string | null; count: number; children: React.ReactNode }) {
  return (
    <>
      {day && (
        <div className="daybreak">
          <h3 className="display misreg">{day}</h3>
          <span className="mono">{count}</span>
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
