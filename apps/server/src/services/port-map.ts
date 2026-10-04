/**
 * port-map.ts — o mapa de portas do modal "Portas" da página do projeto.
 *
 * Pedido do dono (03/10/2026, depois de publicar o cassino): ver as portas
 * dos containers do projeto e de todo o servidor, e trocar a porta publicada.
 *
 * Junta duas fontes, sem chamar o Docker (quem chama passa a listagem):
 *  - o que está no ar: a coluna Ports do `docker ps` de cada container;
 *  - o que cada projeto compose do painel vai publicar: as portas do compose
 *    com as trocas feitas no painel (Project.portOverrides) — um projeto
 *    parado também "quer" a porta dele, e é aí que aparece o conflito.
 *
 * Lógica pura (testada sem Docker). Valida a troca: porta 1024–65535, fora das
 * reservadas ao painel e sem disputa com outro container ou projeto.
 *
 * Pedido de 04/10/2026 ("não consigo trocar de cada container ou em lote?"):
 * publicar porta num serviço que não tem (publicação ADICIONADA, guardada em
 * portOverrides com `added`) e a edição em lote — a lista completa validada de
 * uma vez, com o erro de cada linha (checkPortsBatch).
 */
import type {
  DockerContainerInfo,
  LivePort,
  PortOverride,
  PortUsageRow,
  Project,
  ProjectPortEntry,
  ProjectPortService,
  ProjectPortsView,
  PortPublicationInput,
  PortRowError,
  SetPortRequest,
  SetPortsRequest,
} from "@paas/core";
import { addedPortKey, networkModeBlock, portEntryText, type ComposePortEntry } from "@paas/deploy";
import { httpError } from "./http-error.js";

const PANEL_CONTAINER = "tws-panel";

export interface PortsInput {
  projects: Project[];
  /** Portas do compose por id de projeto; null/ausente = sem compose ou sem o código. */
  composePorts: Map<string, Record<string, ComposePortEntry[]> | null>;
  /** Containers do docker ps; null = o Docker não respondeu. */
  containers: DockerContainerInfo[] | null;
  /** Portas do servidor reservadas ao painel. */
  reserved: number[];
  /** network_mode de cada serviço, lido do compose (ausente = usa a detecção). */
  networkModes?: Map<string, Record<string, string | null>>;
}

// ---------------------------------------------------------------------------
// docker ps
// ---------------------------------------------------------------------------

const PS_PORT = /^(?:(.*):(\d+)(?:-(\d+))?->)?(\d+)(?:-(\d+))?\/(\w+)$/;

/** Endereço de escuta normalizado: null = todos (0.0.0.0, ::, vazio). */
function normalizeIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null;
  const bare = ip.replace(/^\[(.*)\]$/, "$1");
  return bare === "" || bare === "0.0.0.0" || bare === "::" ? null : bare;
}

/** Coluna Ports do docker ps → portas (todas as faixas abertas; IPv4/IPv6 de "todos" juntos). */
export function parseDockerPorts(ports: string[]): LivePort[] {
  const result: LivePort[] = [];
  for (const raw of ports) {
    const m = PS_PORT.exec(raw.trim());
    if (!m) continue;
    const [, ip, hostStart, , cStart, cEnd, protocol] = m;
    const count = (cEnd ? Number(cEnd) : Number(cStart)) - Number(cStart) + 1;
    for (let i = 0; i < count; i++) {
      const port: LivePort = {
        hostIp: hostStart === undefined ? null : normalizeIp(ip),
        hostPort: hostStart === undefined ? null : Number(hostStart) + i,
        containerPort: Number(cStart) + i,
        protocol: protocol!,
      };
      const dup = result.some(
        (p) =>
          p.hostIp === port.hostIp &&
          p.hostPort === port.hostPort &&
          p.containerPort === port.containerPort &&
          p.protocol === port.protocol,
      );
      if (!dup) result.push(port);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Quem quer cada porta
// ---------------------------------------------------------------------------

function ipOverlap(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function projectOfContainer(c: DockerContainerInfo, projects: Project[]): Project | undefined {
  return c.projectSlug ? projects.find((p) => p.slug === c.projectSlug) : undefined;
}

function serviceOfContainer(c: DockerContainerInfo): string {
  return c.service ?? c.name;
}

function containerOfService(project: Project, service: string, containers: DockerContainerInfo[]) {
  const mine = containers.filter((c) => c.projectSlug === project.slug);
  return (
    mine.find((c) => c.service === service) ??
    // respostas antigas, sem o serviço: pelo nome paas-<slug>-<serviço>-N
    mine.find((c) => (c.service === undefined || c.service === null) && new RegExp(`-${service}-\\d+$`).test(c.name))
  );
}

/** Como o painel vai publicar uma porta do compose, com a troca aplicada. */
function effective(entry: ComposePortEntry, override: PortOverride | undefined) {
  if (entry.panel === "removed") return { published: false, hostIp: null, hostPort: null };
  if (override && entry.panel === null) {
    return override.hostPort === null
      ? { published: false, hostIp: null, hostPort: null }
      : { published: true, hostIp: normalizeIp(override.hostIp), hostPort: override.hostPort };
  }
  return { published: true, hostIp: normalizeIp(entry.hostIp), hostPort: entry.hostPort };
}

/** Publicações adicionadas no painel de um serviço, no formato das do compose. */
function addedEntries(project: Project, service: string): ComposePortEntry[] {
  return (project.portOverrides?.[service] ?? []).flatMap((o) =>
    o.added && o.hostPort !== null
      ? [
          {
            key: o.original,
            containerPort: o.added.containerPort,
            protocol: o.added.protocol,
            hostIp: o.hostIp,
            hostPort: o.hostPort,
            composeHost: "",
            panel: null,
          },
        ]
      : [],
  );
}

/** Por que o serviço não pode publicar porta própria (rede de outro), ou null. */
function publishBlockOf(project: Project, input: PortsInput, service: string): string | null {
  const modes = input.networkModes?.get(project.id);
  if (modes && service in modes) return networkModeBlock(modes[service] ?? null);
  const other = project.detection?.services?.find((s) => s.name === service)?.networkModeService;
  return other ? networkModeBlock(`service:${other}`) : null;
}

interface Want {
  owner: PortUsageRow["owner"];
  /** Quem é o dono (o mesmo serviço no ar e configurado é um dono só). */
  ownerKey: string;
  label: string;
  project: Project | null;
  container: DockerContainerInfo | null;
  service: string | null;
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number | null;
  protocol: string;
  source: PortUsageRow["source"];
  /** Chave da porta do compose (só nas configuradas). */
  entry?: string;
}

function liveWants(input: PortsInput): Want[] {
  const wants: Want[] = [];
  for (const c of input.containers ?? []) {
    const project = projectOfContainer(c, input.projects);
    const service = project ? serviceOfContainer(c) : c.service ?? null;
    const base = project
      ? { owner: "project" as const, ownerKey: `p:${project.id}:${service}`, label: `${project.name} · ${service}` }
      : c.managed || c.name === PANEL_CONTAINER
        ? { owner: "panel" as const, ownerKey: "panel", label: "o painel" }
        : { owner: "external" as const, ownerKey: `c:${c.name}`, label: `container ${c.name}` };
    const published = parseDockerPorts(c.ports).filter((p) => p.hostPort !== null);
    if (published.length === 0) {
      wants.push({ ...base, project: project ?? null, container: c, service, hostIp: null, hostPort: null, containerPort: null, protocol: "tcp", source: "live" });
    }
    for (const p of published) {
      wants.push({ ...base, project: project ?? null, container: c, service, ...p, source: "live" });
    }
  }
  return wants;
}

function configuredWants(input: PortsInput, live: Want[]): Want[] {
  const wants: Want[] = [];
  for (const project of input.projects) {
    const entries = input.composePorts.get(project.id);
    if (!entries) continue;
    for (const [service, list] of Object.entries(entries)) {
      const ownerKey = `p:${project.id}:${service}`;
      const container = input.containers ? (containerOfService(project, service, input.containers) ?? null) : null;
      for (const entry of [...list, ...addedEntries(project, service)]) {
        const eff = effective(entry, project.portOverrides?.[service]?.find((o) => o.original === entry.key));
        if (!eff.published || eff.hostPort === null) continue;
        const already = live.some(
          (w) =>
            w.ownerKey === ownerKey &&
            w.hostPort === eff.hostPort &&
            w.hostIp === eff.hostIp &&
            w.containerPort === entry.containerPort &&
            w.protocol === entry.protocol,
        );
        if (already) continue;
        wants.push({
          owner: "project",
          ownerKey,
          label: `${project.name} · ${service}`,
          project,
          container,
          service,
          hostIp: eff.hostIp,
          hostPort: eff.hostPort,
          containerPort: entry.containerPort,
          protocol: entry.protocol,
          source: "configured",
          entry: entry.key,
        });
      }
    }
  }
  return wants;
}

function allWants(input: PortsInput): Want[] {
  const live = liveWants(input);
  return [...live, ...configuredWants(input, live)];
}

/** Com quem a porta conflita (frase curta), ou null. */
function conflictOf(
  want: Pick<Want, "ownerKey" | "hostIp" | "hostPort" | "protocol">,
  wants: Want[],
  reserved: number[],
  skip: (w: Want) => boolean = () => false,
): string | null {
  if (want.hostPort === null) return null;
  if (want.ownerKey !== "panel" && reserved.includes(want.hostPort)) return "o painel (porta reservada)";
  const other = wants.find(
    (w) =>
      !skip(w) &&
      w.ownerKey !== want.ownerKey &&
      w.hostPort === want.hostPort &&
      w.protocol === want.protocol &&
      ipOverlap(w.hostIp, want.hostIp),
  );
  return other ? other.label : null;
}

/** Linhas da aba "Todos os projetos": cada porta publicada de cada container, e as que projetos do painel vão usar. */
export function buildPortRows(input: PortsInput): PortUsageRow[] {
  const wants = allWants(input);
  return wants.map((w) => {
    const conflictWith = conflictOf(w, wants, input.reserved);
    return {
      owner: w.owner,
      projectId: w.project?.id ?? null,
      projectName: w.project?.name ?? null,
      container: w.container?.name ?? null,
      service: w.service,
      image: w.container?.image ?? null,
      state: w.container?.state ?? null,
      hostIp: w.hostIp,
      hostPort: w.hostPort,
      containerPort: w.containerPort,
      protocol: w.protocol,
      source: w.source,
      conflict: conflictWith !== null,
      conflictWith,
    };
  });
}

// ---------------------------------------------------------------------------
// Aba "Este projeto"
// ---------------------------------------------------------------------------

function sameBinding(live: LivePort, hostIp: string | null, hostPort: number, containerPort: number, protocol: string) {
  return live.hostPort === hostPort && live.hostIp === hostIp && live.containerPort === containerPort && live.protocol === protocol;
}

function entryView(
  entry: ComposePortEntry,
  override: PortOverride | undefined,
  container: DockerContainerInfo | undefined,
  /** As outras publicações do serviço (uma porta no ar que é delas não conta para a removida). */
  siblings: Array<{ hostIp: string | null; hostPort: number | null; containerPort: number; protocol: string }> = [],
): ProjectPortEntry {
  const eff = effective(entry, override);
  const running = container?.state === "running";
  const live = container ? parseDockerPorts(container.ports) : [];
  let applied: boolean | null = null;
  if (running) {
    if (!eff.published) {
      applied = !live.some(
        (l) =>
          l.hostPort !== null &&
          l.containerPort === entry.containerPort &&
          l.protocol === entry.protocol &&
          !siblings.some((o) => o.hostPort !== null && sameBinding(l, o.hostIp, o.hostPort, o.containerPort, o.protocol)),
      );
    } else if (eff.hostPort !== null) {
      applied = live.some((l) => sameBinding(l, eff.hostIp, eff.hostPort!, entry.containerPort, entry.protocol));
    }
  }
  return {
    original: entry.key,
    containerPort: entry.containerPort,
    protocol: entry.protocol,
    composeHost: entry.composeHost,
    published: eff.published,
    hostIp: eff.hostIp,
    hostPort: eff.hostPort,
    override: entry.panel === null ? (override ?? null) : null,
    panel: entry.panel,
    applied,
    changeable: entry.panel === null,
    added: Boolean(override?.added),
    composeHostPort: override?.added ? null : entry.hostPort,
    composeHostIp: override?.added ? null : normalizeIp(entry.hostIp),
  };
}

function uniqueSorted(ports: number[]): number[] {
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function projectPortsView(project: Project, input: PortsInput): ProjectPortsView {
  const detection = project.detection;
  const entries = detection?.type === "compose" ? input.composePorts.get(project.id) : null;
  const containers = input.containers ?? [];
  let services: ProjectPortService[];

  if (entries) {
    services = Object.entries(entries).map(([name, list]) => {
      const container = containerOfService(project, name, containers);
      const live = container ? parseDockerPorts(container.ports) : [];
      const info = detection?.services?.find((s) => s.name === name);
      const added = addedEntries(project, name);
      return {
        name,
        container: container?.name ?? null,
        state: container?.state ?? null,
        health: container?.health ?? null,
        internalPorts: uniqueSorted([
          ...(info?.internalPorts ?? []).map((p) => p.port),
          ...live.map((p) => p.containerPort),
          ...list.map((e) => e.containerPort),
          ...added.map((e) => e.containerPort),
        ]),
        ports: [...list, ...added].map((e, _i, all) => {
          const overrideOf = (x: ComposePortEntry) => project.portOverrides?.[name]?.find((o) => o.original === x.key);
          const siblings = all
            .filter((x) => x !== e)
            .map((x) => ({ ...effective(x, overrideOf(x)), containerPort: x.containerPort, protocol: x.protocol }))
            .filter((x) => x.published);
          return entryView(e, overrideOf(e), container, siblings);
        }),
        livePorts: live.filter((p) => p.hostPort !== null),
        networkModeService: info?.networkModeService ?? null,
        publishBlocked: publishBlockOf(project, input, name),
      };
    });
  } else {
    services = containers
      .filter((c) => c.projectSlug === project.slug)
      .map((c) => {
        const live = parseDockerPorts(c.ports);
        return {
          name: serviceOfContainer(c),
          container: c.name,
          state: c.state,
          health: c.health ?? null,
          internalPorts: uniqueSorted(live.map((p) => p.containerPort)),
          ports: [],
          livePorts: live.filter((p) => p.hostPort !== null),
          networkModeService: null,
          publishBlocked: null,
        };
      });
  }

  const entryService = project.proxyService ?? detection?.proxyService ?? null;
  const entryPort = project.proxyPort ?? detection?.proxyPort ?? null;
  return {
    projectId: project.id,
    projectName: project.name,
    type: detection?.type ?? null,
    canChange: Boolean(entries),
    entry: entryService === null && entryPort === null ? null : { service: entryService, port: entryPort },
    services,
    pendingDeploy: services.some((s) => s.ports.some((p) => p.applied === false)),
  };
}

// ---------------------------------------------------------------------------
// Troca
// ---------------------------------------------------------------------------

function text(hostIp: string | null, hostPort: number, containerPort: number, protocol: string): string {
  return portEntryText(hostIp, hostPort, containerPort, protocol);
}

/** As portas do compose do projeto; erro quando não é compose ou o código não está no servidor. */
function composeEntriesOf(project: Project, input: PortsInput): Record<string, ComposePortEntry[]> {
  if (project.detection?.type !== "compose") {
    throw httpError(409, "not_compose", "Trocar a porta pelo painel só vale para projetos compose.");
  }
  const entries = input.composePorts.get(project.id);
  if (!entries) {
    throw httpError(
      409,
      "code_unavailable",
      "O código do projeto ainda não está no servidor. Faça o primeiro deploy e tente de novo.",
    );
  }
  return entries;
}

/**
 * Valida uma troca e devolve as trocas do projeto já atualizadas (undefined =
 * nenhuma) e a frase da auditoria. Lança erro HTTP com a explicação.
 */
export function checkPortChange(
  project: Project,
  input: PortsInput,
  req: SetPortRequest,
): { portOverrides: Record<string, PortOverride[]> | undefined; detail: string } {
  const entries = composeEntriesOf(project, input);
  const list = entries[req.service];
  if (!list) {
    throw httpError(
      400,
      "invalid_service",
      `O serviço "${req.service}" não existe no compose. Serviços: ${Object.keys(entries).join(", ")}.`,
    );
  }
  const entry = list.find((e) => e.key === req.original);
  if (!entry) {
    throw httpError(400, "invalid_port_entry", `A porta ${req.original} não está no compose do serviço ${req.service}.`);
  }
  if (entry.panel !== null) {
    throw httpError(
      400,
      "proxy_port",
      "As portas 80 e 443 são do painel (ele recebe o tráfego de todos os sites e cuida do HTTPS) e não podem ser trocadas aqui.",
    );
  }

  const current = project.portOverrides?.[req.service]?.find((o) => o.original === entry.key);
  const before = effective(entry, current);
  const beforeText = before.published && before.hostPort !== null
    ? text(before.hostIp, before.hostPort, entry.containerPort, entry.protocol)
    : before.published
      ? entry.key
      : "publicação removida";

  let next: PortOverride | null;
  let afterText: string;
  if (req.action === "reset") {
    next = null;
    afterText = `como está no compose (${entry.key})`;
  } else if (req.action === "remove") {
    next = { original: entry.key, hostPort: null, hostIp: null };
    afterText = "publicação removida";
  } else {
    const keep = req.hostPort === undefined;
    const hostPort = req.hostPort ?? before.hostPort ?? entry.hostPort;
    if (hostPort === null) {
      throw httpError(400, "invalid_port", "Informe a nova porta do servidor (no compose ela não é um número fixo).");
    }
    if (!keep && (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)) {
      throw httpError(400, "invalid_port", "A porta do servidor precisa ser de 1024 a 65535.");
    }
    const hostIp = req.hostIp ?? "127.0.0.1";
    const ownerKey = `p:${project.id}:${req.service}`;
    const wants = allWants(input);
    if (input.reserved.includes(hostPort)) {
      throw httpError(409, "port_in_use", `A porta ${hostPort} do servidor é reservada ao painel. Escolha outra.`);
    }
    const conflict = conflictOf(
      { ownerKey: "", hostIp: normalizeIp(hostIp), hostPort, protocol: entry.protocol },
      wants,
      [],
      (w) =>
        w.ownerKey === ownerKey &&
        (w.entry === entry.key || (w.source === "live" && w.containerPort === entry.containerPort && w.protocol === entry.protocol)),
    );
    if (conflict) {
      throw httpError(409, "port_in_use", `A porta ${hostPort} do servidor já é usada por ${conflict}. Escolha outra.`);
    }
    const sameAsCompose = hostPort === entry.hostPort && normalizeIp(hostIp) === normalizeIp(entry.hostIp);
    next = sameAsCompose ? null : { original: entry.key, hostPort, hostIp };
    afterText = text(hostIp, hostPort, entry.containerPort, entry.protocol);
  }

  const others = (project.portOverrides?.[req.service] ?? []).filter((o) => o.original !== entry.key);
  const serviceList = next ? [...others, next] : others;
  const all = { ...(project.portOverrides ?? {}) };
  if (serviceList.length > 0) all[req.service] = serviceList;
  else delete all[req.service];

  return {
    portOverrides: Object.keys(all).length > 0 ? all : undefined,
    detail: `Projeto "${project.name}", serviço ${req.service}: ${beforeText} → ${afterText}.`,
  };
}

// ---------------------------------------------------------------------------
// Edição em lote (e "Publicar uma porta", que manda a lista completa)
// ---------------------------------------------------------------------------

const PROXY_PORTS_MESSAGE =
  "As portas 80 e 443 são do painel (ele recebe o tráfego de todos os sites e cuida do HTTPS) e não podem ser usadas aqui.";

/** Uma publicação como vai ficar depois de salvar (para conferir conflitos). */
interface Publication {
  /** Índice da linha enviada; null = porta do compose que não veio na lista. */
  index: number | null;
  service: string;
  hostIp: string | null;
  hostPort: number;
  containerPort: number;
  protocol: string;
}

/** Portas publicadas de um serviço, em texto, para o resumo da auditoria. */
function serviceSummary(list: ComposePortEntry[], overrides: PortOverride[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    const override = overrides.find((o) => !o.added && o.original === entry.key);
    const eff = effective(entry, override);
    if (!eff.published) continue;
    const ip = override && entry.panel === null ? override.hostIp : entry.hostIp;
    out.push(eff.hostPort === null ? entry.key : text(ip, eff.hostPort, entry.containerPort, entry.protocol));
  }
  for (const o of overrides) {
    if (o.added && o.hostPort !== null) out.push(text(o.hostIp, o.hostPort, o.added.containerPort, o.added.protocol));
  }
  return out;
}

/**
 * Valida a lista COMPLETA de trocas e publicações adicionadas do projeto (a
 * edição em lote) e devolve as trocas novas e o resumo da auditoria. Porta do
 * compose fora da lista volta ao que o compose pede. Qualquer linha com
 * problema recusa tudo: erro 400 invalid_ports com o erro de cada linha em
 * `details.errors` ({ index, message }).
 */
export function checkPortsBatch(
  project: Project,
  input: PortsInput,
  req: SetPortsRequest,
): { portOverrides: Record<string, PortOverride[]> | undefined; detail: string } {
  const entries = composeEntriesOf(project, input);
  const errors = new Map<number, string>();
  const next: Record<string, PortOverride[]> = {};
  const pubs: Publication[] = [];
  const seen = new Set<string>();

  req.ports.forEach((item: PortPublicationInput, index) => {
    const fail = (message: string) => void errors.set(index, message);
    const list = entries[item.service];
    if (!list) return fail(`O serviço "${item.service}" não existe no compose. Serviços: ${Object.keys(entries).join(", ")}.`);

    let containerPort: number;
    let protocol: string;
    let entry: ComposePortEntry | undefined;
    if (item.original !== undefined) {
      entry = list.find((e) => e.key === item.original);
      if (!entry) return fail(`A porta ${item.original} não está no compose do serviço ${item.service}.`);
      if (entry.panel !== null) return fail(PROXY_PORTS_MESSAGE);
      const id = `${item.service}\n${entry.key}`;
      if (seen.has(id)) return fail("Esta porta do compose aparece duas vezes na lista.");
      seen.add(id);
      containerPort = entry.containerPort;
      protocol = entry.protocol;
      if (item.hostPort === null) {
        (next[item.service] ??= []).push({ original: entry.key, hostPort: null, hostIp: null });
        return;
      }
    } else {
      const blocked = publishBlockOf(project, input, item.service);
      if (blocked) return fail(blocked);
      if (item.containerPort === undefined || !Number.isInteger(item.containerPort) || item.containerPort < 1 || item.containerPort > 65535) {
        return fail("Informe a porta interna (onde o app escuta dentro do container), de 1 a 65535.");
      }
      containerPort = item.containerPort;
      protocol = item.protocol ?? "tcp";
    }

    const hostPort = item.hostPort ?? entry?.hostPort ?? null;
    if (hostPort === null) return fail("Informe a porta do servidor.");
    if (hostPort === 80 || hostPort === 443) return fail(PROXY_PORTS_MESSAGE);
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) return fail("A porta do servidor precisa ser de 1024 a 65535.");
    if (input.reserved.includes(hostPort)) return fail(`A porta ${hostPort} do servidor é reservada ao painel. Escolha outra.`);

    const hostIp = item.hostIp ?? "127.0.0.1";
    pubs.push({ index, service: item.service, hostIp: normalizeIp(hostIp), hostPort, containerPort, protocol });
    if (entry) {
      const sameAsCompose = hostPort === entry.hostPort && normalizeIp(hostIp) === normalizeIp(entry.hostIp);
      if (!sameAsCompose) (next[item.service] ??= []).push({ original: entry.key, hostPort, hostIp });
    } else {
      (next[item.service] ??= []).push({
        original: addedPortKey(hostIp, hostPort, containerPort, protocol),
        hostPort,
        hostIp,
        added: { containerPort, protocol: protocol as "tcp" | "udp" },
      });
    }
  });

  // Portas do compose que não vieram na lista ficam como o compose pede.
  for (const [service, list] of Object.entries(entries)) {
    for (const entry of list) {
      if (seen.has(`${service}\n${entry.key}`) || entry.panel === "removed" || entry.hostPort === null) continue;
      pubs.push({ index: null, service, hostIp: normalizeIp(entry.hostIp), hostPort: entry.hostPort, containerPort: entry.containerPort, protocol: entry.protocol });
    }
  }

  // Conflitos: entre as linhas do projeto e com o resto do servidor (o que o
  // próprio projeto usa hoje não conta: depois do deploy vale a lista nova).
  const others = allWants(input).filter((w) => w.project?.id !== project.id);
  for (const pub of pubs) {
    if (pub.index === null) continue;
    const twin = pubs.find(
      (o) => o !== pub && o.hostPort === pub.hostPort && o.protocol === pub.protocol && ipOverlap(o.hostIp, pub.hostIp),
    );
    if (twin) {
      errors.set(pub.index, `A porta ${pub.hostPort} do servidor também está na linha de ${twin.service} (→ ${twin.containerPort}).`);
      continue;
    }
    const conflict = conflictOf({ ownerKey: "", hostIp: pub.hostIp, hostPort: pub.hostPort, protocol: pub.protocol }, others, []);
    if (conflict) errors.set(pub.index, `A porta ${pub.hostPort} do servidor já é usada por ${conflict}. Escolha outra.`);
  }

  if (errors.size > 0) {
    const list: PortRowError[] = [...errors.entries()].sort((a, b) => a[0] - b[0]).map(([index, message]) => ({ index, message }));
    const err = httpError(
      400,
      "invalid_ports",
      `${list.length} ${list.length === 1 ? "porta" : "portas"} com problema. A primeira: ${list[0]!.message}`,
    );
    err.details = { errors: list };
    throw err;
  }

  const changes: string[] = [];
  for (const [service, list] of Object.entries(entries)) {
    const before = serviceSummary(list, project.portOverrides?.[service] ?? []);
    const after = serviceSummary(list, next[service] ?? []);
    if (before.join(", ") !== after.join(", ")) {
      changes.push(`${service}: ${before.join(", ") || "nenhuma"} → ${after.join(", ") || "nenhuma"}`);
    }
  }
  return {
    portOverrides: Object.keys(next).length > 0 ? next : undefined,
    detail: `Projeto "${project.name}", portas em lote — ${changes.length > 0 ? changes.join("; ") : "nenhuma mudança"}.`,
  };
}
