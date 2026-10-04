/**
 * ports.ts — funções do modal "Portas" (página do projeto): texto de cada
 * porta, ordenação das duas abas, busca, conferência da porta nova antes de
 * mandar ao servidor (que confere de novo) e a ordenação lembrada no navegador.
 */
import type {
  PortBindAddress,
  PortProtocol,
  PortPublicationInput,
  PortUsageRow,
  ProjectPortService,
  ProjectPortsView,
} from "@paas/core";

export type SortDir = "asc" | "desc";
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}
export type ProjectSortKey = "service" | "port" | "state";
export type AllSortKey = "project" | "container" | "port" | "state";

/** "127.0.0.1:8010 → 8010"; sem porta do servidor, "80 (só interna)". */
export function bindingText(hostIp: string | null, hostPort: number | null, containerPort: number, protocol: string): string {
  const proto = protocol === "tcp" ? "" : `/${protocol}`;
  if (hostPort === null) return `${containerPort}${proto} (só interna)`;
  const ip = hostIp === null ? "0.0.0.0" : hostIp.includes(":") ? `[${hostIp}]` : hostIp;
  return `${ip}:${hostPort} → ${containerPort}${proto}`;
}

export function ownerLabel(row: PortUsageRow): string {
  if (row.owner === "panel") return "Painel";
  if (row.owner === "external") return "Externo";
  return row.projectName ?? "Projeto";
}

const STATE_RANK: Record<string, number> = { running: 0, restarting: 1, created: 2, paused: 2, exited: 3, dead: 3 };

function stateRank(state: string | null): number {
  return state === null ? 9 : (STATE_RANK[state] ?? 4);
}

/** Números ausentes ficam sempre no fim, nos dois sentidos. */
function compareNullable(a: number | null, b: number | null, dir: SortDir): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir === "asc" ? a - b : b - a;
}

function compareText(a: string, b: string, dir: SortDir): number {
  const r = a.localeCompare(b, "pt-BR");
  return dir === "asc" ? r : -r;
}

export function sortRows(rows: PortUsageRow[], sort: SortState<AllSortKey>): PortUsageRow[] {
  const by = (a: PortUsageRow, b: PortUsageRow): number => {
    switch (sort.key) {
      case "project":
        return compareText(ownerLabel(a), ownerLabel(b), sort.dir);
      case "container":
        return compareText(a.container ?? a.service ?? "", b.container ?? b.service ?? "", sort.dir);
      case "port":
        return compareNullable(a.hostPort, b.hostPort, sort.dir);
      case "state":
        return compareNullable(stateRank(a.state), stateRank(b.state), sort.dir);
    }
  };
  return [...rows].sort((a, b) => by(a, b) || compareNullable(a.hostPort, b.hostPort, "asc"));
}

function firstPort(s: ProjectPortService): number | null {
  const ports = [...s.ports.filter((p) => p.published).map((p) => p.hostPort), ...s.livePorts.map((p) => p.hostPort)];
  const known = ports.filter((p): p is number => p !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

export function sortServices(services: ProjectPortService[], sort: SortState<ProjectSortKey>): ProjectPortService[] {
  const by = (a: ProjectPortService, b: ProjectPortService): number => {
    switch (sort.key) {
      case "service":
        return compareText(a.name, b.name, sort.dir);
      case "port":
        return compareNullable(firstPort(a), firstPort(b), sort.dir);
      case "state":
        return compareNullable(stateRank(a.state), stateRank(b.state), sort.dir);
    }
  };
  return [...services].sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
}

export function filterRows(rows: PortUsageRow[], query: string): PortUsageRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [ownerLabel(r), r.container, r.service, r.image, r.hostPort, r.containerPort]
      .filter((v) => v !== null && v !== undefined)
      .some((v) => String(v).toLowerCase().includes(q)),
  );
}

/**
 * Confere a porta digitada (vazio = manter a mesma). Devolve a frase do
 * problema ou null. O servidor confere de novo ao salvar.
 */
export function checkNewPort(
  text: string,
  rows: PortUsageRow[],
  reserved: number[],
  own: { projectId: string; service: string },
): string | null {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "Digite só o número da porta.";
  const port = Number(t);
  if (port === 80 || port === 443) return "As portas 80 e 443 são do painel (ele recebe o tráfego de todos os sites).";
  if (port < 1024 || port > 65535) return "Use uma porta de 1024 a 65535.";
  if (reserved.includes(port)) return `A porta ${port} é reservada ao painel. Escolha outra.`;
  const other = rows.find(
    (r) => r.hostPort === port && !(r.owner === "project" && r.projectId === own.projectId && r.service === own.service),
  );
  if (other) {
    const who =
      other.owner === "project"
        ? `${other.projectName} · ${other.service}`
        : other.owner === "panel"
          ? "o painel"
          : `container ${other.container}`;
    return `A porta ${port} já é usada por ${who}. Escolha outra.`;
  }
  return null;
}

const SORT_PREFIX = "paas.ports.sort.";

/** Ordenação lembrada no navegador; qualquer problema volta ao padrão. */
export function loadSort<K extends string>(name: string, keys: readonly K[], fallback: SortState<K>): SortState<K> {
  try {
    const raw = localStorage.getItem(SORT_PREFIX + name);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SortState<K>>;
    if (parsed && keys.includes(parsed.key as K) && (parsed.dir === "asc" || parsed.dir === "desc")) {
      return { key: parsed.key as K, dir: parsed.dir };
    }
  } catch {
    // armazenamento bloqueado ou valor quebrado
  }
  return fallback;
}

export function saveSort<K extends string>(name: string, sort: SortState<K>): void {
  try {
    localStorage.setItem(SORT_PREFIX + name, JSON.stringify(sort));
  } catch {
    // armazenamento bloqueado: a ordenação vale só nesta visita
  }
}

// ---------------------------------------------------------------------------
// Edição em lote e "Publicar uma porta" (pedido do dono, 04/10/2026: "não
// consigo trocar de cada container ou em lote?"). As duas mandam a lista
// COMPLETA ao servidor (PUT /api/projects/:id/ports/batch): o rascunho sai da
// aba do projeto, é conferido inteiro aqui e de novo no servidor.
// ---------------------------------------------------------------------------

/** Os dois endereços de escuta que o painel oferece. */
export const BIND_ADDRESSES: readonly PortBindAddress[] = ["127.0.0.1", "0.0.0.0"];

/** Uma linha do rascunho: uma porta do compose ou uma publicação adicionada. */
export interface DraftRow {
  id: string;
  service: string;
  /** Chave da porta do compose; null = adicionada no painel. */
  original: string | null;
  /** Texto dos campos (o que a pessoa digitou). */
  containerPort: string;
  protocol: string;
  hostPort: string;
  /** "127.0.0.1", "0.0.0.0" ou o endereço que o próprio compose usa. */
  hostIp: string;
  /** Porta do compose com a publicação removida. */
  removed: boolean;
  /** O que o compose pede (null nas adicionadas). */
  compose: { hostPort: number | null; hostIp: string } | null;
}

function ipText(ip: string | null | undefined): string {
  return ip === null || ip === undefined ? "0.0.0.0" : ip;
}

/** O rascunho a partir da aba do projeto: as portas que o painel pode mexer (sem 80/443). */
export function draftFromView(view: ProjectPortsView): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const service of view.services) {
    for (const e of service.ports) {
      if (!e.changeable) continue;
      const id = `${service.name}|${e.original}`;
      if (e.added ?? Boolean(e.override?.added)) {
        rows.push({
          id,
          service: service.name,
          original: null,
          containerPort: String(e.containerPort),
          protocol: e.protocol,
          hostPort: String(e.hostPort ?? ""),
          hostIp: ipText(e.hostIp),
          removed: false,
          compose: null,
        });
        continue;
      }
      const compose = {
        hostPort: e.composeHostPort !== undefined ? e.composeHostPort : e.override ? null : e.hostPort,
        hostIp: ipText(e.composeHostIp !== undefined ? e.composeHostIp : e.override ? null : e.hostIp),
      };
      const removed = !e.published;
      rows.push({
        id,
        service: service.name,
        original: e.original,
        containerPort: String(e.containerPort),
        protocol: e.protocol,
        hostPort: removed ? String(compose.hostPort ?? "") : String(e.hostPort ?? ""),
        hostIp: removed ? compose.hostIp : ipText(e.hostIp),
        removed,
        compose,
      });
    }
  }
  return rows;
}

let draftCounter = 0;

/** Linha nova (publicação adicionada) para um serviço. */
export function addDraftRow(service: string): DraftRow {
  draftCounter += 1;
  return {
    id: `nova-${draftCounter}`,
    service,
    original: null,
    containerPort: "",
    protocol: "tcp",
    hostPort: "",
    hostIp: "127.0.0.1",
    removed: false,
    compose: null,
  };
}

/** A linha é exatamente o que o compose pede (não vai na lista). */
export function isAsCompose(row: DraftRow): boolean {
  return (
    row.compose !== null &&
    !row.removed &&
    row.hostPort.trim() === String(row.compose.hostPort ?? "") &&
    row.hostIp === row.compose.hostIp
  );
}

/** A lista que vai ao servidor e, na mesma ordem, o id de cada linha (para mostrar o erro dela). */
export function draftToRequest(rows: DraftRow[]): { ports: PortPublicationInput[]; ids: string[] } {
  const ports: PortPublicationInput[] = [];
  const ids: string[] = [];
  for (const r of rows) {
    if (r.original !== null) {
      if (r.removed) ports.push({ service: r.service, original: r.original, hostPort: null });
      else if (isAsCompose(r)) continue;
      else ports.push({ service: r.service, original: r.original, hostPort: Number(r.hostPort.trim()), hostIp: r.hostIp as PortBindAddress });
    } else {
      ports.push({
        service: r.service,
        containerPort: Number(r.containerPort.trim()),
        protocol: r.protocol as PortProtocol,
        hostPort: Number(r.hostPort.trim()),
        hostIp: r.hostIp as PortBindAddress,
      });
    }
    ids.push(r.id);
  }
  return { ports, ids };
}

function overlaps(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function bindIp(ip: string): string | null {
  return ip === "0.0.0.0" || ip === "::" ? null : ip;
}

function usedBy(row: PortUsageRow): string {
  if (row.owner === "project") return `por ${row.projectName} · ${row.service}`;
  if (row.owner === "panel") return "pelo painel";
  return `pelo container ${row.container}`;
}

/** Problema da porta do servidor digitada (sem olhar conflitos), ou null. */
function hostPortProblem(text: string, reserved: number[]): string | null {
  const t = text.trim();
  if (t === "") return "Informe a porta do servidor.";
  if (!/^\d+$/.test(t)) return "Digite só o número da porta.";
  const port = Number(t);
  if (port === 80 || port === 443) return "As portas 80 e 443 são do painel (ele recebe o tráfego de todos os sites).";
  if (port < 1024 || port > 65535) return "Use uma porta de 1024 a 65535.";
  if (reserved.includes(port)) return `A porta ${port} é reservada ao painel. Escolha outra.`;
  return null;
}

/**
 * Confere TODAS as linhas juntas: cada uma sozinha e os conflitos entre si e
 * com o resto do servidor (as portas do próprio projeto hoje não contam — vale
 * a lista nova). Devolve o erro de cada linha, pelo id.
 */
export function checkDraft(rows: DraftRow[], serverRows: PortUsageRow[], reserved: number[], projectId: string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const r of rows) {
    if (r.removed) continue;
    if (r.original === null) {
      const c = r.containerPort.trim();
      if (!/^\d+$/.test(c) || Number(c) < 1 || Number(c) > 65535) {
        errors[r.id] = "Informe a porta interna (onde o app escuta dentro do container), de 1 a 65535.";
        continue;
      }
    }
    if (isAsCompose(r)) continue;
    const problem = hostPortProblem(r.hostPort, reserved);
    if (problem) errors[r.id] = problem;
    else if (!(BIND_ADDRESSES as readonly string[]).includes(r.hostIp)) {
      errors[r.id] = "Escolha onde a porta fica aberta: 127.0.0.1 ou 0.0.0.0.";
    }
  }

  const live = rows.filter((r) => !r.removed && /^\d+$/.test(r.hostPort.trim()));
  const others = serverRows.filter((s) => !(s.owner === "project" && s.projectId === projectId));
  for (const r of live) {
    if (errors[r.id] || isAsCompose(r)) continue;
    const port = Number(r.hostPort.trim());
    const ip = bindIp(r.hostIp);
    const twin = live.find(
      (o) => o !== r && Number(o.hostPort.trim()) === port && o.protocol === r.protocol && overlaps(bindIp(o.hostIp), ip),
    );
    if (twin) {
      errors[r.id] = `A porta ${port} do servidor também está na linha de ${twin.service} (→ ${twin.containerPort}).`;
      continue;
    }
    const other = others.find((s) => s.hostPort === port && s.protocol === r.protocol && overlaps(s.hostIp, ip));
    if (other) errors[r.id] = `A porta ${port} do servidor já é usada ${usedBy(other)}. Escolha outra.`;
  }
  return errors;
}

/** Atalho "Fechar todas para a internet": todas as publicações só no servidor (127.0.0.1). */
export function closeAllToLocal(rows: DraftRow[]): DraftRow[] {
  return rows.map((r) => (r.removed ? r : { ...r, hostIp: "127.0.0.1" }));
}

/** Atalho "Voltar tudo ao compose": sem adicionadas, sem trocas, sem remoções. */
export function resetAllToCompose(rows: DraftRow[]): DraftRow[] {
  return rows.flatMap((r) =>
    r.compose === null ? [] : [{ ...r, removed: false, hostPort: String(r.compose.hostPort ?? ""), hostIp: r.compose.hostIp }],
  );
}

/**
 * Porta do servidor sugerida para uma porta interna: ela mesma quando está
 * livre (e na faixa 1024–65535); senão +10000, +20000…; senão a próxima livre.
 */
export function suggestHostPort(internal: number, taken: (port: number) => boolean): number | null {
  const ok = (p: number) => p >= 1024 && p <= 65535 && !taken(p);
  for (let p = internal; p <= 65535; p += 10000) if (ok(p)) return p;
  for (let p = Math.max(1024, internal + 1); p <= 65535; p++) if (ok(p)) return p;
  for (let p = 1024; p < internal; p++) if (ok(p)) return p;
  return null;
}

/** Portas de banco de dados (as mesmas dos guardrails do deploy, compose-ports.ts). */
const DATABASE_PORTS: ReadonlyMap<number, string> = new Map([
  [5432, "PostgreSQL"],
  [3306, "MySQL/MariaDB"],
  [6379, "Redis"],
  [27017, "MongoDB"],
  [1521, "Oracle"],
  [1433, "SQL Server"],
  [5984, "CouchDB"],
  [9200, "Elasticsearch"],
]);

export function databaseName(containerPort: number): string | null {
  return DATABASE_PORTS.get(containerPort) ?? null;
}
