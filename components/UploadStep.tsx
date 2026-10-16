"use client";

import { useEffect, useState } from "react";
import { api, AuthRequiredError, sleep } from "@/lib/api";
import { startLogin, type AuthUser } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, preparePoster } from "@/lib/client-image";
import type { CreateLineupResponse, Lineup, LineupSummary } from "@/lib/types";

const PHASES = ["Enviando o cartaz", "Lendo o texto (OCR)", "Identificando artistas com IA", "Buscando no Spotify"];
const POLL_TIMEOUT_MS = 4 * 60_000;

function phaseOf(lineup: Lineup): number {
  if (lineup.status === "WAITING_UPLOAD") return 0;
  if (lineup.stage === "ocr") return 1;
  if (lineup.stage === "extracting") return 2;
  if (lineup.stage === "matching") return 3;
  return PHASES.length;
}

export function UploadStep({ user, onLineup }: { user: AuthUser | null; onLineup: (lineup: Lineup) => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LineupSummary[]>([]);

  useEffect(() => {
    if (!user) return;
    api<{ lineups: LineupSummary[] }>("/lineups")
      .then((d) => setHistory(d.lineups.filter((l) => l.status === "READY")))
      .catch(() => {});
  }, [user]);

  async function run(task: () => Promise<Lineup>) {
    setBusy(true);
    setError(null);
    setPhase(0);
    try {
      onLineup(await task());
    } catch (e) {
      if (e instanceof AuthRequiredError) return startLogin();
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
    if (!file || busy) return;
    if (!user) return startLogin();
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
      for (const [k, v] of Object.entries(upload!.fields)) form.append(k, v);
      form.append("file", blob, "poster.jpg");
      const res = await fetch(upload!.url, { method: "POST", body: form });
      if (!res.ok) throw new Error("Falha ao enviar a imagem.");
      setPhase(1);
      return waitUntilReady(lineup.id);
    });
  }

  function useDemo() {
    if (!user) return startLogin();
    run(async () => (await api<CreateLineupResponse>("/lineups", { method: "POST", body: JSON.stringify({ demo: true }) })).lineup);
  }

  function openSaved(id: string) {
    run(() => api<Lineup>(`/lineups/${id}`));
  }

  return (
    <>
      <section className="hero">
        <div>
          <h1 className="display misreg">
            <span className="reveal" style={{ ["--i" as string]: 0 }}>Envie o</span>
            <span className="reveal pink" style={{ ["--i" as string]: 1 }}>line-up.</span>
            <span className="reveal" style={{ ["--i" as string]: 2 }}>Ganhe a</span>
            <span className="reveal" style={{ ["--i" as string]: 3 }}>playlist.</span>
          </h1>
          <p className="lede reveal" style={{ ["--i" as string]: 4 }}>
            Mande a foto do cartaz do festival. A gente lê os nomes, você escolhe quem quer ouvir, e a playlist aparece pronta na sua conta do Spotify.
          </p>
          <div className="ticketline mono reveal" style={{ ["--i" as string]: 5 }}>
            <span>★ Filtros por dia e gênero</span>
            <span>★ 3, 5 ou 10 músicas por artista</span>
            <span>★ Suas seleções ficam salvas</span>
          </div>
        </div>

        <div className="reveal" style={{ ["--i" as string]: 3 }}>
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
            ) : user ? (
              <>
                <div className="display big">Solte o cartaz aqui</div>
                <div className="mono" style={{ fontSize: 13 }}>ou clique para escolher · PNG, JPG, WEBP</div>
                <input type="file" accept="image/*" aria-label="Enviar cartaz" onChange={(e) => handleFile(e.target.files?.[0])} />
              </>
            ) : (
              <>
                <div className="display big">Entre para começar</div>
                <div className="mono" style={{ fontSize: 13 }}>Seus line-ups e seleções ficam salvos na sua conta.</div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", position: "relative" }}>
                  <button className="btn" onClick={() => startLogin("login")}>Entrar</button>
                  <button className="btn alt" onClick={() => startLogin("signup")}>Criar conta</button>
                </div>
              </>
            )}
          </div>
          {!busy && user && (
            <p style={{ textAlign: "center", marginTop: 22 }}>
              <button className="linkish" onClick={useDemo}>
                Sem cartaz à mão? Testar com um line-up de exemplo →
              </button>
            </p>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </section>

      {history.length > 0 && !busy && (
        <section className="history reveal" style={{ ["--i" as string]: 6 }}>
          <h2 className="display">Seus line-ups</h2>
          <ul>
            {history.slice(0, 6).map((l) => (
              <li key={l.id}>
                <button onClick={() => openSaved(l.id)}>
                  <b>{[l.festival ?? "Festival sem nome", l.edition].filter(Boolean).join(" ")}</b>
                  <span className="mono">
                    {l.artistCount} artistas · {new Date(l.createdAt).toLocaleDateString("pt-BR")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="how">
        {[
          ["Envie", "Foto ou print do cartaz oficial."],
          ["Escolha", "Filtre por dia, gênero ou marque quem você quer conhecer."],
          ["Ouça", "A playlist é criada direto no seu Spotify."],
        ].map(([t, d], i) => (
          <div key={t} className="reveal" style={{ ["--i" as string]: 6 + i }}>
            <span className="n">0{i + 1}</span>
            <b>{t}</b>
            <p>{d}</p>
          </div>
        ))}
      </section>
    </>
  );
}
