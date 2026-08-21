/**
 * routes-terminal.test.ts — WebSocket do terminal web (/api/terminal/ws):
 *  - auth: sem setup token → 401 no handshake; com token → conecta;
 *  - relay puro: input do usuário chega ao PTY e NUNCA à auditoria/logs;
 *  - frame de controle {"type":"resize"} redimensiona o PTY;
 *  - sessão única: novo cliente derruba o anterior (close 4000);
 *  - integração: saída produzida no alvo aparece no stream do cliente.
 */
import { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import terminalRoutes, { WS_CLOSE_REPLACED } from "../src/routes/terminal.js";
import { TerminalService } from "../src/services/terminal-service.js";
import type { RemotePty } from "../src/services/docker-socket.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const SETUP_TOKEN = "token-de-teste";

class FakePty implements RemotePty {
  readonly inputs: Buffer[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly stream: Duplex;

  constructor() {
    this.stream = new Duplex({
      write: (chunk, _enc, cb) => {
        this.inputs.push(Buffer.from(chunk));
        cb();
      },
      read: () => undefined,
    });
  }

  emit(data: string): void {
    this.stream.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  async kill(): Promise<void> {
    this.stream.push(null);
  }
}

interface TerminalTestContext extends AuthTestContext {
  baseUrl: string;
  ptys: FakePty[];
}

async function buildTerminalTestApp(): Promise<TerminalTestContext> {
  const ctx = await buildAuthTestApp(SETUP_TOKEN);
  const ptys: FakePty[] = [];
  const terminalService = new TerminalService({
    openPty: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return Promise.resolve(pty);
    },
    audit: (action, detail) => {
      void ctx.auditService.record({ action, detail });
    },
  });
  ctx.app.decorate("terminalService", terminalService);
  await ctx.app.register(terminalRoutes);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address();
  if (address === null || typeof address === "string") throw new Error("sem porta de teste");
  return { ...ctx, baseUrl: `ws://127.0.0.1:${address.port}`, ptys };
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("falha ao conectar o WS")), { once: true });
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev) => resolve(typeof ev.data === "string" ? ev.data : String(ev.data)),
      { once: true },
    );
  });
}

function wsClosed(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (ev) => resolve({ code: ev.code }), { once: true });
  });
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

let ctx: TerminalTestContext | null = null;

afterEach(async () => {
  if (ctx) {
    // a auditoria de disconnect é fire-and-forget: espera ela gravar antes do rm
    await tick();
    await closeAuthTestApp(ctx);
    ctx = null;
  }
});

describe("WS /api/terminal/ws — autenticação", () => {
  it("sem setup token → handshake recusado (401)", async () => {
    ctx = await buildTerminalTestApp();
    const httpBase = ctx.baseUrl.replace("ws://", "http://");
    const noToken = await fetch(`${httpBase}/api/terminal/ws`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`${httpBase}/api/terminal/ws?token=errado`);
    expect(wrongToken.status).toBe(401);
    expect(ctx.ptys).toHaveLength(0); // nenhum PTY aberto sem auth
  });

  it("HTTP sem upgrade também responde 401 sem token", async () => {
    ctx = await buildTerminalTestApp();
    const res = await fetch(`${ctx.baseUrl.replace("ws://", "http://")}/api/terminal/ws`);
    expect(res.status).toBe(401);
  });
});

describe("WS /api/terminal/ws — relay puro e REGRA DE OURO", () => {
  it("input vai ao PTY; saída volta ao cliente; 'senha-secreta' NUNCA na auditoria", async () => {
    ctx = await buildTerminalTestApp();
    const ws = await connectWs(`${ctx.baseUrl}/api/terminal/ws?token=${SETUP_TOKEN}`);
    const pty = ctx.ptys[0];
    expect(pty).toBeDefined();

    // saída do alvo → cliente (espelho ao vivo)
    const echoed = nextMessage(ws);
    pty!.emit("root@vps:~$ ");
    expect(await echoed).toContain("root@vps:~$ ");

    // input do usuário → PTY (relay puro)
    ws.send("senha-secreta\n");
    await tick();
    expect(Buffer.concat(pty!.inputs).toString("utf8")).toContain("senha-secreta");

    ws.close();
    await tick();

    // prova: a auditoria tem connect/disconnect, mas NUNCA o que foi digitado
    const auditRaw = await readFile(path.join(ctx.dir, "audit.json"), "utf8");
    expect(auditRaw).toContain("terminal.connect");
    expect(auditRaw).not.toContain("senha-secreta");
  });

  it("frame JSON de resize redimensiona o PTY (e não vira input)", async () => {
    ctx = await buildTerminalTestApp();
    const ws = await connectWs(`${ctx.baseUrl}/api/terminal/ws?token=${SETUP_TOKEN}`);
    ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    await tick();
    const pty = ctx.ptys[0];
    expect(pty?.resizes).toEqual([{ cols: 132, rows: 43 }]);
    expect(Buffer.concat(pty?.inputs ?? []).toString("utf8")).not.toContain("resize");
    ws.close();
  });

  it("sessão única: novo cliente assume e o anterior é desconectado (4000)", async () => {
    ctx = await buildTerminalTestApp();
    const first = await connectWs(`${ctx.baseUrl}/api/terminal/ws?token=${SETUP_TOKEN}`);
    const closed = wsClosed(first);
    const second = await connectWs(`${ctx.baseUrl}/api/terminal/ws?token=${SETUP_TOKEN}`);
    expect((await closed).code).toBe(WS_CLOSE_REPLACED);
    // o PTY é o mesmo (sessão compartilhada, não duplicada)
    expect(ctx.ptys).toHaveLength(1);
    const msg = nextMessage(second);
    ctx.ptys[0]?.emit("ainda vivo\n");
    expect(await msg).toContain("ainda vivo");
    const secondClosed = wsClosed(second);
    second.close();
    await secondClosed;
  });
});
