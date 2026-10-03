import { useState } from "react";
import type { ComposeServiceInfo, DockerContainerInfo, Project } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ArrowRightLeft, Boxes, CheckCircle2, Loader2, RefreshCw, Save } from "lucide-react";

/**
 * Serviços do compose: todos, com o que sobe, as portas, a rede, as
 * dependências e o healthcheck — e qual serviço/porta recebe o HTTP do painel.
 * Validação real (cassino, 03/10/2026): só a entrada aparecia, e não dava
 * para entender por que ela era wallet:80 (o caddy atende DENTRO do wallet).
 */

const INTERNAL_SOURCE: Record<ComposeServiceInfo["internalPorts"][number]["source"], string> = {
  expose: "expose",
  dockerfile: "EXPOSE do Dockerfile",
  healthcheck: "do healthcheck",
  environment: "variável PORT",
};

const CONDITION: Record<string, string> = {
  service_healthy: "saudável",
  service_started: "iniciado",
  service_completed_successfully: "concluído",
};

const HEALTHCHECK: Record<NonNullable<ComposeServiceInfo["healthcheck"]> | "none", string> = {
  compose: "Healthcheck no compose",
  dockerfile: "Healthcheck no Dockerfile",
  disabled: "Healthcheck desligado",
  none: "Sem healthcheck",
};

const PROXY_IMAGE = /^(?:[^/]+\/)*(caddy|nginx|traefik)(?::|@|$)/i;

function buildLabel(build: NonNullable<ComposeServiceInfo["build"]>): string {
  const ctx = build.context.replace(/\/+$/, "");
  return ctx === "." || ctx === "" ? build.dockerfile : `${ctx}/${build.dockerfile}`;
}

type ContainerState = { label: string; variant: "success" | "warning" | "destructive" | "secondary" };

/** Estado do container de um serviço, em palavras simples. */
function containerState(c: DockerContainerInfo | undefined): ContainerState {
  if (!c) return { label: "sem container", variant: "secondary" };
  if (c.state === "running") {
    if (c.health === "unhealthy") return { label: "não saudável", variant: "destructive" };
    if (c.health === "healthy") return { label: "saudável", variant: "success" };
    if (c.health === "starting") return { label: "iniciando", variant: "warning" };
    return { label: "rodando", variant: "success" };
  }
  if (c.state === "restarting") return { label: "reiniciando", variant: "warning" };
  if (c.state === "created") return { label: "não iniciou", variant: "secondary" };
  return { label: "parado", variant: "destructive" };
}

function containerOf(name: string, containers: DockerContainerInfo[]): DockerContainerInfo | undefined {
  return (
    containers.find((c) => c.service === name) ??
    // respostas antigas, sem o serviço: pelo nome paas-<slug>-<serviço>-N
    containers.find((c) => c.service === undefined && new RegExp(`-${name}-\\d+$`).test(c.name))
  );
}

/** Explicação da entrada quando outro serviço atende dentro dela (network_mode). */
function entryExplanation(services: ComposeServiceInfo[], entry: string, port: number | null): string | null {
  const inside = services.filter((s) => s.networkModeService === entry);
  if (inside.length === 0) return null;
  const main = inside.find((s) => PROXY_IMAGE.test(s.image ?? "")) ?? inside[0]!;
  const others = inside.filter((s) => s !== main).map((s) => s.name);
  const where = `${entry}:${port ?? "?"}`;
  return (
    `O ${main.name} atende dentro do ${entry} (network_mode: service:${entry}), por isso a entrada é ${where} — ` +
    `a porta em que o ${main.name} escuta.` +
    (others.length > 0 ? ` ${others.join(", ")} também ${others.length === 1 ? "usa" : "usam"} a rede do ${entry}.` : "")
  );
}

export function ComposeServicesList({
  services,
  entryService,
  entryPort,
  containers,
}: {
  services: ComposeServiceInfo[];
  entryService: string | null;
  entryPort: number | null;
  /** Containers do projeto (depois do deploy); ausente = sem estado. */
  containers?: DockerContainerInfo[];
}) {
  const explanation = entryService ? entryExplanation(services, entryService, entryPort) : null;
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="compose-entry"
        className="flex flex-col gap-1 rounded-lg border border-sky-500/40 bg-sky-500/5 p-3 text-sm"
      >
        {entryService ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <ArrowRightLeft className="h-4 w-4 shrink-0 text-sky-400" />O HTTP do painel chega em{" "}
            <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-sky-300">
              {entryService}:{entryPort ?? "?"}
            </code>
          </span>
        ) : (
          <span className="text-amber-300">Nenhum serviço escolhido para receber o HTTP do painel.</span>
        )}
        {explanation && <span className="text-xs text-muted-foreground">{explanation}</span>}
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {services.map((s) => {
          const state = containers ? containerState(containerOf(s.name, containers)) : null;
          const isEntry = s.name === entryService;
          return (
            <li
              key={s.name}
              data-testid={`compose-service-${s.name}`}
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-lg border p-3 text-xs text-muted-foreground",
                isEntry && "border-sky-500/50",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-sm font-medium text-foreground">{s.name}</span>
                {isEntry && <Badge variant="default">entrada HTTP</Badge>}
                {state && <Badge variant={state.variant}>{state.label}</Badge>}
              </div>
              <span className="break-words">
                {s.image ? (
                  <>
                    Imagem <code className="font-mono">{s.image}</code>
                  </>
                ) : s.build ? (
                  <>
                    Construído do repositório (<code className="font-mono">{buildLabel(s.build)}</code>)
                  </>
                ) : (
                  "Sem imagem nem build"
                )}
              </span>
              {s.publishedPorts.length > 0 && (
                <span className="break-words">
                  Portas publicadas:{" "}
                  {s.publishedPorts.map((p, i) => (
                    <span key={`${p.mapping}-${i}`}>
                      {i > 0 && " · "}
                      <code className="font-mono">{p.mapping}</code>
                      {p.panel === "removed" && <span className="text-emerald-400"> (o painel retira)</span>}
                      {p.panel === "conflict" && <span className="text-amber-300"> (conflita com o painel)</span>}
                    </span>
                  ))}
                </span>
              )}
              {s.internalPorts.length > 0 && (
                <span className="break-words">
                  Portas internas:{" "}
                  {s.internalPorts.map((p) => `${p.port} (${INTERNAL_SOURCE[p.source]})`).join(", ")}
                </span>
              )}
              {s.networkModeService && <span>Usa a rede do {s.networkModeService}</span>}
              {s.dependsOn.length > 0 && (
                <span className="break-words">
                  Depende de:{" "}
                  {s.dependsOn
                    .map((d) => (d.condition && CONDITION[d.condition] ? `${d.service} (${CONDITION[d.condition]})` : d.service))
                    .join(", ")}
                </span>
              )}
              <span>{HEALTHCHECK[s.healthcheck ?? "none"]}</span>
            </li>
          );
        })}
      </ul>
      {services.some((s) => s.publishedPorts.some((p) => p.panel === "conflict")) && (
        <p className="text-xs text-amber-300">
          As portas 80 e 443 marcadas como “conflita com o painel” são de um proxy HTTPS próprio: o painel não as
          retira e o deploy fica bloqueado. O caminho é um compose.paas.yaml sem essas portas.
        </p>
      )}
    </div>
  );
}

/** Portas candidatas para a entrada: as do serviço e as de quem usa a rede dele. */
function knownPorts(services: ComposeServiceInfo[], name: string): number[] {
  const ports = new Set<number>();
  for (const s of services.filter((x) => x.name === name || x.networkModeService === name)) {
    for (const p of s.publishedPorts) ports.add(p.containerPort);
    for (const p of s.internalPorts) ports.add(p.port);
  }
  return [...ports].sort((a, b) => a - b);
}

export function validPortText(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/** Escolha do serviço e da porta interna que recebem o HTTP do painel. */
export function ComposeEntryPicker({
  services,
  service,
  port,
  onServiceChange,
  onPortChange,
}: {
  services: ComposeServiceInfo[];
  service: string;
  port: string;
  onServiceChange: (value: string) => void;
  onPortChange: (value: string) => void;
}) {
  const options = services.filter((s) => !s.networkModeService).map((s) => s.name);
  if (service && !options.includes(service)) options.push(service);
  const ports = knownPorts(services, service);
  const portInvalid = port.trim() !== "" && !validPortText(port);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 text-sm">
        Serviço que recebe o HTTP
        <select
          value={service}
          onChange={(e) => onServiceChange(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {!service && <option value="">escolha um serviço</option>}
          {options.map((name) => (
            <option key={name} value={name} className="bg-background">
              {name}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          Quem usa a rede de outro serviço (network_mode) não aparece: a entrada é o dono da rede.
        </span>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Porta interna (dentro da rede Docker)
        <Input value={port} onChange={(e) => onPortChange(e.target.value)} inputMode="numeric" />
        {portInvalid && <span className="text-xs text-destructive">Use um número entre 1 e 65535.</span>}
        {ports.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            Portas conhecidas:
            {ports.map((p) => (
              <Button
                key={p}
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 font-mono"
                onClick={() => onPortChange(String(p))}
              >
                {p}
              </Button>
            ))}
          </span>
        )}
      </label>
    </div>
  );
}

/** Card "Serviços do compose" da página do projeto, com a troca da entrada. */
export function ComposeServicesCard({
  project,
  containers,
  onChanged,
}: {
  project: Project;
  containers: DockerContainerInfo[];
  onChanged: () => void;
}) {
  const services = project.detection?.services;
  const initialService = project.proxyService ?? project.detection?.proxyService ?? "";
  const initialPort = project.proxyPort ?? project.detection?.proxyPort ?? null;
  const [service, setService] = useState(initialService);
  const [port, setPort] = useState(initialPort ? String(initialPort) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ proxyService: service || null, proxyPort: port ? Number(port) : null }),
      });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar a entrada.");
    } finally {
      setBusy(false);
    }
  }

  async function redetect() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${project.id}/detect`, { method: "POST" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao ler o compose.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="compose-services">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="h-4 w-4" /> Serviços do compose{services ? ` (${services.length})` : ""}
        </CardTitle>
        <CardDescription>O que sobe no deploy e por onde o site recebe as visitas.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!services ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <p>
              Este projeto foi lido antes de o painel listar os serviços. Leia o compose de novo para ver todos (nada é
              publicado agora).
            </p>
            <Button variant="info" size="sm" disabled={busy} onClick={() => void redetect()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Ler o compose de novo
            </Button>
          </div>
        ) : (
          <>
            <ComposeServicesList
              services={services}
              entryService={initialService || null}
              entryPort={initialPort}
              containers={containers}
            />
            <ComposeEntryPicker
              services={services}
              service={service}
              port={port}
              onServiceChange={(v) => {
                setService(v);
                setSaved(false);
              }}
              onPortChange={(v) => {
                setPort(v);
                setSaved(false);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="success"
                size="sm"
                disabled={busy || !service || !validPortText(port)}
                onClick={() => void save()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Salvar entrada
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Entrada salva — vale no próximo deploy.
                </span>
              )}
            </div>
          </>
        )}
        {error && <p className="whitespace-pre-line text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
