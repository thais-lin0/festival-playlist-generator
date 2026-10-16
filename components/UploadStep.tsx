"use client";

import { useEffect, useState } from "react";
import { AuthCard, type AuthMode } from "@/components/AuthCard";
import { api, AuthRequiredError, sleep } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, preparePoster } from "@/lib/client-image";
import type { CreateLineupResponse, Lineup, LineupSummary } from "@/lib/types";

const PHASES = ["Enviando o cartaz", "Lendo artistas", "Organizando o line-up", "Buscando no Spotify"];
const POLL_TIMEOUT_MS = 4 * 60_000;

function phaseOf(lineup: Lineup): number {
  if (lineup.status === "WAITING_UPLOAD") return 0;
  if (lineup.stage === "ocr") return 1;
  if (lineup.stage === "extracting") return 2;
  if (lineup.stage === "matching") return 3;
  return PHASES.length;
}

interface Props {
  user: AuthUser | null;
  authMode: AuthMode;
  onAuthMode: (mode: AuthMode) => void;
  onSignedIn: () => void;
  onAuthRequired: () => void;
  onLineup: (lineup: Lineup) => void;
  onOpenHistory: () => void;
}

export function UploadStep({ user, authMode, onAuthMode, onSignedIn, onAuthRequired, onLineup, onOpenHistory }: Props) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LineupSummary[]>([]);
  const [pasteKey, setPasteKey] = useState("Ctrl+V");

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setPasteKey("⌘V");
  }, []);

  useEffect(() => {
    if (!user) return setHistory([]);
    api<{ lineups: LineupSummary[] }>("/lineups")
      .then((d) => setHistory(d.lineups.filter((l) => l.status === "READY")))
      .catch((e) => e instanceof AuthRequiredError && onAuthRequired());
  }, [user, onAuthRequired]);

  // Ctrl/⌘+V anywhere on this screen: use an image from the clipboard (e.g. a screenshot of the poster).
  useEffect(() => {
    if (!user) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        handleFile(file);
      } else if (e.clipboardData?.types.includes("text/plain")) {
        setError("Copie a imagem do cartaz (não o link ou o texto) e cole de novo.");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  async function run(task: () => Promise<Lineup>) {
    setBusy(true);
    setError(null);
    setPhase(0);
    try {
      onLineup(await task());
    } catch (e) {
      if (e instanceof AuthRequiredError) return onAuthRequired();
      setError(e instanceof Error ? e.message : "Falha ao ler o cartaz.");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function waitUntilReady(id: string): Promise<Lineup> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      const lineup = await api<Lineup>(`/lineups/${id}`);
      setPhase(phaseOf(lineup));
      if (lineup.status === "READY") return lineup;
      if (lineup.status === "FAILED") throw new Error(lineup.error ?? "Não foi possível ler o cartaz.");
    }
    throw new Error("A leitura está demorando mais que o normal. Tente novamente em instantes.");
  }

  async function handleFile(file: File | undefined) {
    if (!file || busy || !user) return;
    if (!file.type.startsWith("image/")) {
      setError("Envie uma imagem (PNG, JPG ou WEBP).");
      return;
    }
    setPreview(URL.createObjectURL(file));
    await run(async () => {
      const blob = await preparePoster(file);
      if (blob.size > MAX_UPLOAD_BYTES) throw new Error("Imagem muito grande mesmo após compressão. Tente outra foto.");
      const { lineup, upload } = await api<CreateLineupResponse>("/lineups", { method: "POST", body: JSON.stringify({}) });
      const form = new FormData();
      for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
      form.append("file", blob, "poster.jpg");
      const res = await fetch(upload.url, { method: "POST", body: form });
      if (!res.ok) throw new Error("Falha ao enviar a imagem.");
      setPhase(1);
      return waitUntilReady(lineup.id);
    });
  }

  const openSaved = (id: string) => run(() => api<Lineup>(`/lineups/${id}`));

  return (
    <section className="stage">
      <div className="stage-copy">
        <h1 className="display misreg">
          <span className="reveal" style={{ ["--i" as string]: 0 }}>Envie o</span>
          <span className="reveal pink" style={{ ["--i" as string]: 1 }}>line-up.</span>
          <span className="reveal" style={{ ["--i" as string]: 2 }}>Ganhe a</span>
          <span className="reveal" style={{ ["--i" as string]: 3 }}>playlist.</span>
        </h1>
        <p className="lede reveal" style={{ ["--i" as string]: 4 }}>
          Mande a foto do cartaz do festival. A gente lê os nomes, você escolhe quem quer ouvir, e a playlist aparece no seu Spotify.
        </p>
        <ol className="how-strip mono reveal" style={{ ["--i" as string]: 5 }}>
          <li><b>01</b> Envie o cartaz</li>
          <li><b>02</b> Escolha os artistas</li>
          <li><b>03</b> Ouça no Spotify</li>
        </ol>
        {history.length > 0 && !busy && (
          <div className="recent reveal" style={{ ["--i" as string]: 6 }}>
            <span className="mono">Recentes</span>
            {history.slice(0, 3).map((l) => (
              <button key={l.id} className="chip" onClick={() => openSaved(l.id)} title={`${l.artistCount} artistas`}>
                {[l.festival ?? "Sem nome", l.edition].filter(Boolean).join(" ")}
              </button>
            ))}
            <button className="linkish" onClick={onOpenHistory}>ver histórico →</button>
          </div>
        )}
      </div>

      <div className="stage-card reveal" style={{ ["--i" as string]: 3 }}>
        {!user ? (
          <div className="drop auth-frame">
            <span className="tape" aria-hidden />
            <AuthCard mode={authMode} onMode={onAuthMode} onSignedIn={onSignedIn} />
          </div>
        ) : (
          <div
            className={`drop ${over ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              handleFile(e.dataTransfer.files[0]);
            }}
          >
            <span className="tape" aria-hidden />
            {preview && <img className="preview" src={preview} alt="" />}
            {busy ? (
              <>
                <div className="scan" aria-hidden />
                <div className="progress" role="status" aria-live="polite">
                  <ul>
                    {PHASES.map((p, i) => (
                      <li key={p} className={i < phase ? "done" : i === phase ? "active" : ""}>
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <>
                <div className="display big">
                  <span className="only-pointer">Solte o cartaz aqui</span>
                  <span className="only-touch">Toque para escolher o cartaz</span>
                </div>
                <div className="drop-hint mono only-pointer">
                  clique para escolher <span>·</span> cole com <kbd>{pasteKey}</kbd>
                </div>
                <div className="mono drop-formats">PNG, JPG ou WEBP</div>
                <input type="file" accept="image/*" aria-label="Enviar cartaz" onChange={(e) => handleFile(e.target.files?.[0])} />
              </>
            )}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}
