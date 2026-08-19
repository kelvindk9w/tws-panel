/**
 * baseline.ts — snapshot pós-hardening e diff de scans recorrentes
 * (Fase 4 — spec: docs/security-research.md §6.6).
 *
 * Snapshot: pacotes instalados (dpkg), portas em listen (ss -tulpn, com
 * fallback para /proc/net) e sha256 de arquivos críticos (sshd_config, UFW,
 * fail2ban). Todos os comandos são strings FIXAS — nada vem da API.
 */
import { randomUUID } from "node:crypto";
import type { BaselineDiff, BaselinePort, SecurityBaseline } from "@paas/core";
import type { TargetRunner } from "./runner.js";

// Comandos FIXOS executados no alvo.
const CMD_PACKAGES =
  "dpkg-query -W -f='${binary:Package}=${Version}\\n' 2>/dev/null | sort -u";
const CMD_PORTS =
  'if command -v ss >/dev/null 2>&1; then ss -tulpnH 2>/dev/null; ' +
  'else for f in tcp tcp6 udp udp6; do echo "== $f"; cat /proc/net/$f 2>/dev/null; done; fi';
const CMD_FILES =
  "find /etc/ssh/sshd_config /etc/ssh/sshd_config.d /etc/ufw /etc/fail2ban -maxdepth 2 -type f 2>/dev/null | sort | xargs -r sha256sum 2>/dev/null";

/** Arquivos críticos rastreados mesmo quando ausentes (para detectar remoção/criação). */
const TRACKED_FILES = ["/etc/ssh/sshd_config"];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parsePackages(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("="));
}

/** Parse da saída de `ss -tulpnH` (ou do fallback /proc/net). */
function parsePorts(stdout: string): BaselinePort[] {
  const ports = new Map<string, BaselinePort>();
  if (!stdout.includes("== tcp")) {
    // formato ss: tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
    for (const line of stdout.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5) continue;
      const proto = fields[0] === "tcp" ? "tcp" : fields[0] === "udp" ? "udp" : null;
      if (!proto) continue;
      const local = fields[4] ?? "";
      const port = Number(local.slice(local.lastIndexOf(":") + 1));
      if (!Number.isInteger(port) || port <= 0) continue;
      const procMatch = /users:\(\("([^"]+)"/.exec(line);
      const key = `${proto}/${port}`;
      if (!ports.has(key)) {
        ports.set(key, { proto, port, process: procMatch?.[1] ?? null });
      }
    }
    return [...ports.values()].sort((a, b) => a.port - b.port);
  }

  // fallback /proc/net: seções "== tcp" …; local_address em hex "0100007F:0035"
  let section: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("== ")) {
      section = trimmed.slice(3);
      continue;
    }
    if (!section || trimmed.startsWith("sl ")) continue;
    const fields = trimmed.split(/\s+/);
    const localHex = fields[1] ?? "";
    const state = fields[3] ?? "";
    const proto = section.startsWith("tcp") ? "tcp" : "udp";
    // tcp: 0A = LISTEN; udp: 07 = sem conexão (socket "aberto")
    if (proto === "tcp" && state !== "0A") continue;
    if (proto === "udp" && state !== "07") continue;
    const portHex = localHex.split(":")[1];
    const port = portHex ? Number.parseInt(portHex, 16) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port === 0) continue;
    const key = `${proto}/${port}`;
    if (!ports.has(key)) ports.set(key, { proto, port, process: null });
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
}

/** Parse de `sha256sum`: "<hash>  <caminho>". */
function parseFileHashes(stdout: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) files[match[2]] = match[1];
  }
  return files;
}

// ---------------------------------------------------------------------------
// Coleta + diff
// ---------------------------------------------------------------------------

/** Coleta o snapshot do alvo (pacotes, portas, hashes de arquivos críticos). */
export async function collectBaseline(runner: TargetRunner): Promise<SecurityBaseline> {
  await runner.ensureReady();

  const [packages, ports, files] = await Promise.all([
    runner.exec(CMD_PACKAGES, { timeoutMs: 60_000 }),
    runner.exec(CMD_PORTS, { timeoutMs: 60_000 }),
    runner.exec(CMD_FILES, { timeoutMs: 60_000 }),
  ]);

  const fileHashes = parseFileHashes(files.stdout);
  const fileMap: Record<string, string | null> = {};
  for (const tracked of TRACKED_FILES) fileMap[tracked] = fileHashes[tracked] ?? null;
  for (const [file, hash] of Object.entries(fileHashes)) fileMap[file] = hash;

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    target: runner.label,
    packages: packages.code === 0 ? parsePackages(packages.stdout) : [],
    ports: ports.code === 0 ? parsePorts(ports.stdout) : [],
    files: fileMap,
  };
}

function portKey(p: BaselinePort): string {
  return `${p.proto}/${p.port}`;
}

/** Compara o estado atual com o baseline salvo. */
export function diffBaseline(baseline: SecurityBaseline, current: SecurityBaseline): BaselineDiff {
  const basePkgs = new Set(baseline.packages);
  const curPkgs = new Set(current.packages);
  const newPackages = current.packages.filter((p) => !basePkgs.has(p));
  const removedPackages = baseline.packages.filter((p) => !curPkgs.has(p));

  const basePorts = new Map(baseline.ports.map((p) => [portKey(p), p]));
  const curPorts = new Map(current.ports.map((p) => [portKey(p), p]));
  const newPorts = current.ports.filter((p) => !basePorts.has(portKey(p)));
  const closedPorts = baseline.ports.filter((p) => !curPorts.has(portKey(p)));

  const changedFiles: string[] = [];
  const removedFiles: string[] = [];
  const addedFiles: string[] = [];
  const allFiles = new Set([...Object.keys(baseline.files), ...Object.keys(current.files)]);
  for (const file of allFiles) {
    const before = baseline.files[file];
    const after = current.files[file];
    if (before === undefined && after !== undefined) addedFiles.push(file);
    else if (before !== undefined && after === undefined) removedFiles.push(file);
    else if (before !== after) {
      if (before === null) addedFiles.push(file); // ausente no baseline, passou a existir
      else if (after === null) removedFiles.push(file);
      else changedFiles.push(file);
    }
  }

  return {
    newPackages: newPackages.sort(),
    removedPackages: removedPackages.sort(),
    newPorts,
    closedPorts,
    changedFiles: changedFiles.sort(),
    removedFiles: removedFiles.sort(),
    addedFiles: addedFiles.sort(),
  };
}

/** true quando o diff não tem nenhuma mudança. */
export function isDiffEmpty(diff: BaselineDiff): boolean {
  return (
    diff.newPackages.length === 0 &&
    diff.removedPackages.length === 0 &&
    diff.newPorts.length === 0 &&
    diff.closedPorts.length === 0 &&
    diff.changedFiles.length === 0 &&
    diff.removedFiles.length === 0 &&
    diff.addedFiles.length === 0
  );
}
