"use client";

import { useEffect, useState } from "react";
import { api, AuthRequiredError } from "@/lib/api";
import type { Lineup, LineupSummary, PlaylistSummary } from "@/lib/types";

interface Props {
  onOpenLineup: (lineup: Lineup) => void;
  onLineupDeleted: (id: string) => void;
  onNewPoster: () => void;
  onAuthRequired: () => void;
}

const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
const formatDate = (iso: string) => dateFmt.format(new Date(iso)).replace(".", "");

export function HistoryPage({ onOpenLineup, onLineupDeleted, onNewPoster, onAuthRequired }: Props) {
  const [lineups, setLineups] = useState<LineupSummary[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // Inline confirmation: which line-up / playlist is asking "apagar?"
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    // Playlists are secondary: if that call fails, still show the line-ups.
    const playlistsCall = api<{ playlists: PlaylistSummary[] }>("/playlists").catch((e) => {
      if (e instanceof AuthRequiredError) throw e;
      return { playlists: [] };
    });
    Promise.all([api<{ lineups: LineupSummary[] }>("/lineups"), playlistsCall])
      .then(([l, p]) => {
        setLineups(l.lineups.filter((x) => x.status === "READY" || x.status === "FAILED"));
        setPlaylists(p.playlists.filter((x) => x.status === "DONE"));
      })
      .catch((e) => (e instanceof AuthRequiredError ? onAuthRequired() : setError("Não foi possível carregar seu histórico.")));
  }, [onAuthRequired]);

  async function open(id: string) {
    setOpening(id);
    try {
      onOpenLineup(await api<Lineup>(`/lineups/${id}`));
    } catch (e) {
      if (e instanceof AuthRequiredError) return onAuthRequired();
      setError("Não foi possível abrir este line-up.");
      setOpening(null);
    }
  }

  async function removeLineup(id: string) {
    setDeleting(id);
    setError(null);
    try {
      await api(`/lineups/${id}`, { method: "DELETE" });
      setLineups((ls) => (ls ?? []).filter((l) => l.id !== id));
      setPlaylists((ps) => ps.filter((p) => p.lineupId !== id));
      onLineupDeleted(id);
    } catch (e) {
      if (e instanceof AuthRequiredError) return onAuthRequired();
      setError("Não foi possível apagar este line-up.");
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
  }

  async function removePlaylist(id: string) {
    setDeleting(id);
    setError(null);
    try {
      await api(`/playlists/${id}`, { method: "DELETE" });
      setPlaylists((ps) => ps.filter((p) => p.id !== id));
    } catch (e) {
      if (e instanceof AuthRequiredError) return onAuthRequired();
      setError(e instanceof Error ? e.message : "Não foi possível remover esta playlist.");
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
  }

  const playlistItem = (p: PlaylistSummary) => (
    <li key={p.id} className={confirming === p.id ? "confirming" : ""}>
      <span className="pl-name">{p.playlistName}</span>
      <span className="mono pl-meta">
        {p.tracksAdded} músicas · {formatDate(p.createdAt)}
      </span>
      {confirming === p.id ? (
        <span className="pl-confirm mono">
          tirar do histórico? (continua no Spotify){" "}
          <button className="linkish danger" onClick={() => removePlaylist(p.id)} disabled={deleting !== null}>
            {deleting === p.id ? "removendo…" : "sim"}
          </button>{" "}
          · <button className="linkish" onClick={() => setConfirming(null)}>não</button>
        </span>
      ) : (
        <>
          {p.playlistUrl && (
            <a className="linkish" href={p.playlistUrl} target="_blank" rel="noreferrer">
              abrir no Spotify ↗
            </a>
          )}
          <button className="icon-btn" title="Tirar do histórico" aria-label={`Tirar ${p.playlistName} do histórico`} onClick={() => setConfirming(p.id)}>
            ✕
          </button>
        </>
      )}
    </li>
  );

  const byLineup = new Map<string, PlaylistSummary[]>();
  for (const p of playlists) byLineup.set(p.lineupId, [...(byLineup.get(p.lineupId) ?? []), p]);
  const knownIds = new Set((lineups ?? []).map((l) => l.id));
  const orphans = playlists.filter((p) => !knownIds.has(p.lineupId));
  const totalTracks = playlists.reduce((n, p) => n + p.tracksAdded, 0);

  return (
    <section className="history-page">
      <header className="history-head">
        <h2 className="display misreg reveal">Seu histórico</h2>
        <button className="btn reveal" style={{ ["--i" as string]: 1 }} onClick={onNewPoster}>
          + Enviar cartaz
        </button>
      </header>

      {error && <div className="error">{error}</div>}

      {lineups === null && !error ? (
        <div className="eq history-loading" aria-label="Carregando">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
          ))}
        </div>
      ) : lineups && lineups.length === 0 && playlists.length === 0 ? (
        <div className="history-empty reveal">
          <div className="display">Nada por aqui ainda.</div>
          <p>Envie o cartaz de um festival para montar sua primeira playlist.</p>
          <button className="btn" onClick={onNewPoster}>Enviar cartaz →</button>
        </div>
      ) : (
        lineups && (
          <>
            <div className="stats history-stats reveal" style={{ ["--i" as string]: 2 }}>
              <div>
                <b>{lineups.length}</b>
                <span>cartazes enviados</span>
              </div>
              <div>
                <b>{playlists.length}</b>
                <span>playlists criadas</span>
              </div>
              <div>
                <b>{totalTracks}</b>
                <span>músicas adicionadas</span>
              </div>
            </div>

            <ul className="tickets">
              {lineups.map((l, i) => {
                const lists = byLineup.get(l.id) ?? [];
                const failed = l.status === "FAILED";
                return (
                  <li key={l.id} className={`ticket reveal ${failed ? "failed" : ""}`} style={{ ["--i" as string]: Math.min(i + 3, 12) }}>
                    <div className="ticket-main">
                      <div className="ticket-date mono">{formatDate(l.createdAt)}</div>
                      <div className="ticket-title display">
                        {l.festival ?? "Festival sem nome"} {l.edition && <span>{l.edition}</span>}
                      </div>
                      <div className="ticket-meta mono">
                        {failed ? "não foi possível ler este cartaz" : `${l.artistCount} ${l.artistCount === 1 ? "artista" : "artistas"}`}
                        {lists.length > 0 && ` · ${lists.length} ${lists.length === 1 ? "playlist" : "playlists"}`}
                      </div>
                      {lists.length > 0 && (
                        <ul className="ticket-playlists">{lists.map(playlistItem)}</ul>
                      )}
                    </div>
                    <div className="ticket-stub">
                      {failed ? (
                        <span className="mono">falhou</span>
                      ) : (
                        <button className="btn alt small" onClick={() => open(l.id)} disabled={opening !== null || deleting !== null}>
                          {opening === l.id ? "Abrindo…" : lists.length > 0 ? "Nova playlist →" : "Continuar →"}
                        </button>
                      )}
                      <button className="linkish stub-delete" onClick={() => setConfirming(l.id)} disabled={deleting !== null}>
                        apagar
                      </button>
                    </div>
                    {confirming === l.id && (
                      <div className="ticket-confirm" role="alertdialog" aria-label="Confirmar exclusão">
                        <span>
                          Apagar <b>{l.festival ?? "este line-up"}</b> e a seleção salva
                          {lists.length > 0 && ` (e ${lists.length === 1 ? "1 playlist" : `${lists.length} playlists`} do histórico)`}?{" "}
                          <span className="mono">As playlists continuam no seu Spotify.</span>
                        </span>
                        <span className="ticket-confirm-actions">
                          <button className="btn small danger" onClick={() => removeLineup(l.id)} disabled={deleting !== null}>
                            {deleting === l.id ? "Apagando…" : "Apagar"}
                          </button>
                          <button className="linkish" onClick={() => setConfirming(null)}>cancelar</button>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {orphans.length > 0 && (
              <div className="orphans">
                <h3 className="display">Outras playlists</h3>
                <ul className="ticket-playlists">{orphans.map(playlistItem)}</ul>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
