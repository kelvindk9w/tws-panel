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
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupRecord } from "@paas/core";

export const PANEL_RESTORE_DIR = ".restaurar-painel";
export const PANEL_RESTORE_MARKER = ".restaurar-painel.json";
export const PANEL_SAFETY_DIR = "antes-da-restauracao";

/** Nomes do diretório de dados que a restauração nunca troca. */
export const PANEL_PRESERVED = ["backups", "setup-token", "projects"];
/** Arquivos do .7z que não são estado do painel. */
const ARCHIVE_EXTRAS = ["LEIA-ME.txt", "manifesto.json"];

export interface PanelRestoreMarker {
  requestedAt: string;
  fileName: string;
  actor: string;
}

/**
 * Aplica uma restauração pendente. Devolve o marcador aplicado (para o log)
 * ou null quando não havia nada a fazer.
 */
export async function applyPendingPanelRestore(dataDir: string, now: () => Date = () => new Date()): Promise<PanelRestoreMarker | null> {
  const backupsDir = path.join(dataDir, "backups");
  const markerFile = path.join(backupsDir, PANEL_RESTORE_MARKER);
  if (!existsSync(markerFile)) return null;
  let marker: PanelRestoreMarker;
  try {
    marker = JSON.parse(await readFile(markerFile, "utf8")) as PanelRestoreMarker;
  } catch {
    await rm(markerFile, { force: true });
    return null;
  }
  const staged = path.join(backupsDir, PANEL_RESTORE_DIR);
  if (!existsSync(staged)) {
    await rm(markerFile, { force: true });
    return null;
  }
  const safety = path.join(backupsDir, "_painel", PANEL_SAFETY_DIR);
  await rm(safety, { recursive: true, force: true });
  await mkdir(safety, { recursive: true });
  for (const name of await readdir(dataDir)) {
    if (PANEL_PRESERVED.includes(name)) continue;
    await rename(path.join(dataDir, name), path.join(safety, name));
  }
  for (const name of await readdir(staged)) {
    if (PANEL_PRESERVED.includes(name) || ARCHIVE_EXTRAS.includes(name)) continue;
    await onlyOwner(path.join(staged, name));
    await rename(path.join(staged, name), path.join(dataDir, name));
  }
  await rm(staged, { recursive: true, force: true });
  await rm(markerFile, { force: true });

  // O histórico que voltou é o do backup: registra nele a própria restauração.
  const historyFile = path.join(dataDir, "backups-history.json");
  let entries: BackupRecord[] = [];
  try {
    const raw = JSON.parse(await readFile(historyFile, "utf8")) as { entries?: BackupRecord[] };
    entries = Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    entries = [];
  }
  const at = now().toISOString();
  entries.push({
    id: randomBytes(6).toString("hex"),
    target: "panel",
    targetName: "Painel",
    operation: "restore",
    trigger: "manual",
    status: "success",
    queuedAt: marker.requestedAt,
    startedAt: marker.requestedAt,
    finishedAt: at,
    fileName: marker.fileName,
    sizeBytes: null,
    local: false,
    remote: "none",
    remoteEncrypted: false,
    remoteDetail: null,
    steps: [{ label: "Trocar o estado do painel (na subida)", status: "done" }],
    warnings: [`O estado anterior ficou em backups/_painel/${PANEL_SAFETY_DIR}/.`],
    error: null,
  });
  await writeFile(historyFile, JSON.stringify({ entries: entries.slice(-200) }, null, 2) + "\n", { mode: 0o600 });
  return marker;
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
