/**
 * ports.ts — funções do modal "Portas" (página do projeto): texto de cada
 * porta, ordenação das duas abas, busca, conferência da porta nova antes de
 * mandar ao servidor (que confere de novo) e a ordenação lembrada no navegador.
 */
import type { PortUsageRow, ProjectPortService } from "@paas/core";

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
