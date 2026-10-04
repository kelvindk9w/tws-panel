import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  PortBindAddress,
  PortUsageRow,
  ProjectPortEntry,
  ProjectPortService,
  ProjectPortsResponse,
  SetPortRequest,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import {
  bindingText,
  checkNewPort,
  filterRows,
  loadSort,
  ownerLabel,
  saveSort,
  sortRows,
  sortServices,
  type AllSortKey,
  type ProjectSortKey,
  type SortState,
} from "@/lib/ports";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowDown, ArrowRightLeft, ArrowUp, ArrowUpDown, Loader2, Plug, Rocket, Search, X } from "lucide-react";
import { containerState } from "./ComposeServices";

/**
 * Modal "Portas" da página do projeto. Pedido do dono (03/10/2026, depois de
 * publicar o cassino): ver as portas dos containers do projeto e de todo o
 * servidor, ordenar, e trocar a porta publicada pelo painel.
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
  const [port, setPort] = useState("");
  const [address, setAddress] = useState<PortBindAddress>("127.0.0.1");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const clientError =
    checkNewPort(port, rows, reserved, { projectId, service }) ??
    (port.trim() === "" && entry.hostPort === null ? "Informe a nova porta (no compose ela não é um número fixo)." : null);
  const error = serverError ?? clientError;

  async function send(body: SetPortRequest) {
    setBusy(true);
    setServerError(null);
    try {
      onSaved(await apiFetch<ProjectPortsResponse>(`/api/projects/${projectId}/ports`, { method: "PUT", body: JSON.stringify(body) }));
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Não foi possível salvar a troca.");
      setBusy(false);
    }
  }

  const base = { service, original: entry.original };
  const inputId = `port-${service}-${entry.original}`;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-sky-500/40 bg-sky-500/5 p-3" data-testid="port-form">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-foreground">
          Nova porta do servidor
        </label>
        <Input
          id={inputId}
          inputMode="numeric"
          className="max-w-[12rem] font-mono"
          placeholder={entry.hostPort !== null ? `manter ${entry.hostPort}` : "ex.: 18010"}
          value={port}
          onChange={(e) => {
            setPort(e.target.value);
            setServerError(null);
          }}
        />
        <span className="text-xs text-muted-foreground">
          De 1024 a 65535. Vazio = manter a mesma. A porta interna ({entry.containerPort}) não muda.
        </span>
      </div>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="mb-1 text-xs font-medium text-foreground">Onde a porta fica aberta</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name={`${inputId}-ip`} className="mt-1" checked={address === "127.0.0.1"} onChange={() => setAddress("127.0.0.1")} />
          <span>
            Só no servidor (127.0.0.1) — recomendado
            <span className="block text-xs text-muted-foreground">Só programas da própria VPS (e túnel SSH) chegam nela.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name={`${inputId}-ip`} className="mt-1" checked={address === "0.0.0.0"} onChange={() => setAddress("0.0.0.0")} />
          <span>Em todos os endereços (0.0.0.0)</span>
        </label>
      </fieldset>
      {address === "0.0.0.0" && (
        <p data-testid="port-exposed-warning" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            A porta fica aberta para a internet. Na maioria das VPS o Docker publica por fora do firewall (UFW); se a sua
            tem regras para o Docker, o UFW pode bloquear. Depois do deploy, teste de fora da VPS.
          </span>
        </p>
      )}
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Salvar troca
        </Button>
        {entry.published && (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void send({ ...base, action: "remove" })}>
            Remover publicação
          </Button>
        )}
        {entry.override && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ ...base, action: "reset" })}>
            Voltar ao compose
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      {entry.published && (
        <span className="text-xs text-muted-foreground">
          Remover publicação: a porta deixa de existir no servidor; o app continua acessível pelo painel e pela rede interna
          dos containers.
        </span>
      )}
    </div>
  );
}

function PortLine({ entry, canChange, onChange }: { entry: ProjectPortEntry; canChange: boolean; onChange: () => void }) {
  const text = entry.published
    ? entry.hostPort !== null
      ? bindingText(entry.hostIp, entry.hostPort, entry.containerPort, entry.protocol)
      : `${entry.composeHost} → ${entry.containerPort}`
    : entry.original;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <code className={cn("break-all font-mono text-xs", !entry.published && "text-muted-foreground line-through")}>{text}</code>
        {entry.panel === "removed" && <Badge variant="secondary">o painel retira (80/443 são do painel)</Badge>}
        {entry.panel === "conflict" && <Badge variant="destructive">conflita com o painel</Badge>}
        {entry.panel === null && !entry.published && <Badge variant="secondary">publicação removida</Badge>}
        {entry.published && entry.hostIp === null && <Badge variant="warning">aberta a todos os endereços</Badge>}
        {entry.override && <Badge variant="outline">trocada no painel</Badge>}
        {entry.applied === false && <Badge variant="warning">vale no próximo deploy</Badge>}
        {entry.applied === true && entry.published && <Badge variant="success">no ar</Badge>}
        {canChange && entry.changeable && (
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onChange}>
            <ArrowRightLeft className="h-3.5 w-3.5" /> Trocar
          </Button>
        )}
      </div>
      {entry.override && <span className="text-xs text-muted-foreground">no compose: {entry.original}</span>}
    </div>
  );
}

function ServiceCard({
  service,
  canChange,
  editing,
  onEdit,
  form,
}: {
  service: ProjectPortService;
  canChange: boolean;
  editing: string | null;
  onEdit: (original: string | null) => void;
  form: (entry: ProjectPortEntry) => ReactNode;
}) {
  const state = service.container ? containerState({ state: service.state ?? "", health: service.health }) : null;
  return (
    <li data-testid={`port-service-${service.name}`} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-medium">{service.name}</span>
        <Badge variant={state?.variant ?? "secondary"}>{state?.label ?? "sem container"}</Badge>
        {service.container && service.container !== service.name && (
          <span className="break-all font-mono text-xs text-muted-foreground">{service.container}</span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        Portas internas: {service.internalPorts.length > 0 ? service.internalPorts.join(", ") : "não identificadas"}
      </span>
      {service.networkModeService && (
        <span className="text-xs text-muted-foreground">Usa a rede do {service.networkModeService}: as portas publicadas são as dele.</span>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">Publicadas no servidor</span>
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
          <span className="text-xs text-muted-foreground">nenhuma — só acessível pela rede interna e pelo painel</span>
        )}
      </div>
    </li>
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
  const { project } = data;
  const [sort, setSort] = useState(() => loadSort<ProjectSortKey>("project", PROJECT_SORT_KEYS, { key: "service", dir: "asc" }));
  const [editing, setEditing] = useState<{ service: string; original: string } | null>(null);
  const services = useMemo(() => sortServices(project.services, sort), [project.services, sort]);

  function onSort(key: ProjectSortKey) {
    const next = nextSort(sort, key);
    setSort(next);
    saveSort("project", next);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Porta interna é onde o app escuta dentro do container; só muda no código do app. Porta publicada é a porta do
        servidor que leva até ele; o painel pode trocar.
      </p>
      {project.entry && (
        <p data-testid="ports-entry" className="flex flex-wrap items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/5 p-2 text-sm">
          <ArrowRightLeft className="h-4 w-4 shrink-0 text-sky-400" /> O HTTP do painel chega em{" "}
          <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-sky-300">
            {project.entry.service ? `${project.entry.service}:${project.entry.port ?? "?"}` : `porta ${project.entry.port} do container`}
          </code>
          <span className="text-xs text-muted-foreground">(pela rede interna — não precisa de porta publicada)</span>
        </p>
      )}
      {!project.canChange && (
        <p data-testid="ports-cannot-change" className="text-xs text-muted-foreground">
          {project.type === "compose"
            ? "O código do projeto ainda não está no servidor. Faça o primeiro deploy para ver e trocar as portas do compose."
            : "Trocar a porta pelo painel só vale para projetos compose. Aqui aparecem as portas que estão no ar."}
        </p>
      )}
      {project.pendingDeploy && (
        <div data-testid="ports-pending" className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-sm sm:flex-row sm:items-center">
          <span className="flex-1">Há troca salva que ainda não está no ar: vale no próximo deploy.</span>
          {onDeploy && (
            <Button size="sm" variant="deploy" onClick={onDeploy}>
              <Rocket className="h-4 w-4" /> Fazer deploy agora
            </Button>
          )}
        </div>
      )}
      {project.services.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          Ordenar por:
          <SortButton label="Serviço" sortKey="service" sort={sort} onSort={onSort} />
          <SortButton label="Porta" sortKey="port" sort={sort} onSort={onSort} />
          <SortButton label="Estado" sortKey="state" sort={sort} onSort={onSort} />
        </div>
      )}
      {services.length === 0 && <p className="text-sm text-muted-foreground">Nenhum container deste projeto ainda.</p>}
      <ul className="grid gap-2 lg:grid-cols-2">
        {services.map((s) => (
          <ServiceCard
            key={s.name}
            service={s}
            canChange={project.canChange}
            editing={editing?.service === s.name ? editing.original : null}
            onEdit={(original) => setEditing(original ? { service: s.name, original } : null)}
            form={(entry) => (
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
            )}
          />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba "Todos os projetos"
// ---------------------------------------------------------------------------

function rowPort(r: PortUsageRow): string {
  if (r.hostPort === null && r.containerPort === null) return "nenhuma publicada";
  return bindingText(r.hostIp, r.hostPort, r.containerPort ?? 0, r.protocol);
}

function rowState(r: PortUsageRow): ReactNode {
  if (r.source === "configured") return <Badge variant="outline">vai usar (próximo deploy ou ao iniciar)</Badge>;
  const s = containerState({ state: r.state ?? "", health: null });
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function rowKey(r: PortUsageRow, i: number): string {
  return `${r.container ?? r.service}-${r.hostIp}-${r.hostPort}-${r.containerPort}-${r.protocol}-${r.source}-${i}`;
}

function AllTab({ rows }: { rows: PortUsageRow[] }) {
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
        Todos os containers do servidor: os dos projetos do painel, os do próprio painel e os externos.
      </p>
      {conflicts > 0 && (
        <p data-testid="ports-conflicts" className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          {conflicts} portas em conflito — duas coisas querem a mesma porta do servidor. Troque uma delas.
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Buscar projeto, container, imagem ou porta"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* celular: só a ordenação; as linhas viram lista empilhada */}
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground md:hidden">
        Ordenar por:
        <SortButton label="Projeto" sortKey="project" sort={sort} onSort={onSort} />
        <SortButton label="Container" sortKey="container" sort={sort} onSort={onSort} />
        <SortButton label="Porta" sortKey="port" sort={sort} onSort={onSort} />
        <SortButton label="Estado" sortKey="state" sort={sort} onSort={onSort} />
      </div>
      {shown.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma porta encontrada.</p>}
      <table data-testid="ports-table" className="hidden w-full text-sm md:table">
        <thead className="border-b text-xs">
          <tr>
            {header("Projeto", "project")}
            {header("Container", "container")}
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Imagem</th>
            {header("Porta", "port")}
            {header("Estado", "state")}
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
                {r.service && r.owner === "project" && <span className="block text-xs text-muted-foreground">serviço {r.service}</span>}
              </td>
              <td className="break-all px-2 py-1.5 font-mono text-xs text-muted-foreground">{r.image ?? "—"}</td>
              <td className="px-2 py-1.5">
                <code className="font-mono text-xs">{rowPort(r)}</code>
                {r.conflict && <span className="block text-xs text-red-300">conflito com {r.conflictWith}</span>}
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
              {r.service && r.owner === "project" ? ` · serviço ${r.service}` : ""}
            </span>
            {r.image && <span className="break-all font-mono text-xs text-muted-foreground">{r.image}</span>}
            <code className="break-all font-mono text-xs">{rowPort(r)}</code>
            {r.conflict && <span className="text-xs text-red-300">conflito com {r.conflictWith}</span>}
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
  const [tab, setTab] = useState<"project" | "all">("project");
  const [data, setData] = useState<ProjectPortsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectPortsResponse>(`/api/projects/${projectId}/ports`)
      .then((r) => !cancelled && setData(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Não foi possível carregar as portas."));
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
        aria-label="Portas"
        data-testid="ports-modal"
        className="flex max-h-[90dvh] w-full max-w-5xl flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plug className="h-5 w-5" /> Portas
          </h2>
          <Button variant="ghost" size="icon" aria-label="Fechar" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div role="tablist" aria-label="Portas" className="flex flex-wrap gap-1 border-b pb-2">
          <button type="button" role="tab" aria-selected={tab === "project"} className={tabClass(tab === "project")} onClick={() => setTab("project")}>
            Este projeto
          </button>
          <button type="button" role="tab" aria-selected={tab === "all"} className={tabClass(tab === "all")} onClick={() => setTab("all")}>
            Todos os projetos
          </button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!data && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {data && !data.docker && (
          <p data-testid="ports-docker-down" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            O Docker não respondeu agora: aparece só o que está configurado nos projetos do painel.
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
