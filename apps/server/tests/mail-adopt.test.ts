/**
 * mail-adopt.ts — o que o painel cadastra a partir do que o Stalwart tem
 * (depois de restaurar o backup do e-mail). Regra pura: sem rede, sem disco.
 */
import { describe, expect, it } from "vitest";
import { planAdoption } from "../src/services/mail-adopt.js";

const person = (name: string, emails: string[] = [name]) => ({ name, emails });

describe("planAdoption", () => {
  it("2 domínios e 4 caixas do backup, com a postmaster como caixa do sistema", () => {
    const plan = planAdoption({
      domains: ["cassp.example.com", "envio.example.com"],
      mailboxes: [
        person("contato@envio.example.com"),
        person("contato@cassp.example.com"),
        person("postmaster@envio.example.com", ["postmaster@envio.example.com", "abuse@envio.example.com", "dmarc@envio.example.com"]),
        person("postmaster@cassp.example.com", ["postmaster@cassp.example.com", "abuse@cassp.example.com"]),
      ],
      knownDomains: new Set(),
      knownMailboxes: new Set(),
      projects: [],
    });
    expect(plan.domains).toEqual(["cassp.example.com", "envio.example.com"]);
    expect(plan.mailboxes.map((m) => [m.id, m.kind])).toEqual([
      ["contato@envio.example.com", "user"],
      ["contato@cassp.example.com", "user"],
      ["postmaster@envio.example.com", "system"],
      ["postmaster@cassp.example.com", "system"],
    ]);
    // abuse@ e dmarc@ são endereços da postmaster@, não caixas
    expect(plan.mailboxes.some((m) => m.localPart === "abuse" || m.localPart === "dmarc")).toBe(false);
    expect(plan.skipped).toEqual([]);
  });

  it("o que já está cadastrado não entra de novo (idempotente)", () => {
    const plan = planAdoption({
      domains: ["cassp.example.com", "envio.example.com"],
      mailboxes: [person("contato@envio.example.com"), person("postmaster@envio.example.com"), person("contato@cassp.example.com")],
      knownDomains: new Set(["envio.example.com"]),
      knownMailboxes: new Set(["contato@envio.example.com", "postmaster@envio.example.com"]),
      projects: [],
    });
    expect(plan.domains).toEqual(["cassp.example.com"]);
    expect(plan.mailboxes.map((m) => m.id)).toEqual(["contato@cassp.example.com"]);
  });

  it("caixa de domínio já cadastrado entra mesmo sem o domínio novo", () => {
    const plan = planAdoption({
      domains: ["envio.example.com"],
      mailboxes: [person("vendas@envio.example.com")],
      knownDomains: new Set(["envio.example.com"]),
      knownMailboxes: new Set(),
      projects: [],
    });
    expect(plan.domains).toEqual([]);
    expect(plan.mailboxes.map((m) => m.id)).toEqual(["vendas@envio.example.com"]);
  });

  it("endereço que bate com o slug de um projeto vira caixa dele", () => {
    const plan = planAdoption({
      domains: ["envio.example.com"],
      mailboxes: [person("loja@envio.example.com"), person("outra@envio.example.com")],
      knownDomains: new Set(),
      knownMailboxes: new Set(),
      projects: [{ id: "p1", slug: "loja" }],
      projectDomains: new Map([["p1", "envio.example.com"]]),
    });
    expect(plan.mailboxes[0]).toMatchObject({ id: "loja@envio.example.com", kind: "project", projectId: "p1" });
    expect(plan.mailboxes[1]).toMatchObject({ kind: "user" });
    expect(plan.mailboxes[1]).not.toHaveProperty("projectId");
  });

  it("o slug só vale no domínio do e-mail do projeto (contato@ de outro domínio não é do projeto contato)", () => {
    const plan = planAdoption({
      domains: ["envio.example.com", "cassp.example.com"],
      mailboxes: [person("contato@cassp.example.com"), person("contato@envio.example.com")],
      knownDomains: new Set(),
      knownMailboxes: new Set(),
      projects: [{ id: "p1", slug: "contato" }],
      projectDomains: new Map([["p1", "envio.example.com"]]),
    });
    expect(plan.mailboxes.find((m) => m.domain === "envio.example.com")).toMatchObject({ kind: "project", projectId: "p1" });
    expect(plan.mailboxes.find((m) => m.domain === "cassp.example.com")).toMatchObject({ kind: "user" });
  });

  it("alias de outra caixa e abuse@/dmarc@ próprios vão para os ignorados, não viram caixa comum", () => {
    const plan = planAdoption({
      domains: ["envio.example.com"],
      mailboxes: [
        person("postmaster@envio.example.com", ["postmaster@envio.example.com", "abuse@envio.example.com"]),
        person("abuse@envio.example.com"),
        person("dmarc@envio.example.com"),
      ],
      knownDomains: new Set(),
      knownMailboxes: new Set(),
      projects: [],
    });
    expect(plan.mailboxes.map((m) => m.id)).toEqual(["postmaster@envio.example.com"]);
    expect(plan.skipped).toEqual(["abuse@envio.example.com", "dmarc@envio.example.com"]);
  });

  it("ignora e lista o que não dá para cadastrar: nome sem @, domínio que o Stalwart não tem, parte local inválida, duplicado", () => {
    const plan = planAdoption({
      domains: ["envio.example.com", "not a domain"],
      mailboxes: [
        person("joao"),
        person("a@b@envio.example.com"),
        person("x@semdominio.example.org"),
        person("Bad Name@envio.example.com"),
        person("ok@envio.example.com"),
        person("ok@envio.example.com"),
      ],
      knownDomains: new Set(),
      knownMailboxes: new Set(),
      projects: [],
    });
    expect(plan.domains).toEqual(["envio.example.com"]);
    expect(plan.mailboxes.map((m) => m.id)).toEqual(["ok@envio.example.com"]);
    expect(plan.skipped).toEqual([
      "not a domain",
      "joao",
      "a@b@envio.example.com",
      "x@semdominio.example.org",
      "bad name@envio.example.com",
    ]);
  });

  it("principal avulso com o nome de um endereço que é alias de outra caixa não vira caixa", () => {
    const plan = planAdoption({
      domains: ["envio.example.com"],
      mailboxes: [
        person("postmaster@envio.example.com", ["postmaster@envio.example.com", "abuse@envio.example.com"]),
        person("abuse@envio.example.com"),
      ],
      knownDomains: new Set(),
      knownMailboxes: new Set(),
      projects: [],
    });
    expect(plan.mailboxes.map((m) => m.id)).toEqual(["postmaster@envio.example.com"]);
  });
});
