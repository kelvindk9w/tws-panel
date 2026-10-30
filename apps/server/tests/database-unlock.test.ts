/**
 * database-unlock.test.ts — a liberação da edição do banco: criar, usar, expirar, renovar com o uso, bloquear agora,
 * sessão que acaba, uma liberação por sessão e por projeto, e a configuração (arquivo) que a governa.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSettings } from "@paas/core";
import { DatabaseSettingsStore } from "../src/services/database-settings.js";
import { DURATION_LABELS, DatabaseUnlock } from "../src/services/database-unlock.js";

const MIN = 60_000;
const P1 = { id: "p1", slug: "loja", name: "Loja" };
const P2 = { id: "p2", slug: "blog", name: "Blog" };

let now: number;
let settings: DatabaseSettings;
let active: Set<string>;
let audits: Array<{ actor: string; action: string; target: string; detail: string }>;
let unlock: DatabaseUnlock;

beforeEach(() => {
  now = 5_000;
  settings = { unlockDuration: "30m", renewOnUse: true };
  active = new Set(["s1", "s2"]);
  audits = [];
  unlock = new DatabaseUnlock({
    settings: { current: () => settings },
    now: () => now,
    isSessionActive: (id) => active.has(id),
    audit: (i) => void audits.push(i),
  });
});

afterEach(() => {
  unlock.dispose();
  vi.useRealTimers();
});

describe("liberação: criar, usar e expirar", () => {
  it("começa bloqueada; liberar abre pelo prazo da configuração e audita com ator, projeto e duração", () => {
    expect(unlock.isUnlocked("s1", "p1")).toBe(false);
    expect(unlock.status("s1", "p1")).toMatchObject({ unlocked: false, expiresAt: null, remainingMs: null, lastEnd: null, duration: "30m", renewOnUse: true });
    const st = unlock.grant("s1", P1, "kelvin");
    expect(st).toMatchObject({ unlocked: true, remainingMs: 30 * MIN, duration: "30m" });
    expect(Date.parse(st.expiresAt!)).toBeGreaterThan(Date.now());
    expect(unlock.isUnlocked("s1", "p1")).toBe(true);
    expect(audits).toEqual([{ actor: "kelvin", action: "database.unlock_granted", target: "loja", detail: expect.stringMatching(/"Loja".*30 min.*renova com o uso/) }]);
  });

  it("expira no prazo (sem depender do timer) e audita o fim uma vez", () => {
    unlock.grant("s1", P1, "kelvin");
    now += 30 * MIN - 1;
    expect(unlock.isUnlocked("s1", "p1")).toBe(true);
    now += 1;
    expect(unlock.isUnlocked("s1", "p1")).toBe(false);
    expect(unlock.status("s1", "p1").lastEnd).toBe("expired");
    expect(unlock.isUnlocked("s1", "p1")).toBe(false);
    expect(audits.filter((a) => a.action === "database.unlock_ended")).toEqual([expect.objectContaining({ actor: "kelvin", target: "loja", detail: expect.stringContaining("o prazo acabou") })]);
  });

  it("o timer encerra e audita mesmo sem ninguém perguntar", () => {
    vi.useFakeTimers();
    unlock.grant("s1", P1, "kelvin");
    now += 30 * MIN;
    vi.advanceTimersByTime(30 * MIN);
    expect(audits.map((a) => a.action)).toEqual(["database.unlock_granted", "database.unlock_ended"]);
  });

  it("timer que dispara depois de uma renovação espera mais, sem encerrar", () => {
    vi.useFakeTimers();
    unlock.grant("s1", P1, "kelvin");
    now += 20 * MIN;
    unlock.use("s1", "p1");
    // o timer antigo dispara em 30 min do relógio falso, mas a liberação foi renovada
    now += 10 * MIN;
    vi.advanceTimersByTime(30 * MIN);
    expect(unlock.isUnlocked("s1", "p1")).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(["database.unlock_granted"]);
  });

  it("liberar de novo recomeça o prazo e não deixa timer antigo", () => {
    unlock.grant("s1", P1, "kelvin");
    now += 25 * MIN;
    unlock.grant("s1", P1, "kelvin");
    expect(unlock.status("s1", "p1").remainingMs).toBe(30 * MIN);
  });
});

describe("renovar com o uso", () => {
  it("cada uso estende até o prazo cheio", () => {
    unlock.grant("s1", P1, "kelvin");
    now += 20 * MIN;
    expect(unlock.use("s1", "p1")).toBe(true);
    expect(unlock.status("s1", "p1").remainingMs).toBe(30 * MIN);
    now += 29 * MIN;
    expect(unlock.isUnlocked("s1", "p1")).toBe(true);
  });

  it("desligada: usar não estende", () => {
    settings = { unlockDuration: "30m", renewOnUse: false };
    unlock.grant("s1", P1, "kelvin");
    now += 20 * MIN;
    expect(unlock.use("s1", "p1")).toBe(true);
    expect(unlock.status("s1", "p1").remainingMs).toBe(10 * MIN);
  });

  it("usar sem liberação (ou vencida) devolve false", () => {
    expect(unlock.use("s1", "p1")).toBe(false);
    unlock.grant("s1", P1, "kelvin");
    now += 31 * MIN;
    expect(unlock.use("s1", "p1")).toBe(false);
  });

  it("'até a sessão acabar': sem prazo e usar não muda nada", () => {
    settings = { unlockDuration: "session", renewOnUse: true };
    const st = unlock.grant("s1", P1, "kelvin");
    expect(st).toMatchObject({ unlocked: true, expiresAt: null, remainingMs: null, duration: "session" });
    expect(audits[0]!.detail).toContain("até a sessão acabar");
    now += 100 * 60 * MIN;
    expect(unlock.use("s1", "p1")).toBe(true);
    expect(unlock.status("s1", "p1").remainingMs).toBeNull();
  });
});

describe("configuração alterada com liberação em curso", () => {
  it("encurtar corta o que resta para o novo prazo; alongar não estica", () => {
    unlock.grant("s1", P1, "kelvin");
    settings = { unlockDuration: "15m", renewOnUse: true };
    expect(unlock.status("s1", "p1").remainingMs).toBe(15 * MIN);
    settings = { unlockDuration: "4h", renewOnUse: false };
    expect(unlock.status("s1", "p1").remainingMs).toBe(15 * MIN);
  });

  it("de 'até a sessão acabar' para um prazo: passa a valer o prazo", () => {
    settings = { unlockDuration: "session", renewOnUse: true };
    unlock.grant("s1", P1, "kelvin");
    settings = { unlockDuration: "1h", renewOnUse: true };
    expect(unlock.status("s1", "p1").remainingMs).toBe(60 * MIN);
  });
});

describe("bloquear agora, sessão e escopo", () => {
  it("bloquear agora encerra e lembra o motivo; sem liberação devolve false", () => {
    expect(unlock.lock("s1", "p1")).toBe(false);
    unlock.grant("s1", P1, "kelvin");
    expect(unlock.lock("s1", "p1")).toBe(true);
    expect(unlock.isUnlocked("s1", "p1")).toBe(false);
    expect(unlock.status("s1", "p1").lastEnd).toBe("manual");
    expect(audits.at(-1)).toMatchObject({ action: "database.unlock_ended", detail: expect.stringContaining("bloqueada pelo botão") });
  });

  it("liberar de novo limpa o 'último fim'", () => {
    unlock.grant("s1", P1, "kelvin");
    unlock.lock("s1", "p1");
    unlock.grant("s1", P1, "kelvin");
    expect(unlock.status("s1", "p1").lastEnd).toBeNull();
  });

  it("é por sessão e por projeto", () => {
    unlock.grant("s1", P1, "kelvin");
    expect(unlock.isUnlocked("s2", "p1")).toBe(false);
    expect(unlock.isUnlocked("s1", "p2")).toBe(false);
    unlock.grant("s1", P2, "kelvin");
    unlock.lock("s1", "p1");
    expect(unlock.isUnlocked("s1", "p2")).toBe(true);
  });

  it("sessão que deixou de valer (expirou) encerra na próxima conferência", () => {
    unlock.grant("s1", P1, "kelvin");
    active.delete("s1");
    expect(unlock.isUnlocked("s1", "p1")).toBe(false);
    expect(unlock.status("s1", "p1").lastEnd).toBe("session");
  });

  it("sem conferência de sessão injetada, só a revogação explícita encerra", () => {
    const plain = new DatabaseUnlock({ settings: { current: () => settings }, now: () => now });
    plain.grant("sx", P1, "kelvin");
    expect(plain.isUnlocked("sx", "p1")).toBe(true);
    plain.lock("sx", "p1");
    expect(plain.isUnlocked("sx", "p1")).toBe(false);
    plain.dispose();
  });

  it("watch: sair/revogar a sessão encerra só as liberações dela e some a escuta ao cancelar", () => {
    let revoke: (ids: readonly string[]) => void = () => undefined;
    const off = vi.fn();
    const stop = unlock.watch({
      onRevoked: (l) => {
        revoke = l;
        return off;
      },
    });
    unlock.grant("s1", P1, "kelvin");
    unlock.grant("s1", P2, "kelvin");
    unlock.grant("s2", P1, "ana");
    revoke(["s1", "zzz"]);
    expect(unlock.isUnlocked("s1", "p1")).toBe(false);
    expect(unlock.isUnlocked("s1", "p2")).toBe(false);
    expect(unlock.isUnlocked("s2", "p1")).toBe(true);
    expect(unlock.status("s1", "p1").lastEnd).toBe("session");
    stop();
    expect(off).toHaveBeenCalled();
  });

  it("auditoria que falha não impede liberar nem bloquear; guarda só os últimos motivos", () => {
    const boom = new DatabaseUnlock({
      settings: { current: () => settings },
      now: () => now,
      audit: () => {
        throw new Error("disco");
      },
    });
    boom.grant("s1", P1, "kelvin");
    expect(boom.lock("s1", "p1")).toBe(true);
    for (let i = 0; i < 70; i++) {
      boom.grant(`x${i}`, P1, "kelvin");
      boom.lock(`x${i}`, "p1");
    }
    expect(boom.status("x69", "p1").lastEnd).toBe("manual");
    expect(boom.status("s1", "p1").lastEnd).toBeNull();
    boom.dispose();
  });

  it("sem relógio injetado usa o monotônico do sistema; rótulos de duração", () => {
    const real = new DatabaseUnlock({ settings: { current: () => settings } });
    expect(real.grant("a", P1, "kelvin").remainingMs).toBeGreaterThan(29 * MIN);
    real.dispose();
    expect(DURATION_LABELS["4h"]).toBe("4 h");
  });
});

describe("DatabaseSettingsStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-dbset-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("padrão: 30 min, renovando com o uso; grava e relê", async () => {
    const store = new DatabaseSettingsStore(dir);
    expect(await store.load()).toEqual({ unlockDuration: "30m", renewOnUse: true });
    await store.set({ unlockDuration: "2h", renewOnUse: false });
    expect(store.current()).toEqual({ unlockDuration: "2h", renewOnUse: false });
    const again = new DatabaseSettingsStore(dir);
    expect(await again.load()).toEqual({ unlockDuration: "2h", renewOnUse: false });
    expect(JSON.parse(await readFile(path.join(dir, "database-settings.json"), "utf8"))).toEqual({ unlockDuration: "2h", renewOnUse: false });
  });

  it("arquivo com valor estranho volta ao padrão", async () => {
    await writeFile(path.join(dir, "database-settings.json"), JSON.stringify({ unlockDuration: "10h", renewOnUse: true }));
    expect(await new DatabaseSettingsStore(dir).load()).toEqual({ unlockDuration: "30m", renewOnUse: true });
    await writeFile(path.join(dir, "database-settings.json"), JSON.stringify({ unlockDuration: "1h", renewOnUse: "sim" }));
    expect(await new DatabaseSettingsStore(dir).load()).toEqual({ unlockDuration: "30m", renewOnUse: true });
  });

  it("falha de disco na leitura mantém o último valor; na gravação não muda a memória", async () => {
    const store = new DatabaseSettingsStore(dir);
    await store.load();
    const file = (store as unknown as { file: { read: () => Promise<unknown>; update: () => Promise<unknown> } }).file;
    file.read = async () => {
      throw new Error("ilegível");
    };
    expect(await store.load()).toEqual({ unlockDuration: "30m", renewOnUse: true });
    file.update = async () => {
      throw new Error("disco cheio");
    };
    await expect(store.set({ unlockDuration: "4h", renewOnUse: false })).rejects.toThrow("disco cheio");
    expect(store.current()).toEqual({ unlockDuration: "30m", renewOnUse: true });
  });
});
