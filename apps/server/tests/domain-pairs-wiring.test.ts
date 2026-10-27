/**
 * Com o app de verdade (buildApp): o par com/sem www depende de duas ligações
 * que só existem em app.ts e que nenhum teste de serviço enxerga:
 *  - `hostState` (a consulta de DNS do proxy): sem ela, NENHUM par redireciona em produção;
 *  - os temporizadores de reconferência (3 min na primeira, depois a cada 10 min): sem eles,
 *    quem cria o registro de DNS depois nunca vê o redirecionamento nascer.
 * Os temporizadores são capturados (nenhum espera de verdade) e disparados à mão.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolve4 } = vi.hoisted(() => ({ resolve4: vi.fn<(name: string) => Promise<string[]>>() }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, default: { ...actual, resolve4 } };
});

const PUBLIC_IP = "203.0.113.10";
const saved: Record<string, string | undefined> = {};
let dir = "";

interface Captured {
  kind: "timeout" | "interval";
  ms: number;
  fn: () => void;
}
let captured: Captured[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-pairs-wiring-"));
  await writeFile(path.join(dir, "setup-token"), "token-de-teste-pares");
  for (const [k, v] of Object.entries({
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: PUBLIC_IP,
    LOG_LEVEL: "silent",
  })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  resolve4.mockReset();
  resolve4.mockImplementation(async (name) => {
    if (name === "www.example.com") return [PUBLIC_IP];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  });
  captured = [];
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  // Só guarda o que o app agenda com os atrasos do par; o resto segue como era.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 3 * 60_000) captured.push({ kind: "timeout", ms, fn });
    return realTimeout(fn as never, ms, ...(rest as []));
  }) as unknown as typeof setTimeout);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 10 * 60_000) captured.push({ kind: "interval", ms, fn });
    return realInterval(fn as never, ms, ...(rest as []));
  }) as unknown as typeof setInterval);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("par com/sem www no app real", () => {
  it("a consulta de DNS do proxy está ligada e a reconferência reaplica o proxy quando o par passa a apontar", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const engine = (app.deployService as unknown as { engine: { syncCaddy: unknown } }).engine;
      const sync = vi.fn(async () => undefined);
      engine.syncCaddy = sync;
      await app.deployService.createProject({
        name: "site",
        ingestMode: "git",
        source: "https://github.com/k/x",
        branch: "main",
        domain: "example.com",
      });
      sync.mockClear();
      // o DNS do www aponta e o proxy ainda não o aplicou: a reconferência tem de reaplicar
      expect(await app.deployService.reconcilePairs()).toBe(true);
      expect(sync).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("agenda a primeira reconferência em 3 min e as seguintes a cada 10 min, e ambas chamam reconcilePairs", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      expect(captured.map((c) => [c.kind, c.ms])).toEqual([
        ["timeout", 3 * 60_000],
        ["interval", 10 * 60_000],
      ]);
      const reconcile = vi.spyOn(app.deployService, "reconcilePairs").mockResolvedValue(false);
      for (const c of captured) c.fn();
      await flush();
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("falha na reconferência não derruba o app (vira aviso)", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      vi.spyOn(app.deployService, "reconcilePairs").mockRejectedValue(new Error("docker fora do ar"));
      expect(() => captured.forEach((c) => c.fn())).not.toThrow();
      await flush();
    } finally {
      await app.close();
    }
  });
});
