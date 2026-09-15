/**
 * Rotas diante de falha de gravação em disco (users.json, sessions.json,
 * credentials.json): a resposta ao operador é honesta — nunca 200/201 para o
 * que não foi salvo —, a memória não fica com a alteração que falhou e a
 * auditoria não registra como feito o que não foi feito.
 *
 * A falha é provocada trocando o arquivo de destino por um diretório (a
 * escrita falha com EISDIR, inclusive como root).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import projectsRoutes from "../src/routes/projects.js";
import setupRoutes from "../src/routes/setup.js";
import { CredentialVault } from "../src/services/credential-vault.js";
import type { DeployService } from "../src/services/deploy-service.js";
import { UserStore } from "../src/services/user-store.js";
import {
  buildAuthTestApp,
  closeAuthTestApp,
  sessionCookieOf,
  type AuthTestContext,
} from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const NOVA = "NovaSenha456";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

/** Troca o arquivo por um diretório; devolve o conteúdo anterior (se havia). */
async function quebrarGravacao(nome: string): Promise<string | null> {
  const alvo = path.join(ctx.dir, nome);
  const antes = await readFile(alvo, "utf8").catch(() => null);
  await rm(alvo, { force: true });
  await mkdir(alvo);
  return antes;
}

/** Desfaz a quebra, devolvendo ao disco o conteúdo anterior (se havia). */
async function consertarGravacao(nome: string, conteudo: string | null): Promise<void> {
  const alvo = path.join(ctx.dir, nome);
  await rm(alvo, { recursive: true, force: true });
  if (conteudo !== null) await writeFile(alvo, conteudo, { mode: 0o600 });
}

async function acoesAuditadas(): Promise<string[]> {
  await ctx.auditService.flush();
  return (await ctx.auditService.list()).entries.map((e) => e.action);
}

function semDetalheDeDisco(body: string): void {
  expect(body).not.toContain(ctx.dir);
  expect(body).not.toMatch(/EISDIR|ENOENT|EACCES/);
}

describe("auth e setup com falha de gravação", () => {
  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    await app.register(authRoutes);
    await app.register(setupRoutes);
  });

  const createAdmin = () =>
    app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: PASSWORD },
    });

  const login = (password = PASSWORD, remoteAddress = "127.0.0.1") =>
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress,
      payload: { username: "admin", password },
    });

  const me = (cookie: string) =>
    app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

  it("criação do admin que não chega ao disco → 500, nenhum admin, setup aberto e sem auditoria", async () => {
    await quebrarGravacao("users.json");
    const res = await createAdmin();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(res.json().message).toMatch(/não foi possível salvar/i);
    expect(res.json().message).toMatch(/nada foi alterado/i);
    semDetalheDeDisco(res.body);

    expect(await ctx.userStore.hasAdmin()).toBe(false);
    expect((await ctx.setupState.load()).completed).toBe(false);
    expect(await acoesAuditadas()).not.toContain("setup.admin_created");

    // disco de volta: a mesma requisição conclui o setup
    await consertarGravacao("users.json", null);
    expect((await createAdmin()).statusCode).toBe(201);
  });

  it("login cuja sessão não é gravada → 500, sem cookie e sem auditoria de login", async () => {
    await createAdmin();
    await quebrarGravacao("sessions.json");
    const res = await login();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(res.json().message).toMatch(/não foi possível salvar/i);
    expect(res.headers["set-cookie"]).toBeUndefined();
    semDetalheDeDisco(res.body);
    expect(await acoesAuditadas()).not.toContain("auth.login");
  });

  it("logout que não chega ao disco → 500, a sessão continua válida e nada é auditado como logout", async () => {
    await createAdmin();
    const cookie = sessionCookieOf(await login());
    const antes = await quebrarGravacao("sessions.json");

    const res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(res.json().message).toMatch(/continua válida/i);
    // o cookie não é apagado: o navegador segue refletindo o estado real
    expect(res.headers["set-cookie"]).toBeUndefined();
    semDetalheDeDisco(res.body);
    expect((await me(cookie)).statusCode).toBe(200);
    expect(await acoesAuditadas()).not.toContain("auth.logout");

    await consertarGravacao("sessions.json", antes);
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode,
    ).toBe(200);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("troca de senha que não chega ao disco → 500; a senha antiga vale em memória e após recarregar do disco; nenhuma sessão revogada", async () => {
    await createAdmin();
    const cookieA = sessionCookieOf(await login());
    const cookieB = sessionCookieOf(await login(PASSWORD, "10.1.1.1"));
    const usersAntes = await quebrarGravacao("users.json");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: cookieA },
      payload: { currentPassword: PASSWORD, newPassword: NOVA },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(res.json().message).toMatch(/nada foi alterado/i);
    semDetalheDeDisco(res.body);

    // memória: a senha antiga continua entrando, a nova não
    expect((await login()).statusCode).toBe(200);
    expect((await login(NOVA)).statusCode).toBe(401);
    // as outras sessões NÃO foram revogadas (a troca não aconteceu)
    expect((await me(cookieB)).statusCode).toBe(200);
    expect(await acoesAuditadas()).not.toContain("auth.password_changed");

    // "reinício": um store novo a partir do disco também só conhece a antiga
    await consertarGravacao("users.json", usersAntes);
    const reiniciado = new UserStore(ctx.dir);
    const doDisco = await reiniciado.findByUsername("admin");
    expect(doDisco?.passwordHash).toBe((await ctx.userStore.findByUsername("admin"))?.passwordHash);

    // com o disco de volta, a troca funciona
    const deNovo = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: cookieA },
      payload: { currentPassword: PASSWORD, newPassword: NOVA },
    });
    expect(deNovo.statusCode).toBe(200);
    expect((await login(NOVA)).statusCode).toBe(200);
  });

  it("senha gravada mas revogação das outras sessões falha → 500 explícito: senha trocada, outras sessões podem continuar válidas", async () => {
    await createAdmin();
    const cookieA = sessionCookieOf(await login());
    const cookieB = sessionCookieOf(await login(PASSWORD, "10.1.1.1"));
    const hashAntes = (await ctx.userStore.findByUsername("admin"))?.passwordHash;
    const sessoesAntes = await quebrarGravacao("sessions.json");

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: cookieA },
      payload: { currentPassword: PASSWORD, newPassword: NOVA },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("sessions_not_revoked");
    expect(res.json().message).toMatch(/senha foi alterada/i);
    expect(res.json().message).toMatch(/outras sessões/i);
    expect(res.json().message).toMatch(/continuar válidas/i);
    semDetalheDeDisco(res.body);

    // a senha nova já vale (foi gravada); a sessão B não foi dada como revogada
    const hashDepois = (await ctx.userStore.findByUsername("admin"))?.passwordHash;
    expect(hashDepois).not.toBe(hashAntes);
    expect((await new UserStore(ctx.dir).findByUsername("admin"))?.passwordHash).toBe(hashDepois);
    expect((await me(cookieB)).statusCode).toBe(200);

    // a auditoria registra o que aconteceu de fato: troca feita, revogação falhou
    await ctx.auditService.flush();
    const registro = (await ctx.auditService.list()).entries.find(
      (e) => e.action === "auth.password_changed",
    );
    expect(registro?.detail).toMatch(/não foi possível invalidar/i);

    await consertarGravacao("sessions.json", sessoesAntes);
    expect((await login()).statusCode).toBe(401);
    expect((await login(NOVA, "10.3.3.3")).statusCode).toBe(200);
  });
});

describe("credencial de projeto com falha de gravação (cofre real)", () => {
  let cofre: CredentialVault;

  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    cofre = new CredentialVault(ctx.dir);
    // Só as operações de credencial importam aqui; elas vão direto ao cofre
    // real para que a falha de gravação seja a de verdade, não um mock.
    const service = {
      credentialInfo: vi.fn(async (p: { id: string }) => cofre.info(p.id)),
      setCredential: vi.fn(async (id: string, req: { token: string; username?: string }) =>
        cofre.set(id, { username: req.username ?? "", token: req.token }),
      ),
      removeCredential: vi.fn(async (id: string) => cofre.remove(id)),
    };
    app.decorate("deployService", service as unknown as DeployService);
    await app.register(projectsRoutes);
  });

  it("remoção que não chega ao disco → 500, a credencial continua reportada como existente e sem auditoria", async () => {
    await cofre.set("p1", { username: "u", token: "tok-leitura-1234" });
    await quebrarGravacao("credentials.json");

    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/credential",
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(res.json().message).toMatch(/continua cadastrada/i);
    expect(res.json().message).toMatch(/nada foi alterado/i);
    semDetalheDeDisco(res.body);

    expect((await cofre.info("p1")).configured).toBe(true);
    expect(await acoesAuditadas()).not.toContain("project.credential.remove");
  });

  it("definição que não chega ao disco → 500 e a credencial anterior segue valendo", async () => {
    await cofre.set("p1", { username: "u", token: "tok-leitura-1234" });
    await quebrarGravacao("credentials.json");

    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: { token: "tok-novo-9999" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(res.json().message).toMatch(/nada foi alterado/i);
    semDetalheDeDisco(res.body);
    expect(res.body).not.toContain("tok-novo-9999");

    expect((await cofre.info("p1")).hint).toBe("1234");
    expect(await acoesAuditadas()).not.toContain("project.credential.set");
  });
});
