/**
 * notification-close.test.ts — o fechamento do serviço de notificações com
 * carga e gravação LENTAS e controladas. Ao terminar, close() garante que não
 * há mais nada a gravar e que o que foi pedido antes dele foi gravado.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Gate {
  promise: Promise<void>;
  open: () => void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const control = vi.hoisted(() => ({
  keyGate: null as null | { promise: Promise<void> },
  writeGate: null as null | { promise: Promise<void> },
  keyStarted: [] as string[],
  writesStarted: [] as string[],
  writesDone: [] as string[],
}));

vi.mock("../src/services/json-file.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/json-file.js")>();
  return {
    ...real,
    loadOrCreateKey: async (...args: Parameters<typeof real.loadOrCreateKey>) => {
      control.keyStarted.push(String(args[0]));
      await control.keyGate?.promise;
      return real.loadOrCreateKey(...args);
    },
    writeFileAtomic: async (...args: Parameters<typeof real.writeFileAtomic>) => {
      const name = path.basename(String(args[0]));
      control.writesStarted.push(name);
      await control.writeGate?.promise;
      const out = await real.writeFileAtomic(...args);
      control.writesDone.push(name);
      return out;
    },
  };
});

const { NotificationService } = await import("../src/services/notification-service.js");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-notif-close-"));
  control.keyGate = null;
  control.writeGate = null;
  control.keyStarted.length = 0;
  control.writesStarted.length = 0;
  control.writesDone.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const telegram = {} as never;
const service = () => new NotificationService({ dataDir: dir, telegram, log: () => undefined });
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe("close() com carga e gravação lentas", () => {
  it("mudança pedida enquanto o serviço ainda carrega + close logo depois: close só resolve depois da gravação, e ela foi feita", async () => {
    const load = gate();
    const write = gate();
    control.keyGate = load;
    control.writeGate = write;
    const s = service();

    const change = s.setKinds({ deploy: false } as never, "admin");
    await tick(); // a carga começou e está parada no portão
    expect(control.keyStarted).toHaveLength(1);

    let closed = false;
    const closing = s.close().then(() => {
      closed = true;
    });

    load.open();
    // a carga terminou e a gravação da mudança começou (parada no portão)
    for (let i = 0; i < 200 && !control.writesStarted.includes("notifications.json"); i++) await tick(5);
    expect(control.writesStarted).toContain("notifications.json");
    await tick(40);
    // (2) uma volta só no laço deixaria close() resolver aqui, com a gravação ainda em andamento
    expect(closed).toBe(false);

    write.open();
    await closing;
    await change;
    // quando close() resolve, não resta gravação nenhuma
    expect(control.writesDone.length).toBe(control.writesStarted.length);
    const gravados = control.writesDone.length;
    await tick(50);
    expect(control.writesStarted.length).toBe(gravados);

    // (3) a mudança respondeu com sucesso E foi persistida (nada perdido em silêncio)
    const stored = JSON.parse(await readFile(path.join(dir, "notifications.json"), "utf8")) as { kinds: Record<string, boolean> };
    expect(stored.kinds.deploy).toBe(false);
    expect(await readdir(dir)).toContain("notifications-key");
  });

  it("gravação já pendente quando close() é chamado é persistida (não é descartada por 'fechado')", async () => {
    const s = service();
    await s.setKinds({ deploy: true } as never, "admin"); // carrega e grava o estado inicial
    const write = gate();
    control.writeGate = write;
    control.writesStarted.length = 0;
    const change = s.setKinds({ deploy: false } as never, "admin");
    for (let i = 0; i < 200 && control.writesStarted.length === 0; i++) await tick(5);
    const closing = s.close();
    await tick(30);
    write.open();
    await closing;
    await change;
    const stored = JSON.parse(await readFile(path.join(dir, "notifications.json"), "utf8")) as { kinds: Record<string, boolean> };
    expect(stored.kinds.deploy).toBe(false);
  });

  it("depois de fechado, nada novo é gravado", async () => {
    const s = service();
    await s.setKinds({ deploy: true } as never, "admin");
    await s.close();
    control.writesStarted.length = 0;
    await s.setKinds({ deploy: false } as never, "admin");
    await s.flush();
    expect(control.writesStarted).toEqual([]);
    const stored = JSON.parse(await readFile(path.join(dir, "notifications.json"), "utf8")) as { kinds: Record<string, boolean> };
    expect(stored.kinds.deploy).toBe(true);
  });
});

describe("close() para o relógio do serviço", () => {
  it("nenhum disparo periódico depois de close()", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = service();
    const tickSpy = vi.spyOn(s, "tick").mockResolvedValue(undefined);
    s.start(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const antes = tickSpy.mock.calls.length;
    await s.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickSpy.mock.calls.length).toBe(antes);
    expect(vi.getTimerCount()).toBe(0);
  });
});
