/**
 * docker-cleanup.test.ts — verificador e limpeza do Docker: cálculo, proteção das imagens do painel,
 * bloqueio com deploy/backup, desligada por padrão, registro, aviso e rotas.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CADDY_IMAGE,
  DOCKER_CLEANUP_DEFAULTS,
  HOST_HELPER_IMAGE,
  NODE_SERVER_IMAGES,
  dockerCleanupWarns,
  validateDockerCleanupSettings,
  type DockerCleanupScan,
} from "@paas/core";
import { buildScan, isPanelImage, isPanelRepository, pinnedDigests, repositoryOf, uniqueBytes, type RawCacheRecord, type RawImage } from "../src/services/docker-cleanup-plan.js";
import { DockerCleanupBlockedError, DockerCleanupService, HISTORY_LIMIT } from "../src/services/docker-cleanup-service.js";
import type { DockerCleanupApi } from "../src/services/docker-cleanup-docker.js";
import type { NotificationEvent } from "../src/services/notification-service.js";
import dockerCleanupRoutes from "../src/routes/docker-cleanup.js";
import { removeDir } from "./helpers/tmp.js";

const GB = 1024 ** 3;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const sec = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / 1000);

const img = (id: string, daysAgo: number, size: number, over: Partial<RawImage> = {}): RawImage => ({
  Id: `sha256:${id}`,
  RepoTags: [`app-${id}:latest`],
  RepoDigests: [],
  Created: sec(daysAgo),
  Size: size,
  SharedSize: 0,
  Containers: 0,
  ...over,
});
const cache = (id: string, daysAgo: number, size: number, inUse = false): RawCacheRecord => ({
  ID: id,
  InUse: inUse,
  Size: size,
  CreatedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  LastUsedAt: new Date(NOW - daysAgo * DAY).toISOString(),
});
const disk100 = { totalBytes: 100 * GB, usedBytes: 85 * GB, usedPercent: 85 };

describe("cálculo do verificador", () => {
  it("separa cache de build e imagens, soma o ganho e dá o % do disco", () => {
    const scan = buildScan({
      now: NOW,
      minAgeDays: 7,
      images: [img("a", 30, 5 * GB), img("b", 20, 3 * GB)],
      cache: [cache("c1", 10, 4 * GB), cache("c2", 1, 2 * GB), cache("c3", 30, 1 * GB, true)],
      usedImageIds: new Set(),
      disk: disk100,
    });
    expect(scan.buildCache).toEqual({ bytes: 4 * GB, entries: 1, totalBytes: 7 * GB });
    expect(scan.images.bytes).toBe(8 * GB);
    expect(scan.images.candidates.map((c) => c.tags[0])).toEqual(["app-a:latest", "app-b:latest"]);
    expect(scan.totalBytes).toBe(12 * GB);
    expect(scan.totalPercentOfDisk).toBe(12);
    expect(scan.images.candidates[0]).toMatchObject({ ageDays: 30, bytes: 5 * GB });
  });

  it("protege imagem recente, em uso (parado ou rodando) e do painel, cada uma com o seu motivo", () => {
    const pinned = [...pinnedDigests()][0]!;
    const scan = buildScan({
      now: NOW,
      minAgeDays: 7,
      images: [
        img("novo", 2, GB),
        img("uso", 50, GB, { Containers: 1 }),
        img("uso2", 50, GB),
        img("painel", 50, GB, { RepoTags: ["tws-panel:1.0"] }),
        img("fixa", 50, GB, { RepoTags: [], RepoDigests: [`outro/nome@${pinned}`] }),
        img("velha", 50, GB),
      ],
      cache: [],
      usedImageIds: new Set(["sha256:uso2"]),
      disk: null,
    });
    const reasons = Object.fromEntries(scan.images.protected.map((p) => [p.id.slice(7), p.reason]));
    expect(reasons).toEqual({ novo: "recent", uso: "in_use", uso2: "in_use", painel: "panel", fixa: "panel" });
    expect(scan.images.candidates.map((c) => c.id)).toEqual(["sha256:velha"]);
    expect(scan.totalPercentOfDisk).toBeNull();
  });

  it("desconta a camada dividida com outras imagens e ignora <none>:<none>", () => {
    expect(uniqueBytes(img("x", 9, 10 * GB, { SharedSize: 4 * GB }))).toBe(6 * GB);
    expect(uniqueBytes(img("x", 9, 10 * GB, { SharedSize: -1 }))).toBe(10 * GB);
    expect(uniqueBytes(img("x", 9, 1, { SharedSize: 5 }))).toBe(0);
    const scan = buildScan({ now: NOW, minAgeDays: 7, images: [img("d", 9, GB, { RepoTags: ["<none>:<none>"] }), img("e", 9, GB, { RepoTags: null })], cache: [], usedImageIds: new Set(), disk: null });
    expect(scan.images.candidates.every((c) => c.tags.length === 0)).toBe(true);
  });

  it("cache sem data legível ou com data zerada cai na criação; sem nenhuma data não entra", () => {
    const scan = buildScan({
      now: NOW,
      minAgeDays: 7,
      images: [],
      cache: [
        { ID: "z", Size: GB, CreatedAt: new Date(NOW - 20 * DAY).toISOString(), LastUsedAt: "0001-01-01T00:00:00Z" },
        { ID: "n", Size: GB },
        { ID: "novo", Size: GB, CreatedAt: new Date(NOW - DAY).toISOString(), LastUsedAt: null },
      ],
      usedImageIds: new Set(),
      disk: null,
    });
    expect(scan.buildCache).toMatchObject({ bytes: GB, entries: 1, totalBytes: 3 * GB });
  });
});

describe("proteção das imagens fixadas do painel", () => {
  it("todas as imagens de images.ts e de PANEL_IMAGE_REPOSITORIES contam como do painel", () => {
    const refs = [HOST_HELPER_IMAGE, CADDY_IMAGE, ...Object.values(NODE_SERVER_IMAGES)];
    for (const ref of refs) {
      const at = ref.indexOf("@");
      // por digest, mesmo sem nome nenhum (imagem que perdeu a tag)
      expect(isPanelImage(img("p", 99, 1, { RepoTags: [], RepoDigests: [], Id: ref.slice(at + 1) }))).toBe(true);
      expect(isPanelImage(img("p", 99, 1, { RepoTags: [], RepoDigests: [`algo@${ref.slice(at + 1)}`] }))).toBe(true);
    }
    for (const repo of ["alpine", "caddy", "nginx", "node", "stalwartlabs/mail-server", "roundcube/roundcubemail", "axllent/mailpit", "tws-panel"]) {
      expect(isPanelImage(img("r", 99, 1, { RepoTags: [`${repo}:qualquer`] }))).toBe(true);
    }
    expect(isPanelImage(img("r", 99, 1, { RepoTags: [], RepoDigests: ["ghcr.io/dono/tws-panel@sha256:0"] }))).toBe(true);
    expect(isPanelImage(img("r", 99, 1))).toBe(false);
  });

  it("normaliza registro, tag e digest no nome do repositório", () => {
    expect(repositoryOf("docker.io/library/Node:22@sha256:ab")).toBe("docker.io/library/node");
    expect(repositoryOf("localhost:5000/app")).toBe("localhost:5000/app");
    expect(isPanelRepository("docker.io/library/node")).toBe(true);
    expect(isPanelRepository("meu-node")).toBe(false);
    expect(isPanelRepository("ghcr.io/dono/tws-panel")).toBe(true);
  });
});

describe("configuração", () => {
  it("o padrão é DESLIGADA, semanal, 7 dias", () => {
    expect(DOCKER_CLEANUP_DEFAULTS).toMatchObject({ enabled: false, frequency: "weekly", minAgeDays: 7, diskTriggerPercent: null });
  });
  it("valida limites e completa o que falta com o padrão", () => {
    expect(validateDockerCleanupSettings({})).toEqual({ ok: true, value: DOCKER_CLEANUP_DEFAULTS });
    expect(validateDockerCleanupSettings({ enabled: true, diskTriggerPercent: 90 })).toMatchObject({ ok: true, value: { enabled: true, diskTriggerPercent: 90 } });
    for (const bad of [null, [], { enabled: "sim" }, { frequency: "hourly" }, { minAgeDays: 0 }, { minAgeDays: 1.5 }, { diskTriggerPercent: 10 }, { warnGainGb: 0 }, { warnDiskPercent: 100 }]) {
      expect(validateDockerCleanupSettings(bad)).toEqual({ ok: false });
    }
  });
  it("aviso: ganho acima do limite, ou disco acima do % com algo a limpar", () => {
    const scan = (total: number, used: number | null): DockerCleanupScan => ({ ...buildScan({ now: NOW, minAgeDays: 7, images: [], cache: [], usedImageIds: new Set(), disk: null }), totalBytes: total, disk: used === null ? null : { totalBytes: 100 * GB, usedBytes: used * GB, usedPercent: used } });
    const w = { warnGainGb: 10, warnDiskPercent: 80 };
    expect(dockerCleanupWarns(null, w)).toBe(false);
    expect(dockerCleanupWarns(scan(0, 95), w)).toBe(false);
    expect(dockerCleanupWarns(scan(11 * GB, 10), w)).toBe(true);
    expect(dockerCleanupWarns(scan(1 * GB, 85), w)).toBe(true);
    expect(dockerCleanupWarns(scan(1 * GB, 50), w)).toBe(false);
    expect(dockerCleanupWarns(scan(1 * GB, null), w)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

interface Fake {
  api: DockerCleanupApi;
  images: RawImage[];
  cache: RawCacheRecord[];
  used: Set<string>;
  removed: string[];
  pruned: number[];
  failRef: Set<string>;
  down: boolean;
  pruneFails: boolean;
  onRemove?: () => void;
}
function fake(): Fake {
  const f: Fake = {
    images: [],
    cache: [],
    used: new Set(),
    removed: [],
    pruned: [],
    failRef: new Set(),
    down: false,
    pruneFails: false,
    api: undefined as unknown as DockerCleanupApi,
  };
  f.api = {
    df: async () => (f.down ? null : { images: f.images, cache: f.cache }),
    usedImageIds: async () => (f.down ? null : f.used),
    pruneBuildCache: async (hours) => {
      if (f.pruneFails) throw new Error("prune quebrou");
      f.pruned.push(hours);
      return f.cache.filter((c) => !c.InUse).reduce((n, c) => n + c.Size, 0);
    },
    removeImage: async (ref) => {
      f.onRemove?.();
      if (f.failRef.has(ref)) return { ok: false, message: "em uso" };
      f.removed.push(ref);
      return { ok: true };
    },
  };
  return f;
}

let dir: string;
let clock: number;
let deployBusy: boolean;
let backupBusy: boolean;
let notify: ReturnType<typeof vi.fn<(e: NotificationEvent) => Promise<void>>>;
let f: Fake;
let statfsUsed: number;

const make = () =>
  new DockerCleanupService({
    dataDir: dir,
    api: f.api,
    statfs: async () => ({ blocks: 100, bsize: GB, bavail: 100 - statfsUsed }),
    deployBusy: () => deployBusy,
    backupBusy: () => backupBusy,
    notify,
    log: () => undefined,
    now: () => clock,
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-docker-cleanup-"));
  clock = NOW;
  deployBusy = false;
  backupBusy = false;
  notify = vi.fn<(e: NotificationEvent) => Promise<void>>(async () => undefined);
  statfsUsed = 50;
  f = fake();
  f.images = [img("a", 30, 6 * GB), img("b", 20, 2 * GB), img("c", 1, GB), img("pnl", 90, 4 * GB, { RepoTags: ["tws-panel:old"] }), img("sem", 40, GB, { RepoTags: [] })];
  f.cache = [cache("c1", 15, 5 * GB)];
});
afterEach(async () => {
  await removeDir(dir);
});

describe("serviço: verificar", () => {
  it("nasce com a limpeza desligada e sem nada removido", async () => {
    const s = make();
    await s.load();
    expect(s.state().settings.enabled).toBe(false);
    expect(s.state()).toMatchObject({ lastScan: null, history: [], nextRunAt: null, blocked: null, working: false });
    clock += 30 * DAY;
    await s.tick(); // desligada: só verifica, não remove
    expect(f.removed).toEqual([]);
    expect(f.pruned).toEqual([]);
    expect(s.state().lastScan).not.toBeNull();
  });

  it("scan lê, guarda a data e persiste; um processo novo vê a mesma verificação", async () => {
    const s = make();
    await s.load();
    const scan = await s.scan();
    expect(scan?.totalBytes).toBe(14 * GB);
    expect(f.removed).toEqual([]);
    const again = make();
    await again.load();
    expect(again.state().lastScan?.scannedAt).toBe(new Date(NOW).toISOString());
  });

  it("Docker fora: scan e run devolvem null e nada é gravado", async () => {
    f.down = true;
    const s = make();
    await s.load();
    expect(await s.scan()).toBeNull();
    expect(await s.run("manual", "ana")).toBeNull();
    expect(s.state().history).toEqual([]);
    expect(s.state().blocked).toBeNull();
  });

  it("avisa quando passa do limite (uma vez por dia) e aponta a tela", async () => {
    const s = make();
    await s.load();
    await s.scan();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ kind: "disk", path: "/settings/docker-cleanup" });
    expect(s.state().warning).toBe(true);
    await s.scan();
    expect(notify).toHaveBeenCalledTimes(1);
    clock += 25 * HOURS;
    await s.scan();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("sem ganho suficiente nem disco cheio, não avisa; erro do envio não derruba", async () => {
    f.images = [img("a", 30, GB)];
    f.cache = [];
    const s = make();
    await s.load();
    await s.scan();
    expect(notify).not.toHaveBeenCalled();
    expect(s.state().warning).toBe(false);
    statfsUsed = 90;
    notify.mockRejectedValueOnce(new Error("telegram fora"));
    await expect(s.scan()).resolves.not.toBeNull();
  });
});
const HOURS = 3_600_000;

describe("serviço: limpar", () => {
  it("remove imagem a imagem pela lista, nunca as do painel, e registra", async () => {
    const s = make();
    await s.load();
    const rec = await s.run("manual", "ana");
    expect(f.pruned).toEqual([7 * 24]);
    expect(f.removed.sort()).toEqual(["app-a:latest", "app-b:latest", "sha256:sem"]);
    expect(f.removed).not.toContain("tws-panel:old");
    expect(rec).toMatchObject({ trigger: "manual", actor: "ana", result: "success", freedBytes: 5 * GB + 9 * GB, buildCacheBytes: 5 * GB, imagesBytes: 9 * GB, errors: [] });
    expect(rec?.removedImages).toEqual(["app-a:latest", "app-b:latest", "sem"]);
    expect(s.state().history).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(dir, "docker-cleanup.json"), "utf8"));
    expect(saved.history[0].actor).toBe("ana");
  });

  it("imagem com vários nomes tem cada nome retirado", async () => {
    f.images = [img("m", 30, GB, { RepoTags: ["x:1", "x:2"] })];
    f.cache = [];
    const s = make();
    await s.load();
    await s.run("manual", "ana");
    expect(f.removed).toEqual(["x:1", "x:2"]);
    expect(f.pruned).toEqual([]);
  });

  it("falha numa imagem não para as outras: resultado parcial com o erro no registro", async () => {
    f.failRef.add("app-a:latest");
    const s = make();
    await s.load();
    const rec = await s.run("manual", "ana");
    expect(rec?.result).toBe("partial");
    expect(rec?.errors).toEqual(["app-a:latest: em uso"]);
    expect(rec?.removedImages).toEqual(["app-b:latest", "sem"]);
    expect(rec?.imagesBytes).toBe(3 * GB);
  });

  it("tudo falhando = falha; cache que falha vira erro mas as imagens seguem", async () => {
    f.pruneFails = true;
    f.images = [img("a", 30, GB)];
    f.failRef.add("app-a:latest");
    const s = make();
    await s.load();
    const rec = await s.run("manual", "ana");
    expect(rec?.result).toBe("failed");
    expect(rec?.errors[0]).toContain("Cache de build: prune quebrou");
  });

  it("não roda com deploy em andamento nem durante backup, e não grava nada", async () => {
    const s = make();
    await s.load();
    deployBusy = true;
    expect(s.state().blocked).toBe("deploy");
    await expect(s.run("manual", "ana")).rejects.toMatchObject({ name: "DockerCleanupBlockedError", reason: "deploy" });
    deployBusy = false;
    backupBusy = true;
    expect(s.state().blocked).toBe("backup");
    await expect(s.run("manual", "ana")).rejects.toBeInstanceOf(DockerCleanupBlockedError);
    expect(f.removed).toEqual([]);
    expect(f.pruned).toEqual([]);
    expect(s.state().history).toEqual([]);
  });

  it("deploy que começa no meio da limpeza interrompe o resto", async () => {
    const s = make();
    await s.load();
    f.onRemove = () => {
      deployBusy = true;
    };
    const rec = await s.run("manual", "ana");
    expect(f.removed).toHaveLength(1);
    expect(rec?.result).toBe("partial");
    expect(rec?.errors[0]).toContain("Interrompida");
  });

  it("verificar ou limpar com outra operação no ar é recusado", async () => {
    const s = make();
    await s.load();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const original = f.api.df;
    f.api.df = async () => {
      await gate;
      return original();
    };
    const running = s.scan();
    expect(s.state().working).toBe(true);
    expect(s.state().blocked).toBe("cleaning");
    await expect(s.scan()).rejects.toMatchObject({ reason: "cleaning" });
    await expect(s.run("manual", "ana")).rejects.toMatchObject({ reason: "cleaning" });
    await s.tick(); // ocupado: nem tenta
    release();
    await running;
    expect(s.state().working).toBe(false);
  });

  it("o histórico guarda só os mais recentes", async () => {
    f.images = [];
    f.cache = [];
    const s = make();
    await s.load();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await s.run("manual", `u${i}`);
    expect(s.state().history).toHaveLength(HISTORY_LIMIT);
    expect(s.state().history[0]!.actor).toBe(`u${HISTORY_LIMIT + 4}`);
  });
});

describe("serviço: limpeza automática", () => {
  const on = (over = {}) => ({ ...DOCKER_CLEANUP_DEFAULTS, enabled: true, ...over });

  it("ligada, só roda depois de uma frequência inteira contada do momento em que foi ligada", async () => {
    const s = make();
    await s.load();
    const st = await s.updateSettings(on());
    expect(st.nextRunAt).toBe(new Date(NOW + 7 * DAY).toISOString());
    clock += 6 * DAY;
    await s.tick();
    expect(f.removed).toEqual([]);
    clock += 1 * DAY;
    await s.tick();
    expect(f.removed.length).toBeGreaterThan(0);
    expect(s.state().history[0]).toMatchObject({ trigger: "schedule", actor: "automática" });
    expect(s.state().nextRunAt).toBe(new Date(clock + 7 * DAY).toISOString());
  });

  it("com deploy em andamento a automática espera e tenta no próximo giro", async () => {
    const s = make();
    await s.load();
    await s.updateSettings(on({ frequency: "daily" }));
    clock += 2 * DAY;
    deployBusy = true;
    await s.tick();
    expect(f.removed).toEqual([]);
    expect(s.state().history).toEqual([]);
    deployBusy = false;
    await s.tick();
    expect(f.removed.length).toBeGreaterThan(0);
  });

  it("pelo uso do disco: limpa ao passar do %, e espera 6 h antes de tentar de novo", async () => {
    const s = make();
    await s.load();
    await s.updateSettings(on({ diskTriggerPercent: 80 }));
    statfsUsed = 70;
    await s.tick();
    expect(f.removed).toEqual([]);
    statfsUsed = 85;
    await s.tick();
    expect(s.state().history[0]).toMatchObject({ trigger: "disk" });
    const n = s.state().history.length;
    f.images = [img("z", 30, GB)];
    clock += 3 * HOURS;
    await s.tick();
    expect(s.state().history).toHaveLength(n);
    clock += 4 * HOURS;
    await s.tick();
    expect(f.removed).toContain("app-z:latest");
  });

  it("pelo disco sem nada a limpar não enche o histórico", async () => {
    f.images = [];
    f.cache = [];
    const s = make();
    await s.load();
    await s.updateSettings(on({ diskTriggerPercent: 80 }));
    statfsUsed = 95;
    await s.tick();
    expect(s.state().history).toEqual([]);
  });

  it("desligar apaga a agenda; religar recomeça a contar; arquivo ilegível volta ao padrão", async () => {
    const s = make();
    await s.load();
    await s.updateSettings(on());
    expect((await s.updateSettings(on({ minAgeDays: 14 }))).nextRunAt).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect((await s.updateSettings({ ...on(), enabled: false })).nextRunAt).toBeNull();
    expect(s.settings().enabled).toBe(false);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "docker-cleanup.json"), "{quebrado");
    const fresh = make();
    await fresh.load();
    expect(fresh.state().settings).toEqual(DOCKER_CLEANUP_DEFAULTS);
  });

  it("start agenda o giro e stop o desarma", async () => {
    const s = make();
    s.start();
    s.start();
    s.stop();
    s.stop();
  });

  it("um giro sem verificação recente verifica; com verificação recente, não repete", async () => {
    const s = make();
    await s.load();
    await s.tick();
    const first = s.state().lastScan?.scannedAt;
    clock += HOURS;
    await s.tick();
    expect(s.state().lastScan?.scannedAt).toBe(first);
    clock += 6 * HOURS;
    await s.tick();
    expect(s.state().lastScan?.scannedAt).not.toBe(first);
  });
});

describe("rotas", () => {
  let app: FastifyInstance;
  let audits: Array<{ action: string; detail: string }>;
  let session: { username: string; token?: unknown } | null;
  let service: DockerCleanupService;

  beforeEach(async () => {
    audits = [];
    session = { username: "ana" };
    service = make();
    await service.load();
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      (req as unknown as { session: unknown }).session = session;
    });
    app.decorate("dockerCleanup", service);
    app.decorate("auditService", { record: async (e: { action: string; detail: string }) => void audits.push(e) } as never);
    await app.register(dockerCleanupRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  it("GET devolve o estado; POST scan atualiza", async () => {
    const a = await app.inject({ method: "GET", url: "/api/docker-cleanup" });
    expect(a.statusCode).toBe(200);
    expect(a.json().settings.enabled).toBe(false);
    const b = await app.inject({ method: "POST", url: "/api/docker-cleanup/scan" });
    expect(b.statusCode).toBe(200);
    expect(b.json().lastScan.totalBytes).toBe(14 * GB);
  });

  it("run exige confirm:true, remove, audita e devolve o registro", async () => {
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: { confirm: false } })).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: { confirm: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json().record.actor).toBe("ana");
    expect(audits[0]).toMatchObject({ action: "docker_cleanup.run" });
  });

  it("run auditado inclui falhas; deploy ativo = 409; Docker fora = 503", async () => {
    f.failRef.add("app-a:latest");
    const r = await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: { confirm: true } });
    expect(audits[0]!.detail).toContain("1 falha(s)");
    expect(r.json().record.result).toBe("partial");
    deployBusy = true;
    const b = await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: { confirm: true } });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toBe("cleanup_deploy");
    // verificar é só leitura: continua disponível durante o deploy
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/scan" })).statusCode).toBe(200);
    deployBusy = false;
    f.down = true;
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/scan" })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: { confirm: true } })).statusCode).toBe(503);
  });

  it("scan com outra operação no ar volta 409 cleaning", async () => {
    vi.spyOn(service, "scan").mockRejectedValueOnce(new DockerCleanupBlockedError("cleaning"));
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/scan" })).json().error).toBe("cleanup_cleaning");
    vi.spyOn(service, "scan").mockRejectedValueOnce(new Error("boom"));
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/scan" })).statusCode).toBe(500);
    vi.spyOn(service, "run").mockRejectedValueOnce(new Error("boom"));
    expect((await app.inject({ method: "POST", url: "/api/docker-cleanup/run", payload: { confirm: true } })).statusCode).toBe(500);
  });

  it("PUT grava, audita e rejeita valor fora do limite", async () => {
    const settings = { ...DOCKER_CLEANUP_DEFAULTS, enabled: true, minAgeDays: 14, diskTriggerPercent: 90 };
    const ok = await app.inject({ method: "PUT", url: "/api/docker-cleanup/settings", payload: { settings } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ enabled: true, minAgeDays: 14, diskTriggerPercent: 90 });
    expect(audits[0]!.detail).toContain("desligada → ligada");
    const bad = await app.inject({ method: "PUT", url: "/api/docker-cleanup/settings", payload: { settings: { ...settings, minAgeDays: 0 } } });
    expect(bad.statusCode).toBe(400);
  });

  it("PUT com falha de disco = 500 e nada muda", async () => {
    vi.spyOn(service, "updateSettings").mockRejectedValueOnce(new Error("disco"));
    const r = await app.inject({ method: "PUT", url: "/api/docker-cleanup/settings", payload: { settings: DOCKER_CLEANUP_DEFAULTS } });
    expect(r.statusCode).toBe(500);
    expect(service.settings().enabled).toBe(false);
  });

  it("token e requisição sem sessão não verificam, limpam nem configuram", async () => {
    for (const s of [{ username: "bot", token: { id: "t" } }, null]) {
      session = s;
      for (const [method, url, payload] of [
        ["POST", "/api/docker-cleanup/scan", undefined],
        ["POST", "/api/docker-cleanup/run", { confirm: true }],
        ["PUT", "/api/docker-cleanup/settings", { settings: DOCKER_CLEANUP_DEFAULTS }],
      ] as const) {
        const r = await app.inject({ method, url, payload });
        expect(r.statusCode).toBe(403);
      }
    }
    expect(f.removed).toEqual([]);
  });
});
