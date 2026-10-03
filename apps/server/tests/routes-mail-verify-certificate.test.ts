/**
 * "Verificar agora" do domínio de e-mail pede o certificado de mail.<domínio>
 * sozinho.
 *
 * Validação real (02/10/2026): o domínio foi cadastrado antes de existir o
 * registro A de mail.<domínio>; o Caddy falhou e ficou esperando para tentar
 * de novo. A página Certificados mostrou o motivo e "Tentar emitir agora"
 * resolveu. Agora a verificação faz o mesmo pedido quando encontra o registro
 * A apontando para a VPS (respeitando as regras e o limite da página
 * Certificados), sem quebrar quando o pedido é recusado nem quando o serviço
 * de certificados não existe.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SETUP_TOKEN_HEADER, MAIL_DEFAULT_PORTS, type DnsVerifyResponse } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import { httpError } from "../src/services/http-error.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const URL = "/api/mail/domains/exemplo.com.br/verify";

function verifyResponse(aStatus: "found" | "missing" | "mismatch"): DnsVerifyResponse {
  return {
    domain: "exemplo.com.br",
    verifiedAt: "2026-10-02T12:00:00.000Z",
    summary: { ok: aStatus === "found" ? 1 : 0, total: 2 },
    records: [
      {
        id: "a",
        type: "A",
        name: "mail.exemplo.com.br",
        expected: "203.0.113.10",
        purpose: "…",
        status: aStatus,
        found: aStatus === "missing" ? [] : [aStatus === "found" ? "203.0.113.10" : "198.51.100.7"],
        note: null,
      },
    ],
    ptr: { ip: "203.0.113.10", expected: "mail.exemplo.com.br", status: "pending", found: [], ticketText: null },
    suggestion: null,
  };
}

let ctx: AuthTestContext;
let app: FastifyInstance;
let verifySpy: MockInstance;
let retry: ReturnType<typeof vi.fn>;

async function build({ withCertificates = true } = {}): Promise<void> {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", {
    dataDir: ctx.dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig);
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
  } as unknown as FastifyInstance["deployService"]);
  if (withCertificates) {
    app.decorate("certificateService", { retry } as unknown as FastifyInstance["certificateService"]);
  }
  await app.register(mailRoutes);
}

beforeEach(() => {
  retry = vi.fn(async (host: string) => ({ host, message: `Pedimos ao proxy que tente emitir o certificado de ${host} agora.` }));
  verifySpy = vi.spyOn(MailService.prototype, "verifyDomain");
});

afterEach(async () => {
  verifySpy.mockRestore();
  await closeAuthTestApp(ctx);
});

describe("verificar agora → certificado de mail.<domínio>", () => {
  it("registro A certo e certificado ainda não válido: pede a emissão em segundo plano e avisa na resposta", async () => {
    await build();
    verifySpy.mockResolvedValue(verifyResponse("found"));
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(retry).toHaveBeenCalledWith("mail.exemplo.com.br", { background: true });
    expect(res.json().certificateRetry).toEqual({
      host: "mail.exemplo.com.br",
      message: expect.stringContaining("mail.exemplo.com.br"),
    });
  });

  it("registro A ausente ou apontando para outro IP: não pede nada", async () => {
    await build();
    for (const status of ["missing", "mismatch"] as const) {
      verifySpy.mockResolvedValue(verifyResponse(status));
      const res = await app.inject({ method: "POST", url: URL, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().certificateRetry).toBeUndefined();
    }
    expect(retry).not.toHaveBeenCalled();
  });

  it("certificado já válido (409): a verificação segue normal, sem aviso", async () => {
    await build();
    verifySpy.mockResolvedValue(verifyResponse("found"));
    retry.mockRejectedValue(httpError(409, "already_valid", "já válido"));
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().certificateRetry).toBeUndefined();
    expect(res.json().summary).toEqual({ ok: 1, total: 2 });
  });

  it("pedido de há pouco (limite de 1 por minuto): não quebra e continua dizendo que a emissão foi pedida", async () => {
    await build();
    verifySpy.mockResolvedValue(verifyResponse("found"));
    retry.mockRejectedValue(httpError(429, "retry_too_soon", "Tente de novo em 40 s."));
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().certificateRetry).toEqual({ host: "mail.exemplo.com.br", message: expect.any(String) });
  });

  it("outros erros do pedido (proxy fora, nome desconhecido): a verificação segue normal", async () => {
    await build();
    verifySpy.mockResolvedValue(verifyResponse("found"));
    retry.mockRejectedValue(new Error("docker fora do ar"));
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().certificateRetry).toBeUndefined();
  });

  it("sem o serviço de certificados: a verificação funciona e não pede nada", async () => {
    await build({ withCertificates: false });
    verifySpy.mockResolvedValue(verifyResponse("found"));
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().certificateRetry).toBeUndefined();
  });
});
