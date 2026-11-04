/**
 * blue-green.ts — troca sem queda de projetos de UM container (Next.js, Dockerfile, site estático).
 *
 * A versão nova sobe AO LADO da atual com nome e apelido de rede temporários (`<container>-next`, apelido
 * `<slug>--next`: o slug nunca tem dois hifens seguidos, então não colide com outro projeto). Quando ela responde,
 * o Caddy passa a apontar para `<slug>--next` (só a nova responde por ele), a anterior é drenada e parada
 * (guardada como `-previous`, o rollback de sempre) e a nova ganha o nome definitivo e o apelido do projeto; o
 * upstream de sempre volta no fim do deploy. Se a nova não fica saudável, é removida e a atual segue atendendo
 * sem interrupção.
 *
 * Fica fora do engine.ts (que depende do Docker) para ser testado sem Docker: o docker, o relógio, a sonda HTTP e
 * as pontas que dependem do engine (subir o container, apontar o Caddy) são injetados.
 */
import { PAAS_NETWORK, ZERO_DOWNTIME_PHASES } from "@paas/core";

export type LogFn = (chunk: string) => void;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type DockerFn = (args: string[], opts?: { timeoutMs?: number }) => Promise<DockerResult>;

/** Espera máxima padrão pela saúde da versão nova (ms). */
export const SWAP_HEALTH_TIMEOUT_MS = 90_000;
/** Tempo padrão com o tráfego já na versão nova e a anterior ainda de pé, para as conexões em curso terminarem (ms). */
export const SWAP_DRAIN_MS = 5_000;
const POLL_MS = 1_000;
/** Depois de apontar o proxy de volta, quanto esperar antes de parar a versão nova que recebia tráfego (ms). */
const ABORT_GRACE_MS = 3_000;

export interface SwapNames {
  slug: string;
  /** Container no ar: `-app` (Next.js, Dockerfile) ou `-web` (estático). */
  current: string;
  /** Container novo, durante a troca. */
  next: string;
  /** Onde a versão anterior fica guardada (parada); null = estático, a anterior é removida. */
  previous: string | null;
  /**
   * Apelido de rede EXCLUSIVO da versão nova nesta troca (o Caddy aponta para ele): `<slug>--a` ou `<slug>--b`,
   * o que o container no ar NÃO tem (ver pickNextAlias). O apelido temporário fica no container promovido; a
   * alternância garante que a próxima troca use o outro e a sonda nunca caia na versão que já está no ar.
   */
  nextAlias: string;
}

const TEMP_ALIASES = ["--a", "--b"] as const;

export function swapNames(prefix: string, slug: string, web: boolean): SwapNames {
  const current = web ? `${prefix}-web` : `${prefix}-app`;
  return { slug, current, next: `${current}-next`, previous: web ? null : `${prefix}-app-previous`, nextAlias: `${slug}--a` };
}

interface ContainerInfo {
  State?: { Running?: boolean; Status?: string; ExitCode?: number; Health?: { Status?: string } };
  HostConfig?: { PortBindings?: Record<string, unknown> | null };
  Mounts?: Array<{ Type?: string; Name?: string; RW?: boolean; Destination?: string }>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; Aliases?: string[] | null }> | null };
}

async function inspect(docker: DockerFn, name: string): Promise<ContainerInfo | null> {
  const r = await docker(["inspect", name]);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : null;
    return typeof first === "object" && first !== null ? (first as ContainerInfo) : null;
  } catch {
    return null;
  }
}

async function isRunning(docker: DockerFn, name: string): Promise<boolean> {
  const r = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  return r.code === 0 && r.stdout.trim() === "true";
}

async function exists(docker: DockerFn, name: string): Promise<boolean> {
  return (await docker(["inspect", "-f", "{{.Id}}", name])).code === 0;
}

export type SwapEligibility =
  | { ok: true }
  /** Nada no ar para trocar (primeiro deploy, container parado ou removido): sobe direto, sem aviso a dar. */
  | { ok: false; reason: "none" }
  | { ok: false; reason: "ports" | "volume"; detail: string };

const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

/**
 * Dá para ter duas versões ao mesmo tempo? Precisa haver uma versão rodando e ela não pode publicar porta no
 * servidor (a nova não conseguiria a mesma) nem ter pasta/volume gravável compartilhável (SQLite, lock de
 * uploads: dois processos corromperiam). Volume anônimo da imagem é por container e não conta.
 */
export async function swapEligibility(docker: DockerFn, names: SwapNames): Promise<SwapEligibility> {
  const info = await inspect(docker, names.current);
  if (!info || info.State?.Running !== true) return { ok: false, reason: "none" };
  const ports = Object.entries(info.HostConfig?.PortBindings ?? {})
    .filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0)
    .map(([port]) => port);
  if (ports.length > 0) return { ok: false, reason: "ports", detail: ports.join(", ") };
  const shared = (info.Mounts ?? [])
    .filter((m) => m.RW !== false && (m.Type === "bind" || (m.Type === "volume" && !ANONYMOUS_VOLUME.test(m.Name ?? ""))))
    .map((m) => m.Destination);
  if (shared.length > 0) return { ok: false, reason: "volume", detail: shared.join(", ") };
  return { ok: true };
}

/**
 * Escolhe o apelido temporário desta troca: `<slug>--a` ou `<slug>--b`, o que o container no ar não tem (lido do
 * próprio Docker, nada em disco). Containers anteriores a esta versão podem ter o apelido legado `<slug>--next`:
 * ele não é nenhum dos dois, então também funciona. Sem leitura possível, usa `--a`.
 */
export async function pickNextAlias(docker: DockerFn, names: SwapNames): Promise<SwapNames> {
  // nenhum container RODANDO do projeto (atual, sobra do -next, anterior) pode ter o apelido: ele resolveria para dois
  const taken = new Set<string>();
  for (const name of [names.current, names.next, names.previous]) {
    if (!name) continue;
    const info = await inspect(docker, name);
    if (info?.State?.Running === false) continue;
    for (const alias of info?.NetworkSettings?.Networks?.[PAAS_NETWORK]?.Aliases ?? []) taken.add(alias);
  }
  const free = TEMP_ALIASES.map((suffix) => `${names.slug}${suffix}`).find((alias) => !taken.has(alias));
  return { ...names, nextAlias: free ?? `${names.slug}--c` };
}

/**
 * Sonda a versão nova DE DENTRO do Caddy central (`wget`, que a imagem do Caddy traz): é o único lugar que
 * certamente está na rede dos projetos (o painel fica de fora dela) e testa o caminho que o tráfego vai fazer,
 * apelido incluso. Devolve o status HTTP da raiz (4xx e 5xx também: `wget -S` imprime os cabeçalhos mesmo
 * quando sai com erro) ou null se não houve resposta. O prazo é de verdade: `timeout 5` DENTRO do Caddy
 * (matar só o cliente do Docker não mata o wget lá dentro) e `timeoutMs` no cliente; `--spider` não baixa o corpo.
 */
export const PROBE_TIMEOUT_S = 5;
export function caddyExecProbe(docker: DockerFn, caddyContainer: string): (host: string, port: number) => Promise<number | null> {
  return async (host, port) => {
    const r = await docker(
      ["exec", caddyContainer, "timeout", String(PROBE_TIMEOUT_S), "wget", "--spider", "-S", "-T", "3", "-t", "1", `http://${host}:${port}/`],
      { timeoutMs: (PROBE_TIMEOUT_S + 3) * 1000 },
    );
    const codes = [...`${r.stderr}\n${r.stdout}`.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)];
    const last = codes[codes.length - 1]?.[1];
    return last ? Number(last) : null;
  };
}

export interface SwapDeps {
  docker: DockerFn;
  log: LogFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Status HTTP da raiz da versão nova pelo apelido dela na rede do proxy (null = sem resposta). */
  probe: (host: string, port: number) => Promise<number | null>;
  /** Fase 1: sobe o container NOVO com `names.next` e o apelido `names.nextAlias` (e só ele). */
  start: () => Promise<void>;
  /** Aponta o Caddy (validação + reload) para o upstream dado, pela fila de sempre. */
  repoint: (upstream: string) => Promise<void>;
  /** Chamado quando a troca falha e a versão anterior segue (ou voltou a estar) no ar. */
  onOldServing?: () => void;
}

export interface SwapOptions {
  /** Porta interna do app (a que o Caddy usa). */
  port: number;
  healthTimeoutMs?: number;
  drainMs?: number;
}

/** A versão nova não ficou saudável a tempo (ou caiu): a atual segue no ar. */
export class SwapHealthError extends Error {
  constructor(reason: string) {
    super(`a nova versão não ficou saudável (${reason}); a versão anterior segue no ar, sem interrupção.`);
    this.name = "SwapHealthError";
  }
}

const REPROBE_MS = 15_000;
/** Com a sonda HTTP respondendo, quanto o HEALTHCHECK do Docker pode seguir em "starting" antes de a troca aceitar a sonda (ms). */
export const HEALTH_GRACE_MS = 30_000;

/**
 * Espera a versão nova responder e diz qual verificação valeu. A sonda HTTP roda desde o início, intercalada com
 * o HEALTHCHECK do Docker (se a imagem tem): healthy passa; se a sonda responde (<500) e o HEALTHCHECK segue em
 * "starting" por mais de HEALTH_GRACE_MS, ou reprovou (unhealthy), a sonda vale e o log explica; um HEALTHCHECK mal
 * ajustado não derruba a troca de um app que responde. Sem HEALTHCHECK, a sonda sozinha (qualquer status abaixo
 * de 500 na porta interna: um 401/404 na raiz é o app de pé). Container que sai reprova na hora.
 */
async function waitNextReady(deps: SwapDeps, names: SwapNames, port: number, timeoutMs: number): Promise<string> {
  const deadline = deps.now() + timeoutMs;
  let last = "sem resposta ainda";
  let probeOkSince: number | null = null;
  let health: string | undefined;
  let probeNote = "";
  for (;;) {
    const info = await inspect(deps.docker, names.next);
    if (!info) throw new SwapHealthError("o container novo não foi encontrado");
    if (info.State?.Running !== true) {
      throw new SwapHealthError(`o container novo saiu (${info.State?.Status}, código ${info.State?.ExitCode}); veja o log do container`);
    }
    health = info.State.Health?.Status;
    if (health === "healthy") return "HEALTHCHECK do Docker";
    const status = await deps.probe(names.nextAlias, port);
    const responding = status !== null && status < 500;
    probeNote = status === null ? `sem resposta na porta ${port}` : `HTTP ${status} na porta ${port}`;
    if (responding) {
      if (health === undefined) return `resposta HTTP ${status} na porta ${port}`;
      probeOkSince ??= deps.now();
      if (health === "unhealthy" || deps.now() - probeOkSince >= HEALTH_GRACE_MS) {
        return `resposta HTTP ${status} na porta ${port} (o HEALTHCHECK do Docker não confirmou: ${health}; aceito porque o app responde)`;
      }
    } else {
      probeOkSince = null;
    }
    last = health === undefined ? probeNote : `HEALTHCHECK do Docker: ${health}; sonda HTTP: ${probeNote}`;
    if (health === "unhealthy" || deps.now() >= deadline) break;
    await deps.sleep(POLL_MS);
  }
  throw new SwapHealthError(health === "unhealthy" ? last : `sem resposta em ${Math.round(timeoutMs / 1000)}s: ${last}`);
}

/**
 * Garante que o container responde pelo apelido do projeto (`<slug>`) na rede do proxy. O Docker não permite
 * acrescentar apelido a quem já está na rede: sai e entra de novo. Na troca isto acontece antes de a nova receber
 * qualquer tráfego (o Caddy só passa a usá-la depois), então nenhuma conexão em curso é cortada. Nada a fazer se
 * o apelido já existe.
 */
export async function ensureAliases(docker: DockerFn, name: string, names: SwapNames, extra?: string): Promise<boolean> {
  const info = await inspect(docker, name);
  if (!info) return false; // não deu para ler: não mexe no que está no ar
  const net = info.NetworkSettings?.Networks?.[PAAS_NETWORK];
  if (net && net.Aliases?.includes(names.slug)) return false;
  if (net) await docker(["network", "disconnect", PAAS_NETWORK, name]);
  // mantém o apelido temporário que o container já tinha (a nova da troca, ou a promovida numa recuperação)
  const temp = [...new Set([...(net?.Aliases ?? []).filter((a) => a.startsWith(`${names.slug}--`)), ...(extra ? [extra] : [])])];
  const args = ["network", "connect", "--alias", names.slug, ...temp.flatMap((a) => ["--alias", a]), PAAS_NETWORK, name];
  let join = await docker(args);
  if (join.code !== 0) join = await docker(args);
  if (join.code !== 0) throw new Error(`não consegui ligar ${name} à rede ${PAAS_NETWORK} com o apelido ${names.slug}: ${join.stderr.trim()}`);
  return true;
}

/** A versão nova assume o nome definitivo (e o apelido, se ainda não tiver). */
export async function promoteNext(docker: DockerFn, names: SwapNames): Promise<void> {
  await ensureAliases(docker, names.next, names);
  const renamed = await docker(["rename", names.next, names.current]);
  if (renamed.code !== 0) throw new Error(`não consegui renomear ${names.next} para ${names.current}: ${renamed.stderr.trim()}`);
}

/**
 * Executa a troca. Ordem (minimiza queda E mistura de versões):
 *  1. sobe a nova só com `<slug>--next`; 2. espera a saúde;
 *  3. liga a nova ao apelido `<slug>` (ainda sem tráfego: ninguém usa o apelido dela) e IMEDIATAMENTE aponta o
 *     Caddy para `<slug>--next` (reload pela fila, com validate): daí o tráfego novo vai só para a nova. Única
 *     mistura de versões: entre ligar o apelido e o reload terminar, `<slug>` resolve para as duas (≈ 1 s), e
 *     conexões keep-alive que o Caddy já tinha com a anterior seguem nela até fecharem;
 *  4. sonda de novo, drena (SWAP_DRAIN_MS) e para a anterior (guardada como `-previous`); a nova assume o nome.
 * O upstream volta a `<slug>:<porta>` no passo final do deploy (proxyAndHealth), agora que só a nova responde por
 * `<slug>`. Lança se algo falhar, depois de deixar o site como estava (a atual no ar, Caddy de volta e a nova
 * removida); se nem isso for possível, mantém a nova no ar e diz.
 */
export async function performSwap(deps: SwapDeps, names: SwapNames, opts: SwapOptions): Promise<void> {
  const { docker, log } = deps;
  const timeoutMs = opts.healthTimeoutMs ?? SWAP_HEALTH_TIMEOUT_MS;
  const drainMs = opts.drainMs ?? SWAP_DRAIN_MS;
  const phase = (n: 1 | 2 | 3 | 4): void => log(`\n=== Troca sem queda · fase ${n}/4 · ${ZERO_DOWNTIME_PHASES[n - 1]} ===\n`);
  const dropNext = async (): Promise<void> => {
    await docker(["rm", "-f", names.next]);
  };
  const state = { moved: false, renamed: false, stopped: false, removedOld: false };

  // Volta ao que era antes da troca e relança o erro original. O container novo sai em QUALQUER saída.
  const abort = async (err: unknown): Promise<never> => {
    log(`✖ A troca falhou: ${messageOf(err)}\n`);
    let oldBack = !state.removedOld;
    if (state.renamed && names.previous) {
      await docker(["rename", names.previous, names.current]);
      if (state.stopped) await docker(["start", names.current]);
    }
    if (oldBack) oldBack = await isRunning(docker, names.current);
    if (!oldBack) {
      log("✖ Não consegui religar a versão anterior: mantive a versão nova no ar.\n");
      try {
        await promoteNext(docker, names);
      } catch (promoteErr) {
        log(`✖ ${messageOf(promoteErr)}\n`);
      }
      throw err;
    }
    if (state.moved) {
      try {
        await deps.repoint(`${names.slug}:${opts.port}`);
      } catch (repointErr) {
        // O proxy segue apontando para o apelido temporário (a última configuração válida): tirar a nova da rede
        // derrubaria o site. Ela fica no ar, o upstream temporário continua valendo para as reaplicações do proxy
        // (o engine mantém o mapa) e o aviso diz o que aconteceu.
        log(`✖ Não consegui apontar o proxy de volta para a versão anterior (${messageOf(repointErr)}); a versão nova foi mantida no ar e o proxy segue nela.\n`);
        throw err;
      }
      // o Caddy já voltou para a anterior, mas requisições em curso na nova ainda precisam terminar: espera um pouco,
      // para a nova com `stop` (encerra com SIGTERM, ela conclui o que tem) e só então sai da rede e é removida
      await deps.sleep(ABORT_GRACE_MS);
      await docker(["stop", names.next], { timeoutMs: 120_000 });
      await docker(["network", "disconnect", PAAS_NETWORK, names.next]);
    }
    await dropNext();
    deps.onOldServing?.();
    log("↩ A versão anterior segue no ar, sem interrupção; a versão nova foi removida.\n");
    throw err;
  };

  await dropNext(); // sobra de uma troca interrompida
  phase(1);
  try {
    await deps.start();
  } catch (err) {
    await dropNext();
    deps.onOldServing?.();
    throw err;
  }

  phase(2);
  let how: string;
  try {
    how = await waitNextReady(deps, names, opts.port, timeoutMs);
  } catch (err) {
    await dropNext();
    deps.onOldServing?.();
    log(`✖ ${messageOf(err)}\n`);
    throw err;
  }
  log(`Versão nova saudável (verificação: ${how}).\n`);

  phase(3);
  try {
    await ensureAliases(docker, names.next, names, names.nextAlias);
    state.moved = true; // conservador: se o reload falhar no meio, o proxy é apontado de volta
    await deps.repoint(`${names.nextAlias}:${opts.port}`);
    const deadline = deps.now() + REPROBE_MS;
    for (;;) {
      const status = await deps.probe(names.nextAlias, opts.port);
      if (status !== null && status < 500) break;
      if (deps.now() >= deadline) throw new SwapHealthError("a nova versão deixou de responder ao receber o tráfego");
      await deps.sleep(POLL_MS);
    }
  } catch (err) {
    return abort(err);
  }
  log(`Tráfego na versão nova. Aguardando ${Math.round(drainMs / 1000)}s antes de desligar a anterior.\n`);
  await deps.sleep(drainMs);

  phase(4);
  try {
    if (names.previous) {
      await docker(["rm", "-f", names.previous]);
      const renamed = await docker(["rename", names.current, names.previous]);
      if (renamed.code !== 0) throw new Error(`não consegui guardar a versão anterior: ${renamed.stderr.trim()}`);
      state.renamed = true;
      const stopped = await docker(["stop", names.previous], { timeoutMs: 120_000 });
      if (stopped.code !== 0) throw new Error(`não consegui parar a versão anterior: ${stopped.stderr.trim()}`);
      state.stopped = true;
    } else {
      const removed = await docker(["rm", "-f", names.current]);
      if (removed.code !== 0) throw new Error(`não consegui remover a versão anterior: ${removed.stderr.trim()}`);
      state.removedOld = true;
    }
    await promoteNext(docker, names);
  } catch (err) {
    return abort(err);
  }
  log("Versão anterior desligada; a nova assumiu o nome definitivo.\n");
}

/**
 * Subida do painel depois de um deploy interrompido no meio de uma troca. Nunca deixa o site sem container:
 * - o atual roda: apaga a versão nova (sobra) e confere que ele responde pelo apelido do projeto;
 * - o atual não roda, mas a nova sim (a anterior já tinha sido guardada ou removida): a nova fica
 *   (guardando/removendo o que sobrou do atual) e assume o nome e o apelido definitivos → "promoted";
 * - a nova existe e não roda: sobra, é apagada.
 * Devolve "promoted" quando a nova foi mantida; null quando não há mais o que decidir (o restante da
 * recuperação segue o fluxo de sempre).
 */
export async function recoverSwap(docker: DockerFn, names: SwapNames, log: LogFn): Promise<"promoted" | null> {
  const nextExists = await exists(docker, names.next);
  if (await isRunning(docker, names.current)) {
    if (nextExists) {
      await docker(["rm", "-f", names.next]);
      log("Havia uma versão nova sobrando de uma troca interrompida: removida; o site segue com a versão que estava no ar.\n");
    }
    // caiu entre a troca de nome e a troca de apelido: o container roda, mas o proxy não o encontra
    if (await ensureAliases(docker, names.current, names)) log("O container no ar estava sem o apelido do projeto na rede: corrigido.\n");
    return null;
  }
  if (!nextExists) return null;
  if (!(await isRunning(docker, names.next))) {
    await docker(["rm", "-f", names.next]);
    return null;
  }
  // a anterior foi só renomeada (o painel caiu antes do stop): para, para não dividir as visitas com a nova
  if (names.previous && (await isRunning(docker, names.previous))) await docker(["stop", names.previous], { timeoutMs: 120_000 });
  if (await exists(docker, names.current)) {
    if (names.previous) {
      await docker(["rm", "-f", names.previous]);
      await docker(["rename", names.current, names.previous]);
    } else {
      await docker(["rm", "-f", names.current]);
    }
  }
  await promoteNext(docker, names);
  log("O deploy foi interrompido no meio da troca, com a versão nova já saudável e no ar: ela foi mantida e assumiu o nome definitivo.\n");
  return "promoted";
}
