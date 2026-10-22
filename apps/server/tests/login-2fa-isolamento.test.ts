/**
 * login-2fa-isolamento.test.ts — isolamento do limite das rotas com sessão
 * aberta: o IP e a sessão do atacante travam; o dono (outra sessão, outro IP)
 * segue livre. Uma chave fixa para todos, ou só por conta, derruba estes
 * testes; cf-connecting-ip/cf-ray também não podem mudar o IP contado.
 */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import setupRestartRoutes from "../src/routes/setup-restart.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const WRONG = "000000";
const DONO_IP = "203.0.113.150";
const ATACANTE_IP = "203.0.113.151";

let ctx: AuthTestContext;
let app: FastifyInstance;
const nowMs = Date.UTC(2026, 9, 22, 12, 0, 0);

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));

const post = (url: string, cookie: string | null, ip: string, payload: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url,
    headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": ip, ...extra },
    payload,
  });

const loginFrom = (ip: string) => post("/api/auth/login", null, ip, { username: "admin", password: PASSWORD });

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs, trustProxy: true });
  app = ctx.app;
  app.decorate("config", { setupTokenFile: path.join(ctx.dir, "setup-token") } as never);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(setupRestartRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

type Rota = {
  nome: string;
  usa2fa: boolean;
  preparar?: (cookie: string) => Promise<void>;
  errar: (cookie: string, ip: string) => Promise<{ statusCode: number }>;
  acertar: (cookie: string, ip: string, recovery: string) => Promise<{ statusCode: number }>;
};

const rotas: Rota[] = [
  {
    nome: "trocar senha",
    usa2fa: false,
    errar: (c, ip) => post("/api/auth/change-password", c, ip, { currentPassword: "Errada123456", newPassword: "NovaSenha456xyz" }),
    acertar: (c, ip) => post("/api/auth/change-password", c, ip, { currentPassword: PASSWORD, newPassword: "NovaSenha456xyz" }),
  },
  {
    nome: "ativar 2FA",
    usa2fa: false,
    preparar: async (c) => {
      await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie: c } });
    },
    errar: (c, ip) => post("/api/auth/2fa/enable", c, ip, { currentPassword: "Errada123456", code: WRONG }),
    acertar: async (c, ip) => {
      const setup = await post("/api/auth/2fa/setup", c, ip, {});
      const { secret } = setup.json() as { secret: string };
      return post("/api/auth/2fa/enable", c, ip, { currentPassword: PASSWORD, code: codeNow(secret) });
    },
  },
  {
    nome: "desativar 2FA",
    usa2fa: true,
    errar: (c, ip) => post("/api/auth/2fa/disable", c, ip, { currentPassword: "Errada123456", code: WRONG }),
    acertar: (c, ip, recovery) => post("/api/auth/2fa/disable", c, ip, { currentPassword: PASSWORD, code: recovery }),
  },
  {
    nome: "recomeçar o assistente",
    usa2fa: true,
    errar: (c, ip) => post("/api/settings/restart-setup", c, ip, { currentPassword: "Errada123456", confirm: "recomeçar", code: WRONG }),
    acertar: (c, ip, recovery) =>
      post("/api/settings/restart-setup", c, ip, { currentPassword: PASSWORD, confirm: "recomeçar", code: recovery }),
  },
];

/** Sessões abertas ANTES de ligar o 2FA (depois o login pediria código). */
async function cenario(usa2fa: boolean) {
  const dono = sessionCookieOf(await loginFrom(DONO_IP));
  const atacante = sessionCookieOf(await loginFrom(ATACANTE_IP));
  const atacanteMesmoIp = sessionCookieOf(await loginFrom(ATACANTE_IP));
  const atacanteOutroIp = sessionCookieOf(await loginFrom("203.0.113.152"));
  let recovery = "";
  if (usa2fa) {
    const setup = await post("/api/auth/2fa/setup", dono, DONO_IP, {});
    const { secret } = setup.json() as { secret: string };
    const en = await post("/api/auth/2fa/enable", dono, DONO_IP, { currentPassword: PASSWORD, code: codeNow(secret) });
    expect(en.statusCode, en.body).toBe(200);
    recovery = (en.json() as { recoveryCodes: string[] }).recoveryCodes[0]!;
  }
  return { dono, atacante, atacanteMesmoIp, atacanteOutroIp, recovery };
}

describe("isolamento por IP e por sessão nas rotas com sessão aberta", () => {
  for (const rota of rotas) {
    it(`${rota.nome}: 5 erros travam a sessão e o IP do atacante; o dono (outra sessão, outro IP) segue livre`, async () => {
      const c = await cenario(rota.usa2fa);
      if (rota.preparar) {
        await rota.preparar(c.atacante);
        await rota.preparar(c.atacanteMesmoIp);
        await rota.preparar(c.atacanteOutroIp);
      }
      const codigos: number[] = [];
      for (let i = 0; i < 5; i += 1) codigos.push((await rota.errar(c.atacante, ATACANTE_IP)).statusCode);
      expect(codigos.slice(0, 4).every((s) => s !== 429)).toBe(true);
      expect(codigos[4]).toBe(429);
      // a sessão do atacante, de qualquer IP, segue travada
      expect((await rota.errar(c.atacante, "203.0.113.153")).statusCode).toBe(429);
      // o IP do atacante, com outra sessão, segue travado
      expect((await rota.errar(c.atacanteMesmoIp, ATACANTE_IP)).statusCode).toBe(429);
      // sessão nova em IP novo não está travada: o erro dela é um erro comum
      expect((await rota.errar(c.atacanteOutroIp, "203.0.113.154")).statusCode).not.toBe(429);
      // o dono não é afetado
      expect((await rota.acertar(c.dono, DONO_IP, c.recovery)).statusCode).toBe(200);
    });
  }
});

describe("cabeçalhos da Cloudflare nas rotas com sessão aberta", () => {
  const trocar = (cookie: string, ip: string, senha: string, extra: Record<string, string>) =>
    post("/api/auth/change-password", cookie, ip, { currentPassword: senha, newPassword: "NovaSenha456xyz" }, extra);

  it("cf-connecting-ip e cf-ray variando não escapam do limite do IP real (sessões diferentes)", async () => {
    const sessoes: string[] = [];
    for (let i = 0; i < 7; i += 1) sessoes.push(sessionCookieOf(await loginFrom(`203.0.113.${160 + i}`)));
    const codigos: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      codigos.push(
        (await trocar(sessoes[i]!, ATACANTE_IP, "Errada123456", { "cf-connecting-ip": `198.51.100.${i + 1}`, "cf-ray": `ray-${i}` }))
          .statusCode,
      );
    }
    expect(codigos.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codigos.slice(4).every((c) => c === 429)).toBe(true);
  });

  it("o dono, em outro IP, com o MESMO cf-connecting-ip do atacante, não herda o bloqueio", async () => {
    const dono = sessionCookieOf(await loginFrom(DONO_IP));
    const atacante = sessionCookieOf(await loginFrom(ATACANTE_IP));
    const cf = { "cf-connecting-ip": "198.51.100.77", "cf-ray": "mesmo-ray" };
    for (let i = 0; i < 5; i += 1) await trocar(atacante, ATACANTE_IP, "Errada123456", cf);
    expect((await trocar(dono, DONO_IP, PASSWORD, cf)).statusCode).toBe(200);
  });
});
