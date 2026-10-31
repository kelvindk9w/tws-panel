/**
 * metrics-watch.ts — alertas de recursos, com histerese.
 *
 * Roda a cada volta do coletor. Cada condição tem DOIS limiares: um para
 * disparar (sustentado por uma janela, nunca um pico) e outro, mais folgado, para
 * voltar ao normal. Entre os dois nada muda — sem isso, um valor oscilando
 * perto do limite abriria e fecharia alertas sem parar.
 *
 * O alerta nasce na central de alertas (origem "resources"); o aviso por
 * Telegram/e-mail sai pelo mesmo caminho dos outros alertas (tipo "resources",
 * ligado por padrão). A mensagem externa leva só o título: números e nomes
 * ficam no detalhe, dentro do painel.
 *
 * Disco cheio já tem o seu vigia (DiskWatcher, aviso "disk"); aqui entram
 * memória, CPU, steal, disco lento, inodes, morte por falta de memória e
 * container que não para de reiniciar ou não passa na verificação de saúde.
 *
 * Depois de reiniciar o painel o vigia adota os alertas de recursos que estavam
 * abertos (casando pelo título): eles voltam ao normal pela mesma histerese, em
 * vez de ficarem abertos para sempre.
 *
 * Serviço parado: um serviço de projeto que caiu e ficou parado (container saiu com erro, ou saiu e
 * não volta sozinho) abre um alerta depois de 2 minutos seguidos parado e o encerra depois de 5 voltas
 * boas. Não conta como parada: projeto parado pelo painel, deploy em andamento, execução avulsa
 * (`compose run`) e serviço de execução única que terminou com código 0 sem política de reinício.
 * Memória perto do limite: ≥ 90 % do limite do próprio container, em todas as amostras de 10 minutos;
 * volta ao normal abaixo de 80 % pelo mesmo tempo.
 *
 * Falta de dado nunca decide: sem amostras suficientes na janela, a condição
 * não dispara e, se estava ativa, não volta ao normal.
 */
import { isCompletedOneShot, MEMORY_NEAR_LIMIT, type AlertSeverity, type HostMetricId } from "@paas/core";
import { buildLogMasker, cleanLogText } from "./log-mask.js";
import { RESTART_WINDOW_SECONDS, type ContainerStatus, type TickResult } from "./metrics-collector.js";
import type { HostSampleValues } from "./metrics-compute.js";

export interface WatchDeps {
  create(input: { severity: AlertSeverity; source: "resources"; title: string; detail: string; projectSlug?: string }): Promise<{ alert: { id: string }; created: boolean }>;
  resolve(id: string): Promise<unknown>;
  /** O que a pessoa pretende para o projeto: parado por ela no painel, ou com deploy em andamento. null = nada (deve estar no ar). */
  intent?(slug: string): "stopped" | "deploying" | "maintenance" | null;
  /** Alertas de recursos abertos agora (id e título): na subida, o vigia os adota para que se resolvam com a histerese normal. */
  listOpen?(): Promise<Array<{ id: string; title: string }>>;
  /** Valores das variáveis do projeto, para mascarar o detalhe do alerta (a saída do healthcheck pode ecoar um segredo). */
  secrets?(slug: string): Promise<readonly string[]>;
  log: (message: string) => void;
}

export const WATCH = {
  memPsiRaise: 20,
  memPsiRaiseMinutes: 5,
  memPsiClear: 10,
  memPsiClearMinutes: 15,
  memAvailRaise: 5,
  memAvailClear: 10,
  cpuPsiRaise: 50,
  cpuPsiClear: 30,
  cpuMinutes: 15,
  cpuBusyRaise: 95,
  cpuBusyClear: 80,
  stealRaise: 10,
  stealRaiseMinutes: 30,
  stealClear: 5,
  stealClearMinutes: 60,
  ioRaise: 30,
  ioClear: 15,
  ioMinutes: 10,
  inodeRaise: 90,
  inodeClear: 85,
  restartLoop: 3,
  unhealthySeconds: 300,
  healthyTicksToClear: 10,
  /** Segundos seguidos parado até abrir o alerta de serviço parado. */
  downSeconds: 120,
  /** Voltas seguidas sem nada parado até encerrar o alerta. */
  downOkTicks: 5,
  /** Parte mínima da janela que precisa ter amostra para valer. */
  coverage: 0.8,
} as const;

type Recent = ReadonlyArray<{ t: number; v: HostSampleValues }>;

/** Média de uma métrica nos últimos `minutes`; null se menos de 80% da janela tem amostra dela. */
export function windowAvg(recent: Recent, id: HostMetricId, nowSec: number, minutes: number): number | null {
  const from = nowSec - minutes * 60;
  let sum = 0;
  let n = 0;
  for (const s of recent) {
    const v = s.v[id];
    if (s.t > from && typeof v === "number") {
      sum += v;
      n++;
    }
  }
  return n >= Math.ceil(minutes * WATCH.coverage) ? sum / n : null;
}

interface Verdict {
  /** true = deve estar ativo e ainda não está → dispara; null = sem dado. */
  trigger: boolean | null;
  /** true = já pode voltar ao normal; null = sem dado (continua ativo). */
  recovered: boolean | null;
}

interface Rule {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Projeto do painel a que o alerta se refere (liga o alerta à página do projeto). */
  projectSlug?: string;
  verdict: Verdict;
}

const pct = (n: number | null) => (n === null ? "?" : `${Math.round(n)}%`);

function hostRules(recent: Recent, nowSec: number): Rule[] {
  const avg = (id: HostMetricId, m: number) => windowAvg(recent, id, nowSec, m);
  const out: Rule[] = [];

  // Memória: pressão (PSI); sem PSI no kernel, memória disponível.
  const memPsiR = avg("psiMem", WATCH.memPsiRaiseMinutes);
  const memPsiC = avg("psiMem", WATCH.memPsiClearMinutes);
  const availR = avg("memUsedPct", WATCH.memPsiRaiseMinutes);
  const availC = avg("memUsedPct", WATCH.memPsiClearMinutes);
  const usePsi = memPsiR !== null || memPsiC !== null;
  out.push({
    key: "host:memory",
    severity: "critical",
    title: "Memória da VPS apertada",
    detail: usePsi
      ? `A VPS passou a esperar por memória: pressão de ${pct(memPsiR)} nos últimos ${WATCH.memPsiRaiseMinutes} minutos (alerta a partir de ${WATCH.memPsiRaise}%). Considere mais memória no plano ou reduzir o que roda.`
      : `Sobrou pouca memória disponível (usada: ${pct(availR)} nos últimos ${WATCH.memPsiRaiseMinutes} minutos). Considere mais memória no plano ou reduzir o que roda.`,
    verdict: usePsi
      ? {
          trigger: memPsiR === null ? null : memPsiR >= WATCH.memPsiRaise,
          recovered: memPsiC === null ? null : memPsiC < WATCH.memPsiClear,
        }
      : {
          trigger: availR === null ? null : 100 - availR < WATCH.memAvailRaise,
          recovered: availC === null ? null : 100 - availC > WATCH.memAvailClear,
        },
  });

  // CPU: pressão; sem PSI, uso.
  const cpuPsi = avg("psiCpu", WATCH.cpuMinutes);
  const cpuBusy = avg("cpuBusy", WATCH.cpuMinutes);
  const cpuByPsi = cpuPsi !== null;
  out.push({
    key: "host:cpu",
    severity: "warning",
    title: "CPU da VPS no limite",
    detail: cpuByPsi
      ? `Processos esperaram pela CPU em ${pct(cpuPsi)} do tempo nos últimos ${WATCH.cpuMinutes} minutos (alerta a partir de ${WATCH.cpuPsiRaise}%).`
      : `A CPU ficou em ${pct(cpuBusy)} nos últimos ${WATCH.cpuMinutes} minutos.`,
    verdict: cpuByPsi
      ? { trigger: cpuPsi >= WATCH.cpuPsiRaise, recovered: cpuPsi < WATCH.cpuPsiClear }
      : { trigger: cpuBusy === null ? null : cpuBusy >= WATCH.cpuBusyRaise, recovered: cpuBusy === null ? null : cpuBusy < WATCH.cpuBusyClear },
  });

  // CPU tomada pelo provedor (steal).
  const stealR = avg("cpuSteal", WATCH.stealRaiseMinutes);
  const stealC = avg("cpuSteal", WATCH.stealClearMinutes);
  out.push({
    key: "host:steal",
    severity: "warning",
    title: "O provedor está tomando CPU da VPS",
    detail: `Em média ${pct(stealR)} da CPU foi tomada pelo servidor físico nos últimos ${WATCH.stealRaiseMinutes} minutos (alerta a partir de ${WATCH.stealRaise}%). Trocar de plano ou de servidor ajuda mais do que otimizar.`,
    verdict: { trigger: stealR === null ? null : stealR >= WATCH.stealRaise, recovered: stealC === null ? null : stealC < WATCH.stealClear },
  });

  // Disco lento: espera por IO.
  const iow = avg("cpuIowait", WATCH.ioMinutes);
  const psiIo = avg("psiIo", WATCH.ioMinutes);
  const have = [iow, psiIo].filter((x): x is number => x !== null);
  out.push({
    key: "host:io",
    severity: "warning",
    title: "Disco da VPS lento",
    detail: `A VPS passou muito tempo esperando o disco nos últimos ${WATCH.ioMinutes} minutos (espera de CPU ${pct(iow)}, pressão ${pct(psiIo)}).`,
    verdict: {
      trigger: have.length === 0 ? null : have.some((x) => x >= WATCH.ioRaise),
      recovered: have.length === 0 ? null : have.every((x) => x < WATCH.ioClear),
    },
  });

  // Inodes (a última amostra; muda devagar).
  const inode = recent.at(-1)?.v.inodePct;
  out.push({
    key: "host:inodes",
    severity: "critical",
    title: "Disco da VPS sem arquivos disponíveis (inodes)",
    detail: `${pct(inode ?? null)} dos inodes do disco estão em uso (alerta a partir de ${WATCH.inodeRaise}%). Mesmo com espaço livre, sem inodes não dá para criar arquivos novos.`,
    verdict: { trigger: inode === undefined ? null : inode >= WATCH.inodeRaise, recovered: inode === undefined ? null : inode < WATCH.inodeClear },
  });
  return out;
}

const HOST_TITLES: ReadonlySet<string> = new Set([
  "Memória da VPS apertada",
  "CPU da VPS no limite",
  "O provedor está tomando CPU da VPS",
  "Disco da VPS lento",
  "Disco da VPS sem arquivos disponíveis (inodes)",
]);
const CONTAINER_TITLE = / (reinicia sem parar|não passa na verificação de saúde|parou de rodar|está perto do limite de memória)$/;

const OOM_DETAIL = "O sistema encerrou um processo do container por falta de memória (o limite dele ou a memória da VPS). Veja o limite do serviço e a memória da VPS, ou reduza o consumo.";

const label = (c: ContainerStatus) => (c.slug !== null ? `${c.slug}/${c.service ?? c.name}` : c.name);

function memoryRule(c: ContainerStatus, history: ReadonlyArray<{ t: number; pct: number }>, nowSec: number): Rule {
  const { raise, clear, minutes } = MEMORY_NEAR_LIMIT;
  const from = nowSec - minutes * 60;
  const win = history.filter((h) => h.t > from);
  const covered = win.length >= Math.ceil(minutes * WATCH.coverage);
  const last = win.at(-1)?.pct ?? null;
  return {
    key: `c:${c.id}:memhigh`,
    severity: "warning",
    title: `${label(c)} está perto do limite de memória`,
    ...(c.slug !== null ? { projectSlug: c.slug } : {}),
    detail: `O container está usando ${pct(last)} do limite de memória dele (alerta a partir de ${raise}% por ${minutes} minutos). Se passar do limite, o sistema o encerra por falta de memória. Aumente o limite do serviço ou reduza o consumo.`,
    verdict: {
      trigger: covered ? win.every((h) => h.pct >= raise) : null,
      // container parado não usa memória: o que importa dele é o alerta de serviço parado
      recovered: c.state !== "running" ? true : covered ? win.every((h) => h.pct < clear) : null,
    },
  };
}

const isoOf = (sec: number) => new Date(sec * 1000).toISOString();

/** Estado do container em palavras, para o detalhe dos alertas: estado, saída, saúde, desde quando. */
function stateText(c: ContainerStatus): string {
  const parts = [`estado: ${c.state}`];
  if (c.exitCode !== null && c.state !== "running") parts.push(`código de saída: ${c.exitCode}`);
  if (c.health !== null) parts.push(`saúde: ${c.health}`);
  if (c.oomKilled) parts.push("encerrado por falta de memória");
  return parts.join("; ");
}

const doneOf = (c: ContainerStatus) => isCompletedOneShot({ state: c.state, exitCode: c.exitCode, awaitedByDependents: c.awaited === true });

/** `handover`: o alerta de serviço parado deste container já está aberto (ou o projeto foi parado pelo painel). */
function containerRules(c: ContainerStatus, nowSec: number, okStreak: number, handover: boolean): Rule[] {
  const loop = c.restartsAt.filter((t) => t > nowSec - RESTART_WINDOW_SECONDS).length;
  const unhealthy = c.unhealthySince !== null && nowSec - c.unhealthySince >= WATCH.unhealthySeconds;
  return [
    {
      key: `c:${c.id}:loop`,
      severity: "critical",
      title: `${label(c)} reinicia sem parar`,
      detail: `Serviço ${c.service ?? c.name} (container ${c.name}): reiniciou ${loop} vezes nos últimos ${RESTART_WINDOW_SECONDS / 60} minutos (${stateText(c)}). Veja a aba Logs do projeto para saber o motivo.`,
      ...(c.slug !== null ? { projectSlug: c.slug } : {}),
      verdict: { trigger: loop > WATCH.restartLoop, recovered: loop === 0 },
    },
    {
      key: `c:${c.id}:health`,
      severity: "warning",
      title: `${label(c)} não passa na verificação de saúde`,
      detail:
        `Verificação: healthcheck do serviço ${c.service ?? c.name} (container ${c.name}). ` +
        `Está marcado como não saudável${c.unhealthySince !== null ? ` desde ${isoOf(c.unhealthySince)}` : ""}, há mais de ${WATCH.unhealthySeconds / 60} minutos (${stateText(c)}).` +
        (c.healthOutput ? ` Última saída da verificação: ${c.healthOutput}.` : "") +
        " Veja a aba Logs do projeto.",
      ...(c.slug !== null ? { projectSlug: c.slug } : {}),
      verdict: {
        trigger: unhealthy,
        // Job concluído (saiu com 0, esperado por outro serviço): não há saúde a verificar, encerra já. Container que
        // saiu de outro jeito: o alerta fica até o de "parou de rodar" abrir (ou a pessoa parar o projeto); sem isso a
        // queda de um serviço não saudável sumiria da lista no instante em que ele cai.
        recovered: c.unhealthySince === null && (c.state === "running" ? okStreak >= WATCH.healthyTicksToClear : doneOf(c) || handover),
      },
    },
  ];
}

/** Container que contaria como "parado de verdade" (ignora o que é intencional). */
export function isUnexpectedlyDown(c: ContainerStatus): boolean {
  if (c.oneoff || (c.state !== "exited" && c.state !== "dead")) return false;
  // saiu sem o código conhecido (o inspect falhou): não dá para dizer se foi uma execução única que terminou bem
  if (c.state === "exited" && c.exitCode === null) return false;
  // Saiu com 0 só é "concluído" se outro serviço espera pela conclusão dele (migração). Serviço comum que saiu com 0
  // (SIGTERM no reinício da VPS, docker stop) caiu.
  return !doneOf(c);
}

interface State {
  alertId: string | null;
  /** Alerta adotado na subida: só pode voltar ao normal depois deste instante (o histórico em memória começou vazio). */
  notBefore?: number;
}

export class ResourceWatcher {
  private readonly active = new Map<string, State>();
  private readonly streak = new Map<string, number>();
  /** Serviço → desde quando está parado sem parar (epoch s) e quantas voltas boas seguidas. */
  private readonly down = new Map<string, { since: number | null; ok: number }>();
  /** Container → % do limite de memória nas últimas voltas. */
  private readonly memHistory = new Map<string, Array<{ t: number; pct: number }>>();
  private adopted = false;
  private nowSec = 0;

  constructor(private readonly deps: WatchDeps) {}

  /** Chaves de alertas ativos (testes e diagnóstico). */
  activeKeys(): string[] {
    return [...this.active.keys()].sort();
  }

  private async apply(rule: Rule): Promise<void> {
    const state = this.active.get(rule.key);
    if (!state) {
      if (rule.verdict.trigger !== true) return;
      try {
        const { alert } = await this.deps.create({
          severity: rule.severity,
          source: "resources",
          title: rule.title,
          detail: await this.maskedDetail(rule),
          ...(rule.projectSlug !== undefined ? { projectSlug: rule.projectSlug } : {}),
        });
        this.active.set(rule.key, { alertId: alert.id });
      } catch (err) {
        // não ativa: a próxima volta tenta de novo
        this.deps.log(`métricas: alerta não gravado (${err instanceof Error ? err.message : String(err)})`);
      }
      return;
    }
    if (rule.verdict.recovered === true && (state.notBefore === undefined || this.nowSec >= state.notBefore)) await this.clear(rule.key, state);
  }

  /** O detalhe sai pela API de alertas (tokens, MCP): cores e controles saem, e os segredos do projeto são mascarados. */
  private async maskedDetail(rule: Rule): Promise<string> {
    let secrets: readonly string[] = [];
    if (rule.projectSlug !== undefined && this.deps.secrets) {
      try {
        secrets = await this.deps.secrets(rule.projectSlug);
      } catch {
        // sem os valores, ainda valem os padrões gerais (senha em URL, tokens)
      }
    }
    return cleanLogText(rule.detail, buildLogMasker(secrets));
  }

  private async clear(key: string, state: State): Promise<void> {
    try {
      // réplicas do mesmo serviço dividem o alerta (mesmo título): só se encerra quando a última se recuperou
      const shared = state.alertId !== null && [...this.active].some(([k, s]) => k !== key && s.alertId === state.alertId);
      if (state.alertId !== null && !shared) await this.deps.resolve(state.alertId);
      this.active.delete(key);
    } catch (err) {
      this.deps.log(`métricas: alerta não encerrado (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /**
   * Na primeira volta com o Docker respondendo: casa cada alerta de recursos aberto com a regra de mesmo
   * título (vira ativo, com a histerese de sempre). Sobra de container que não existe mais, ou duplicata
   * do mesmo título, é encerrada. Eventos (morte por falta de memória) ficam: a pessoa resolve.
   */
  private async adopt(rules: Rule[]): Promise<void> {
    if (!this.deps.listOpen) {
      this.adopted = true;
      return;
    }
    let open: Array<{ id: string; title: string }>;
    try {
      open = await this.deps.listOpen();
    } catch (err) {
      this.deps.log(`métricas: alertas abertos não lidos (${err instanceof Error ? err.message : String(err)})`);
      return; // tenta de novo na próxima volta
    }
    this.adopted = true;
    const byTitle = new Map(rules.filter((r) => !r.key.includes(":oom:")).map((r) => [r.title, r.key]));
    const owned = (title: string) => HOST_TITLES.has(title) || CONTAINER_TITLE.test(title);
    for (const a of open) {
      const key = byTitle.get(a.title);
      if (key !== undefined && !this.active.has(key)) {
        // laço de reinício: a lista de reinícios recentes começa vazia depois da subida; espera uma janela inteira
        this.active.set(key, key.endsWith(":loop") ? { alertId: a.id, notBefore: this.nowSec + RESTART_WINDOW_SECONDS } : { alertId: a.id });
      } else if (owned(a.title)) {
        await this.clear(`adotado:${a.id}`, { alertId: a.id });
      }
    }
  }

  async evaluate(tick: TickResult, recent: Recent): Promise<void> {
    const nowSec = tick.t;
    this.nowSec = nowSec;
    const rules = hostRules(recent, nowSec);
    const seen = new Set<string>();
    // Sem leitura do Docker nesta volta, nada se sabe dos containers: não é "sumiram". Mantém o estado.
    for (const c of tick.dockerOk ? tick.containers : []) {
      const ok = c.unhealthySince === null ? (this.streak.get(c.id) ?? 0) + 1 : 0;
      this.streak.set(c.id, ok);
      const handover =
        c.slug !== null && c.service !== null && (this.active.has(`s:${c.slug}/${c.service}:down`) || this.deps.intent?.(c.slug) === "stopped");
      for (const r of containerRules(c, nowSec, ok, handover)) {
        rules.push(r);
        seen.add(r.key);
      }
      const hist = this.memHistory.get(c.id) ?? [];
      if (c.state !== "running") hist.length = 0;
      else if (typeof c.memPct === "number") hist.push({ t: nowSec, pct: c.memPct });
      while (hist.length > 0 && hist[0]!.t <= nowSec - (MEMORY_NEAR_LIMIT.minutes + 1) * 60) hist.shift();
      this.memHistory.set(c.id, hist);
      const mem = memoryRule(c, hist, nowSec);
      rules.push(mem);
      seen.add(mem.key);
      // morte por falta de memória: evento, sem volta ao normal automática (a pessoa resolve)
      if (c.oomAt.includes(nowSec)) {
        rules.push({
          key: `c:${c.id}:oom:${nowSec}`,
          severity: "critical",
          title: `${label(c)} morreu por falta de memória`,
          detail: OOM_DETAIL,
          verdict: { trigger: true, recovered: true },
        });
      }
    }
    if (tick.dockerOk) for (const r of this.serviceRules(tick, nowSec)) {
      rules.push(r);
      seen.add(r.key);
    }
    // container que já saiu da lista (removido, ou recriado no mesmo minuto) e morreu por memória: o alerta usa o rótulo lembrado
    for (const o of tick.orphanOoms ?? []) {
      rules.push({
        key: `c:orphan:${o.label}:oom:${nowSec}`,
        severity: "critical",
        title: `${o.label} morreu por falta de memória`,
        detail: OOM_DETAIL,
        verdict: { trigger: true, recovered: true },
      });
    }
    if (!this.adopted && tick.dockerOk) await this.adopt(rules);
    const hostOom = tick.host.oom ?? 0;
    if (hostOom > 0) {
      rules.push({
        key: `host:oom:${nowSec}`,
        severity: "critical",
        title: "A VPS matou um processo por falta de memória",
        detail: `${hostOom} processo(s) foram encerrados pelo sistema por falta de memória no último minuto. Veja a memória da VPS e os containers com mais consumo.`,
        verdict: { trigger: true, recovered: true },
      });
    }
    for (const r of rules) {
      await this.apply(r);
      // eventos (oom) não ficam ativos: o alerta já foi gravado e a pessoa decide
      if (r.key.includes(":oom:")) this.active.delete(r.key);
    }
    if (!tick.dockerOk) return;
    // container que sumiu: encerra os alertas dele
    const present = new Set(tick.containers.map((c) => c.id));
    for (const id of [...this.streak.keys()]) if (!present.has(id)) this.streak.delete(id);
    for (const id of [...this.memHistory.keys()]) if (!present.has(id)) this.memHistory.delete(id);
    for (const [key, state] of [...this.active]) {
      if ((key.startsWith("c:") || key.startsWith("s:")) && !seen.has(key)) await this.clear(key, state);
    }
  }

  /** Alerta de serviço parado: uma regra por serviço de projeto que existe na volta. */
  private serviceRules(tick: TickResult, nowSec: number): Rule[] {
    const groups = new Map<string, { slug: string; service: string; list: ContainerStatus[] }>();
    for (const c of tick.containers) {
      if (c.slug === null || c.service === null || c.oneoff) continue;
      const key = `s:${c.slug}/${c.service}:down`;
      const g = groups.get(key) ?? { slug: c.slug, service: c.service, list: [] };
      g.list.push(c);
      groups.set(key, g);
    }
    for (const key of [...this.down.keys()]) if (!groups.has(key)) this.down.delete(key);
    const out: Rule[] = [];
    for (const [key, g] of groups) {
      const intent = this.deps.intent?.(g.slug) ?? null;
      const bad = intent === null ? g.list.filter(isUnexpectedlyDown) : [];
      const st = this.down.get(key) ?? { since: null, ok: 0 };
      // deploy ou restauração em andamento: o estado congela (não conta como volta boa, para um alerta aberto não
      // se encerrar no meio e reabrir se o deploy falhar, com duas notificações para a mesma queda)
      const frozen = intent === "deploying" || intent === "maintenance";
      if (frozen) {
        // nada muda
      } else if (bad.length > 0) {
        st.since ??= nowSec;
        st.ok = 0;
      } else {
        st.since = null;
        st.ok++;
      }
      this.down.set(key, st);
      const wanted = (tick.services ?? []).find((x) => x.slug === g.slug && x.service === g.service)?.wanted ?? g.list.length;
      const running = g.list.filter((c) => c.state === "running").length;
      const code = bad.find((c) => c.exitCode !== null)?.exitCode ?? null;
      out.push({
        key,
        severity: running === 0 ? "critical" : "warning",
        title: `${g.slug}/${g.service} parou de rodar`,
        detail:
          (wanted > 1 ? `${bad.length} de ${wanted} réplicas estão paradas (${running} rodando). ` : "O serviço está parado. ") +
          `Ele ficou parado por mais de ${WATCH.downSeconds / 60} minutos${st.since !== null ? ` (desde ${isoOf(st.since)})` : ""}${code !== null ? ` (código de saída ${code})` : ""} sem ter sido parado pelos botões do painel. ` +
          `Container ${bad[0]?.name ?? g.service}: ${bad[0] ? stateText(bad[0]) : "sem leitura"}. Veja a aba Logs do projeto para saber o motivo e reinicie o serviço.`,
        projectSlug: g.slug,
        verdict: {
          trigger: frozen ? null : st.since !== null && nowSec - st.since >= WATCH.downSeconds,
          // tudo concluído (job de execução única que terminou com 0): não há o que esperar, encerra já
          recovered: frozen ? null : st.since === null && (st.ok >= WATCH.downOkTicks || g.list.every(doneOf)),
        },
      });
    }
    return out;
  }
}
