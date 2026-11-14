/**
 * Disco maior que o sistema de arquivos dos dados (disk-layout.ts).
 *
 * Os testes montam um sysfs de mentira numa pasta temporária, com a mesma forma do real: pastas
 * em devices/…/block/<disco>/<partição> com `size`, `start` e `partition`, e os links
 * dev/block/<major>:<minor> e block/<disco>. Os números do "caso real" são os lidos na VPS de testes
 * (disco de 100 GiB, Ubuntu de nuvem com sda14/sda15/sda16 antes da sda1) com o disco dobrado.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISK_UNEXPANDED_LIMITS } from "@paas/core";
import {
  defaultDiskLayoutDeps,
  exceedsUnexpandedLimits,
  parseSysNumber,
  probeDiskLayout,
  splitDev,
  type DiskLayoutDeps,
} from "../src/services/disk-layout.js";
import { readText } from "../src/services/metrics-sources.js";
import { removeDir } from "./helpers/tmp.js";

const GiB = 1024 ** 3;
const SECTORS_PER_GIB = GiB / 512;
const EXT4 = 0xef53;
const XFS = 0x58465342;
const BTRFS = 0x9123683e;

/** st_dev do Linux a partir de major:minor (inverso de gnu_dev_major/minor). */
function makedev(major: number, minor: number): bigint {
  const M = BigInt(major);
  const m = BigInt(minor);
  return (m & 0xffn) | ((M & 0xfffn) << 8n) | ((m & ~0xffn) << 12n) | ((M & ~0xfffn) << 32n);
}

interface PartSpec {
  name: string;
  num?: string;
  start?: string;
  size?: string;
  dev?: string;
}
interface DiskSpec {
  /** Pasta do disco dentro de devices/ (ex.: pci0000:00/virtio1/block/sda). */
  base: string;
  size?: string;
  dev: string;
  parts?: PartSpec[];
  /** false = não cria /sys/block/<nome> (não é disco inteiro). */
  listed?: boolean;
}

let root: string;
let sys: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-disk-layout-"));
  sys = path.join(root, "sys");
  await mkdir(path.join(sys, "dev", "block"), { recursive: true });
  await mkdir(path.join(sys, "block"), { recursive: true });
});
afterEach(async () => removeDir(root));

async function put(file: string, text: string | undefined): Promise<void> {
  if (text === undefined) return;
  await writeFile(file, text);
}

async function addDisk(d: DiskSpec): Promise<string> {
  const dir = path.join(sys, "devices", d.base);
  const name = path.basename(dir);
  await mkdir(dir, { recursive: true });
  await put(path.join(dir, "size"), d.size);
  await writeFile(path.join(dir, "ro"), "0\n");
  await mkdir(path.join(dir, "holders"), { recursive: true });
  await symlink(dir, path.join(sys, "dev", "block", d.dev));
  if (d.listed !== false) await symlink(dir, path.join(sys, "block", name));
  for (const p of d.parts ?? []) {
    const pdir = path.join(dir, p.name);
    await mkdir(pdir, { recursive: true });
    await put(path.join(pdir, "partition"), p.num);
    await put(path.join(pdir, "start"), p.start);
    await put(path.join(pdir, "size"), p.size);
    if (p.dev) await symlink(pdir, path.join(sys, "dev", "block", p.dev));
  }
  return dir;
}

function deps(over: { dev: bigint; type?: number; fsBytes?: number; bsize?: number } & Partial<DiskLayoutDeps>): DiskLayoutDeps {
  const bsize = over.bsize ?? 4096;
  const real = defaultDiskLayoutDeps("/data");
  return {
    dataDir: "/data",
    sysRoot: sys,
    read: readText,
    stat: async () => ({ dev: over.dev }),
    statfs: async () => ({ type: over.type ?? EXT4, bsize, blocks: Math.floor((over.fsBytes ?? 0) / bsize) }),
    realpath: real.realpath,
    readdir: real.readdir,
    ...over,
  };
}

/** Disposição da VPS de testes: sda14 (BIOS), sda15 (EFI), sda16 (/boot) no começo; sda1 (raiz) por último. */
const CLOUD_PARTS = (sda1Size: string): PartSpec[] => [
  { name: "sda1", num: "1\n", start: "2099200\n", size: sda1Size, dev: "8:1" },
  { name: "sda14", num: "14\n", start: "2048\n", size: "8192\n", dev: "8:14" },
  { name: "sda15", num: "15\n", start: "10240\n", size: "217088\n", dev: "8:15" },
  { name: "sda16", num: "16\n", start: "227328\n", size: "1869825\n", dev: "259:0" },
];
const SDA_BASE = "pci0000:00/0000:00:05.0/virtio1/host0/target0:0:0/0:0:0:0/block/sda";
/** Sistema de arquivos lido na VPS de testes: 25119164 blocos de 4 KiB (95,8 GiB, o "96G" do df). */
const FS_BYTES = 25119164 * 4096;

describe("caso real: o provedor dobrou o disco e a partição continuou com o tamanho antigo", () => {
  it("disco de 200 GiB com a raiz de ~99 GiB: avisa com os números do disco, do sistema de arquivos e do que ampliar libera", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    const r = await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }));
    const after = (200 * SECTORS_PER_GIB - (2099200 + 207615967)) * 512;
    const inside = 207615967 * 512 - FS_BYTES;
    expect(r).toEqual({
      diskBytes: 200 * GiB,
      fsBytes: FS_BYTES,
      spareBytes: after + inside,
      disk: "sda",
      partition: "sda1",
      partitionNumber: 1,
      fsType: "ext4",
      growPartition: true,
    });
    // ~104 GiB: os 200 do disco menos os ~96 que o df mostra
    expect(r!.spareBytes / GiB).toBeGreaterThan(103);
    expect(r!.spareBytes / GiB).toBeLessThan(105);
  });

  it("a mesma VPS antes do upgrade (a partição vai até o fim do disco, como na VPS de testes): nada a avisar", async () => {
    await addDisk({ base: SDA_BASE, size: "209715200\n", dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }))).toBeNull();
  });

  it("partição já ampliada, mas o sistema de arquivos não (faltou o resize2fs): avisa só do sistema de arquivos", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: CLOUD_PARTS(`${200 * SECTORS_PER_GIB - 2099200 - 33}\n`) });
    const r = await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }));
    expect(r).toMatchObject({ disk: "sda", partition: "sda1", growPartition: false });
    // os 33 setores do fim (a cópia da tabela GPT) entram como "depois da partição": ficam muito abaixo de 1 GiB, sem growpart
    expect(r!.spareBytes).toBe((200 * SECTORS_PER_GIB - 2099200 - 33) * 512 - FS_BYTES + 33 * 512);
  });

  it("xfs: o tipo vai na resposta (o comando é outro)", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES, type: XFS }))).toMatchObject({ fsType: "xfs" });
  });
});

describe("limiar: mais de 10% do disco E mais de 5 GiB", () => {
  /** Disco de `disk` GiB com uma partição única de `part` GiB (começando em 1 MiB) e o sistema de arquivos do tamanho da partição. */
  async function single(diskGiB: number, partGiB: number) {
    await addDisk({
      base: "pci0000:00/virtio2/block/vda",
      size: `${diskGiB * SECTORS_PER_GIB}\n`,
      dev: "252:0",
      parts: [{ name: "vda1", num: "1", start: "2048", size: `${partGiB * SECTORS_PER_GIB}`, dev: "252:1" }],
    });
    return probeDiskLayout(deps({ dev: makedev(252, 1), fsBytes: partGiB * GiB }));
  }

  it("sobra de 9% num disco de 100 GiB: abaixo dos 10%, nada", async () => {
    expect(await single(100, 91)).toBeNull();
  });

  it("sobra de ~11% num disco de 100 GiB: avisa", async () => {
    expect(await single(100, 89)).toMatchObject({ disk: "vda", partition: "vda1", growPartition: true });
  });

  it("disco pequeno: 4 GiB sobrando num disco de 30 GiB passam dos 10%, mas não dos 5 GiB: nada", async () => {
    expect(await single(30, 26)).toBeNull();
  });

  it("disco pequeno: 6 GiB sobrando num disco de 40 GiB passam dos dois: avisa", async () => {
    expect(await single(40, 34)).toMatchObject({ diskBytes: 40 * GiB, fsBytes: 34 * GiB });
  });

  it("exceedsUnexpandedLimits nas bordas exatas", () => {
    const disk = 100 * GiB;
    expect(exceedsUnexpandedLimits(10 * GiB, disk)).toBe(true);
    expect(exceedsUnexpandedLimits(10 * GiB - 1, disk)).toBe(false);
    expect(exceedsUnexpandedLimits(DISK_UNEXPANDED_LIMITS.minBytes, 50 * GiB)).toBe(true);
    expect(exceedsUnexpandedLimits(DISK_UNEXPANDED_LIMITS.minBytes - 1, 20 * GiB)).toBe(false);
    expect(exceedsUnexpandedLimits(0, 0)).toBe(false);
  });

  it("a diferença normal entre partição e sistema de arquivos (metadados do ext4, ~3%) não avisa", async () => {
    // a VPS de testes real: partição de 99 GiB, sistema de arquivos de 95,8 GiB
    await addDisk({ base: SDA_BASE, size: "209715200\n", dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }))).toBeNull();
  });
});

describe("tipos de disco", () => {
  it("disco inteiro sem partição (volume extra do provedor): avisa sem número de partição e sem growpart", async () => {
    await addDisk({ base: "pci0000:00/0000:00:06.0/virtio3/host1/target1:0:0/1:0:0:0/block/sdb", size: `${100 * SECTORS_PER_GIB}\n`, dev: "8:16" });
    const r = await probeDiskLayout(deps({ dev: makedev(8, 16), fsBytes: 50 * GiB }));
    expect(r).toEqual({ diskBytes: 100 * GiB, fsBytes: 50 * GiB, spareBytes: 50 * GiB, disk: "sdb", partition: null, partitionNumber: null, fsType: "ext4", growPartition: false });
  });

  it("disco inteiro sem partição e já do tamanho do disco (só os metadados de diferença): nada", async () => {
    await addDisk({ base: "pci0000:00/virtio3/block/sdb", size: `${100 * SECTORS_PER_GIB}\n`, dev: "8:16" });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 16), fsBytes: 97 * GiB }))).toBeNull();
  });

  it("disco inteiro maior que o sistema de arquivos, mas com tabela de partições: fora do caso simples, nada", async () => {
    await addDisk({
      base: "pci0000:00/virtio3/block/sdb",
      size: `${100 * SECTORS_PER_GIB}\n`,
      dev: "8:16",
      parts: [{ name: "sdb1", num: "1", start: "2048", size: `${10 * SECTORS_PER_GIB}`, dev: "8:17" }],
    });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 16), fsBytes: 50 * GiB }))).toBeNull();
  });

  it("NVMe: nvme0n1p1 no disco nvme0n1 (sem pasta 'block' no caminho, major 259)", async () => {
    await addDisk({
      base: "pci0000:00/0000:00:04.0/nvme/nvme0/nvme0n1",
      size: `${200 * SECTORS_PER_GIB}\n`,
      dev: "259:0",
      parts: [
        { name: "nvme0n1p1", num: "1\n", start: "227328\n", size: `${100 * SECTORS_PER_GIB}\n`, dev: "259:1" },
        { name: "nvme0n1p15", num: "15\n", start: "2048\n", size: "217088\n", dev: "259:2" },
      ],
    });
    expect(await probeDiskLayout(deps({ dev: makedev(259, 1), fsBytes: 97 * GiB }))).toMatchObject({
      disk: "nvme0n1",
      partition: "nvme0n1p1",
      partitionNumber: 1,
      growPartition: true,
    });
  });

  it("virtio vda1 e Xen xvda1", async () => {
    await addDisk({ base: "pci0000:00/virtio1/block/vda", size: `${200 * SECTORS_PER_GIB}`, dev: "252:0", parts: [{ name: "vda1", num: "1", start: "2048", size: `${100 * SECTORS_PER_GIB}`, dev: "252:1" }] });
    expect(await probeDiskLayout(deps({ dev: makedev(252, 1), fsBytes: 98 * GiB }))).toMatchObject({ disk: "vda", partition: "vda1" });
    await addDisk({ base: "vbd-51712/block/xvda", size: `${200 * SECTORS_PER_GIB}`, dev: "202:0", parts: [{ name: "xvda1", num: "1", start: "2048", size: `${100 * SECTORS_PER_GIB}`, dev: "202:1" }] });
    expect(await probeDiskLayout(deps({ dev: makedev(202, 1), fsBytes: 98 * GiB }))).toMatchObject({ disk: "xvda", partition: "xvda1" });
  });

  it("splitDev: major e minor do st_dev, inclusive os números estendidos", () => {
    expect(splitDev(0x801n)).toEqual({ major: 8, minor: 1 });
    expect(splitDev(makedev(259, 0))).toEqual({ major: 259, minor: 0 });
    expect(splitDev(makedev(259, 300))).toEqual({ major: 259, minor: 300 });
    expect(splitDev(makedev(4100, 70000))).toEqual({ major: 4100, minor: 70000 });
  });
});

describe("indeterminado: nunca avisa", () => {
  it("LVM (dm-0 em devices/virtual/block), RAID (md0) e loop", async () => {
    await addDisk({ base: "virtual/block/dm-0", size: `${200 * SECTORS_PER_GIB}`, dev: "253:0" });
    expect(await probeDiskLayout(deps({ dev: makedev(253, 0), fsBytes: 50 * GiB }))).toBeNull();
    await addDisk({ base: "virtual/block/md0", size: `${200 * SECTORS_PER_GIB}`, dev: "9:0" });
    expect(await probeDiskLayout(deps({ dev: makedev(9, 0), fsBytes: 50 * GiB }))).toBeNull();
    await addDisk({ base: "virtual/block/loop3", size: `${200 * SECTORS_PER_GIB}`, dev: "7:3" });
    expect(await probeDiskLayout(deps({ dev: makedev(7, 3), fsBytes: 50 * GiB }))).toBeNull();
  });

  it("dispositivo anônimo (btrfs, overlay, tmpfs: major 0) e sistema de arquivos que não é ext4/xfs", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    expect(await probeDiskLayout(deps({ dev: makedev(0, 45), fsBytes: FS_BYTES }))).toBeNull();
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES, type: BTRFS }))).toBeNull();
  });

  it("partição que não é a última: o espaço novo fica depois de outra partição (swap no fim)", async () => {
    await addDisk({
      base: SDA_BASE,
      size: `${200 * SECTORS_PER_GIB}`,
      dev: "8:0",
      parts: [
        { name: "sda1", num: "1", start: "2048", size: `${90 * SECTORS_PER_GIB}`, dev: "8:1" },
        { name: "sda2", num: "2", start: `${2048 + 90 * SECTORS_PER_GIB}`, size: `${8 * SECTORS_PER_GIB}`, dev: "8:2" },
      ],
    });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: 88 * GiB }))).toBeNull();
  });

  it("partição lógica dentro de uma estendida do MBR (o kernel mostra a estendida com 2 setores)", async () => {
    await addDisk({
      base: SDA_BASE,
      size: `${200 * SECTORS_PER_GIB}`,
      dev: "8:0",
      parts: [
        { name: "sda2", num: "2", start: "2048", size: "2", dev: "8:2" },
        { name: "sda5", num: "5", start: "4096", size: `${90 * SECTORS_PER_GIB}`, dev: "8:5" },
      ],
    });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 5), fsBytes: 88 * GiB }))).toBeNull();
  });

  it("disco que não está em /sys/block (não é disco inteiro) e link que sai de /sys/devices", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}`, dev: "8:0", listed: false, parts: CLOUD_PARTS("207615967") });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }))).toBeNull();
    const fora = path.join(root, "fora", "sdc");
    await mkdir(fora, { recursive: true });
    await writeFile(path.join(fora, "size"), `${200 * SECTORS_PER_GIB}`);
    await symlink(fora, path.join(sys, "dev", "block", "8:32"));
    expect(await probeDiskLayout(deps({ dev: makedev(8, 32), fsBytes: 50 * GiB }))).toBeNull();
  });

  it("major:minor que não existe no /sys e /sys inteiro ausente", async () => {
    expect(await probeDiskLayout(deps({ dev: makedev(8, 99), fsBytes: FS_BYTES }))).toBeNull();
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES, sysRoot: path.join(root, "nada") }))).toBeNull();
  });
});

describe("validação das leituras", () => {
  it("parseSysNumber: aceita só inteiro decimal que cabe em bytes sem perder precisão", () => {
    expect(parseSysNumber("209715200\n")).toBe(209715200);
    expect(parseSysNumber("  42  ")).toBe(42);
    expect(parseSysNumber("0")).toBe(0);
    for (const bad of [null, "", "\n", "abc", "-5", "1.5", "1e9", "12 34", "0x10", "99999999999999999999", "18014398509481984"]) {
      expect(parseSysNumber(bad)).toBeNull();
    }
  });

  it.each([
    ["tamanho do disco ausente", { disk: undefined }],
    ["tamanho do disco malformado", { disk: "abc\n" }],
    ["tamanho do disco zero", { disk: "0\n" }],
    ["tamanho do disco negativo", { disk: "-1\n" }],
    ["número da partição zero", { num: "0\n" }],
    ["número da partição malformado", { num: "x\n" }],
    ["início da partição ausente", { start: undefined }],
    ["início da partição zero", { start: "0\n" }],
    ["tamanho da partição vazio", { size: "" }],
    ["tamanho da partição gigante", { size: "99999999999999999999\n" }],
  ])("%s: nada", async (_nome, over: { disk?: string | undefined; num?: string | undefined; start?: string | undefined; size?: string | undefined }) => {
    const sda1: PartSpec = { name: "sda1", num: "1\n", start: "2099200\n", size: "207615967\n", dev: "8:1" };
    if ("num" in over) sda1.num = over.num;
    if ("start" in over) sda1.start = over.start;
    if ("size" in over) sda1.size = over.size;
    const parts = [sda1, ...CLOUD_PARTS("1").slice(1)];
    await addDisk({ base: SDA_BASE, size: "disk" in over ? over.disk : `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }))).toBeNull();
  });

  it("disco inteiro sem partição com tamanho zero, e partição com nome fora do padrão do disco: nada", async () => {
    await addDisk({ base: "pci0000:00/virtio3/block/sdb", size: "0\n", dev: "8:16" });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 16), fsBytes: 50 * GiB }))).toBeNull();
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: [...CLOUD_PARTS("207615967\n"), { name: "sda1x", num: "3", start: "999", size: "8", dev: "8:3" }] });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 3), fsBytes: GiB }))).toBeNull();
  });

  it("partição vizinha ilegível: sem certeza, nada", async () => {
    const parts = CLOUD_PARTS("207615967\n");
    parts[3] = { ...parts[3]!, size: "lixo\n" };
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }))).toBeNull();
  });

  it("pasta com nome de partição sem o arquivo 'partition' não conta como partição", async () => {
    const parts = CLOUD_PARTS("207615967\n");
    parts.push({ name: "sda9", start: "1", size: "1" });
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES }))).toMatchObject({ partition: "sda1" });
  });

  it("sistema de arquivos maior que a partição ou o disco, partição além do fim do disco e partições sobrepostas: leitura incoerente, nada", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: 150 * GiB }))).toBeNull();
    await addDisk({ base: "pci0000:00/virtio3/block/sdb", size: `${100 * SECTORS_PER_GIB}\n`, dev: "8:16" });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 16), fsBytes: 150 * GiB }))).toBeNull();
    await addDisk({
      base: "pci0000:00/virtio4/block/sdc",
      size: `${100 * SECTORS_PER_GIB}`,
      dev: "8:32",
      parts: [{ name: "sdc1", num: "1", start: "2048", size: `${200 * SECTORS_PER_GIB}`, dev: "8:33" }],
    });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 33), fsBytes: 50 * GiB }))).toBeNull();
    await addDisk({
      base: "pci0000:00/virtio5/block/sdd",
      size: `${200 * SECTORS_PER_GIB}`,
      dev: "8:48",
      parts: [
        { name: "sdd1", num: "1", start: "2048", size: `${50 * SECTORS_PER_GIB}`, dev: "8:49" },
        { name: "sdd2", num: "2", start: `${10 * SECTORS_PER_GIB}`, size: `${10 * SECTORS_PER_GIB}`, dev: "8:50" },
      ],
    });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 49), fsBytes: 48 * GiB }))).toBeNull();
  });

  it("statfs com zero blocos, statfs que falha e stat que falha: nada, sem exceção", async () => {
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}\n`, dev: "8:0", parts: CLOUD_PARTS("207615967\n") });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: 0 }))).toBeNull();
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES, statfs: async () => Promise.reject(new Error("EACCES")) }))).toBeNull();
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES, stat: async () => Promise.reject(new Error("ENOENT")) }))).toBeNull();
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: FS_BYTES, statfs: async () => ({ type: EXT4, bsize: Number.MAX_SAFE_INTEGER, blocks: 4 }) }))).toBeNull();
  });

  it("disco com partições demais: fora do caso simples", async () => {
    const parts: PartSpec[] = [{ name: "sda1", num: "1", start: "2048", size: `${SECTORS_PER_GIB}`, dev: "8:1" }];
    for (let i = 2; i <= 130; i++) parts.push({ name: `sda${i}`, num: `${i}`, start: `${i * 4096}`, size: "8" });
    await addDisk({ base: SDA_BASE, size: `${200 * SECTORS_PER_GIB}`, dev: "8:0", parts });
    expect(await probeDiskLayout(deps({ dev: makedev(8, 1), fsBytes: Math.floor(0.9 * GiB) }))).toBeNull();
  });
});

describe("dependências reais", () => {
  it("leem a pasta temporária de verdade e o probe nunca lança", async () => {
    const real = defaultDiskLayoutDeps(root);
    expect(typeof (await real.stat(root)).dev).toBe("bigint");
    const fs = await real.statfs(root);
    expect(fs.blocks).toBeGreaterThan(0);
    expect(fs.bsize).toBeGreaterThan(0);
    expect(typeof fs.type).toBe("number");
    expect(await real.realpath(sys)).toBe(path.resolve(await real.realpath(root), "sys"));
    expect((await real.readdir(sys)).sort()).toEqual(["block", "dev"]);
    const r = await probeDiskLayout(real);
    expect(r === null || typeof r.diskBytes === "number").toBe(true);
  });
});
