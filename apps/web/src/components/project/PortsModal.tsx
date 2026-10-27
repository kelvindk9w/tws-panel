import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  PortBindAddress,
  PortRowError,
  PortUsageRow,
  ProjectPortEntry,
  ProjectPortService,
  ProjectPortsResponse,
  SetPortRequest,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, t, Trans, useI18n } from "@/i18n";
import {
  addDraftRow,
  bindingText,
  checkDraft,
  checkNewPort,
  closeAllToLocal,
  databaseName,
  draftFromView,
  draftToRequest,
  filterRows,
  isAsCompose,
  loadSort,
  ownerLabel,
  resetAllToCompose,
  saveSort,
  sortRows,
  sortServices,
  suggestHostPort,
  type AllSortKey,
  type DraftRow,
  type ProjectSortKey,
  type SortState,
} from "@/lib/ports";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  Lock,
  Plug,
  Plus,
  Rocket,
  Search,
  Table2,
  Undo2,
  X,
} from "lucide-react";
import { containerState } from "./ComposeServices";

/**
 * Modal "Portas" da página do projeto. Pedido do dono (03/10/2026, depois de
 * publicar a vitrine): ver as portas dos containers do projeto e de todo o
 * servidor, ordenar, e trocar a porta publicada pelo painel.
 *
 * Pedido de 04/10/2026 ("não consigo trocar de cada container ou em lote?"):
 * cada serviço pode publicar uma porta (ou mais uma), e "Editar em lote" vira
 * uma lista editável de todas as portas, salva numa chamada só.
 *
 * Uma consulta ao abrir (o servidor lista o Docker uma vez) alimenta as duas
 * abas. A troca vale no próximo deploy.
 */

const PROJECT_SORT_KEYS = ["service", "port", "state"] as const;
const ALL_SORT_KEYS = ["project", "container", "port", "state"] as const;

function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden />;
  return dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />;
}

function SortButton<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium hover:bg-accent",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      <SortIcon active={active} dir={sort.dir} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Aba "Este projeto"
// ---------------------------------------------------------------------------

/** Onde a porta fica aberta: 127.0.0.1 (recomendado) ou 0.0.0.0. */
function AddressChoice({ name, value, onChange }: { name: string; value: PortBindAddress; onChange: (v: PortBindAddress) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="flex flex-col gap-1.5 text-sm">
      <legend className="mb-1 text-xs font-medium text-foreground">{t("ports.address.legend")}</legend>
      <label className="flex items-start gap-2">
        <input type="radio" name={name} className="mt-1" checked={value === "127.0.0.1"} onChange={() => onChange("127.0.0.1")} />
        <span>
          {t("ports.address.local")}
          <span className="block text-xs text-muted-foreground">{t("ports.address.localHint")}</span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" name={name} className="mt-1" checked={value === "0.0.0.0"} onChange={() => onChange("0.0.0.0")} />
        <span>{t("ports.address.all")}</span>
      </label>
    </fieldset>
  );
}

function ExposedWarning() {
  const { t } = useI18n();
  return (
    <p data-testid="port-exposed-warning" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{t("ports.exposedWarning")}</span>
    </p>
  );
}

/** Banco aberto para a internet: o risco, para leigo, e o que o deploy faz. */
function DatabaseWarning({ db, testId }: { db: string; testId: string }) {
  const { t } = useI18n();
  return (
    <p data-testid={testId} className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
      <span>{t("ports.databaseWarning", { db })}</span>
    </p>
  );
}

const SAVE_URL = (projectId: string) => `/api/projects/${projectId}/ports/batch`;

/** Grava a lista completa; devolve o erro de cada linha (pelo id) quando o servidor recusa. */
async function saveDraft(
  projectId: string,
  rows: DraftRow[],
): Promise<{ data: ProjectPortsResponse } | { message: string; rowErrors: Record<string, string> }> {
  const { ports, ids } = draftToRequest(rows);
  try {
    return { data: await apiFetch<ProjectPortsResponse>(SAVE_URL(projectId), { method: "PUT", body: JSON.stringify({ ports }) }) };
  } catch (err) {
    const rowErrors: Record<string, string> = {};
    const list = err instanceof ApiRequestError ? (err.data?.errors as PortRowError[] | undefined) : undefined;
    for (const e of list ?? []) {
      const id = ids[e.index];
      if (id) rowErrors[id] = e.message;
    }
    return { message: apiErrorText(err, "ports.saveFailed"), rowErrors };
  }
}

/** Portas do servidor já ocupadas (para a sugestão): as do servidor, as reservadas e as do rascunho. */
function takenBy(data: ProjectPortsResponse, rows: DraftRow[], except: string) {
  return (port: number) =>
    data.reserved.includes(port) ||
    data.rows.some((r) => r.hostPort === port) ||
    rows.some((r) => r.id !== except && !r.removed && Number(r.hostPort) === port);
}

/**
 * "Publicar uma porta" / "Adicionar outra" de um serviço, e a troca de uma
 * publicação adicionada (editing). Manda a lista completa do projeto.
 */
function PublishForm({
  data,
  service,
  editing,
  onSaved,
  onCancel,
}: {
  data: ProjectPortsResponse;
  service: ProjectPortService;
  editing: ProjectPortEntry | null;
  onSaved: (data: ProjectPortsResponse) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const base = useMemo(() => draftFromView(data.project), [data.project]);
  const myId = editing ? `${service.name}|${editing.original}` : "publicar";
  const [internal, setInternal] = useState(editing ? String(editing.containerPort) : "");
  const [host, setHost] = useState(editing?.hostPort != null ? String(editing.hostPort) : "");
  const [hostTouched, setHostTouched] = useState(Boolean(editing));
  const [address, setAddress] = useState<PortBindAddress>(editing && editing.hostIp === null ? "0.0.0.0" : "127.0.0.1");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const mine: DraftRow = {
    ...(base.find((r) => r.id === myId) ?? { service: service.name, original: null, protocol: "tcp", removed: false, compose: null }),
    id: myId,
    containerPort: internal,
    hostPort: host,
    hostIp: address,
  };
  const rows = editing ? base.map((r) => (r.id === myId ? mine : r)) : [...base, mine];
  const clientError = checkDraft(rows, data.rows, data.reserved, data.project.projectId)[myId] ?? null;
  const error = serverError ?? clientError;
  const internalNumber = /^\d+$/.test(internal.trim()) ? Number(internal.trim()) : null;
  const db = internalNumber !== null ? databaseName(internalNumber) : null;

  function chooseInternal(text: string) {
    setInternal(text);
    setServerError(null);
    const n = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
    if (!hostTouched && n !== null && n >= 1 && n <= 65535) {
      setHost(String(suggestHostPort(n, takenBy(data, rows, myId)) ?? ""));
    }
  }

  async function send(next: DraftRow[]) {
    setBusy(true);
    setServerError(null);
    const r = await saveDraft(data.project.projectId, next);
    if ("data" in r) return onSaved(r.data);
    setServerError(r.rowErrors[myId] ?? r.message);
    setBusy(false);
  }

  const id = `publish-${service.name}`;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-sky-500/40 bg-sky-500/5 p-3" data-testid="publish-form">
      <p className="text-xs text-muted-foreground">
        {t("ports.publish.intro")}
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-internal`} className="text-xs font-medium text-foreground">
          {t("ports.publish.internalLabel")}
        </label>
        {service.internalPorts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {t("ports.publish.known")}
            {service.internalPorts.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={internal === String(p) ? "secondary" : "outline"}
                className="h-7 font-mono"
                aria-pressed={internal === String(p)}
                onClick={() => chooseInternal(String(p))}
              >
                {p}
              </Button>
            ))}
          </div>
        )}
        <Input
          id={`${id}-internal`}
          inputMode="numeric"
          className="max-w-[12rem] font-mono"
          placeholder={t("ports.placeholder.internal")}
          value={internal}
          onChange={(e) => chooseInternal(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          {t("ports.publish.internalHint")}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-host`} className="text-xs font-medium text-foreground">
          {t("ports.publish.hostLabel")}
        </label>
        <Input
          id={`${id}-host`}
          inputMode="numeric"
          className="max-w-[12rem] font-mono"
          placeholder={t("ports.placeholder.host")}
          value={host}
          onChange={(e) => {
            setHost(e.target.value);
            setHostTouched(true);
            setServerError(null);
          }}
        />
        <span className="text-xs text-muted-foreground">{t("ports.publish.hostHint")}</span>
      </div>
      <AddressChoice name={`${id}-ip`} value={address} onChange={setAddress} />
      {address === "0.0.0.0" && <ExposedWarning />}
      {address === "0.0.0.0" && db && <DatabaseWarning db={db} testId="publish-db-warning" />}
      {address === "127.0.0.1" && db && /^\d+$/.test(host.trim()) && (
        <p className="text-xs text-muted-foreground">
          <Trans
            k="ports.publish.tunnel"
            params={{ host: host.trim(), command: `ssh -L ${host.trim()}:127.0.0.1:${host.trim()} ${t("ports.publish.tunnelTarget")}` }}
            components={{ code: <code className="break-all rounded bg-black/30 px-1 font-mono" /> }}
          />
        </p>
      )}
      {error && (
        <p data-testid="publish-error" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || clientError !== null} onClick={() => void send(rows)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {editing ? t("ports.action.save") : t("ports.action.publish")}
        </Button>
        {editing && (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void send(base.filter((r) => r.id !== myId))}>
            {t("ports.action.removePublication")}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("ports.action.cancel")}
        </Button>
      </div>
    </div>
  );
}

function PortForm({
  projectId,
  service,
  entry,
  rows,
  reserved,
  onSaved,
  onCancel,
}: {
  projectId: string;
  service: string;
  entry: ProjectPortEntry;
  rows: PortUsageRow[];
  reserved: number[];
  onSaved: (data: ProjectPortsResponse) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [port, setPort] = useState("");
  const [address, setAddress] = useState<PortBindAddress>("127.0.0.1");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const clientError =
    checkNewPort(port, rows, reserved, { projectId, service }) ??
    (port.trim() === "" && entry.hostPort === null ? t("ports.form.newPortRequired") : null);
  const error = serverError ?? clientError;

  async function send(body: SetPortRequest) {
    setBusy(true);
    setServerError(null);
    try {
      onSaved(await apiFetch<ProjectPortsResponse>(`/api/projects/${projectId}/ports`, { method: "PUT", body: JSON.stringify(body) }));
    } catch (err) {
      setServerError(apiErrorText(err, "ports.form.saveFailed"));
      setBusy(false);
    }
  }

  const base = { service, original: entry.original };
  const inputId = `port-${service}-${entry.original}`;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-sky-500/40 bg-sky-500/5 p-3" data-testid="port-form">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-foreground">
          {t("ports.form.label")}
        </label>
        <Input
          id={inputId}
          inputMode="numeric"
          className="max-w-[12rem] font-mono"
          placeholder={entry.hostPort !== null ? t("ports.form.keep", { port: entry.hostPort }) : t("ports.placeholder.newHost")}
          value={port}
          onChange={(e) => {
            setPort(e.target.value);
            setServerError(null);
          }}
        />
        <span className="text-xs text-muted-foreground">
          {t("ports.form.hint", { port: entry.containerPort })}
        </span>
      </div>
      <AddressChoice name={`${inputId}-ip`} value={address} onChange={setAddress} />
      {address === "0.0.0.0" && <ExposedWarning />}
      {error && (
        <p data-testid="port-form-error" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || clientError !== null}
          onClick={() =>
            void send({
              ...base,
              action: "change",
              ...(port.trim() !== "" ? { hostPort: Number(port.trim()) } : {}),
              hostIp: address,
            })
          }
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t("ports.form.save")}
        </Button>
        {entry.published && (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void send({ ...base, action: "remove" })}>
            {t("ports.action.removePublication")}
          </Button>
        )}
        {entry.override && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ ...base, action: "reset" })}>
            {t("ports.action.backToCompose")}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("ports.action.cancel")}
        </Button>
      </div>
      {entry.published && (
        <span className="text-xs text-muted-foreground">{t("ports.form.removeHint")}</span>
      )}
    </div>
  );
}

function PortLine({ entry, canChange, onChange }: { entry: ProjectPortEntry; canChange: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const text = entry.published
    ? entry.hostPort !== null
      ? bindingText(entry.hostIp, entry.hostPort, entry.containerPort, entry.protocol)
      : `${entry.composeHost} → ${entry.containerPort}`
    : entry.original;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <code className={cn("break-all font-mono text-xs", !entry.published && "text-muted-foreground line-through")}>{text}</code>
        {entry.panel === "removed" && <Badge variant="secondary">{t("ports.line.panelRemoves")}</Badge>}
        {entry.panel === "conflict" && <Badge variant="destructive">{t("ports.line.panelConflict")}</Badge>}
        {entry.panel === null && !entry.published && <Badge variant="secondary">{t("ports.line.removed")}</Badge>}
        {entry.published && entry.hostIp === null && <Badge variant="warning">{t("ports.line.openAll")}</Badge>}
        {entry.added && <Badge variant="outline">{t("ports.line.added")}</Badge>}
        {entry.override && !entry.added && <Badge variant="outline">{t("ports.line.changed")}</Badge>}
        {entry.applied === false && <Badge variant="warning">{t("ports.line.nextDeploy")}</Badge>}
        {entry.applied === true && entry.published && <Badge variant="success">{t("ports.line.live")}</Badge>}
        {canChange && entry.changeable && (
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onChange}>
            <ArrowRightLeft className="h-3.5 w-3.5" /> {t("ports.line.change")}
          </Button>
        )}
      </div>
      {entry.override && !entry.added && <span className="text-xs text-muted-foreground">{t("ports.line.inCompose", { value: entry.original })}</span>}
    </div>
  );
}

function ServiceCard({
  service,
  canChange,
  editing,
  onEdit,
  form,
  publishForm,
  onPublish,
}: {
  service: ProjectPortService;
  canChange: boolean;
  editing: string | null;
  onEdit: (original: string | null) => void;
  form: (entry: ProjectPortEntry) => ReactNode;
  /** Formulário "Publicar uma porta" aberto neste serviço (null = fechado). */
  publishForm: ReactNode;
  onPublish: () => void;
}) {
  const { t } = useI18n();
  const state = service.container ? containerState({ state: service.state ?? "", health: service.health }) : null;
  const hasPublished = service.ports.some((p) => p.published);
  return (
    <li data-testid={`port-service-${service.name}`} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-medium">{service.name}</span>
        <Badge variant={state?.variant ?? "secondary"}>{state?.label ?? t("compose.state.none")}</Badge>
        {service.container && service.container !== service.name && (
          <span className="break-all font-mono text-xs text-muted-foreground">{service.container}</span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {t("ports.service.internalPorts", {
          ports: service.internalPorts.length > 0 ? service.internalPorts.join(", ") : t("ports.service.unknownPorts"),
        })}
      </span>
      {service.publishBlocked ? (
        <span className="text-xs text-muted-foreground">{service.publishBlocked}</span>
      ) : (
        service.networkModeService && (
          <span className="text-xs text-muted-foreground">{t("ports.service.usesNetwork", { service: service.networkModeService })}</span>
        )
      )}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">{t("ports.service.published")}</span>
        {service.ports.map((entry) => (
          <div key={entry.original} className="flex flex-col gap-2">
            <PortLine entry={entry} canChange={canChange} onChange={() => onEdit(editing === entry.original ? null : entry.original)} />
            {editing === entry.original && form(entry)}
          </div>
        ))}
        {service.ports.length === 0 &&
          service.livePorts.map((p) => (
            <code key={`${p.hostIp}:${p.hostPort}:${p.containerPort}/${p.protocol}`} className="break-all font-mono text-xs">
              {bindingText(p.hostIp, p.hostPort, p.containerPort, p.protocol)}
            </code>
          ))}
        {service.ports.length === 0 && service.livePorts.length === 0 && (
          <span className="text-xs text-muted-foreground">{t("ports.service.none")}</span>
        )}
        {canChange && !service.publishBlocked && !publishForm && (
          <Button size="sm" variant="outline" className="h-7 self-start" onClick={onPublish}>
            <Plus className="h-3.5 w-3.5" /> {hasPublished ? t("ports.service.addAnother") : t("ports.service.publish")}
          </Button>
        )}
        {publishForm}
      </div>
    </li>
  );
}

const SELECT_CLASS = "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50";

function composeText(row: DraftRow): string {
  if (!row.compose) return "";
  return row.compose.hostPort === null
    ? t("ports.composeRandom", { port: row.containerPort })
    : bindingText(row.compose.hostIp === "0.0.0.0" ? null : row.compose.hostIp, row.compose.hostPort, Number(row.containerPort), row.protocol);
}

/**
 * "Editar em lote": todas as portas do projeto (do compose, trocadas e
 * adicionadas) numa lista editável. Confere todas juntas enquanto se digita;
 * "Salvar tudo" grava numa chamada só.
 */
function BatchEditor({
  data,
  onSaved,
  onCancel,
}: {
  data: ProjectPortsResponse;
  onSaved: (data: ProjectPortsResponse) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { project } = data;
  const [rows, setRows] = useState<DraftRow[]>(() => draftFromView(project));
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // linhas novas em que a pessoa já digitou a porta do servidor (a sugestão para de mexer)
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const eligible = project.services.filter((s) => !s.publishBlocked);
  const clientErrors = checkDraft(rows, data.rows, data.reserved, project.projectId);
  const hasClientErrors = Object.keys(clientErrors).length > 0;

  function change(next: DraftRow[]) {
    setRows(next);
    setServerErrors({});
    setTopError(null);
  }

  function update(id: string, patch: Partial<DraftRow>) {
    change(
      rows.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch };
        // linha nova: a porta do servidor segue a sugestão até a pessoa digitar nela
        if (r.original === null && r.compose === null && patch.containerPort !== undefined && !touched.has(id) && id.startsWith("nova-")) {
          const n = /^\d+$/.test(patch.containerPort.trim()) ? Number(patch.containerPort.trim()) : null;
          if (n !== null && n >= 1 && n <= 65535) next.hostPort = String(suggestHostPort(n, takenBy(data, rows, id)) ?? "");
        }
        return next;
      }),
    );
  }

  async function saveAll() {
    setBusy(true);
    const r = await saveDraft(project.projectId, rows);
    if ("data" in r) return onSaved(r.data);
    setServerErrors(r.rowErrors);
    setTopError(r.message);
    setBusy(false);
  }

  return (
    <div data-testid="ports-batch" className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-sm text-muted-foreground">
        <Trans k="ports.batch.intro" components={{ b: <strong /> }} />
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => change(closeAllToLocal(rows))}>
          <Lock className="h-4 w-4" /> {t("ports.batch.closeAll")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => change(resetAllToCompose(rows))}>
          <Undo2 className="h-4 w-4" /> {t("ports.batch.resetAll")}
        </Button>
        {eligible.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => change([...rows, addDraftRow(eligible[0]!.name)])}>
            <Plus className="h-4 w-4" /> {t("ports.batch.add")}
          </Button>
        )}
      </div>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t("ports.batch.empty")}</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const error = serverErrors[r.id] ?? clientErrors[r.id];
          const db = databaseName(Number(r.containerPort));
          const differs = r.compose !== null && !isAsCompose(r);
          const field = `batch-${r.id}`;
          return (
            <li
              key={r.id}
              data-testid="batch-row"
              className={cn(
                "grid min-w-0 grid-cols-2 gap-2 rounded-lg border p-2 text-sm lg:grid-cols-[minmax(0,1fr)_6rem_7rem_12rem_14rem] lg:items-end",
                error && "border-red-500/50 bg-red-500/10",
              )}
            >
              {r.original === null ? (
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  {t("ports.batch.service")}
                  <select className={SELECT_CLASS} value={r.service} onChange={(e) => update(r.id, { service: e.target.value })}>
                    {eligible.map((s) => (
                      <option key={s.name} value={s.name} className="bg-background">
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  {t("ports.batch.service")}
                  <span className="break-all py-2 font-mono text-sm text-foreground">{r.service}</span>
                </div>
              )}
              {r.original === null ? (
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  {t("ports.batch.internal")}
                  <Input
                    inputMode="numeric"
                    className="font-mono"
                    list={`${field}-known`}
                    placeholder={t("ports.placeholder.internal")}
                    value={r.containerPort}
                    onChange={(e) => update(r.id, { containerPort: e.target.value })}
                  />
                  <datalist id={`${field}-known`}>
                    {(project.services.find((s) => s.name === r.service)?.internalPorts ?? []).map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </label>
              ) : (
                <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  {t("ports.batch.internal")}
                  <span className="py-2 font-mono text-sm text-foreground">
                    {r.containerPort}
                    {r.protocol === "tcp" ? "" : `/${r.protocol}`}
                  </span>
                </div>
              )}
              <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                {t("ports.batch.host")}
                <Input
                  inputMode="numeric"
                  className="font-mono"
                  disabled={r.removed}
                  placeholder={r.compose?.hostPort === null ? t("ports.batch.random") : t("ports.placeholder.host")}
                  value={r.hostPort}
                  onChange={(e) => {
                    setTouched(new Set(touched).add(r.id));
                    update(r.id, { hostPort: e.target.value });
                  }}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                {t("ports.batch.address")}
                <select
                  className={SELECT_CLASS}
                  disabled={r.removed}
                  value={r.hostIp}
                  onChange={(e) => update(r.id, { hostIp: e.target.value })}
                >
                  <option value="127.0.0.1" className="bg-background">
                    {t("ports.batch.addressLocal")}
                  </option>
                  <option value="0.0.0.0" className="bg-background">
                    {t("ports.batch.addressAll")}
                  </option>
                  {r.hostIp !== "127.0.0.1" && r.hostIp !== "0.0.0.0" && (
                    <option value={r.hostIp} className="bg-background">
                      {t("ports.batch.fromCompose", { ip: r.hostIp })}
                    </option>
                  )}
                </select>
              </label>
              <div className="col-span-2 flex flex-wrap gap-1 lg:col-span-1 lg:justify-end">
                {r.original === null ? (
                  <Button size="sm" variant="danger" onClick={() => change(rows.filter((x) => x.id !== r.id))}>
                    {t("ports.batch.remove")}
                  </Button>
                ) : r.removed ? (
                  <Button size="sm" variant="outline" onClick={() => update(r.id, { removed: false })}>
                    {t("ports.batch.republish")}
                  </Button>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => update(r.id, { removed: true })}>
                    {t("ports.batch.remove")}
                  </Button>
                )}
                {differs && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update(r.id, { removed: false, hostPort: String(r.compose!.hostPort ?? ""), hostIp: r.compose!.hostIp })
                    }
                  >
                    {t("ports.action.backToCompose")}
                  </Button>
                )}
              </div>
              <div className="col-span-2 flex flex-col gap-1 text-xs lg:col-span-5">
                {r.original === null && <span className="text-muted-foreground">{t("ports.batch.addedNote")}</span>}
                {r.removed && <span className="text-muted-foreground">{t("ports.batch.removedNote")}</span>}
                {differs && !r.removed && <span className="text-muted-foreground">{t("ports.line.inCompose", { value: composeText(r) })}</span>}
                {!r.removed && r.hostIp === "0.0.0.0" && (
                  <span className={db ? "text-red-300" : "text-amber-300"}>
                    {db
                      ? t("ports.batch.databaseOpen", { db })
                      : t("ports.batch.openAll")}
                  </span>
                )}
                {error && (
                  <span data-testid="batch-row-error" className="text-red-300">
                    {error}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {topError && (
        <p data-testid="ports-batch-error" className="text-sm text-red-300">
          {topError}
        </p>
      )}
      {hasClientErrors && <p className="text-xs text-red-300">{t("ports.batch.fixErrors")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || hasClientErrors} onClick={() => void saveAll()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t("ports.batch.saveAll")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("ports.action.cancel")}
        </Button>
      </div>
    </div>
  );
}

function ProjectTab({
  data,
  onSaved,
  onDeploy,
}: {
  data: ProjectPortsResponse;
  onSaved: (data: ProjectPortsResponse) => void;
  onDeploy?: () => void;
}) {
  const { t } = useI18n();
  const { project } = data;
  const [sort, setSort] = useState(() => loadSort<ProjectSortKey>("project", PROJECT_SORT_KEYS, { key: "service", dir: "asc" }));
  const [editing, setEditing] = useState<{ service: string; original: string } | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  // Salvo pelo "Publicar uma porta" ou pelo lote: oferece o deploy na hora.
  const [saved, setSaved] = useState(false);
  const services = useMemo(() => sortServices(project.services, sort), [project.services, sort]);

  function savedAll(next: ProjectPortsResponse) {
    setEditing(null);
    setPublishing(null);
    setBatch(false);
    setSaved(true);
    onSaved(next);
  }

  function onSort(key: ProjectSortKey) {
    const next = nextSort(sort, key);
    setSort(next);
    saveSort("project", next);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t("ports.project.intro")}
      </p>
      {project.entry && (
        <p data-testid="ports-entry" className="flex flex-wrap items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/5 p-2 text-sm">
          <ArrowRightLeft className="h-4 w-4 shrink-0 text-sky-400" />{" "}
          <Trans
            k="compose.entry.arrives"
            params={{
              target: project.entry.service
                ? `${project.entry.service}:${project.entry.port ?? "?"}`
                : t("ports.project.entryContainerPort", { port: project.entry.port ?? "?" }),
            }}
            components={{ code: <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-sky-300" /> }}
          />
          <span className="text-xs text-muted-foreground">{t("ports.project.entryInternal")}</span>
        </p>
      )}
      {!project.canChange && (
        <p data-testid="ports-cannot-change" className="text-xs text-muted-foreground">
          {project.type === "compose"
            ? t("ports.project.noCode")
            : t("ports.project.composeOnly")}
        </p>
      )}
      {saved && (
        <div data-testid="ports-saved" className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-sm sm:flex-row sm:items-center">
          <span className="flex-1">{t("ports.project.saved")}</span>
          {onDeploy && (
            <Button size="sm" variant="deploy" onClick={onDeploy}>
              <Rocket className="h-4 w-4" /> {t("ports.project.deployNow")}
            </Button>
          )}
        </div>
      )}
      {!saved && project.pendingDeploy && (
        <div data-testid="ports-pending" className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-sm sm:flex-row sm:items-center">
          <span className="flex-1">{t("ports.project.pending")}</span>
          {onDeploy && (
            <Button size="sm" variant="deploy" onClick={onDeploy}>
              <Rocket className="h-4 w-4" /> {t("ports.project.deployNow")}
            </Button>
          )}
        </div>
      )}
      {batch && <BatchEditor data={data} onSaved={savedAll} onCancel={() => setBatch(false)} />}
      {!batch && project.canChange && project.services.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => {
            setEditing(null);
            setPublishing(null);
            setBatch(true);
          }}
        >
          <Table2 className="h-4 w-4" /> {t("ports.project.batchEdit")}
        </Button>
      )}
      {!batch && project.services.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {t("ports.sort.by")}
          <SortButton label={t("ports.sort.service")} sortKey="service" sort={sort} onSort={onSort} />
          <SortButton label={t("ports.sort.port")} sortKey="port" sort={sort} onSort={onSort} />
          <SortButton label={t("ports.sort.state")} sortKey="state" sort={sort} onSort={onSort} />
        </div>
      )}
      {services.length === 0 && <p className="text-sm text-muted-foreground">{t("ports.project.noContainers")}</p>}
      {!batch && (
        <ul className="grid gap-2 lg:grid-cols-2">
          {services.map((s) => (
            <ServiceCard
              key={s.name}
              service={s}
              canChange={project.canChange}
              editing={editing?.service === s.name ? editing.original : null}
              onEdit={(original) => {
                setPublishing(null);
                setEditing(original ? { service: s.name, original } : null);
              }}
              onPublish={() => {
                setEditing(null);
                setPublishing(s.name);
              }}
              publishForm={
                publishing === s.name ? (
                  <PublishForm data={data} service={s} editing={null} onSaved={savedAll} onCancel={() => setPublishing(null)} />
                ) : null
              }
              form={(entry) =>
                entry.added ? (
                  <PublishForm data={data} service={s} editing={entry} onSaved={savedAll} onCancel={() => setEditing(null)} />
                ) : (
                  <PortForm
                    projectId={project.projectId}
                    service={s.name}
                    entry={entry}
                    rows={data.rows}
                    reserved={data.reserved}
                    onSaved={(next) => {
                      setEditing(null);
                      onSaved(next);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba "Todos os projetos"
// ---------------------------------------------------------------------------

function rowPort(r: PortUsageRow): string {
  if (r.hostPort === null && r.containerPort === null) return t("ports.all.nonePublished");
  return bindingText(r.hostIp, r.hostPort, r.containerPort ?? 0, r.protocol);
}

function rowState(r: PortUsageRow): ReactNode {
  if (r.source === "configured") return <Badge variant="outline">{t("ports.all.willUse")}</Badge>;
  const s = containerState({ state: r.state ?? "", health: null });
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function rowKey(r: PortUsageRow, i: number): string {
  return `${r.container ?? r.service}-${r.hostIp}-${r.hostPort}-${r.containerPort}-${r.protocol}-${r.source}-${i}`;
}

function AllTab({ rows }: { rows: PortUsageRow[] }) {
  const { t } = useI18n();
  const [sort, setSort] = useState(() => loadSort<AllSortKey>("all", ALL_SORT_KEYS, { key: "project", dir: "asc" }));
  const [query, setQuery] = useState("");
  const shown = useMemo(() => sortRows(filterRows(rows, query), sort), [rows, query, sort]);
  const conflicts = rows.filter((r) => r.conflict).length;

  function onSort(key: AllSortKey) {
    const next = nextSort(sort, key);
    setSort(next);
    saveSort("all", next);
  }

  const header = (label: string, key: AllSortKey) => (
    <th className="px-2 py-1.5 text-left">
      <SortButton label={label} sortKey={key} sort={sort} onSort={onSort} />
    </th>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t("ports.all.intro")}
      </p>
      {conflicts > 0 && (
        <p data-testid="ports-conflicts" className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          {t("ports.all.conflicts", { count: conflicts })}
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder={t("ports.all.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* celular: só a ordenação; as linhas viram lista empilhada */}
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground md:hidden">
        {t("ports.sort.by")}
        <SortButton label={t("ports.sort.project")} sortKey="project" sort={sort} onSort={onSort} />
        <SortButton label={t("ports.sort.container")} sortKey="container" sort={sort} onSort={onSort} />
        <SortButton label={t("ports.sort.port")} sortKey="port" sort={sort} onSort={onSort} />
        <SortButton label={t("ports.sort.state")} sortKey="state" sort={sort} onSort={onSort} />
      </div>
      {shown.length === 0 && <p className="text-sm text-muted-foreground">{t("ports.all.notFound")}</p>}
      <table data-testid="ports-table" className="hidden w-full text-sm md:table">
        <thead className="border-b text-xs">
          <tr>
            {header(t("ports.sort.project"), "project")}
            {header(t("ports.sort.container"), "container")}
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{t("ports.all.image")}</th>
            {header(t("ports.sort.port"), "port")}
            {header(t("ports.sort.state"), "state")}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr
              key={rowKey(r, i)}
              data-testid={r.conflict ? "row-conflict" : "row"}
              className={cn("border-b align-top", r.conflict && "bg-red-500/10")}
            >
              <td className="px-2 py-1.5">{ownerLabel(r)}</td>
              <td className="px-2 py-1.5">
                <span className="break-all font-mono text-xs">{r.container ?? "—"}</span>
                {r.service && r.owner === "project" && <span className="block text-xs text-muted-foreground">{t("ports.all.service", { service: r.service })}</span>}
              </td>
              <td className="break-all px-2 py-1.5 font-mono text-xs text-muted-foreground">{r.image ?? "—"}</td>
              <td className="px-2 py-1.5">
                <code className="font-mono text-xs">{rowPort(r)}</code>
                {r.conflict && <span className="block text-xs text-red-300">{t("ports.all.conflictWith", { other: r.conflictWith ?? "" })}</span>}
              </td>
              <td className="px-2 py-1.5">{rowState(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul data-testid="ports-list" className="flex flex-col gap-2 md:hidden">
        {shown.map((r, i) => (
          <li
            key={rowKey(r, i)}
            className={cn("flex min-w-0 flex-col gap-1 rounded-lg border p-3 text-sm", r.conflict && "border-red-500/50 bg-red-500/10")}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{ownerLabel(r)}</span>
              {rowState(r)}
            </div>
            <span className="break-all font-mono text-xs">
              {r.container ?? "—"}
              {r.service && r.owner === "project" ? ` · ${t("ports.all.service", { service: r.service })}` : ""}
            </span>
            {r.image && <span className="break-all font-mono text-xs text-muted-foreground">{r.image}</span>}
            <code className="break-all font-mono text-xs">{rowPort(r)}</code>
            {r.conflict && <span className="text-xs text-red-300">{t("ports.all.conflictWith", { other: r.conflictWith ?? "" })}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PortsModal({
  projectId,
  onClose,
  onDeploy,
}: {
  projectId: string;
  onClose: () => void;
  /** "Fazer deploy agora" (a troca vale no próximo deploy). */
  onDeploy?: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"project" | "all">("project");
  const [data, setData] = useState<ProjectPortsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectPortsResponse>(`/api/projects/${projectId}/ports`)
      .then((r) => !cancelled && setData(r))
      .catch((err) => !cancelled && setError(apiErrorText(err, "ports.modal.loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabClass = (active: boolean) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm transition-colors",
      active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("ports.modal.title")}
        data-testid="ports-modal"
        className="flex max-h-[90dvh] w-full max-w-5xl flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plug className="h-5 w-5" /> {t("ports.modal.title")}
          </h2>
          <Button variant="ghost" size="icon" aria-label={t("ports.modal.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div role="tablist" aria-label={t("ports.modal.title")} className="flex flex-wrap gap-1 border-b pb-2">
          <button type="button" role="tab" aria-selected={tab === "project"} className={tabClass(tab === "project")} onClick={() => setTab("project")}>
            {t("ports.modal.tabProject")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "all"} className={tabClass(tab === "all")} onClick={() => setTab("all")}>
            {t("ports.modal.tabAll")}
          </button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!data && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {data && !data.docker && (
          <p data-testid="ports-docker-down" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {t("ports.modal.dockerDown")}
          </p>
        )}
        {data && tab === "project" && (
          <ProjectTab
            data={data}
            onSaved={setData}
            onDeploy={
              onDeploy
                ? () => {
                    onDeploy();
                    onClose();
                  }
                : undefined
            }
          />
        )}
        {data && tab === "all" && <AllTab rows={data.rows} />}
      </div>
    </div>
  );
}
