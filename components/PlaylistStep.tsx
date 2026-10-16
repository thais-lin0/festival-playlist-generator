"use client";

import { useCallback, useEffect, useState } from "react";
import { api, AuthRequiredError, sleep } from "@/lib/api";
import { includedArtists, type AppState } from "@/lib/state";
import type { PlaylistJob, PlaylistRequest, PlaylistResult, SpotifyStatus } from "@/lib/types";

const MODE_LABEL = { full: "Line-up completo", selection: "Minha seleção", day: "Por dia", discover: "Descobrir novos artistas" };
const ORDER_LABEL = { popular: "Destaques primeiro", balanced: "Mix equilibrado", festival: "Ordem do cartaz" };

interface Props {
  state: AppState;
  update: (patch: Partial<AppState>) => void;
  onBack: () => void;
  onRestart: () => void;
  onAuthRequired: () => void;
}

export function PlaylistStep({ state, update, onBack, onRestart, onAuthRequired }: Props) {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const artists = includedArtists(state);
  const lineup = state.lineup!;
  const job = state.job;
  const running = job?.status === "QUEUED" || job?.status === "RUNNING";

  const handle = useCallback((e: unknown) => {
    if (e instanceof AuthRequiredError) return onAuthRequired();
    setError(e instanceof Error ? e.message : "Algo deu errado.");
  }, [onAuthRequired]);

  const refreshStatus = useCallback(() => {
    api<SpotifyStatus>("/spotify/status").then(setStatus).catch(handle);
  }, [handle]);

  useEffect(refreshStatus, [refreshStatus]);

  // Poll the playlist job (also resumes after a page reload).
  useEffect(() => {
    if (!job || !running) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        await sleep(1500);
        try {
          const next = await api<PlaylistJob>(`/playlists/${job.id}`);
          if (cancelled) return;
          update({ job: next });
          if (next.status === "DONE" || next.status === "FAILED") {
            if (next.status === "FAILED") setError(next.error ?? "Falha ao criar a playlist.");
            if (next.status === "DONE") window.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }
        } catch (e) {
          handle(e);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job?.id, running, update, handle]); // eslint-disable-line react-hooks/exhaustive-deps

  if (job?.status === "DONE" && job.result) {
    return <Done result={job.result} onBack={() => update({ job: null, step: 2 })} onRestart={onRestart} />;
  }

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await api<{ url: string }>("/spotify/authorize", {
        method: "POST",
        body: JSON.stringify({ returnTo: window.location.origin }),
      });
      window.location.href = url;
    } catch (e) {
      handle(e);
      setConnecting(false);
    }
  }

  async function disconnect() {
    await api("/spotify/connection", { method: "DELETE" }).catch(handle);
    refreshStatus();
  }

  async function generate() {
    setError(null);
    const body: PlaylistRequest = {
      lineupId: lineup.id,
      name: state.playlistName.trim() || "Minha playlist de festival",
      description: `Gerada a partir do line-up${lineup.festival ? ` do ${lineup.festival}` : ""} · ${artists.length} artistas`,
      isPublic: state.isPublic,
      artists: artists.map((a) => ({ name: a.name, spotifyId: lineup.resolved[a.id]?.spotifyId ?? null, order: a.order, tier: a.tier })),
      tracksPerArtist: state.tracksPerArtist,
      ordering: state.ordering,
    };
    try {
      update({ job: await api<PlaylistJob>("/playlists", { method: "POST", body: JSON.stringify(body) }) });
    } catch (e) {
      handle(e);
      refreshStatus();
    }
  }

  return (
    <section className="final">
      <div>
        <h2 className="display misreg reveal">Quase lá.</h2>
        <div className="field reveal" style={{ ["--i" as string]: 1 }}>
          <label htmlFor="pl-name">Nome da playlist</label>
          <input id="pl-name" type="text" value={state.playlistName} maxLength={100} onChange={(e) => update({ playlistName: e.target.value })} />
        </div>
        <div className="field reveal" style={{ ["--i" as string]: 2 }}>
          <span className="label">Visibilidade</span>
          <div className="seg" style={{ borderColor: "var(--ink)", alignSelf: "flex-start" }}>
            {[false, true].map((pub) => (
              <button
                key={String(pub)}
                aria-pressed={state.isPublic === pub}
                onClick={() => update({ isPublic: pub })}
                style={state.isPublic === pub ? { background: "var(--ink)", color: "var(--paper)" } : { color: "var(--ink)" }}
              >
                {pub ? "Pública" : "Privada"}
              </button>
            ))}
          </div>
        </div>
        <div className="summary reveal" style={{ ["--i" as string]: 3 }}>
          <dl>
            <dt>Tipo</dt>
            <dd>
              {MODE_LABEL[state.mode]}
              {state.mode === "day" && state.modeDay ? ` · ${state.modeDay}` : ""}
            </dd>
            <dt>Artistas</dt>
            <dd>{artists.length}</dd>
            <dt>Por artista</dt>
            <dd>até {state.tracksPerArtist} músicas</dd>
            <dt>Ordem</dt>
            <dd>{ORDER_LABEL[state.ordering]}</dd>
            <dt>Estimativa</dt>
            <dd>até {artists.length * state.tracksPerArtist} músicas</dd>
          </dl>
        </div>
        <p className="back">
          <button className="linkish" onClick={onBack} disabled={running}>
            ← voltar para a seleção
          </button>
        </p>
      </div>

      <div className="connect reveal" style={{ ["--i" as string]: 2 }}>
        {running ? (
          <>
            <div className="eq" aria-hidden>
              {Array.from({ length: 14 }, (_, i) => (
                <i key={i} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
              ))}
            </div>
            <div className="display" style={{ fontSize: 40 }}>Montando sua playlist…</div>
            <div className="note mono" role="status">
              {job!.progress.done} de {job!.progress.total} artistas · conferindo identidade e removendo duplicatas
            </div>
          </>
        ) : !status ? (
          <div className="note mono">Verificando sua conexão com o Spotify…</div>
        ) : !status.configured ? (
          <>
            <div className="display" style={{ fontSize: 40 }}>Spotify não configurado</div>
            <p className="note">
              As credenciais do app do Spotify ainda não foram cadastradas no AWS Secrets Manager. Veja o README (seção “Configurar o Spotify”).
            </p>
          </>
        ) : status.connected ? (
          <>
            <div className="who">
              Conectado como <b>{status.user?.name}</b> · <button className="linkish" onClick={disconnect}>desconectar</button>
            </div>
            <div className="display" style={{ fontSize: 40 }}>Tudo pronto.</div>
            <button className="btn blue" onClick={generate} disabled={artists.length === 0}>
              Gerar playlist no Spotify
            </button>
          </>
        ) : (
          <>
            <div className="display" style={{ fontSize: 40 }}>Conecte seu Spotify</div>
            <p className="note">
              Você será levado à página oficial do Spotify para autorizar a criação de playlists. Não pedimos sua senha, e só solicitamos permissão para criar e editar playlists.
            </p>
            <button className="btn blue" onClick={connect} disabled={connecting}>
              {connecting ? "Abrindo o Spotify…" : "Conectar ao Spotify"}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

function Done({ result, onBack, onRestart }: { result: PlaylistResult; onBack: () => void; onRestart: () => void }) {
  return (
    <section className="final">
      <div>
        <span className="stamp">Criada!</span>
        <h2 className="done-head display misreg reveal" style={{ marginTop: 14 }}>
          Sua playlist está pronta!
        </h2>
        <div className="stats reveal" style={{ ["--i" as string]: 1 }}>
          <div>
            <b>{result.artistsRequested}</b>
            <span>artistas selecionados</span>
          </div>
          <div>
            <b>{result.artistsWithTracks}</b>
            <span>com músicas encontradas</span>
          </div>
          <div>
            <b>{result.tracksAdded}</b>
            <span>músicas adicionadas</span>
          </div>
        </div>
        <a className="btn blue reveal" style={{ ["--i" as string]: 2 }} href={result.playlistUrl} target="_blank" rel="noreferrer">
          Abrir playlist no Spotify ↗
        </a>
        {result.shortfalls.length > 0 && (
          <div className="shortfalls">
            <p>Para alguns artistas encontramos menos músicas adequadas do que o pedido — preferimos não completar com faixas de outros artistas:</p>
            <ul>
              {result.shortfalls.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.found === 0 ? "nenhuma encontrada" : `${s.found} de ${s.wanted}`}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="back" style={{ display: "flex", gap: 18 }}>
          <button className="linkish" onClick={onBack}>← ajustar seleção</button>
          <button className="btn alt small" onClick={onRestart}>+ Novo cartaz</button>
        </p>
      </div>
      <div className="setlist reveal" style={{ ["--i" as string]: 2 }}>
        <header>
          <span>{result.playlistName}</span>
          <span>{result.tracks.length} faixas</span>
        </header>
        <ol>
          {result.tracks.map((t) => (
            <li key={t.uri}>
              <div>
                <div className="t">{t.title}</div>
                <div className="a">{t.artist}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
