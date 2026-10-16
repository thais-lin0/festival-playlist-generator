"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthMode } from "@/components/AuthCard";
import { HistoryPage } from "@/components/HistoryPage";
import { UploadStep } from "@/components/UploadStep";
import { SelectStep } from "@/components/SelectStep";
import { PlaylistStep } from "@/components/PlaylistStep";
import { api } from "@/lib/api";
import { currentUser, logout, type AuthUser } from "@/lib/auth";
import { clearState, initialState, loadState, saveState, selectionOf, stateForLineup, type AppState } from "@/lib/state";
import type { Lineup } from "@/lib/types";

const SPOTIFY_NOTICES: Record<string, string> = {
  connected: "Spotify conectado.",
  denied: "A autorização do Spotify foi cancelada.",
  error: "Não foi possível concluir a conexão com o Spotify.",
};

export default function Home() {
  const [state, setState] = useState<AppState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [notice, setNotice] = useState<string | null>(null);
  // "history" is a separate page reached from the header; the main flow stays upload -> selection -> playlist.
  const [page, setPage] = useState<"flow" | "history">("flow");

  useEffect(() => {
    const saved = loadState();
    if (saved) setState(saved);
    setUser(currentUser());
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "history" && currentUser()) setPage("history");
    const spotify = params.get("spotify");
    if (spotify) {
      setNotice(SPOTIFY_NOTICES[spotify] ?? null);
      window.history.replaceState(null, "", "/");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveState(state);
  }, [state, hydrated]);

  // Keep the history page addressable (/?view=history) so reloads and bookmarks land there.
  useEffect(() => {
    if (!hydrated) return;
    const url = page === "history" ? "/?view=history" : "/";
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(null, "", url);
  }, [page, hydrated]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // Persist the selection (artists picked, ♥/✦, playlist options) to DynamoDB.
  const selectionJson = state.lineup ? JSON.stringify(selectionOf(state)) : null;
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || !user || !state.lineup || !selectionJson || selectionJson === lastSaved.current) return;
    const id = state.lineup.id;
    const t = setTimeout(() => {
      lastSaved.current = selectionJson;
      api(`/lineups/${id}`, { method: "PUT", body: JSON.stringify({ selection: JSON.parse(selectionJson) }) }).catch(() => {
        lastSaved.current = null;
      });
    }, 800);
    return () => clearTimeout(t);
  }, [selectionJson, hydrated, user, state.lineup]);

  const update = useCallback((patch: Partial<AppState>) => setState((s) => ({ ...s, ...patch })), []);

  const openLineup = useCallback((lineup: Lineup) => {
    lastSaved.current = JSON.stringify(lineup.selection);
    setPage("flow");
    setState(stateForLineup(lineup));
    window.scrollTo({ top: 0 });
  }, []);

  // Session expired or revoked: back to the start, where the login form lives.
  const onAuthRequired = useCallback(() => {
    setUser(null);
    setPage("flow");
    setAuthMode("signin");
    setState((s) => ({ ...s, step: 1 }));
  }, []);

  const restart = () => {
    setPage("flow");
    clearState();
    setState(initialState);
    window.scrollTo({ top: 0 });
  };

  const goto = (step: 1 | 2 | 3) => {
    setPage("flow");
    update({ step });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const showAuth = (mode: AuthMode) => {
    setAuthMode(mode);
    if (state.step !== 1) update({ step: 1 });
  };

  async function signOut() {
    await logout();
    clearState();
    setState(initialState);
    setUser(null);
    setAuthMode("signin");
    setPage("flow");
  }

  const openHistory = () => {
    setPage("history");
    window.scrollTo({ top: 0 });
  };

  const stepState = (n: number) => (state.step === n ? "current" : state.step > n ? "done" : "todo");
  // Step chips double as navigation: back to any step already reached.
  const canGo = (n: 1 | 2 | 3) => (n === 1 ? true : n === 2 ? Boolean(state.lineup) : state.step === 3);
  const onHistory = page === "history";

  return (
    <main className={`shell ${!onHistory && state.step === 1 ? "onepage" : ""}`}>
      <header className="masthead">
        <button className="wordmark display" onClick={restart}>
          Line-up <span className="arrow">→</span> Playlist
        </button>
        <div className="mast-right">
          {user && (
            <button className="btn alt small" aria-pressed={onHistory} onClick={openHistory} disabled={onHistory}>
              ☰ Meu histórico
            </button>
          )}
          {!onHistory && state.step > 1 && (
            <button className="btn alt small" onClick={restart}>
              + Novo cartaz
            </button>
          )}
          <ol className="steps" aria-label="Etapas">
            {([1, 2, 3] as const).map((n) => (
              <li key={n} data-state={onHistory ? "todo" : stepState(n)}>
                <button disabled={(!onHistory && state.step === n) || !canGo(n)} onClick={() => (n === 1 ? restart() : goto(n))}>
                  0{n} {["Cartaz", "Seleção", "Playlist"][n - 1]}
                </button>
              </li>
            ))}
          </ol>
          {hydrated &&
            (user ? (
              <span className="who-am-i mono">
                {user.email} · <button className="linkish" onClick={signOut}>sair</button>
              </span>
            ) : (
              <span className="who-am-i mono">
                <button className="linkish" onClick={() => showAuth("signin")}>entrar</button> ·{" "}
                <button className="linkish" onClick={() => showAuth("signup")}>criar conta</button>
              </span>
            ))}
        </div>
      </header>

      {notice && <div className="toast mono" role="status">{notice}</div>}

      {hydrated && onHistory && user && <HistoryPage onOpenLineup={openLineup} onNewPoster={restart} onAuthRequired={onAuthRequired} />}
      {hydrated && !onHistory && state.step === 1 && (
        <UploadStep
          user={user}
          authMode={authMode}
          onAuthMode={setAuthMode}
          onSignedIn={() => setUser(currentUser())}
          onAuthRequired={onAuthRequired}
          onLineup={openLineup}
          onOpenHistory={openHistory}
        />
      )}
      {hydrated && !onHistory && state.step === 2 && state.lineup && <SelectStep state={state} update={update} onNext={() => goto(3)} />}
      {hydrated && !onHistory && state.step === 3 && state.lineup && (
        <PlaylistStep state={state} update={update} onBack={() => goto(2)} onRestart={restart} onAuthRequired={onAuthRequired} />
      )}
    </main>
  );
}
