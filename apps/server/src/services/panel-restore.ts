/**
 * panel-restore.ts — termina a restauração do PAINEL na próxima subida.
 *
 * O painel não pode trocar o próprio estado com tudo rodando: cada serviço
 * tem o seu arquivo aberto em memória e gravaria por cima do que acabou de
 * voltar. Por isso a restauração é feita em duas partes:
 *  1. com o painel no ar (backup-service.ts): baixa, confere e extrai o
 *     backup para data/backups/.restaurar-painel/, grava o marcador
 *     data/backups/.restaurar-painel.json e pede para o painel reiniciar;
 *  2. na subida seguinte, ANTES de qualquer serviço ler o disco (index.ts):
 *     esta função move o estado atual para data/backups/_painel/antes-da-
 *     restauracao/ (cópia de segurança) e põe o conteúdo do backup no lugar.
 *
 * A troca é retomável e reversível. O progresso fica gravado em
 * data/backups/.restaurar-painel.progresso.json, com a fase atual:
 *   salvando   → move cada item do estado atual para a cópia de segurança;
 *   aplicando  → move cada item extraído do backup para o diretório de dados;
 *   concluindo → registra no histórico e apaga o pedido.
 * Cada fase só move numa direção, de uma pasta conhecida para outra; repetir
 * uma fase depois de uma queda (kill -9, falta de energia) só move o que
 * faltou. A subida seguinte continua da fase gravada.
 *
 * Se uma etapa FALHA (erro de disco, não queda), a troca é desfeita:
 *   desfazendo-retirando  → os itens do backup voltam para a pasta extraída;
 *   desfazendo-devolvendo → os itens da cópia de segurança voltam ao lugar.
 * O desfazer também é retomável. Se nem desfazer der certo, a função lança e
 * o painel NÃO sobe com metade dos dados trocada (index.ts sai com erro e o
 * Docker reinicia o container, que continua de onde parou).
 *
 * A cópia de segurança nunca é apagada enquanto há troca pela metade. Ao
 * COMEÇAR uma restauração nova (sem progresso gravado), a cópia da
 * restauração anterior vira antes-da-restauracao.anterior em vez de sumir.
 *
 * Ficam como estão: a pasta backups/ (as cópias locais), o setup-token desta
 * instalação e a pasta projects/ (código dos projetos, nas instalações
 * antigas em que ela fica dentro do diretório de dados).
 *
 * Permissões: o 7-Zip guarda e devolve o modo de cada arquivo, mas um .7z
 * refeito no Windows (ou extraído com umask aberto) chega com 0644. Tudo o
 * que volta é estado privado do painel (segredos, chaves, contas), então a
 * troca deixa cada arquivo só para o dono: 0600 (0700 se era executável) e
 * pastas 0700. O dono é o próprio processo do painel, que é quem extrai.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { MAIL_SEND_CONTENT_DIRNAME, type BackupRecord } from "@paas/core";
import { AuditService } from "./audit-service.js";
import { JsonFile, writeFileAtomic } from "./json-file.js";

export const PANEL_RESTORE_DIR = ".restaurar-painel";
export const PANEL_RESTORE_MARKER = ".restaurar-painel.json";
export const PANEL_RESTORE_PROGRESS = ".restaurar-painel.progresso.json";
export const PANEL_SAFETY_DIR = "antes-da-restauracao";
export const PANEL_SAFETY_PREVIOUS = "antes-da-restauracao.anterior";

/**
 * Nomes do diretório de dados que a restauração nunca troca. O conteúdo dos
 * envios (assunto e corpo) fica de fora do backup E da cópia "antes da
 * restauração": lá ele escaparia da retenção e do "desligar apaga na hora".
 */
export const PANEL_PRESERVED = ["backups", "setup-token", "projects", MAIL_SEND_CONTENT_DIRNAME];
/** Arquivos do .7z que não são estado do painel. */
const ARCHIVE_EXTRAS = ["LEIA-ME.txt", "manifesto.json"];

export interface PanelRestoreMarker {
  requestedAt: string;
  fileName: string;
  actor: string;
}

type Phase = "salvando" | "aplicando" | "concluindo" | "desfazendo-retirando" | "desfazendo-devolvendo";
const PHASES: Phase[] = ["salvando", "aplicando", "concluindo", "desfazendo-retirando", "desfazendo-devolvendo"];

interface PanelRestoreProgress {
  phase: Phase;
  marker: PanelRestoreMarker;
  startedAt: string;
  /** Motivo da falha que levou a desfazer. */
  error: string | null;
}

export interface PanelRestoreResult {
  /** applied = backup no lugar; undone = falhou no meio e voltou ao estado de antes. */
  outcome: "applied" | "undone";
  marker: PanelRestoreMarker;
  error: string | null;
}

export interface PanelRestoreOptions {
  now?: () => Date;
  /**
   * Chamado antes de cada etapa ("salvando:users.json", "fase:aplicando"…).
   * Existe para os testes simularem queda ou falha em cada ponto.
   */
  onStep?: (step: string) => void | Promise<void>;
  /**
   * Só em `restorePanelAtBoot`, depois de uma troca APLICADA pedida por SSH
   * (scripts/restaurar-painel.sh). A restauração pela tela já conferiu o que
   * o painel antigo tinha ativo antes do reinício; o script não passa por lá.
   * Nunca impede a subida.
   */
  afterApplied?: (dataDir: string) => Promise<void>;
}

function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Aplica (ou retoma, ou termina de desfazer) uma restauração pendente.
 * Devolve o que aconteceu, ou null quando não havia nada a fazer. Lança só
 * quando a troca ficou pela metade e nem desfazer foi possível.
 */
export async function applyPendingPanelRestore(dataDir: string, opts: PanelRestoreOptions = {}): Promise<PanelRestoreResult | null> {
  const now = opts.now ?? (() => new Date());
  const step = async (name: string): Promise<void> => {
    await opts.onStep?.(name);
  };
  const backupsDir = path.join(dataDir, "backups");
  const markerFile = path.join(backupsDir, PANEL_RESTORE_MARKER);
  const progressFile = path.join(backupsDir, PANEL_RESTORE_PROGRESS);
  const staged = path.join(backupsDir, PANEL_RESTORE_DIR);
  const painelDir = path.join(backupsDir, "_painel");
  const safety = path.join(painelDir, PANEL_SAFETY_DIR);

  const found = await readProgress(progressFile);
  let progress: PanelRestoreProgress;
  const save = async (phase: Phase, error: string | null = progress.error): Promise<void> => {
    progress = { ...progress, phase, error };
    await writeFileAtomic(progressFile, JSON.stringify(progress, null, 2) + "\n");
  };
  const cleanup = async (): Promise<void> => {
    await rm(staged, { recursive: true, force: true });
    await rm(markerFile, { force: true });
    await rm(progressFile, { force: true });
  };

  if (found) {
    progress = found;
  } else {
    if (!existsSync(markerFile)) return null;
    let marker: PanelRestoreMarker;
    try {
      marker = JSON.parse(await readFile(markerFile, "utf8")) as PanelRestoreMarker;
    } catch {
      await rm(markerFile, { force: true });
      return null;
    }
    if (!existsSync(staged)) {
      await rm(markerFile, { force: true });
      return null;
    }
    progress = { phase: "salvando", marker, startedAt: now().toISOString(), error: null };
    try {
      await step("preparar");
      // Ainda não há troca: a cópia de uma restauração anterior sai do
      // caminho, mas não é apagada — vira ".anterior" (a de antes dela, sim).
      if (existsSync(safety) && (await readdir(safety)).length > 0) {
        await rm(path.join(painelDir, PANEL_SAFETY_PREVIOUS), { recursive: true, force: true });
        await rename(safety, path.join(painelDir, PANEL_SAFETY_PREVIOUS));
      } else {
        await rm(safety, { recursive: true, force: true });
      }
      await mkdir(safety, { recursive: true });
      await save("salvando");
    } catch (err) {
      // Nada do estado atual foi movido: só cancela o pedido.
      const error = reasonOf(err);
      await cleanup();
      await appendHistory(dataDir, progress, "failed", undoneMessage(error), now);
      return { outcome: "undone", marker, error };
    }
  }

  /** Move o que ainda está em `from` para `to` (o que já foi numa tentativa anterior, já foi). */
  const moveAll = async (label: string, from: string, to: string, skip: string[], fix = false): Promise<void> => {
    if (!existsSync(from)) return;
    for (const name of await readdir(from)) {
      if (skip.includes(name)) continue;
      await step(`${label}:${name}`);
      if (fix) await onlyOwner(path.join(from, name));
      await rename(path.join(from, name), path.join(to, name));
    }
  };

  if (progress.phase === "salvando" || progress.phase === "aplicando") {
    try {
      if (progress.phase === "salvando") {
        await moveAll("salvando", dataDir, safety, PANEL_PRESERVED);
        await step("fase:aplicando");
        await save("aplicando");
      }
      await moveAll("aplicando", staged, dataDir, [...PANEL_PRESERVED, ...ARCHIVE_EXTRAS], true);
      await step("fase:concluindo");
      await save("concluindo");
    } catch (err) {
      // Na fase "salvando" nada do backup entrou ainda: basta devolver.
      await save(progress.phase === "aplicando" ? "desfazendo-retirando" : "desfazendo-devolvendo", reasonOf(err));
    }
  }

  if (progress.phase === "desfazendo-retirando") {
    await mkdir(staged, { recursive: true });
    await moveAll("desfazendo-retirando", dataDir, staged, PANEL_PRESERVED);
    await step("fase:desfazendo-devolvendo");
    await save("desfazendo-devolvendo");
  }
  if (progress.phase === "desfazendo-devolvendo") {
    await moveAll("desfazendo-devolvendo", safety, dataDir, []);
    const error = progress.error ?? "motivo não registrado";
    await step("desfazendo:historico");
    await appendHistory(dataDir, progress, "failed", undoneMessage(error), now);
    await step("desfazendo:limpar");
    await cleanup();
    return { outcome: "undone", marker: progress.marker, error };
  }

  // concluindo: o backup está no lugar; falta o registro e a limpeza.
  await step("concluindo:historico");
  // O histórico que voltou é o do backup: registra nele a própria restauração.
  await appendHistory(dataDir, progress, "success", null, now);
  await step("concluindo:limpar");
  await cleanup();
  return { outcome: "applied", marker: progress.marker, error: null };
}

function undoneMessage(error: string): string {
  return `A troca falhou no meio (${error}) e foi desfeita: o painel voltou ao estado de antes da restauração. Tente restaurar de novo.`;
}

async function readProgress(file: string): Promise<PanelRestoreProgress | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Ilegível com troca pela metade: não há como saber onde parou. Melhor não
  // subir do que adivinhar e misturar os dois estados (a gravação é atômica,
  // então isso só acontece se alguém editar o arquivo à mão).
  let p: Partial<PanelRestoreProgress> | null = null;
  try {
    p = JSON.parse(raw) as Partial<PanelRestoreProgress>;
  } catch {
    p = null;
  }
  if (!p || !PHASES.includes(p.phase as Phase) || typeof p.marker?.fileName !== "string" || typeof p.startedAt !== "string") {
    throw new Error(`o arquivo de progresso ${path.basename(file)} está ilegível`);
  }
  return { phase: p.phase!, marker: p.marker, startedAt: p.startedAt, error: p.error ?? null };
}

/** Registro no histórico de backups, uma vez só por pedido (a retomada não duplica). */
async function appendHistory(
  dataDir: string,
  progress: PanelRestoreProgress,
  status: "success" | "failed",
  error: string | null,
  now: () => Date,
): Promise<void> {
  const { marker } = progress;
  const id = createHash("sha256").update(`${marker.requestedAt}|${marker.fileName}|${progress.startedAt}`).digest("hex").slice(0, 12);
  const history = new JsonFile<BackupRecord[]>(path.join(dataDir, "backups-history.json"), {
    empty: () => [],
    parse: (raw) => {
      const entries = (raw as { entries?: unknown } | null)?.entries;
      return Array.isArray(entries) ? (entries as BackupRecord[]) : null;
    },
    serialize: (entries) => JSON.stringify({ entries }, null, 2) + "\n",
  });
  await history.update((entries) => {
    if (entries.some((e) => e.id === id)) return entries;
    const record: BackupRecord = {
      id,
      target: "panel",
      targetName: "Painel",
      operation: "restore",
      trigger: "manual",
      status,
      queuedAt: marker.requestedAt,
      startedAt: marker.requestedAt,
      finishedAt: now().toISOString(),
      fileName: marker.fileName,
      sizeBytes: null,
      local: false,
      remote: "none",
      remoteEncrypted: false,
      remoteDetail: null,
      steps: [{ label: "Trocar o estado do painel (na subida)", status: status === "success" ? "done" : "failed" }],
      warnings: status === "success" ? [`O estado anterior ficou em backups/_painel/${PANEL_SAFETY_DIR}/.`] : [],
      error,
    };
    return [...entries, record].slice(-200);
  });
}

/**
 * O passo da subida (index.ts): aplica a restauração pendente, deixa claro
 * no log e na auditoria o que aconteceu e diz se o painel pode subir.
 * false = a troca ficou pela metade e não pôde ser desfeita: NÃO suba.
 */
export async function restorePanelAtBoot(
  dataDir: string,
  log: { warn: (msg: string) => void; error: (msg: string) => void },
  opts: PanelRestoreOptions = {},
): Promise<boolean> {
  let result: PanelRestoreResult | null;
  try {
    result = await applyPendingPanelRestore(dataDir, opts);
  } catch (err) {
    log.error(
      `A restauração do painel ficou pela metade e não pôde ser desfeita (${reasonOf(err)}). ` +
        "O painel não vai subir com metade dos dados trocada. Corrija o problema do disco e reinicie o container: " +
        `ele continua de onde parou. O estado anterior está em data/backups/_painel/${PANEL_SAFETY_DIR}/.`,
    );
    return false;
  }
  if (!result) return true;
  const audit = new AuditService(dataDir);
  const { marker } = result;
  if (result.outcome === "applied") {
    log.warn(`Painel restaurado do backup ${marker.fileName} (pedido por ${marker.actor}).`);
    await audit.record({
      actor: marker.actor,
      action: "backups.panel_restored",
      target: "Painel",
      detail: `Painel restaurado do backup ${marker.fileName} na subida. O estado anterior ficou em backups/_painel/${PANEL_SAFETY_DIR}/.`,
    });
  } else {
    log.error(
      `Restauração do painel desfeita: a troca do backup ${marker.fileName} falhou (${result.error}). O painel subiu com o estado de antes.`,
    );
    await audit.record({
      actor: marker.actor,
      action: "backups.panel_restore_undone",
      target: "Painel",
      detail: `A restauração do backup ${marker.fileName} falhou no meio da troca (${result.error}) e foi desfeita: o painel voltou ao estado de antes.`,
    });
  }
  await audit.flush();
  if (result.outcome === "applied" && marker.actor === "ssh" && opts.afterApplied) {
    try {
      await opts.afterApplied(dataDir);
    } catch (err) {
      log.warn(`Não foi possível conferir o que o painel antigo tinha ativo (${reasonOf(err)}). Confira o webmail e o servidor de e-mail em E-mail.`);
    }
  }
  return true;
}

/**
 * Tira o acesso do grupo e dos outros, recursivamente. Links simbólicos não
 * são seguidos (um link no backup não leva o chmod para fora de /data).
 */
async function onlyOwner(target: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, 0o700);
    for (const name of await readdir(target)) await onlyOwner(path.join(target, name));
    return;
  }
  await chmod(target, info.mode & 0o100 ? 0o700 : 0o600);
}
