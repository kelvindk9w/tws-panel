/**
 * login-travas-unit.test.ts — peças pequenas das travas do login: agrupamento
 * de IP (/64), máscara do IP nos alertas, vigia do login (limites e falhas),
 * aviso do proxy da Cloudflare e o --so-bloqueio do script de emergência.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipGroupKey, maskIp } from "../src/services/ip-group.js";
import { verifyPasswordTimingSafe, warmUpDummyHash } from "../src/services/password.js";
import { LoginLimiter } from "../src/services/login-limiter.js";
import { LoginWatch } from "../src/services/login-watch.js";
import { EdgeWatch } from "../src/services/edge-watch.js";
import { ActionAttempt, beginAction } from "../src/services/action-guard.js";

// O plugin de segurança instancia o SecurityService por dentro; aqui só a rota do proxy importa.
vi.mock("../src/services/security-service.js", () => ({
  SecurityService: vi.fn().mockImplementation(function () {
    return { restoreJobsFromDisk: vi.fn() };
  }),
}));

describe("ipGroupKey / maskIp", () => {
  it("IPv4 fica como está; IPv4 dentro de IPv6 vira IPv4", () => {
    expect(ipGroupKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipGroupKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("IPv6 agrupa pelo /64, em qualquer grafia", () => {
    const a = ipGroupKey("2001:db8:1:2::1");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(ipGroupKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(a);
    expect(ipGroupKey("2001:db8:1:3::1")).not.toBe(a);
    expect(ipGroupKey("::1")).toBe("0:0:0:0::/64");
    expect(ipGroupKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipGroupKey("2001:db8:1:2:3:4:192.0.2.4")).toBe(a);
  });

  it("IPv4 mapeado em IPv6, em qualquer grafia, vira o IPv4 (e não cai no grupo de ::1)", () => {
    for (const form of ["::ffff:192.0.2.4", "::ffff:c000:204", "0:0:0:0:0:ffff:192.0.2.4", "::ffff:192.0.2.4%eth0", "0:0:0:0:0:FFFF:C000:0204"]) {
      expect(ipGroupKey(form), form).toBe("192.0.2.4");
      expect(maskIp(form), form).toBe("192.0.2.0/24");
    }
    expect(ipGroupKey("::1")).not.toBe("192.0.2.4");
    expect(ipGroupKey("::ffff:c000:204")).not.toBe(ipGroupKey("::1"));
  });

  it("texto que não é IP volta como veio (chaves de conta)", () => {
    expect(ipGroupKey("conta:abc")).toBe("conta:abc");
    expect(ipGroupKey("2001:db8:1:2::/64")).toBe("2001:db8:1:2::/64");
    expect(ipGroupKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });

  it("máscara: /24 no IPv4, /64 no IPv6, nada no resto", () => {
    expect(maskIp("203.0.113.77")).toBe("203.0.113.0/24");
    expect(maskIp("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(maskIp("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(maskIp("lixo")).toBe("origem desconhecida");
  });
});

describe("LoginLimiter com IPv6", () => {
  it("30 endereços do mesmo /64 esgotam 5 tentativas; /64 vizinho segue livre", () => {
    const l = new LoginLimiter();
    let permitidas = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = l.check(`2001:db8:9:9::${(i + 1).toString(16)}`);
      if (r.allowed) permitidas += 1;
    }
    expect(permitidas).toBe(5);
    expect(l.check("2001:db8:9:a::1").allowed).toBe(true);
    expect(l.size()).toBe(2);
  });

  it("IPv4 continua por endereço exato", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i += 1) l.check("192.0.2.1");
    expect(l.check("192.0.2.1").allowed).toBe(false);
    expect(l.check("192.0.2.2").allowed).toBe(true);
  });
});

describe("ActionAttempt", () => {
  const fakeReply = () => ({ header: vi.fn(), code: vi.fn().mockReturnThis(), send: vi.fn() });

  it("success zera; release depois de fail não devolve em dobro", () => {
    const l = new LoginLimiter();
    const reply = fakeReply();
    const who = { ip: "192.0.2.1", sessionId: "s1" };
    const a = beginAction(l, who, reply as never)!;
    a.fail();
    a.release(); // já liquidada: não faz nada
    const b = beginAction(l, who, reply as never)!;
    b.success();
    b.release();
    const c = new ActionAttempt(l, ["x"]);
    c.release();
    c.release();
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("IP bloqueado ou sessão bloqueada: 429 e devolve null, sem prender reserva", () => {
    const l = new LoginLimiter();
    const reply = fakeReply();
    for (let i = 0; i < 5; i += 1) beginAction(l, { ip: "192.0.2.2", sessionId: "s2" }, reply as never)?.fail();
    expect(beginAction(l, { ip: "192.0.2.2", sessionId: "outra" }, reply as never)).toBeNull(); // IP travado
    expect(beginAction(l, { ip: "192.0.2.99", sessionId: "s2" }, reply as never)).toBeNull(); // sessão travada
    expect(reply.code).toHaveBeenCalledWith(429);
    // sessão nova em IP novo passa, e a reserva da checagem anterior não ficou presa
    const livre = beginAction(l, { ip: "192.0.2.99", sessionId: "s3" }, reply as never);
    expect(livre).not.toBeNull();
    livre!.release();
  });

  it("fail devolve o maior tempo entre as duas contagens", () => {
    const l = new LoginLimiter();
    const reply = fakeReply();
    let last = { allowed: true, retryAfterSec: 0 };
    for (let i = 0; i < 5; i += 1) last = beginAction(l, { ip: "192.0.2.3", sessionId: "s4" }, reply as never)!.fail();
    expect(last.allowed).toBe(false);
    expect(last.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("LoginWatch", () => {
  function make(extra: Partial<ConstructorParameters<typeof LoginWatch>[0]> = {}) {
    let t = 1_000_000;
    const alerts = { create: vi.fn(async () => ({})) };
    const audit = { record: vi.fn(async () => ({})) };
    const watch = new LoginWatch({ alerts, audit, now: () => t, log: () => undefined, ...extra });
    return { watch, alerts, audit, advance: (ms: number) => (t += ms) };
  }
  const user = { id: "u1", username: "admin" };

  it("pendência repetida do mesmo IP/64 conta tentativas numa só; expira em um evento", async () => {
    const { watch, alerts, audit, advance } = make();
    watch.passwordAccepted("2001:db8:1:2::1", user);
    watch.passwordAccepted("2001:db8:1:2::2", user);
    expect(watch.pending()).toBe(1);
    advance(6 * 60_000);
    await watch.sweep();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect((audit.record.mock.calls as unknown as Array<[{ detail: string }]>)[0]![0].detail).toMatch(/2 vez/);
    expect(alerts.create).toHaveBeenCalledTimes(1);
  });

  it("teto de pendências: a mais antiga é liberada como evento", async () => {
    const { watch, audit } = make({ maxChallenges: 2 });
    watch.passwordAccepted("192.0.2.1", user);
    watch.passwordAccepted("192.0.2.2", user);
    watch.passwordAccepted("192.0.2.3", user);
    watch.codeRejected("192.0.2.4", user);
    await Promise.resolve();
    expect(watch.pending()).toBe(2);
    expect(audit.record).toHaveBeenCalled();
  });

  it("timer: start/stop idempotentes", () => {
    vi.useFakeTimers();
    try {
      const { watch } = make();
      watch.start();
      watch.start();
      watch.stop();
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweep dispara o timer sem lançar erro", async () => {
    vi.useFakeTimers();
    try {
      const { watch, alerts, advance } = make();
      watch.start();
      watch.passwordAccepted("192.0.2.9", user);
      advance(6 * 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(alerts.create).toHaveBeenCalled();
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falha no alerta ou na auditoria vai para o log e não propaga", async () => {
    const log = vi.fn();
    const { watch } = make({
      alerts: { create: vi.fn(async () => { throw new Error("x"); }) },
      audit: { record: vi.fn(async () => { throw "texto"; }) },
      log,
    });
    await watch.accountLocked("192.0.2.1", user, { retryAfterSec: 30, level: 1 });
    await watch.accountLocked("192.0.2.1", user, { retryAfterSec: 7200, level: 2 });
    expect(log).toHaveBeenCalled();
  });

  it("duração no bloqueio: segundos, minutos e horas", async () => {
    const { watch, alerts } = make();
    await watch.accountLocked("192.0.2.1", user, { retryAfterSec: 30, level: 1 });
    await watch.accountLocked("192.0.2.1", user, { retryAfterSec: 7200, level: 5 });
    const detalhes = alerts.create.mock.calls.map((c: unknown[]) => (c[0] as { detail: string }).detail).join("|");
    expect(detalhes).toMatch(/30 s/);
    expect(detalhes).toMatch(/2 h/);
  });
});

describe("EdgeWatch e GET /api/security/edge", () => {
  it("sem cabeçalho da Cloudflare: inativo; com cf-ray: ativo por 24 h", () => {
    let t = 1_000;
    const w = new EdgeWatch(() => t);
    w.observe({ host: "x" });
    expect(w.status()).toEqual({ cloudflareProxy: false, lastSeenAt: null });
    w.observe({ "cf-ray": "abc" });
    expect(w.status().cloudflareProxy).toBe(true);
    t += 25 * 3600 * 1000;
    expect(w.status().cloudflareProxy).toBe(false);
    w.observe({ "cf-connecting-ip": "203.0.113.1" });
    expect(w.status().cloudflareProxy).toBe(true);
  });

  it("a rota devolve o estado", async () => {
    const { default: securityRoutes } = await import("../src/routes/security.js");
    const app = Fastify();
    const edge = new EdgeWatch();
    app.decorate("edgeWatch", edge);
    app.decorate("config", {} as never);
    app.decorate("auditService", { record: vi.fn() } as never);
    app.decorate("terminalService", {} as never);
    app.addHook("onRequest", async (req) => edge.observe(req.headers));
    await app.register(securityRoutes);
    const antes = await app.inject({ method: "GET", url: "/api/security/edge" });
    expect(antes.json().cloudflareProxy).toBe(false);
    const depois = await app.inject({ method: "GET", url: "/api/security/edge", headers: { "cf-ray": "1-GRU" } });
    expect(depois.json().cloudflareProxy).toBe(true);
    await app.close();
  });
});

describe("scripts/reset-2fa.mjs --so-bloqueio", () => {
  const SCRIPT = path.resolve(__dirname, "../../../scripts/reset-2fa.mjs");
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function prepare() {
    dir = await mkdtemp(path.join(tmpdir(), "paas-reset-lock-"));
    const file = path.join(dir, "users.json");
    const user = {
      id: "u1",
      username: "admin",
      usernameLower: "admin",
      passwordHash: "h",
      twoFactor: {
        iv: "a", tag: "b", data: "c", lastStep: 1, recoveryHashes: ["x"], enabledAt: "z",
        failedCodes: 3, lockLevel: 4, lockedUntil: 9_999_999_999_999,
      },
      createdAt: "z",
      updatedAt: "z",
    };
    await writeFile(file, JSON.stringify({ users: [user] }), { mode: 0o600 });
    return file;
  }

  it("mantém o 2FA ligado e limpa só o bloqueio", async () => {
    const file = await prepare();
    const out = execFileSync("node", [SCRIPT, file, "--so-bloqueio"], { encoding: "utf8" });
    expect(out).toMatch(/Bloqueio .* limpo/);
    const saved = JSON.parse(await readFile(file, "utf8")) as { users: Array<{ twoFactor: Record<string, unknown> }> };
    const tf = saved.users[0]!.twoFactor;
    expect(tf.data).toBe("c");
    expect(tf.recoveryHashes).toEqual(["x"]);
    expect(tf).not.toHaveProperty("lockedUntil");
    expect(tf).not.toHaveProperty("failedCodes");
    expect(tf).not.toHaveProperty("lockLevel");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("sem a opção, desligar o 2FA leva o bloqueio junto", async () => {
    const file = await prepare();
    const out = execFileSync("node", [SCRIPT, file], { encoding: "utf8" });
    expect(out).toMatch(/bloqueio por códigos errados também limpo/);
    expect((JSON.parse(await readFile(file, "utf8")) as { users: Array<{ twoFactor: unknown }> }).users[0]!.twoFactor).toBeNull();
  });

  it("opção desconhecida → uso e código 2", async () => {
    const file = await prepare();
    expect(() => execFileSync("node", [SCRIPT, file, "--outra"], { encoding: "utf8", stdio: "pipe" })).toThrow();
  });
});

describe("hash fictício na inicialização", () => {
  it("warmUpDummyHash prepara o hash e a verificação de usuário inexistente continua falsa", async () => {
    await warmUpDummyHash();
    await warmUpDummyHash();
    expect(await verifyPasswordTimingSafe(null, "qualquer")).toBe(false);
  });
});
