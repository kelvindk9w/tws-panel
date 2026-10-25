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
 * Falta de dado nunca decide: sem amostras suficientes na janela, a condição
 * não dispara e, se estava ativa, não volta ao normal.
 */
import type { AlertSeverity, HostMetricId } from "@paas/core";
import { RESTART_WINDOW_SECONDS, type ContainerStatus, type TickResult } from "./metrics-collector.js";
import type { HostSampleValues } from "./metrics-compute.js";

export interface WatchDeps {
  create(input: { severity: AlertSeverity; source: "resources"; title: string; detail: string }): Promise<{ alert: { id: string }; created: boolean }>;
  resolve(id: string): Promise<unknown>;
  /** Alertas de recursos abertos agora (id e título): na subida, o vigia os adota para que se resolvam com a histerese normal. */
  listOpen?(): Promise<Array<{ id: string; title: string }>>;
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
const CONTAINER_TITLE = / (reinicia sem parar|não passa na verificação de saúde)$/;

const label = (c: ContainerStatus) => (c.slug !== null ? `${c.slug}/${c.service ?? c.name}` : c.name);

function containerRules(c: ContainerStatus, nowSec: number, okStreak: number): Rule[] {
  const loop = c.restartsAt.filter((t) => t > nowSec - RESTART_WINDOW_SECONDS).length;
  const unhealthy = c.unhealthySince !== null && nowSec - c.unhealthySince >= WATCH.unhealthySeconds;
  return [
    {
      key: `c:${c.id}:loop`,
      severity: "critical",
      title: `${label(c)} reinicia sem parar`,
      detail: `O container reiniciou ${loop} vezes nos últimos ${RESTART_WINDOW_SECONDS / 60} minutos. Veja a aba Logs do projeto para saber o motivo.`,
      verdict: { trigger: loop > WATCH.restartLoop, recovered: loop === 0 },
    },
    {
      key: `c:${c.id}:health`,
      severity: "warning",
      title: `${label(c)} não passa na verificação de saúde`,
      detail: `O container está marcado como não saudável há mais de ${WATCH.unhealthySeconds / 60} minutos. Veja a aba Logs do projeto.`,
      verdict: { trigger: unhealthy, recovered: c.unhealthySince === null && okStreak >= WATCH.healthyTicksToClear },
    },
  ];
}

interface State {
  alertId: string | null;
}

export class ResourceWatcher {
  private readonly active = new Map<string, State>();
  private readonly streak = new Map<string, number>();
  private adopted = false;

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
        const { alert } = await this.deps.create({ severity: rule.severity, source: "resources", title: rule.title, detail: rule.detail });
        this.active.set(rule.key, { alertId: alert.id });
      } catch (err) {
        // não ativa: a próxima volta tenta de novo
        this.deps.log(`métricas: alerta não gravado (${err instanceof Error ? err.message : String(err)})`);
      }
      return;
    }
    if (rule.verdict.recovered === true) await this.clear(rule.key, state);
  }

  private async clear(key: string, state: State): Promise<void> {
    try {
      if (state.alertId !== null) await this.deps.resolve(state.alertId);
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
        this.active.set(key, { alertId: a.id });
      } else if (owned(a.title)) {
        await this.clear(`adotado:${a.id}`, { alertId: a.id });
      }
    }
  }

  async evaluate(tick: TickResult, recent: Recent): Promise<void> {
    const nowSec = tick.t;
    const rules = hostRules(recent, nowSec);
    const seen = new Set<string>();
    // Sem leitura do Docker nesta volta, nada se sabe dos containers: não é "sumiram". Mantém o estado.
    for (const c of tick.dockerOk ? tick.containers : []) {
      const ok = c.unhealthySince === null ? (this.streak.get(c.id) ?? 0) + 1 : 0;
      this.streak.set(c.id, ok);
      for (const r of containerRules(c, nowSec, ok)) {
        rules.push(r);
        seen.add(r.key);
      }
      // morte por falta de memória: evento, sem volta ao normal automática (a pessoa resolve)
      if (c.oomAt.includes(nowSec)) {
        rules.push({
          key: `c:${c.id}:oom:${nowSec}`,
          severity: "critical",
          title: `${label(c)} morreu por falta de memória`,
          detail: "O container passou do limite de memória e o sistema encerrou um processo dele. Aumente o limite ou a memória da VPS, ou reduza o consumo.",
          verdict: { trigger: true, recovered: true },
        });
      }
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
    for (const [key, state] of [...this.active]) {
      if (key.startsWith("c:") && !seen.has(key)) await this.clear(key, state);
    }
  }
}
