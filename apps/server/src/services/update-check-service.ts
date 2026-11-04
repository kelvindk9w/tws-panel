/**
 * update-check-service.ts — alerta de "nova atualização do projeto".
 *
 * Compara a ponta da BRANCH CONFIGURADA do projeto no repositório remoto
 * (`ls-remote`, sem clonar, com todas as proteções de git-access.ts) com o
 * commit que o último deploy bem-sucedido deixou no ar (Project.deployedCommit).
 * É só AVISO: nada aqui faz deploy.
 *
 * Regras que importam:
 *  - "Não deu para verificar" NUNCA vira "sem atualização": falha de rede,
 *    credencial recusada, branch inexistente etc. são o estado `error` (com um
 *    código fixo; o texto do servidor remoto não passa por aqui, então nem o
 *    token pode vazar).
 *  - Sem commit registrado (projeto publicado antes deste registro) o estado é
 *    `unknown`: nunca uma "atualização" falsa. O registro nasce no próximo deploy.
 *  - Projetos diferentes com o MESMO repositório e branches diferentes são
 *    independentes: a consulta e o cache são por projeto, na branch dele.
 *    Trocar repositório/branch invalida o cache (a chave os inclui).
 *  - Um projeto lento ou com credencial inválida não trava os outros: as
 *    consultas passam por uma fila com poucas vagas simultâneas, cada uma com
 *    prazo, e cada projeto tem o próprio cache e o próprio recuo (backoff).
 *
 * Cache: resultado bom vale UPDATE_CHECK_TTL_MS (com jitter); falha recua
 * exponencialmente (30 s, 1 min, 2 min… até 15 min) e continua mostrada como
 * erro. Uma consulta mais antiga que o último deploy não vale (o deploy pode ter
 * baixado um commit mais novo que o consultado).
 */
import {
  DEFAULT_PROJECT_BRANCH,
  type GitReadCredential,
  type Project,
  type ProjectUpdateStatus,
  type UpdateErrorReason,
  type UpdateState,
} from "@paas/core";
import type { GitAccessInput, RemoteBranchCommit, TargetCheck } from "@paas/deploy";

/** Quanto tempo um resultado bom vale antes de nova consulta (por projeto). */
export const UPDATE_CHECK_TTL_MS = 5 * 60_000;
/** Primeiro recuo depois de uma falha; dobra a cada falha seguida. */
export const UPDATE_CHECK_ERROR_BASE_MS = 30_000;
/** Teto do recuo. */
export const UPDATE_CHECK_ERROR_MAX_MS = 15 * 60_000;
/** Consultas ao mesmo tempo (as demais esperam na fila). */
export const UPDATE_CHECK_CONCURRENCY = 3;
/** Prazo da consulta ao repositório (o git mata o grupo de processos ao estourar). */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** Teto da consulta inteira (inclui a resolução do endereço): estourou, o resultado é "timeout" (a vaga ainda não volta). */
export const UPDATE_CHECK_HARD_TIMEOUT_MS = 15_000;
/**
 * Limite FINAL da vaga: se o trabalho segue pendurado (resolução de nome que nunca responde), a vaga volta
 * mesmo assim, para a fila nunca travar para sempre. No caso normal o trabalho termina bem antes (o ls-remote
 * é morto aos 10 s) e vale o máximo de UPDATE_CHECK_CONCURRENCY simultâneas; só uma resolução pendurada
 * (que não dá para abortar) pode ficar viva além deste prazo, sem segurar a fila.
 */
export const UPDATE_CHECK_SLOT_TIMEOUT_MS = 60_000;
/** Quanto a rota espera uma consulta em andamento antes de responder "verificando". */
export const UPDATE_CHECK_WAIT_MS = 2_500;
/** "Verificar agora" repetido dentro deste prazo reaproveita o resultado recente. */
export const UPDATE_CHECK_MANUAL_MIN_MS = 10_000;
/** Variação aleatória (±) do prazo, para os projetos não consultarem todos juntos. */
export const UPDATE_CHECK_JITTER = 0.2;

const SHORT = 7;

export interface UpdateCheckDeps {
  credentialFor: (project: Project) => Promise<GitReadCredential | null>;
  resolveTarget: (source: string) => Promise<TargetCheck>;
  remoteBranchCommit: (input: GitAccessInput & { branch: string }) => Promise<RemoteBranchCommit>;
  now?: () => number;
  random?: () => number;
}

interface Entry {
  /** repositório + branch consultados: mudou algum, o resultado não vale. */
  key: string;
  remoteCommit: string | null;
  reason: UpdateErrorReason | null;
  checkedAt: number;
  /** Antes disto nenhuma consulta nova automática. */
  nextAt: number;
  failures: number;
}

/** Código fixo da interface para cada motivo do git; nada do texto dele passa. */
export function updateReasonOf(reason: string): UpdateErrorReason {
  switch (reason) {
    case "invalid_token":
    case "auth_required":
      return "auth";
    case "no_permission":
      return "no_permission";
    case "not_found":
    case "not_found_or_no_access":
      return "not_found";
    case "branch_not_found":
      return "branch_not_found";
    case "unreachable":
      return "unreachable";
    case "timeout":
      return "timeout";
    case "redirected":
      return "redirected";
    case "blocked_host":
      return "blocked_host";
    case "unsupported_host":
      return "unsupported";
    default:
      return "unknown";
  }
}

export function branchOf(project: Project): string {
  return project.branch?.trim() || DEFAULT_PROJECT_BRANCH;
}

export class UpdateCheckService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** Consultas esperando vaga; sai primeiro a do projeto verificado há mais tempo (nunca verificado = 0). */
  private readonly waiting: Array<{ priority: number; start: () => void }> = [];
  private active = 0;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly deps: UpdateCheckDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  private keyOf(project: Project): string {
    return `${project.source}\n${branchOf(project)}`;
  }

  /** O cache vale para este projeto agora? (mesma chave e consulta posterior ao último deploy) */
  private usable(project: Project): Entry | null {
    const entry = this.cache.get(project.id);
    if (!entry || entry.key !== this.keyOf(project)) return null;
    const deployedAt = project.lastDeployAt ? Date.parse(project.lastDeployAt) : NaN;
    if (Number.isFinite(deployedAt) && entry.checkedAt < deployedAt) return null;
    return entry;
  }

  /** Esta situação precisa de consulta ao repositório? (senão o estado sai só dos dados do projeto) */
  private localState(project: Project): UpdateState | null {
    if (project.ingestMode !== "git") return "not_applicable";
    const deployed = project.lastDeployStatus === "success" || (project.deployedSource ?? null) !== null;
    if (!deployed) return "never_deployed";
    // O que está no ar vem de OUTRA branch/repositório: comparar commits não faria sentido.
    // (deployedBranch vazio = a branch padrão: projeto criado sem branch)
    if (
      project.deployedSource != null &&
      (project.deployedSource !== project.source ||
        (project.deployedBranch?.trim() || DEFAULT_PROJECT_BRANCH) !== branchOf(project))
    ) {
      return "config_changed";
    }
    if (!project.deployedCommit) return "unknown";
    return null;
  }

  /** Estado atual, SÓ do que já se sabe (nunca espera rede). */
  statusOf(project: Project): ProjectUpdateStatus {
    const base: ProjectUpdateStatus = {
      projectId: project.id,
      state: "checking",
      branch: project.ingestMode === "git" ? branchOf(project) : null,
      remoteCommit: null,
      deployedCommit: project.deployedCommit ? project.deployedCommit.slice(0, SHORT) : null,
      reason: null,
      checkedAt: null,
    };
    const local = this.localState(project);
    if (local) return { ...base, state: local };
    const entry = this.usable(project);
    if (!entry) return base;
    const checkedAt = new Date(entry.checkedAt).toISOString();
    if (entry.reason) return { ...base, state: "error", reason: entry.reason, checkedAt };
    const remote = entry.remoteCommit as string;
    return {
      ...base,
      state: remote === project.deployedCommit ? "up_to_date" : "update_available",
      remoteCommit: remote.slice(0, SHORT),
      checkedAt,
    };
  }

  /** Esquece o que sabe do projeto (credencial trocada, por exemplo). */
  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private jittered(ms: number): number {
    return Math.round(ms * (1 + (this.random() * 2 - 1) * UPDATE_CHECK_JITTER));
  }

  /** Dispara a consulta se for preciso (e permitido). Devolve a consulta em andamento, se houver. */
  private schedule(project: Project, force: boolean): Promise<void> | null {
    if (this.localState(project)) return null;
    const running = this.inflight.get(project.id);
    if (running) return running;
    const entry = this.usable(project);
    if (entry) {
      if (!force && this.now() < entry.nextAt) return null;
      if (force && this.now() - entry.checkedAt < UPDATE_CHECK_MANUAL_MIN_MS) return null;
    }
    const priority = this.cache.get(project.id)?.checkedAt ?? 0;
    const job = this.enqueue(priority, (release) => this.run(project, release)).finally(() => this.inflight.delete(project.id));
    this.inflight.set(project.id, job);
    return job;
  }

  /**
   * Fila com UPDATE_CHECK_CONCURRENCY vagas. A vaga só volta quando o trabalho de fato termina
   * (`release`, chamado por `run`), mesmo que o resultado já tenha sido registrado pelo teto de tempo:
   * assim uma resolução de nome pendurada nunca deixa passar de 3 consultas ao mesmo tempo. Quem espera
   * é atendido pelo projeto verificado há mais tempo, para os lentos da frente não adiarem os demais.
   */
  private enqueue(priority: number, task: (release: () => void) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = () => {
        this.active += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.pump();
        };
        // `run` captura tudo o que pode falhar: a tarefa não rejeita
        void task(release).finally(resolve);
      };
      this.waiting.push({ priority, start });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < UPDATE_CHECK_CONCURRENCY && this.waiting.length > 0) {
      let best = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        if ((this.waiting[i] as { priority: number }).priority < (this.waiting[best] as { priority: number }).priority) best = i;
      }
      const [next] = this.waiting.splice(best, 1);
      next?.start();
    }
  }

  private async run(project: Project, release: () => void): Promise<void> {
    const key = this.keyOf(project);
    const branch = branchOf(project);
    let outcome: { commit: string } | { reason: UpdateErrorReason };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        const target = await this.deps.resolveTarget(project.source);
        if (!target.ok) return { reason: updateReasonOf(target.reason) };
        const credential = await this.deps.credentialFor(project);
        const result = await this.deps.remoteBranchCommit({
          source: project.source,
          branch,
          pin: target.pin,
          credential,
          timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
        });
        return result.ok ? { commit: result.commit } : { reason: updateReasonOf(result.reason) };
      })();
      // a vaga volta quando o trabalho termina de verdade (não quando o teto de tempo dá o resultado);
      // pendurado além do limite final, volta assim mesmo (log curto, sem endereço nem credencial)
      const slotTimer = setTimeout(() => {
        console.warn(`Alerta de atualização: a consulta do projeto ${project.id} não terminou em ${UPDATE_CHECK_SLOT_TIMEOUT_MS / 1000} s; a vaga foi liberada.`);
        release();
      }, UPDATE_CHECK_SLOT_TIMEOUT_MS);
      const done = () => {
        clearTimeout(slotTimer);
        release();
      };
      void work.then(done, done);
      const hardStop = new Promise<{ reason: UpdateErrorReason }>((resolve) => {
        timer = setTimeout(() => resolve({ reason: "timeout" }), UPDATE_CHECK_HARD_TIMEOUT_MS);
      });
      outcome = await Promise.race([work, hardStop]);
    } catch {
      // Sem a mensagem do erro: ela poderia ecoar o que o git recebeu.
      outcome = { reason: "unknown" };
    } finally {
      clearTimeout(timer);
    }

    const now = this.now();
    // se o projeto mudou de repositório/branch durante a consulta, o resultado é de outra coisa
    const previous = this.cache.get(project.id);
    const failures = "reason" in outcome ? (previous?.key === key ? previous.failures : 0) + 1 : 0;
    const wait =
      "reason" in outcome
        ? Math.min(UPDATE_CHECK_ERROR_MAX_MS, UPDATE_CHECK_ERROR_BASE_MS * 2 ** (failures - 1))
        : UPDATE_CHECK_TTL_MS;
    this.cache.set(project.id, {
      key,
      remoteCommit: "commit" in outcome ? outcome.commit : null,
      reason: "reason" in outcome ? outcome.reason : null,
      checkedAt: now,
      nextAt: now + this.jittered(wait),
      failures,
    });
  }

  private async waitFor(jobs: Array<Promise<void>>): Promise<void> {
    if (jobs.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, UPDATE_CHECK_WAIT_MS);
    });
    try {
      await Promise.race([Promise.all(jobs), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Estado de um projeto: dispara a consulta se o cache venceu e espera um pouco por ela. */
  async status(project: Project, opts: { force?: boolean } = {}): Promise<ProjectUpdateStatus> {
    const job = this.schedule(project, opts.force === true);
    if (job) await this.waitFor([job]);
    return this.statusOf(project);
  }

  /** Estado de todos (Dashboard). Esquece o cache de projetos que não existem mais. */
  async statuses(projects: Project[]): Promise<ProjectUpdateStatus[]> {
    const ids = new Set(projects.map((p) => p.id));
    for (const id of [...this.cache.keys()]) if (!ids.has(id)) this.cache.delete(id);
    const jobs = projects.map((p) => this.schedule(p, false)).filter((j): j is Promise<void> => j !== null);
    await this.waitFor(jobs);
    return projects.map((p) => this.statusOf(p));
  }
}
