/**
 * disk-layout.ts — descobre se o disco que guarda os dados do painel é bem maior que o
 * sistema de arquivos em uso (o caso típico: o provedor aumentou o disco no upgrade, mas a
 * partição e o sistema de arquivos continuaram do tamanho antigo).
 *
 * Como funciona de dentro do container: o `stat` da pasta de dados dá o número do dispositivo
 * (major:minor) do sistema de arquivos onde ela está (o volume do Docker fica no disco do host).
 * O /sys do container é o sysfs do kernel (somente leitura) e a parte de blocos não é isolada
 * por container: /sys/dev/block/<major>:<minor> aponta para a pasta do dispositivo, onde
 * `size` e `start` estão SEMPRE em setores de 512 bytes; `partition` existe só em partição.
 * /sys/block/<nome> existe só para disco inteiro.
 *
 * Regra do produto: só avisa, nunca age; e nunca alarme falso. Qualquer coisa fora do caso
 * simples (LVM, RAID, dispositivo virtual, partição estendida, número estranho, sistema de
 * arquivos que não seja ext4/xfs) devolve null: não se avisa nada.
 */
import { readdir as fsReaddir, realpath as fsRealpath, stat as fsStat, statfs as fsStatfs } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { DISK_UNEXPANDED_LIMITS, type DiskUnexpanded } from "@paas/core";
import { readText, type ReadText } from "./metrics-sources.js";

/** Setor do sysfs (`size`, `start`): sempre 512 bytes, qualquer que seja o setor físico do disco. */
const SECTOR = 512;
/** Abaixo disso, o espaço depois da partição é sobra de alinhamento, não motivo para o growpart. */
const GROW_PARTITION_MIN_BYTES = 1024 ** 3;
/** Disco com mais partições que isso foge do caso simples. */
const MAX_PARTITIONS = 128;
/** Assinaturas do statfs (f_type): ext2/3/4 têm a mesma; xfs. */
const EXT_MAGIC = 0xef53;
const XFS_MAGIC = 0x58465342;
/** Discos inteiros que o painel sabe ampliar (SCSI/SATA, virtio, Xen, IDE, NVMe, cartão). */
const WHOLE_DISK_RE = /^(?:sd[a-z]{1,3}|vd[a-z]{1,3}|xvd[a-z]{1,3}|hd[a-z]{1,3}|nvme\d{1,4}n\d{1,4}|mmcblk\d{1,4})$/;
/** Inteiro decimal de um arquivo do sysfs (com quebra de linha opcional). */
const SYS_NUMBER_RE = /^\s*(\d{1,20})\s*$/;

export interface DiskLayoutDeps {
  /** Pasta de dados do painel (a mesma do statfs do coletor). */
  dataDir: string;
  /** Raiz do sysfs (padrão /sys). */
  sysRoot: string;
  read: ReadText;
  /** Número do dispositivo do sistema de arquivos onde a pasta está (st_dev). */
  stat: (path: string) => Promise<{ dev: bigint }>;
  statfs: (path: string) => Promise<{ type: number; bsize: number; blocks: number }>;
  realpath: (path: string) => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
}

export function defaultDiskLayoutDeps(dataDir: string): DiskLayoutDeps {
  return {
    dataDir,
    sysRoot: "/sys",
    read: readText,
    stat: (p) => fsStat(p, { bigint: true }),
    statfs: async (p) => {
      const s = await fsStatfs(p);
      return { type: s.type, bsize: s.bsize, blocks: s.blocks };
    },
    realpath: (p) => fsRealpath(p),
    readdir: (p) => fsReaddir(p),
  };
}

/** major e minor do st_dev do Linux (a mesma conta de gnu_dev_major/gnu_dev_minor da glibc). */
export function splitDev(dev: bigint): { major: number; minor: number } {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return { major: Number(major), minor: Number(minor) };
}

/** Inteiro do sysfs, ou null se ausente, malformado ou grande demais para virar bytes sem perder precisão. */
export function parseSysNumber(text: string | null): number | null {
  if (text === null) return null;
  const m = SYS_NUMBER_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && Number.isSafeInteger(n * SECTOR) ? n : null;
}

/** O espaço que ampliar libera passa dos dois limites (10% do disco e 5 GiB)? */
export function exceedsUnexpandedLimits(spareBytes: number, diskBytes: number): boolean {
  return spareBytes >= DISK_UNEXPANDED_LIMITS.minBytes && spareBytes >= diskBytes * (DISK_UNEXPANDED_LIMITS.minPct / 100);
}

function fsKind(type: number): DiskUnexpanded["fsType"] | null {
  if (type === EXT_MAGIC) return "ext4";
  if (type === XFS_MAGIC) return "xfs";
  return null;
}

interface Part {
  name: string;
  start: number;
  size: number;
}

/**
 * Mede o disco e o sistema de arquivos da pasta de dados. Devolve o aviso só quando o espaço que
 * ampliar libera passa dos limites e o arranjo é o simples; qualquer dúvida devolve null. Nunca lança.
 */
export async function probeDiskLayout(d: DiskLayoutDeps): Promise<DiskUnexpanded | null> {
  try {
    return await probe(d);
  } catch {
    return null;
  }
}

async function probe(d: DiskLayoutDeps): Promise<DiskUnexpanded | null> {
  const fs = await d.statfs(d.dataDir);
  const fsType = fsKind(fs.type);
  if (fsType === null) return null;
  const fsBytes = fs.blocks * fs.bsize;
  if (!Number.isSafeInteger(fsBytes) || fsBytes <= 0) return null;

  // st_dev com major 0 = dispositivo anônimo (btrfs, overlay, tmpfs, rede): não há disco a medir
  const { major, minor } = splitDev((await d.stat(d.dataDir)).dev);
  if (major === 0) return null;

  const sys = await d.realpath(d.sysRoot);
  const devDir = await d.realpath(`${sys}/dev/block/${major}:${minor}`);
  if (!devDir.startsWith(`${sys}/devices/`)) return null;
  const name = basename(devDir);
  const partNumberText = await d.read(`${devDir}/partition`);

  if (partNumberText === null) {
    // sistema de arquivos no disco inteiro, sem partição (comum em volume extra do provedor)
    if (!(await isWholeDisk(d, sys, name, devDir))) return null;
    const diskSectors = parseSysNumber(await d.read(`${devDir}/size`));
    if (diskSectors === null || diskSectors <= 0) return null;
    if ((await partitionsOf(d, devDir, name)) !== "none") return null; // disco com tabela de partições: não é o caso simples
    const diskBytes = diskSectors * SECTOR;
    if (fsBytes > diskBytes) return null;
    const spare = diskBytes - fsBytes;
    if (!exceedsUnexpandedLimits(spare, diskBytes)) return null;
    return { diskBytes, fsBytes, spareBytes: spare, disk: name, partition: null, partitionNumber: null, fsType, growPartition: false };
  }

  // partição: a pasta de cima é o disco
  const partitionNumber = parseSysNumber(partNumberText);
  if (partitionNumber === null || partitionNumber <= 0) return null;
  const diskDir = dirname(devDir);
  const disk = basename(diskDir);
  if (!name.startsWith(disk) || !(await isWholeDisk(d, sys, disk, diskDir))) return null;
  const diskSectors = parseSysNumber(await d.read(`${diskDir}/size`));
  if (diskSectors === null || diskSectors <= 0) return null;
  const parts = await partitionsOf(d, diskDir, disk);
  if (parts === "unsure" || parts === "none") return null;
  const mine = parts.find((p) => p.name === name);
  if (!mine) return null;
  // partição estendida do MBR (o kernel mostra 1 ou 2 setores): partição lógica, fora do caso simples
  if (parts.some((p) => p.size <= 2)) return null;
  const end = mine.start + mine.size;
  if (end > diskSectors) return null;
  // partições que se sobrepõem à nossa = leitura incoerente
  if (parts.some((p) => p !== mine && p.start < end && p.start + p.size > mine.start)) return null;
  // espaço livre LOGO DEPOIS da partição: até a próxima partição ou o fim do disco (é o que o growpart usa)
  const next = parts.filter((p) => p.start >= end).reduce((min, p) => Math.min(min, p.start), diskSectors);
  const afterBytes = (next - end) * SECTOR;
  const partBytes = mine.size * SECTOR;
  if (fsBytes > partBytes) return null;
  const spare = afterBytes + (partBytes - fsBytes);
  const diskBytes = diskSectors * SECTOR;
  if (!exceedsUnexpandedLimits(spare, diskBytes)) return null;
  return {
    diskBytes,
    fsBytes,
    spareBytes: spare,
    disk,
    partition: name,
    partitionNumber,
    fsType,
    growPartition: afterBytes >= GROW_PARTITION_MIN_BYTES,
  };
}

/** É um disco inteiro de um tipo conhecido? (/sys/block/<nome> existe só para disco inteiro; dm-*, md*, loop* ficam fora pelo nome.) */
async function isWholeDisk(d: DiskLayoutDeps, sys: string, name: string, dir: string): Promise<boolean> {
  if (!WHOLE_DISK_RE.test(name)) return false;
  try {
    return (await d.realpath(`${sys}/block/${name}`)) === dir;
  } catch {
    return false;
  }
}

/** Partições do disco (pelas subpastas com `partition`). "unsure" = alguma não pôde ser lida. */
async function partitionsOf(d: DiskLayoutDeps, diskDir: string, disk: string): Promise<Part[] | "none" | "unsure"> {
  // sda → sda1; nvme0n1 → nvme0n1p1; mmcblk0 → mmcblk0p1
  const re = new RegExp(`^${disk}p?\\d{1,4}$`);
  const names = (await d.readdir(diskDir)).filter((n) => re.test(n));
  if (names.length === 0) return "none";
  if (names.length > MAX_PARTITIONS) return "unsure";
  const parts: Part[] = [];
  for (const n of names) {
    const dir = `${diskDir}/${n}`;
    const [num, start, size] = await Promise.all([d.read(`${dir}/partition`), d.read(`${dir}/start`), d.read(`${dir}/size`)]);
    if (num === null) continue; // pasta com nome de partição que não é partição
    const s = parseSysNumber(start);
    const z = parseSysNumber(size);
    if (s === null || z === null || s <= 0 || z <= 0) return "unsure";
    parts.push({ name: n, start: s, size: z });
  }
  return parts.length === 0 ? "none" : parts;
}
