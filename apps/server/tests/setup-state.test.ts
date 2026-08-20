/**
 * Testes da persistência do estado do wizard (setup-state.ts): JSON em disco
 * com defaults tolerantes, modo 0600 e avanço de passo.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_STEPS, SetupStateStore } from "../src/services/setup-state.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SetupStateStore", () => {
  it("arquivo ausente → estado inicial (passo 0, não concluído)", async () => {
    const state = await new SetupStateStore(dir).load();
    expect(state.currentStep).toBe(0);
    expect(state.completed).toBe(false);
    expect(state.updatedAt).toBeTruthy();
  });

  it("JSON corrompido → estado inicial sem lançar", async () => {
    await writeFile(path.join(dir, "setup-state.json"), "{json quebrado");
    const state = await new SetupStateStore(dir).load();
    expect(state.currentStep).toBe(0);
    expect(state.completed).toBe(false);
  });

  it("save persiste e load recupera o estado exato", async () => {
    const store = new SetupStateStore(dir);
    await store.save({ currentStep: 2, completed: true, updatedAt: new Date(0).toISOString() });
    const state = await store.load();
    expect(state.currentStep).toBe(2);
    expect(state.completed).toBe(true);
  });

  it("save atualiza updatedAt e grava o arquivo com modo 0600", async () => {
    const store = new SetupStateStore(dir);
    await store.save({ currentStep: 1, completed: false, updatedAt: new Date(0).toISOString() });
    const file = path.join(dir, "setup-state.json");
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(new Date(raw.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it("setStep avança o passo preservando as demais propriedades", async () => {
    const store = new SetupStateStore(dir);
    await store.save({ currentStep: 0, completed: true, updatedAt: new Date(0).toISOString() });
    const next = await store.setStep(3);
    expect(next.currentStep).toBe(3);
    expect(next.completed).toBe(true);
    expect((await store.load()).currentStep).toBe(3);
  });

  it("campos ausentes no JSON recebem defaults seguros", async () => {
    await writeFile(path.join(dir, "setup-state.json"), JSON.stringify({ currentStep: 5 }));
    const state = await new SetupStateStore(dir).load();
    expect(state.currentStep).toBe(5);
    expect(state.completed).toBe(false);
  });
});

describe("SETUP_STEPS", () => {
  it("wizard tem 4 passos começando pelo token; admin ainda indisponível", () => {
    expect(SETUP_STEPS.map((s) => s.key)).toEqual(["welcome", "health", "security", "admin"]);
    expect(SETUP_STEPS[0]).toMatchObject({ id: 0, available: true });
    expect(SETUP_STEPS.find((s) => s.key === "admin")?.available).toBe(false);
  });
});
