/**
 * mx-guard.ts — proteção contra desviar o e-mail que o domínio já recebe.
 *
 * Motivo real (01/10/2026): o dono do produto ia cadastrar o domínio
 * principal da empresa, que recebe e-mail em outro provedor. Seguir o
 * checklist (MX → esta VPS) desviaria todo o e-mail dela. Antes de cadastrar,
 * o painel consulta o MX atual e classifica.
 */
import { describe, expect, it } from "vitest";
import { assessExistingMail, checkExistingMail } from "../src/mx-guard.js";
import type { DnsResolverLike } from "../src/dns-checklist.js";

const OWN = ["mail.exemplo.com.br"];

describe("assessExistingMail", () => {
  it("MX em outro provedor: 'elsewhere', servidores em ordem de prioridade, sem ponto final", () => {
    const r = assessExistingMail(
      "exemplo.com.br",
      [
        { exchange: "ALT1.ASPMX.L.GOOGLE.COM.", priority: 5 },
        { exchange: "aspmx.l.google.com", priority: 1 },
      ],
      OWN,
    );
    expect(r).toEqual({
      status: "elsewhere",
      servers: ["aspmx.l.google.com", "alt1.aspmx.l.google.com"],
      suggestedDomain: "envio.exemplo.com.br",
    });
  });

  it("sem MX, ou MX nulo (RFC 7505 — o domínio declara que não recebe): 'none'", () => {
    expect(assessExistingMail("exemplo.com.br", [], OWN).status).toBe("none");
    expect(assessExistingMail("exemplo.com.br", [{ exchange: ".", priority: 0 }], OWN).status).toBe("none");
    expect(assessExistingMail("exemplo.com.br", [{ exchange: "", priority: 0 }], OWN).status).toBe("none");
  });

  it("MX já aponta para este servidor: 'here' (recadastro, nada a desviar)", () => {
    const r = assessExistingMail("exemplo.com.br", [{ exchange: "mail.exemplo.com.br.", priority: 10 }], OWN);
    expect(r.status).toBe("here");
  });

  it("MX misto (este servidor + outro): conta como 'elsewhere'", () => {
    const r = assessExistingMail(
      "exemplo.com.br",
      [
        { exchange: "mail.exemplo.com.br", priority: 10 },
        { exchange: "mx.outro-provedor.example", priority: 20 },
      ],
      OWN,
    );
    expect(r.status).toBe("elsewhere");
    expect(r.servers).toEqual(["mail.exemplo.com.br", "mx.outro-provedor.example"]);
  });
});

function resolverWith(resolveMx: DnsResolverLike["resolveMx"]): DnsResolverLike {
  const never = () => Promise.reject(new Error("não usado"));
  return { resolve4: never, resolve6: never, resolveTxt: never, reverse: never, resolveMx };
}

describe("checkExistingMail", () => {
  it("consulta o MX no resolver informado", async () => {
    const r = await checkExistingMail(
      "exemplo.com.br",
      OWN,
      resolverWith(async () => [{ exchange: "mx.outro-provedor.example", priority: 10 }]),
    );
    expect(r.status).toBe("elsewhere");
  });

  it("domínio sem registro MX (ENODATA/ENOTFOUND): 'none'", async () => {
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      const r = await checkExistingMail(
        "exemplo.com.br",
        OWN,
        resolverWith(() => Promise.reject(Object.assign(new Error(code), { code }))),
      );
      expect(r.status).toBe("none");
    }
  });

  it("falha na consulta (tempo esgotado, SERVFAIL): 'unknown' — não dá para afirmar que não há e-mail", async () => {
    const r = await checkExistingMail(
      "exemplo.com.br",
      OWN,
      resolverWith(() => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }))),
    );
    expect(r).toEqual({ status: "unknown", servers: [], suggestedDomain: "envio.exemplo.com.br" });
  });
});
