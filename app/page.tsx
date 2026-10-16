"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadStep } from "@/components/UploadStep";
import { SelectStep } from "@/components/SelectStep";
import { PlaylistStep } from "@/components/PlaylistStep";
import { api } from "@/lib/api";
import { currentUser, logout, startLogin, type AuthUser } from "@/lib/auth";
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
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadState();
    if (saved) setState(saved);
    setUser(currentUser());
    const spotify = new URLSearchParams(window.location.search).get("spotify");
    if (spotify) {
      setNotice(SPOTIFY_NOTICES[spotify] ?? null);
      window.history.replaceState(null, "", "/");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveState(state);
  }, [state, hydrated]);

  // Persist the selection (artists picked, ♥/✦, playlist options) to DynamoDB.
  const selectionJson = state.lineup ? JSON.stringify(selectionOf(state)) : null;
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || !state.lineup || !selectionJson || selectionJson === lastSaved.current) return;
    const id = state.lineup.id;
    const t = setTimeout(() => {
      lastSaved.current = selectionJson;
      api(`/lineups/${id}`, { method: "PUT", body: JSON.stringify({ selection: JSON.parse(selectionJson) }) }).catch(() => {
        lastSaved.current = null;
      });
    }, 800);
    return () => clearTimeout(t);
  }, [selectionJson, hydrated, state.lineup]);

  const update = useCallback((patch: Partial<AppState>) => setState((s) => ({ ...s, ...patch })), []);

  const openLineup = useCallback((lineup: Lineup) => {
    lastSaved.current = JSON.stringify(lineup.selection);
    setState(stateForLineup(lineup));
    window.scrollTo({ top: 0 });
  }, []);

  const restart = () => {
    clearState();
    setState(initialState);
    window.scrollTo({ top: 0 });
  };

  const goto = (step: 1 | 2 | 3) => {
    update({ step });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const stepState = (n: number) => (state.step === n ? "current" : state.step > n ? "done" : "todo");

  return (
    <main className="shell">
      <header className="masthead">
        <button className="wordmark display" onClick={restart} style={{ background: "none", border: 0, padding: 0 }}>
          Line-up <span className="arrow">→</span> Playlist
        </button>
        <ol className="steps" aria-label="Etapas">
          <li data-state={stepState(1)}>01 Cartaz</li>
          <li data-state={stepState(2)}>02 Seleção</li>
          <li data-state={stepState(3)}>03 Playlist</li>
        </ol>
      </header>

      <div className="statusline">
        {user ? (
          <>
            <span className="tag on">{user.email}</span>
            <button className="linkish" onClick={() => logout()}>sair</button>
          </>
        ) : (
          hydrated && (
            <>
              <button className="linkish" onClick={() => startLogin("login")}>entrar</button>
              <button className="linkish" onClick={() => startLogin("signup")}>criar conta</button>
            </>
          )
        )}
        {notice && <span className="tag">{notice}</span>}
      </div>

      {hydrated && state.step === 1 && <UploadStep user={user} onLineup={openLineup} />}
      {hydrated && state.step === 2 && state.lineup && <SelectStep state={state} update={update} onNext={() => goto(3)} onBack={restart} />}
      {hydrated && state.step === 3 && state.lineup && <PlaylistStep state={state} update={update} onBack={() => goto(2)} onRestart={restart} />}
    </main>
  );
}
