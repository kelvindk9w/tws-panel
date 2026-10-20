import { useState } from "react";
import type { ComposeServiceInfo, DockerContainerInfo, Project } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, t, Trans, useI18n, type Key } from "@/i18n";
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

const INTERNAL_SOURCE: Record<ComposeServiceInfo["internalPorts"][number]["source"], Key> = {
  expose: "compose.source.expose",
  dockerfile: "compose.source.dockerfile",
  healthcheck: "compose.source.healthcheck",
  environment: "compose.source.environment",
};

const CONDITION: Record<string, Key> = {
  service_healthy: "compose.condition.healthy",
  service_started: "compose.condition.started",
  service_completed_successfully: "compose.condition.completed",
};

const HEALTHCHECK: Record<NonNullable<ComposeServiceInfo["healthcheck"]> | "none", Key> = {
  compose: "compose.healthcheck.compose",
  dockerfile: "compose.healthcheck.dockerfile",
  disabled: "compose.healthcheck.disabled",
  none: "compose.healthcheck.none",
};

const PROXY_IMAGE = /^(?:[^/]+\/)*(caddy|nginx|traefik)(?::|@|$)/i;

function buildLabel(build: NonNullable<ComposeServiceInfo["build"]>): string {
  const ctx = build.context.replace(/\/+$/, "");
  return ctx === "." || ctx === "" ? build.dockerfile : `${ctx}/${build.dockerfile}`;
}

type ContainerState = { label: string; variant: "success" | "warning" | "destructive" | "secondary" };

/** Estado do container de um serviço, em palavras simples (também no modal Portas). */
export function containerState(c: Pick<DockerContainerInfo, "state" | "health"> | undefined): ContainerState {
  if (!c) return { label: t("compose.state.none"), variant: "secondary" };
  if (c.state === "running") {
    if (c.health === "unhealthy") return { label: t("compose.state.unhealthy"), variant: "destructive" };
    if (c.health === "healthy") return { label: t("compose.state.healthy"), variant: "success" };
    if (c.health === "starting") return { label: t("compose.state.starting"), variant: "warning" };
    return { label: t("compose.state.running"), variant: "success" };
  }
  if (c.state === "restarting") return { label: t("compose.state.restarting"), variant: "warning" };
  if (c.state === "created") return { label: t("compose.state.created"), variant: "secondary" };
  return { label: t("compose.state.stopped"), variant: "destructive" };
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
    t("compose.entry.explanation", { main: main.name, entry, where }) +
    (others.length > 0 ? ` ${t("compose.entry.sharedNetwork", { count: others.length, names: others.join(", "), entry })}` : "")
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
  const { t } = useI18n();
  const explanation = entryService ? entryExplanation(services, entryService, entryPort) : null;
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="compose-entry"
        className="flex flex-col gap-1 rounded-lg border border-sky-500/40 bg-sky-500/5 p-3 text-sm"
      >
        {entryService ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <ArrowRightLeft className="h-4 w-4 shrink-0 text-sky-400" />
            <Trans
              k="compose.entry.arrives"
              params={{ target: `${entryService}:${entryPort ?? "?"}` }}
              components={{ code: <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-sky-300" /> }}
            />
          </span>
        ) : (
          <span className="text-amber-300">{t("compose.entry.none")}</span>
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
                {isEntry && <Badge variant="default">{t("compose.service.httpEntry")}</Badge>}
                {state && <Badge variant={state.variant}>{state.label}</Badge>}
              </div>
              <span className="break-words">
                {s.image ? (
                  <Trans
                    k="compose.service.image"
                    params={{ image: s.image }}
                    components={{ code: <code className="font-mono" /> }}
                  />
                ) : s.build ? (
                  <Trans
                    k="compose.service.build"
                    params={{ path: buildLabel(s.build) }}
                    components={{ code: <code className="font-mono" /> }}
                  />
                ) : (
                  t("compose.service.noImage")
                )}
              </span>
              {s.publishedPorts.length > 0 && (
                <span className="break-words">
                  {t("compose.service.publishedPorts")}{" "}
                  {s.publishedPorts.map((p, i) => (
                    <span key={`${p.mapping}-${i}`}>
                      {i > 0 && " · "}
                      <code className="font-mono">{p.mapping}</code>
                      {p.panel === "removed" && <span className="text-emerald-400"> {t("compose.service.panelRemoves")}</span>}
                      {p.panel === "conflict" && <span className="text-amber-300"> {t("compose.service.panelConflict")}</span>}
                    </span>
                  ))}
                </span>
              )}
              {s.internalPorts.length > 0 && (
                <span className="break-words">
                  {t("compose.service.internalPorts")}{" "}
                  {s.internalPorts.map((p) => `${p.port} (${t(INTERNAL_SOURCE[p.source])})`).join(", ")}
                </span>
              )}
              {s.networkModeService && <span>{t("compose.service.usesNetwork", { service: s.networkModeService })}</span>}
              {s.dependsOn.length > 0 && (
                <span className="break-words">
                  {t("compose.service.dependsOn")}{" "}
                  {s.dependsOn
                    .map((d) => {
                      const condition = d.condition ? CONDITION[d.condition] : undefined;
                      return condition ? `${d.service} (${t(condition)})` : d.service;
                    })
                    .join(", ")}
                </span>
              )}
              <span>{t(HEALTHCHECK[s.healthcheck ?? "none"])}</span>
            </li>
          );
        })}
      </ul>
      {services.some((s) => s.publishedPorts.some((p) => p.panel === "conflict")) && (
        <p className="text-xs text-amber-300">
          {t("compose.conflictNote")}
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
  const { t } = useI18n();
  const options = services.filter((s) => !s.networkModeService).map((s) => s.name);
  if (service && !options.includes(service)) options.push(service);
  const ports = knownPorts(services, service);
  const portInvalid = port.trim() !== "" && !validPortText(port);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 text-sm">
        {t("compose.picker.service")}
        <select
          value={service}
          onChange={(e) => onServiceChange(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {!service && <option value="">{t("compose.picker.choose")}</option>}
          {options.map((name) => (
            <option key={name} value={name} className="bg-background">
              {name}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {t("compose.picker.networkHint")}
        </span>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        {t("compose.picker.port")}
        <Input value={port} onChange={(e) => onPortChange(e.target.value)} inputMode="numeric" />
        {portInvalid && <span className="text-xs text-destructive">{t("compose.picker.portInvalid")}</span>}
        {ports.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {t("compose.picker.knownPorts")}
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
  const { t } = useI18n();
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
      setError(apiErrorText(err, "compose.card.saveFailed"));
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
      setError(apiErrorText(err, "compose.card.redetectFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="compose-services">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="h-4 w-4" /> {t("compose.card.title")}{services ? ` (${services.length})` : ""}
        </CardTitle>
        <CardDescription>{t("compose.card.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!services ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <p>
              {t("compose.card.legacy")}
            </p>
            <Button variant="info" size="sm" disabled={busy} onClick={() => void redetect()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("compose.card.redetect")}
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
                {t("compose.card.save")}
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t("compose.card.saved")}
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
