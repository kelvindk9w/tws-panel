/**
 * timezone-service.test.ts — Configurações → Fuso horário: ler o fuso da VPS
 * pelo host bridge (sem depender da montagem /host/etc/localtime, que
 * congela), aplicar na VPS sem recriar o container (process.env.TZ muda na
 * hora), avisar a agenda dos backups e aplicar nos projetos marcados.
 * O host bridge é um dublê; os comandos reais estão em packages/security.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectTimezoneSetting } from "@paas/core";
import { TimezoneService, createHostTimezoneBridge, type HostTimezoneBridge } from "../src/services/timezone-service.js";
import { TIMEZONE_STATE_FILE } from "../src/services/host-timezone.js";

let dir: string;
let env: NodeJS.ProcessEnv;
let clock: number;
let hostZone: string;
let projects: Project[];
const record = vi.fn(async () => ({}));
const onChange = vi.fn();
const setTimezone = vi.fn(async (id: string, setting: ProjectTimezoneSetting) => {
  const p = projects.find((x) => x.id === id)!;
  p.timezone = setting;
  return p;
});
const recreate = vi.fn(async (id: string) => ({ id: `job-${id}` }));

function bridge(over: Partial<HostTimezoneBridge> = {}): HostTimezoneBridge {
  return {
    read: vi.fn(async () => hostZone),
    set: vi.fn(async (z: string) => {
      hostZone = z;
    }),
    ...over,
  };
}

function project(id: string, name: string, timezone?: ProjectTimezoneSetting): Project {
  return { id, name, slug: id, ...(timezone ? { timezone } : {}) } as Project;
}

function build(b: HostTimezoneBridge | null, startup: { zone: string | null; source: "env" | "saved" | "localtime" | "default"; envOverride: string | null } = { zone: null, source: "default", envOverride: null }) {
  return new TimezoneService({
    dataDir: dir,
    bridge: b,
    startup,
    env,
    projects: { list: async () => projects, setTimezone, recreate },
    audit: { record },
    log: () => undefined,
    now: () => clock,
    onChange,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-tzsvc-"));
  env = {};
  clock = Date.parse("2026-10-15T12:00:00Z");
  hostZone = "Europe/Berlin";
  projects = [project("p1", "Loja"), project("p2", "Blog", { mode: "zone", zone: "Europe/Lisbon" })];
  for (const f of [record, onChange, setTimezone, recreate]) f.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ler o fuso da VPS", () => {
  it("lê pelo host bridge, guarda em data/timezone.json (0600) e passa a usar na hora", async () => {
    env.TZ = "UTC"; // o que a montagem congelada tinha dado
    const svc = build(bridge(), { zone: "UTC", source: "localtime", envOverride: null });
    await svc.refresh();
    expect(env.TZ).toBe("Europe/Berlin");
    expect(onChange).toHaveBeenCalledWith("Europe/Berlin", "UTC");
    const saved = JSON.parse(await readFile(path.join(dir, TIMEZONE_STATE_FILE), "utf8"));
    expect(saved.zone).toBe("Europe/Berlin");
    expect((await stat(path.join(dir, TIMEZONE_STATE_FILE))).mode & 0o777).toBe(0o600);
    const st = await svc.status();
    expect(st).toMatchObject({ zone: "Europe/Berlin", source: "host", hostZone: "Europe/Berlin", canApply: true, cannotApplyReason: null, hostError: null });
    expect(st.offset).toBe("UTC+2");
    expect(st.options[0]!.zone).toBe("America/Sao_Paulo");
    // mesmo fuso de novo: nada muda e nada é avisado
    onChange.mockClear();
    await svc.refresh();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("TZ no .env manda: lê a VPS mas não troca o fuso do painel", async () => {
    env.TZ = "America/Manaus";
    const svc = build(bridge(), { zone: "America/Manaus", source: "env", envOverride: "America/Manaus" });
    await svc.refresh();
    expect(env.TZ).toBe("America/Manaus");
    const st = await svc.status();
    expect(st).toMatchObject({ zone: "America/Manaus", source: "env", envOverride: "America/Manaus", hostZone: "Europe/Berlin" });
    expect(svc.vpsZone()).toBe("Europe/Berlin");
  });

  it("falha ou saída estranha do host bridge não muda nada e aparece na tela", async () => {
    env.TZ = "America/Sao_Paulo";
    const svc = build(bridge({ read: vi.fn(async () => null) }));
    await svc.refresh();
    expect((await svc.status()).hostError).toMatch(/não deu para entender/);
    expect(env.TZ).toBe("America/Sao_Paulo");
    const broken = build(bridge({ read: vi.fn(async () => Promise.reject(new Error("docker fora"))) }));
    await broken.refresh();
    const st = await broken.status();
    expect(st.hostError).toBe("Não foi possível ler o fuso da VPS: docker fora");
    expect(st.zone).toBe("America/Sao_Paulo");
  });

  it("ao abrir a tela relê só depois de 5 minutos; leituras simultâneas viram uma só", async () => {
    const b = bridge();
    const svc = build(b);
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(b.read).toHaveBeenCalledTimes(1);
    await svc.status();
    expect(b.read).toHaveBeenCalledTimes(1);
    clock += 6 * 60_000;
    await svc.status();
    expect(b.read).toHaveBeenCalledTimes(2);
  });

  it("sem host bridge (PAAS_TARGET não é host): mostra o fuso e explica como trocar", async () => {
    const svc = build(null);
    await svc.refresh();
    const st = await svc.status();
    expect(st).toMatchObject({ zone: "UTC", offset: "UTC", canApply: false, hostZone: null });
    expect(st.cannotApplyReason).toMatch(/timedatectl set-timezone/);
    expect(st.projects).toEqual([
      { id: "p1", name: "Loja", setting: { mode: "image" }, effectiveZone: null },
      { id: "p2", name: "Blog", setting: { mode: "zone", zone: "Europe/Lisbon" }, effectiveZone: "Europe/Lisbon" },
    ]);
  });
});

describe("aplicar na VPS", () => {
  it("troca pelo host bridge, confere, usa na hora, audita e aplica nos projetos marcados", async () => {
    env.TZ = "Europe/Berlin";
    const b = bridge();
    const svc = build(b, { zone: "Europe/Berlin", source: "localtime", envOverride: null });
    const res = await svc.apply("America/Sao_Paulo", ["p1", "p1", "nao-existe"], "admin");
    expect(b.set).toHaveBeenCalledWith("America/Sao_Paulo");
    expect(env.TZ).toBe("America/Sao_Paulo");
    expect(onChange).toHaveBeenCalledWith("America/Sao_Paulo", "Europe/Berlin");
    expect(res.status).toMatchObject({ zone: "America/Sao_Paulo", hostZone: "America/Sao_Paulo", source: "host", offset: "UTC−3" });
    expect(setTimezone).toHaveBeenCalledWith("p1", { mode: "host" }, "admin");
    expect(recreate).toHaveBeenCalledWith("p1", "admin");
    expect(res.projects).toEqual([
      { id: "p1", name: "Loja", jobId: "job-p1", error: null },
      { id: "nao-existe", name: "nao-existe", jobId: null, error: "Projeto não encontrado." },
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "timezone.applied", detail: "Fuso da VPS: Europe/Berlin → America/Sao_Paulo.", actor: "admin" }),
    );
    const saved = JSON.parse(await readFile(path.join(dir, TIMEZONE_STATE_FILE), "utf8"));
    expect(saved.zone).toBe("America/Sao_Paulo");
  });

  it("projeto que não reinicia: o erro aparece e os outros seguem", async () => {
    recreate.mockRejectedValueOnce(new Error("Faça o primeiro deploy"));
    const svc = build(bridge());
    const res = await svc.apply("America/Manaus", ["p1", "p2"], "admin");
    expect(res.projects).toEqual([
      { id: "p1", name: "Loja", jobId: null, error: "Faça o primeiro deploy" },
      { id: "p2", name: "Blog", jobId: "job-p2", error: null },
    ]);
  });

  it("recusa fuso fora da lista e sem host bridge", async () => {
    await expect(build(bridge()).apply("Asia/Calcutta", [], "admin")).rejects.toMatchObject({ statusCode: 400, code: "invalid_timezone" });
    await expect(build(null).apply("America/Sao_Paulo", [], "admin")).rejects.toMatchObject({ statusCode: 409, code: "host_bridge_unavailable" });
  });

  it("a VPS recusa ou não troca: 502, nada muda no painel e fica na auditoria", async () => {
    env.TZ = "Europe/Berlin";
    const svc = build(bridge({ set: vi.fn(async () => Promise.reject(new Error("Failed to set time zone"))) }));
    await expect(svc.apply("America/Sao_Paulo", [], "admin")).rejects.toMatchObject({ statusCode: 502, code: "timezone_apply_failed" });
    expect(env.TZ).toBe("Europe/Berlin");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "timezone.apply_failed" }));
    const stuck = build(bridge({ set: vi.fn(async () => undefined) }));
    await expect(stuck.apply("America/Sao_Paulo", [], "admin")).rejects.toThrow(/continua em Europe\/Berlin/);
    expect(env.TZ).toBe("Europe/Berlin");
  });

  it("conferência que falha depois de trocar não impede (o comando já saiu com 0)", async () => {
    const read = vi.fn(async () => hostZone);
    read.mockImplementationOnce(async () => Promise.reject(new Error("helper lento")));
    const svc = build(bridge({ read }));
    const res = await svc.apply("America/Recife", [], "admin");
    expect(res.status.zone).toBe("America/Recife");
  });

  it("com TZ no .env o painel usa o fuso novo agora, mas a fonte continua sendo o .env", async () => {
    env.TZ = "Europe/Berlin";
    const svc = build(bridge(), { zone: "Europe/Berlin", source: "env", envOverride: "Europe/Berlin" });
    const res = await svc.apply("America/Bahia", [], "admin");
    expect(env.TZ).toBe("America/Bahia");
    expect(res.status).toMatchObject({ source: "env", envOverride: "Europe/Berlin", zone: "America/Bahia" });
  });

  it("quem escuta a troca falhar não derruba a aplicação", async () => {
    onChange.mockImplementationOnce(() => {
      throw new Error("agenda");
    });
    const svc = build(bridge());
    await expect(svc.apply("America/Belem", [], "admin")).resolves.toBeTruthy();
    expect(env.TZ).toBe("America/Belem");
  });
});

describe("falhas que não atrapalham", () => {
  it("não consegue gravar data/timezone.json nem a auditoria: avisa no log e segue", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const svc = new TimezoneService({
        dataDir: path.join(dir, "arquivo-no-lugar-da-pasta", "x"),
        bridge: bridge(),
        startup: { zone: null, source: "default", envOverride: null },
        env,
        projects: { list: async () => projects, setTimezone, recreate },
        audit: { record: vi.fn(async () => Promise.reject(new Error("banco fora"))) },
      });
      await import("node:fs/promises").then((fs) => fs.writeFile(path.join(dir, "arquivo-no-lugar-da-pasta"), "x"));
      await svc.refresh();
      expect(env.TZ).toBe("Europe/Berlin");
      await expect(svc.apply("America/Recife", [], "admin")).resolves.toBeTruthy();
      expect(env.TZ).toBe("America/Recife");
      await new Promise((r) => setTimeout(r, 0));
      expect(warn.mock.calls.flat().join(" ")).toMatch(/não foi possível gravar data\/timezone\.json/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("host bridge do fuso", () => {
  it("usa os comandos prontos e trata código de saída", async () => {
    const runner = {
      ensureReady: vi.fn(async () => undefined),
      exec: vi.fn(async (cmd: string) => (cmd === "LER" ? { code: 0, stdout: "America/Sao_Paulo\n", stderr: "" } : { code: 0, stdout: "", stderr: "" })),
    };
    const b = createHostTimezoneBridge(runner, { read: "LER", set: (z) => `TROCAR ${z}`, parse: (o) => o.trim() || null });
    expect(await b.read()).toBe("America/Sao_Paulo");
    await b.set("UTC");
    expect(runner.exec).toHaveBeenCalledWith("TROCAR UTC", { timeoutMs: 60_000 });
    runner.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "Failed to set time zone: Invalid time zone\n" });
    await expect(b.set("UTC")).rejects.toThrow("Failed to set time zone: Invalid time zone");
    runner.exec.mockResolvedValue({ code: 3, stdout: "", stderr: "" });
    await expect(b.read()).rejects.toThrow("código 3");
    await expect(b.set("UTC")).rejects.toThrow("código 3");
    runner.exec.mockResolvedValue({ code: 2, stdout: "", stderr: "sem permissão" });
    await expect(b.read()).rejects.toThrow("sem permissão");
  });
});
