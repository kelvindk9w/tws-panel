import { useCallback, useEffect, useState } from "react";
import type {
  BaselineResponse,
  BlacklistCheckResponse,
  MonitorRunResponse,
  MonitorStateResponse,
  SecurityHistoryResponse,
  SecurityScanResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Activity,
  Camera,
  Gauge,
  Loader2,
  MailWarning,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("pt-BR") : "—";
}

/** Card 1: Hardening Index atual + histórico. */
function HardeningCard() {
  const [scan, setScan] = useState<SecurityScanResponse | null>(null);
  const [history, setHistory] = useState<SecurityHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<SecurityScanResponse>("/api/security/scan"),
      apiFetch<SecurityHistoryResponse>("/api/security/history"),
    ])
      .then(([s, h]) => {
        setScan(s);
        setHistory(h);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar."));
  }, []);

  const index = scan?.report?.hardeningIndex ?? null;
  const scans = history?.entries.filter((e) => e.kind === "scan") ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4" /> Nota de segurança
          {scan?.refreshing && (
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> atualizando…
            </span>
          )}
        </CardTitle>
        <CardDescription>Nota atual desta VPS e como ela evoluiu.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!scan && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </p>
        )}
        {scan && (
          <>
            <div className="flex items-end gap-2">
              <span
                className={`text-4xl font-bold ${
                  (index ?? 0) >= 70 ? "text-emerald-400" : (index ?? 0) >= 40 ? "text-amber-400" : "text-red-400"
                }`}
              >
                {index ?? "—"}
              </span>
              <span className="pb-1 text-sm text-muted-foreground">
                /100 · fonte: {scan.report.hardeningIndexSource}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {scan.report.summary.pass} itens OK · {scan.report.summary.fail} com problema · última verificação{" "}
              {fmtDate(scan.report.scannedAt)}
            </p>
            {/* Evolução: seta só entre notas da MESMA régua — 42 (índice interno)
                → 86 (Lynis) não é ganho de 44 pontos (visto em campo). */}
            {(() => {
              const withIndex = scans.filter((e) => typeof e.hardeningIndex === "number");
              const first = withIndex[0];
              const last = withIndex.at(-1);
              if (!first || !last || first === last) return null;
              const same = (first.hardeningIndexSource ?? "internal") === (last.hardeningIndexSource ?? "internal");
              const a = first.hardeningIndex as number;
              const b = last.hardeningIndex as number;
              return (
                <p data-testid="evolution" className="text-xs text-muted-foreground">
                  {same
                    ? `Evolução: ${a} → ${b}${b > a ? " ▲" : b < a ? " ▼" : ""}`
                    : `Primeira verificação: ${a} (${first.hardeningIndexSource === "lynis" ? "Lynis" : "índice interno"}) · hoje: ${b} (${last.hardeningIndexSource === "lynis" ? "Lynis" : "índice interno"}) — réguas diferentes`}
                </p>
              );
            })()}
            {scans.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {scans.slice(-8).map((s) => (
                  <Badge
                    key={s.id}
                    variant="secondary"
                    title={`${fmtDate(s.at)} — ${s.hardeningIndexSource === "lynis" ? "Lynis" : "índice interno"}`}
                  >
                    {s.hardeningIndex ?? "—"}
                    {s.hardeningIndexSource === "lynis" ? "" : "*"}
                  </Badge>
                ))}
              </div>
            )}
            {scans.some((e) => e.hardeningIndexSource !== "lynis") && (
              <p className="text-[11px] text-muted-foreground">* índice interno do painel (antes de o Lynis existir na VPS)</p>
            )}
          </>
        )}
        <Button size="sm" variant="outline" className="mt-1 self-start" asChild>
          <Link to="/security/hardening">Verificar e aplicar proteções</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** Card 2: Baseline de segurança. */
function BaselineCard({ onUpdated }: { onUpdated: () => void }) {
  const [baseline, setBaseline] = useState<BaselineResponse["baseline"] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<BaselineResponse>("/api/security/baseline");
      setBaseline(res.baseline);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o baseline.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<BaselineResponse>("/api/security/baseline", { method: "POST" });
      setBaseline(res.baseline);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar o baseline.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Camera className="h-4 w-4" /> Retrato de referência
        </CardTitle>
        <CardDescription>
          Registro dos pacotes, portas e arquivos importantes desta VPS. O monitoramento compara com ele para avisar quando algo muda.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </p>
        ) : baseline ? (
          <div className="text-sm">
            <p>
              Criado em <strong>{fmtDate(baseline.createdAt)}</strong> ({baseline.target})
            </p>
            <p className="text-xs text-muted-foreground">
              {baseline.packages.length} pacotes · {baseline.ports.length} portas ·{" "}
              {Object.keys(baseline.files).length} arquivos rastreados
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ainda não há retrato de referência. Crie um depois de aplicar as proteções, para o monitoramento ter com o que comparar.
          </p>
        )}
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {baseline ? "Atualizar retrato de referência" : "Criar retrato de referência"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Card 3: Monitoramento recorrente (scan com diff + agendador). */
function MonitorCard({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<MonitorStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState("6");

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<MonitorStateResponse>("/api/security/monitor/last");
      setState(res);
      setHours(String(Math.round(res.config.intervalMs / 3_600_000)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o monitoramento.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<MonitorRunResponse>("/api/security/monitor/run", { method: "POST" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao executar o scan.");
    } finally {
      setBusy(false);
    }
  }

  async function saveInterval() {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Informe um intervalo válido em horas.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/security/monitor/config", {
        method: "PUT",
        body: JSON.stringify({ intervalMs: Math.round(value * 3_600_000) }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar o intervalo.");
    } finally {
      setBusy(false);
    }
  }

  const diff = state?.lastResult?.diff ?? null;
  const hasChanges =
    diff !== null &&
    (diff.newPackages.length > 0 ||
      diff.removedPackages.length > 0 ||
      diff.newPorts.length > 0 ||
      diff.closedPorts.length > 0 ||
      diff.changedFiles.length > 0 ||
      diff.removedFiles.length > 0 ||
      diff.addedFiles.length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> Monitoramento contínuo
          </CardTitle>
          {state && (
            <Badge variant={state.schedulerRunning ? "success" : "secondary"}>
              {state.schedulerRunning ? "agendador ativo" : "parado"}
            </Badge>
          )}
        </div>
        <CardDescription>Verificação automática periódica: compara a VPS com o retrato de referência e avisa quando algo muda.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!state ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Intervalo (horas):</span>
              <Input
                type="number"
                min={1}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="h-8 w-20"
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveInterval()}>
                Salvar
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void runNow()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Verificar agora
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Última verificação: {fmtDate(state.lastRunAt)}
              {state.lastResult ? ` (${state.lastResult.durationMs}ms, ${state.lastResult.alertsCreated} alerta(s))` : ""}
            </p>
            {state.lastResult?.note && <p className="text-xs text-amber-400">{state.lastResult.note}</p>}
            {diff && !hasChanges && (
              <p className="flex items-center gap-1.5 text-sm text-emerald-400">
                <ShieldCheck className="h-4 w-4" /> Nenhuma diferença em relação ao baseline.
              </p>
            )}
            {diff && hasChanges && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 font-mono text-xs leading-relaxed">
                {diff.newPorts.map((p) => (
                  <p key={`np-${p.proto}-${p.port}`} className="text-red-400">
                    + porta {p.proto}/{p.port}
                    {p.process ? ` (${p.process})` : ""}
                  </p>
                ))}
                {diff.closedPorts.map((p) => (
                  <p key={`cp-${p.proto}-${p.port}`} className="text-amber-300">
                    - porta {p.proto}/{p.port}
                  </p>
                ))}
                {diff.newPackages.map((p) => (
                  <p key={`npkg-${p}`} className="text-amber-300">
                    + pacote {p}
                  </p>
                ))}
                {diff.removedPackages.map((p) => (
                  <p key={`rpkg-${p}`} className="text-amber-300">
                    - pacote {p}
                  </p>
                ))}
                {diff.changedFiles.map((f) => (
                  <p key={`cf-${f}`} className="text-red-400">
                    ~ {f} (alterado)
                  </p>
                ))}
                {diff.removedFiles.map((f) => (
                  <p key={`rf-${f}`} className="text-red-400">
                    - {f} (removido)
                  </p>
                ))}
                {diff.addedFiles.map((f) => (
                  <p key={`af-${f}`} className="text-amber-300">
                    + {f} (novo)
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Card 4: Blacklist de e-mail (DNSBL). */
function BlacklistCard() {
  const [data, setData] = useState<BlacklistCheckResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<BlacklistCheckResponse>("/api/mail/blacklist");
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao consultar as blacklists.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MailWarning className="h-4 w-4" /> Reputação do e-mail
        </CardTitle>
        <CardDescription>
          Confere se o IP e os domínios de e-mail estão em listas de bloqueio de spam (Spamhaus, SpamCop, Barracuda).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <div className="flex flex-col gap-2 text-sm">
            {[data.ip, ...data.domains].map(
              (target) =>
                target && (
                  <div key={target.target} className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-muted-foreground">{target.target}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {target.results.map((r) => (
                        <Badge
                          key={r.dnsbl}
                          variant={r.status === "listed" ? "destructive" : r.status === "clean" ? "success" : "warning"}
                          title={r.detail ?? undefined}
                        >
                          {r.label}: {r.status === "listed" ? "LISTADO" : r.status === "clean" ? "limpo" : "indeterminado"}
                        </Badge>
                      ))}
                    </div>
                    {target.results.some((r) => r.status === "listed" && r.removalUrl) && (
                      <p className="text-xs text-muted-foreground">
                        Remoção:{" "}
                        {target.results
                          .filter((r) => r.status === "listed" && r.removalUrl)
                          .map((r) => (
                            <a key={r.dnsbl} href={r.removalUrl ?? "#"} target="_blank" rel="noreferrer" className="underline">
                              {r.label}
                            </a>
                          ))}
                      </p>
                    )}
                  </div>
                ),
            )}
            <p className="text-xs text-muted-foreground">Verificado em {fmtDate(data.checkedAt)}</p>
          </div>
        )}
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Verificar agora
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SecurityPage() {
  // atualizar o baseline re-executa o card de monitoramento (diff muda)
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Segurança</h1>
        <p className="text-sm text-muted-foreground">
          Proteções da VPS, retrato de referência, monitoramento e reputação do e-mail.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <HardeningCard />
        <BaselineCard onUpdated={() => setRefreshKey((k) => k + 1)} />
      </div>
      <MonitorCard refreshKey={refreshKey} />
      <BlacklistCard />
    </div>
  );
}
