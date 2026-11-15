/**
 * aof-repair.ts — reparo, com um clique e nunca automático, do arquivo AOF do redis/valkey que ficou com o final
 * corrompido (zeros ou lixo no fim depois de uma queda brusca: "Bad file format"; o serviço reinicia sem parar).
 * Arquivo só truncado não chega aqui: com aof-load-truncated yes, o padrão, o redis descarta o fim e sobe sozinho.
 * Faz o que se faria à mão, pela ferramenta da própria imagem:
 *
 *   1. mede: no container auxiliar, `redis-check-aof <manifesto>` SEM --fix diz quantos bytes o corte descartaria
 *      (a ferramenta não grava nada sem --fix). Imagem sem a ferramenta, manifesto fora do lugar, arquivo já
 *      íntegro ou corte maior que o confirmado pela pessoa: para aqui, NADA foi alterado;
 *   2. para o container do serviço (`docker stop`);
 *   3. copia a pasta do AOF para `<pasta>.bak-<AAAAMMDD-HHMMSS>` (UTC) no próprio volume. Falhou: liga de novo, nada cortado;
 *   4. `redis-check-aof --fix <manifesto>` (respondendo "y"), que corta o final a partir do último comando inteiro.
 *      O script mede de novo e só corta se o corte não passar do que a pessoa confirmou. Falhou: liga de novo; a cópia fica;
 *   5. liga o container (`docker start`).
 *
 * Regras de segurança:
 *  - o pedido escolhe só o SERVIÇO (validado por formato); o container vem da lista do painel e o dono é conferido
 *    de novo no `docker inspect` (container-identity.ts): só um container DESTE projeto;
 *  - o AOF corrompido tem de estar no log recente do container agora (o painel não adivinha); o nome do arquivo
 *    vem desse log só no formato seguro (redis-aof.ts) e vai como argumento, nunca como texto de shell;
 *  - a pasta de dados vem do container (o `--dir` dos argumentos ou a pasta de trabalho dele) e tem de estar num
 *    volume (ou bind) gravável dele; a pasta do AOF dentro dela também vem do container (`--appenddirname` ou o
 *    padrão appendonlydir), nunca do log (a do log do Redis 8.4+ só confere); nenhum caminho vem do cliente;
 *  - projeto parado pela pessoa (botão Parar): o reparo é feito e o serviço FICA parado (conferido de novo logo
 *    antes de ligar); o resultado e a auditoria dizem isso. Recusar obrigaria a pessoa a ligar o projeto, que
 *    reiniciaria sem parar de novo, só para poder reparar;
 *  - um reparo (ou medição) por projeto de cada vez, e o projeto fica reservado como num backup (nenhum deploy
 *    começa; deploy em andamento = 409) e em manutenção para o monitoramento (o serviço parado não vira alerta).
 */
import path from "node:path";
import { aofDirFromArgs, containerIdentity, detectAofCorruption, type AofCorruption, type AofMeasureResponse, type AofRepairResponse, type DockerContainerInfo } from "@paas/core";
import type { RecentLogs } from "./aof-diagnosis.js";
import type { AofContainerInspect, AofDocker, AofHelperSpec, AofMount } from "./aof-repair-docker.js";
import { httpError } from "./http-error.js";
import { stripLogControl } from "./log-mask.js";
import { LOG_SERVICE_RE } from "./project-logs.js";

/** Prazos de cada etapa no container auxiliar. */
export const AOF_TIMEOUTS = { measureMs: 5 * 60_000, backupMs: 20 * 60_000, fixMs: 10 * 60_000 } as const;
/** Teto da saída devolvida à tela (o fim é o que importa). */
export const AOF_OUTPUT_MAX = 20_000;

/** Códigos de saída próprios dos scripts (os da ferramenta são 0 e 1; 125–127 são do Docker). */
export const AOF_EXIT = { noTool: 90, noManifest: 91, noDiff: 92, alreadyValid: 93, exceeds: 94, backupExists: 95, copyFailed: 96 } as const;

const PRELUDE = [
  "set -u",
  'tool="$1"',
  'dir="$2"',
  'manifest="$3"',
  'command -v "$tool" >/dev/null 2>&1 || exit 90',
  '[ -f "$dir/$manifest" ] || exit 91',
];

/** Medição: a ferramenta sem --fix (não grava). Sai com o código dela (0 = íntegro, 1 = inválido). */
export const MEASURE_SCRIPT = [...PRELUDE, '"$tool" "$dir/$manifest"'].join("\n");

/** Cópia da pasta do AOF (com dono, permissões e horários). Cópia pela metade é apagada. */
export const BACKUP_SCRIPT = [
  "set -u",
  'dir="$1"',
  'bak="$2"',
  '[ -d "$dir" ] || exit 91',
  '[ ! -e "$bak" ] || exit 95',
  'if ! cp -a "$dir" "$bak"; then rm -rf "$bak"; exit 96; fi',
  'echo "copia feita: $bak"',
].join("\n");

/** Corte: mede de novo e só corta se não passar de `max` bytes. */
export const FIX_SCRIPT = [
  ...PRELUDE,
  'max="$4"',
  'out=$("$tool" "$dir/$manifest" 2>&1)',
  "printf '%s\\n' \"$out\"",
  "d=$(printf '%s\\n' \"$out\" | sed -n 's/^AOF analyzed: .*diff=\\([0-9][0-9]*\\).*$/\\1/p' | tail -n 1)",
  '[ -n "$d" ] || exit 92',
  '[ "$d" -gt 0 ] || exit 93',
  '[ "$d" -le "$max" ] || exit 94',
  "printf 'y\\n' | \"$tool\" --fix \"$dir/$manifest\"",
].join("\n");

/** Saída da ferramenta → bytes que o corte descarta (a última linha "AOF analyzed"), e se ela cortou. */
export function parseCheckAofOutput(output: string): { diff: number | null; truncated: boolean } {
  let diff: number | null = null;
  for (const m of output.matchAll(/^AOF analyzed: .*\bdiff=(\d{1,19})\b/gm)) {
    const n = Number(m[1]);
    diff = Number.isSafeInteger(n) ? n : null;
  }
  return { diff, truncated: /Successfully truncated AOF /.test(output) };
}

const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]{0,250}$/;
const SAFE_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,250}$/;

/** Caminho absoluto sem `..`, sem barra dupla e sem caracteres que mudariam o `--mount` (vírgula, `=`, espaço). */
export function isSafeAbsPath(p: string): boolean {
  return SAFE_PATH.test(p) && path.posix.normalize(p) === p && !p.split("/").includes("..") && (p === "/" || !p.endsWith("/"));
}

/**
 * Pasta de dados do redis no container: o último `--dir <pasta>` dos argumentos (relativo à pasta de trabalho)
 * ou, sem ele, a pasta de trabalho (o `dir ./` padrão; na imagem oficial, /data). null = não dá para saber.
 */
export function resolveDataDir(c: Pick<AofContainerInspect, "argv" | "workingDir">): string | null {
  let dir: string | null = null;
  for (let i = 0; i < c.argv.length - 1; i++) if (c.argv[i] === "--dir") dir = c.argv[i + 1]!;
  const wd = c.workingDir !== null && c.workingDir.startsWith("/") ? path.posix.normalize(c.workingDir) : null;
  let out: string | null;
  if (dir === null) out = wd;
  else if (dir.startsWith("/")) out = path.posix.normalize(dir);
  else out = wd === null ? null : path.posix.resolve(wd, dir);
  if (out !== null && out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out !== null && out !== "/" && isSafeAbsPath(out) ? out : null;
}

/** A montagem (volume ou bind) que contém a pasta de dados: a de destino mais específico. */
export function mountFor(dataDir: string, mounts: readonly AofMount[]): AofMount | null {
  let best: AofMount | null = null;
  for (const m of mounts) {
    if (m.type !== "volume" && m.type !== "bind") continue;
    if (!(dataDir === m.destination || dataDir.startsWith(`${m.destination}/`))) continue;
    if (best === null || m.destination.length > best.destination.length) best = m;
  }
  return best;
}

/** A montagem no formato do auxiliar, só com nomes e caminhos seguros; null = não dá para montar com segurança. */
export function helperMount(m: AofMount): AofHelperSpec["mount"] | null {
  if (!isSafeAbsPath(m.destination) || m.destination === "/") return null;
  if (m.type === "volume") return m.name !== null && SAFE_VOLUME.test(m.name) ? { type: "volume", source: m.name, destination: m.destination } : null;
  return isSafeAbsPath(m.source) && m.source !== "/" ? { type: "bind", source: m.source, destination: m.destination } : null;
}

/** Nome da cópia: `<pasta>.bak-AAAAMMDD-HHMMSS` (UTC). */
export function backupDirName(dir: string, nowMs: number): string {
  const iso = new Date(nowMs).toISOString(); // 2026-11-14T03:12:01.123Z
  return `${dir}.bak-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

export interface AofProjectRef {
  id: string;
  slug: string;
  name: string;
}

export interface AofRepairDeps {
  /** Containers da máquina (lança DockerUnavailableError sem Docker). */
  listContainers(): Promise<DockerContainerInfo[]>;
  logs: RecentLogs;
  docker: AofDocker;
  /** Reserva o projeto como um backup (nenhum deploy começa; deploy em andamento = 409). Devolve quem solta. */
  hold(projectId: string, reason: string): Promise<() => void>;
  /** Manutenção para o monitoramento: o serviço parado de propósito não vira alerta. Devolve quem solta. */
  maintenance(slug: string): () => void;
  /** O painel vai parar/ligar: o reinício que isso causa não conta como "reinicia sem parar". */
  noteManualAction(slug: string): void;
  /** O projeto está parado pela pessoa (Project.stoppedAt), lido de novo a cada chamada. */
  stoppedByUser(projectId: string): Promise<boolean>;
  /** Reparo feito: o diagnóstico deste container sai na hora (o Dashboard e o alerta não mostram mais a causa velha). */
  forgetDiagnosis?(containerId: string): void;
  audit(entry: { actor: string; action: string; target: string; detail: string }): Promise<unknown>;
  now(): number;
}

interface Target {
  container: AofContainerInspect;
  service: string;
  finding: AofCorruption;
  dataDir: string;
  /** Pasta do AOF dentro da pasta de dados, pela configuração do container. */
  aofDir: string;
  mount: NonNullable<ReturnType<typeof helperMount>>;
}

const clean = (text: string) => stripLogControl(text).replace(/\r/g, "");

export class AofRepairService {
  /** Projetos com medição ou reparo em andamento (marcado sem `await` entre conferir e marcar). */
  private readonly busy = new Set<string>();
  /** Projetos sendo parados, iniciados ou removidos agora pelas rotas do projeto (quantas ações em curso). */
  private readonly lifecycle = new Map<string, number>();

  constructor(private readonly deps: AofRepairDeps) {}

  /** Há medição ou reparo em andamento neste projeto? */
  isBusy(projectId: string): boolean {
    return this.busy.has(projectId);
  }

  /**
   * Parar, iniciar ou remover o projeto vai começar (routes/projects.ts). Com reparo em andamento, 409
   * aof_repair_in_progress; senão marca o projeto até a ação terminar (a medição e o reparo recusam enquanto isso,
   * 409 aof_project_busy) e devolve quem desmarca. Conferir e marcar sem `await` no meio: sem janela entre os dois.
   */
  beginProjectAction(projectId: string): () => void {
    if (this.busy.has(projectId)) {
      throw httpError(409, "aof_repair_in_progress", "Há um reparo do arquivo do redis em andamento neste projeto: espere ele terminar.");
    }
    this.lifecycle.set(projectId, (this.lifecycle.get(projectId) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.lifecycle.get(projectId) ?? 1) - 1;
      if (n > 0) this.lifecycle.set(projectId, n);
      else this.lifecycle.delete(projectId);
    };
  }

  private lock(projectId: string): () => void {
    if (this.busy.has(projectId)) throw httpError(409, "aof_repair_in_progress", "Já há um reparo do arquivo do redis em andamento neste projeto. Espere terminar.");
    if (this.lifecycle.has(projectId)) {
      throw httpError(409, "aof_project_busy", "O projeto está sendo parado, iniciado ou removido agora. Nada foi feito: tente de novo quando terminar.");
    }
    this.busy.add(projectId);
    return () => this.busy.delete(projectId);
  }

  /** O container do serviço, a causa no log de agora, a pasta de dados e a montagem dela. Lança com o motivo. */
  private async locate(project: AofProjectRef, service: string): Promise<Target> {
    if (!LOG_SERVICE_RE.test(service)) throw httpError(400, "invalid_service", "Nome de serviço inválido.");
    const mine = (await this.deps.listContainers()).filter((c) => c.managed && c.projectSlug === project.slug && (c.service ?? c.name) === service);
    if (mine.length === 0) throw httpError(404, "service_not_found", "Esse serviço não existe neste projeto.");
    if (mine.length > 1) throw httpError(409, "aof_multiple_containers", "O serviço tem mais de um container (réplicas): o reparo pelo painel funciona com um container só. Veja o guia do reparo manual.");
    const listed = mine[0]!;
    const container = await this.deps.docker.inspect(listed.id);
    if (container === null) throw httpError(503, "docker_unavailable", "Não foi possível consultar o container no Docker agora. Nada foi alterado.");
    // o dono conferido de novo, na leitura de agora (a lista pode ter mudado entre as duas chamadas)
    if (containerIdentity(container.labels, container.name).projectSlug !== project.slug) {
      throw httpError(404, "service_not_found", "Esse serviço não existe neste projeto.");
    }
    const lines = await this.deps.logs(container.id);
    if (lines === null) throw httpError(503, "aof_logs_unavailable", "Não foi possível ler o log do serviço agora. Nada foi alterado.");
    const finding = detectAofCorruption(lines);
    if (finding === null) {
      throw httpError(409, "aof_not_detected", "O log recente do serviço não mostra o arquivo do redis corrompido. Nada foi feito.");
    }
    const aofDir = aofDirFromArgs(container.argv);
    if (aofDir === null) throw httpError(422, "aof_data_dir_unknown", "A pasta do AOF configurada no container (--appenddirname) tem um nome que o painel não usa com segurança. Nada foi alterado; veja o guia do reparo manual.");
    if (finding.logDir !== null && finding.logDir !== aofDir) {
      throw httpError(422, "aof_data_dir_unknown", `A pasta do AOF no log (${finding.logDir}) não confere com a configuração do container (${aofDir}). Nada foi alterado; veja o guia do reparo manual.`);
    }
    const eng = finding.engine;
    const dataDir = resolveDataDir(container);
    if (dataDir === null) throw httpError(422, "aof_data_dir_unknown", `Não foi possível saber a pasta de dados do ${eng} neste container. Nada foi alterado; veja o guia do reparo manual.`);
    const m = mountFor(dataDir, container.mounts);
    if (m === null) throw httpError(422, "aof_not_on_volume", `A pasta de dados do ${eng} (${dataDir}) não está num volume do container: o painel não repara dados que somem quando o container é recriado. Nada foi alterado.`);
    if (!m.rw) throw httpError(422, "aof_volume_read_only", `O volume da pasta de dados do ${eng} (${dataDir}) está montado só para leitura. Nada foi alterado.`);
    const mount = helperMount(m);
    if (mount === null) throw httpError(422, "aof_data_dir_unknown", "O volume da pasta de dados tem um nome ou caminho que o painel não monta com segurança. Nada foi alterado; veja o guia do reparo manual.");
    return { container, service, finding, dataDir, aofDir, mount };
  }

  private spec(t: Target, script: string, args: string[], timeoutMs: number): AofHelperSpec {
    return { image: t.container.image, mount: t.mount, workdir: t.dataDir, script, args, timeoutMs };
  }

  /** Mede quanto o corte descartaria. Nada é alterado. Lança com o motivo quando não dá para medir. */
  private async measureTarget(t: Target): Promise<{ bytes: number; output: string }> {
    const r = await this.deps.docker.helper(this.spec(t, MEASURE_SCRIPT, [t.finding.tool, t.aofDir, t.finding.manifest], AOF_TIMEOUTS.measureMs));
    const output = clean(r.output);
    if (r.timedOut) throw httpError(504, "aof_timeout", "A medição do arquivo passou do prazo e foi interrompida. Nada foi alterado.");
    if (r.code === AOF_EXIT.noTool || r.code === 126 || r.code === 127) {
      throw httpError(422, "aof_tool_missing", `A imagem do serviço não tem a ferramenta ${t.finding.tool} (ou o sh). Nada foi alterado; veja o guia do reparo manual.`);
    }
    if (r.code === AOF_EXIT.noManifest) {
      throw httpError(422, "aof_manifest_missing", `O manifesto ${t.aofDir}/${t.finding.manifest} não está na pasta de dados (${t.dataDir}). Nada foi alterado.`);
    }
    const { diff } = parseCheckAofOutput(output);
    if ((r.code !== 0 && r.code !== 1) || diff === null) {
      const err = httpError(502, "aof_check_failed", "A ferramenta de conferência do arquivo não respondeu como esperado. Nada foi alterado.");
      err.details = { output: output.slice(-AOF_OUTPUT_MAX) };
      throw err;
    }
    return { bytes: diff, output };
  }

  /** POST .../aof-repair/measure: quanto o reparo descartaria agora (o redis antes do 8.4 e o valkey não dizem). */
  async measure(project: AofProjectRef, service: string): Promise<AofMeasureResponse> {
    const unlock = this.lock(project.id);
    try {
      const t = await this.locate(project, service);
      const m = await this.measureTarget(t);
      if (m.bytes === 0) throw httpError(409, "aof_already_valid", `A ferramenta diz que o arquivo do ${t.finding.engine} está íntegro: não há o que cortar.`);
      return { service: t.service, file: t.finding.file, bytes: m.bytes };
    } finally {
      unlock();
    }
  }

  /** POST .../aof-repair: o reparo confirmado. `maxBytes` = o que a pessoa aceitou descartar. */
  async repair(project: AofProjectRef, service: string, maxBytes: number, actor: string): Promise<AofRepairResponse> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw httpError(400, "invalid_max_bytes", "Informe quantos bytes podem ser descartados (um número inteiro positivo).");
    const unlock = this.lock(project.id);
    try {
      const release = await this.deps.hold(project.id, "Reparo do arquivo do redis em andamento");
      const endMaintenance = this.deps.maintenance(project.slug);
      try {
        const t = await this.locate(project, service);
        const before = await this.measureTarget(t);
        if (before.bytes === 0) throw httpError(409, "aof_already_valid", `A ferramenta diz que o arquivo do ${t.finding.engine} está íntegro: não há o que cortar. Nada foi alterado.`);
        if (before.bytes > maxBytes) {
          const err = httpError(
            409,
            "aof_discard_exceeds",
            `O reparo descartaria ${before.bytes} bytes, mais do que os ${maxBytes} confirmados. Nada foi alterado: confira e confirme de novo com o número atual.`,
          );
          err.details = { bytes: before.bytes };
          throw err;
        }
        return await this.run(project, t, before.output, maxBytes, actor);
      } finally {
        endMaintenance();
        release();
      }
    } finally {
      unlock();
    }
  }

  /** Para, copia, corta e liga. A partir daqui o resultado volta sempre (as falhas dizem o que ficou). */
  private async run(project: AofProjectRef, t: Target, measured: string, maxBytes: number, actor: string): Promise<AofRepairResponse> {
    const parts = [`== Medição (${t.finding.tool}, sem --fix) ==\n${measured.trimEnd()}`];
    const result = (r: Omit<AofRepairResponse, "service" | "output">): AofRepairResponse => {
      const output = parts.join("\n\n");
      return { ...r, service: t.service, output: output.length > AOF_OUTPUT_MAX ? `…${output.slice(-AOF_OUTPUT_MAX)}` : output };
    };
    const id = t.container.id;
    const where = `serviço ${t.service} (container ${t.container.name}), arquivo ${t.finding.file}`;
    // "redis" ou "valkey": o nome do produto que o log e a ferramenta mostraram
    const eng = t.finding.engine;
    // projeto parado pela pessoa: o reparo acontece, mas o serviço fica parado no fim (conferido de novo antes de ligar)
    const stoppedAtStart = await this.deps.stoppedByUser(project.id).catch(() => false);

    this.deps.noteManualAction(project.slug);
    try {
      await this.deps.docker.stop(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.record(actor, "project.aof_repair_failed", project, `Reparo do arquivo do ${eng} não começou: o container não parou (${msg}). ${where}. Nada foi alterado.`);
      throw httpError(502, "aof_stop_failed", `O container do serviço não parou: ${msg}. Nada foi alterado.`);
    }
    parts.push("== Serviço parado ==");

    // volta ao estado anterior: liga de novo, salvo com o projeto parado pela pessoa (conferido agora, antes de ligar)
    const restart = async (): Promise<{ restarted: boolean; keptStopped: boolean; says: string }> => {
      let stopped = stoppedAtStart;
      if (!stopped) {
        try {
          stopped = await this.deps.stoppedByUser(project.id);
        } catch {
          stopped = false; // sem saber, volta ao que era quando o reparo começou (não estava parado pela pessoa)
        }
      }
      if (stopped) {
        parts.push("== O projeto está parado por você: o serviço ficou parado ==");
        return { restarted: false, keptStopped: true, says: "Serviço deixado parado (o projeto está parado pela pessoa)" };
      }
      this.deps.noteManualAction(project.slug);
      try {
        await this.deps.docker.start(id);
        parts.push("== Serviço ligado de novo ==");
        return { restarted: true, keptStopped: false, says: "Serviço ligado de novo" };
      } catch (err) {
        parts.push(`== O serviço NÃO voltou a subir: ${clean(err instanceof Error ? err.message : String(err))} ==`);
        return { restarted: false, keptStopped: false, says: "Serviço NÃO voltou a subir" };
      }
    };

    const backup = backupDirName(t.aofDir, this.deps.now());
    const copy = await this.deps.docker.helper(this.spec(t, BACKUP_SCRIPT, [t.aofDir, backup], AOF_TIMEOUTS.backupMs));
    parts.push(`== Cópia: ${t.aofDir} → ${backup} ==\n${clean(copy.output).trimEnd()}`);
    if (copy.code !== 0 || copy.timedOut) {
      parts.push(
        copy.timedOut
          ? "A cópia passou do prazo e foi interrompida."
          : copy.code === AOF_EXIT.backupExists
            ? "Já existe uma cópia com esse nome: nada foi sobrescrito."
            : "A cópia não pôde ser feita (espaço em disco?). O que foi copiado pela metade foi apagado.",
      );
      const back = await restart();
      await this.record(actor, "project.aof_repair_failed", project, `Reparo do arquivo do ${eng}: a cópia de segurança falhou e nada foi cortado. ${where}. ${back.says}.`);
      return result({ ok: false, outcome: "backup_failed", backup: null, discardedBytes: null, restarted: back.restarted, keptStopped: back.keptStopped });
    }

    const fix = await this.deps.docker.helper(this.spec(t, FIX_SCRIPT, [t.finding.tool, t.aofDir, t.finding.manifest, String(maxBytes)], AOF_TIMEOUTS.fixMs));
    const fixOut = clean(fix.output);
    parts.push(`== Reparo (${t.finding.tool} --fix) ==\n${fixOut.trimEnd()}`);
    const parsed = parseCheckAofOutput(fixOut);
    if (fix.code !== 0 || fix.timedOut || !parsed.truncated) {
      parts.push(
        fix.timedOut
          ? "O reparo passou do prazo e foi interrompido."
          : fix.code === AOF_EXIT.exceeds
            ? `O corte passaria dos ${maxBytes} bytes confirmados: nada foi cortado.`
            : fix.code === AOF_EXIT.alreadyValid
              ? "A ferramenta diz que o arquivo já está íntegro: nada foi cortado."
              : "A ferramenta não cortou o arquivo (veja a saída acima). Um arquivo corrompido fora do último pedaço não tem reparo automático.",
      );
      const back = await restart();
      await this.record(actor, "project.aof_repair_failed", project, `Reparo do arquivo do ${eng}: a ferramenta não cortou o arquivo. ${where}. A cópia ${backup} ficou no volume. ${back.says}.`);
      return result({ ok: false, outcome: "fix_failed", backup, discardedBytes: null, restarted: back.restarted, keptStopped: back.keptStopped });
    }

    const discarded = parsed.diff;
    const back = await restart();
    const ok = back.restarted || back.keptStopped;
    // o arquivo foi cortado: a causa velha sai do Dashboard e do alerta já (sem esperar a releitura do log)
    try {
      this.deps.forgetDiagnosis?.(id);
    } catch {
      // limpar o diagnóstico não muda o resultado do reparo
    }
    await this.record(
      actor,
      ok ? "project.aof_repaired" : "project.aof_repair_failed",
      project,
      `Arquivo do ${eng} reparado: ${where}; ${discarded ?? "?"} bytes do final descartados; cópia em ${backup}. ` +
        (back.restarted ? "Serviço ligado de novo." : back.keptStopped ? "O serviço ficou parado, como o projeto (parado pela pessoa)." : "O serviço NÃO voltou a subir: veja a aba Logs."),
    );
    return result({ ok, outcome: ok ? "repaired" : "start_failed", backup, discardedBytes: discarded, restarted: back.restarted, keptStopped: back.keptStopped });
  }

  private async record(actor: string, action: string, project: AofProjectRef, detail: string): Promise<void> {
    try {
      await this.deps.audit({ actor, action, target: project.slug, detail });
    } catch {
      // auditar não pode mudar o resultado do reparo (já aconteceu)
    }
  }
}
