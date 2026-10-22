/**
 * Cliente da API do Stalwart: nome de exibição da caixa (campo `description` do principal). O valor
 * sempre viaja dentro de um corpo JSON — nunca em URL, comando ou texto montado à mão.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StalwartClient } from "../src/client.js";

const client = new StalwartClient("http://stalwart.test:8080", "admin", "segredo-de-teste");

function mockOk(body = `{"data":null}`) {
  const fn = vi.fn(async () => new Response(body, { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sent(fn: ReturnType<typeof mockOk>, i = 0) {
  const [url, init] = fn.mock.calls[i] as unknown as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(String(init.body)) as unknown };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StalwartClient.createMailbox com nome de exibição", () => {
  it("grava o nome em description, no JSON, junto do resto", async () => {
    const fn = mockOk();
    await client.createMailbox("contato@example.com", "senha-forte-de-teste", ["alias@example.com"], 'Loja "Ação" 日本\r\nBcc: x@evil.test');
    const call = sent(fn);
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://stalwart.test:8080/api/principal");
    expect(call.body).toMatchObject({
      type: "individual",
      name: "contato@example.com",
      emails: ["contato@example.com", "alias@example.com"],
      roles: ["user"],
      description: 'Loja "Ação" 日本\r\nBcc: x@evil.test',
    });
  });

  it("sem nome (ou vazio) não manda description", async () => {
    const fn = mockOk();
    await client.createMailbox("a@example.com", "senha-forte-de-teste");
    await client.createMailbox("b@example.com", "senha-forte-de-teste", [], "");
    expect(sent(fn, 0).body).not.toHaveProperty("description");
    expect(sent(fn, 1).body).not.toHaveProperty("description");
  });
});

describe("StalwartClient.setMailboxDisplayName", () => {
  it("faz PATCH só do campo description (senha, 2FA, senhas de app e aliases não entram)", async () => {
    const fn = mockOk();
    await client.setMailboxDisplayName("contato@example.com", "Novo Nome");
    expect(sent(fn)).toEqual({
      url: "http://stalwart.test:8080/api/principal/contato%40example.com",
      method: "PATCH",
      body: [{ action: "set", field: "description", value: "Novo Nome" }],
    });
  });

  it("vazio manda texto vazio (remove o nome)", async () => {
    const fn = mockOk();
    await client.setMailboxDisplayName("contato@example.com", "");
    expect(sent(fn).body).toEqual([{ action: "set", field: "description", value: "" }]);
  });

  it("o nome nunca vai para a URL, mesmo com caracteres perigosos", async () => {
    const fn = mockOk();
    await client.setMailboxDisplayName("contato@example.com", "../../admin?x=1&y=2 #");
    expect(sent(fn).url).toBe("http://stalwart.test:8080/api/principal/contato%40example.com");
  });
});

describe("StalwartClient.listPrincipals traz o nome", () => {
  it("devolve description aparada; vazio ou que não é texto fica de fora", async () => {
    mockOk(
      JSON.stringify({
        data: {
          items: [
            { name: "a@example.com", description: "  Loja Exemplo " },
            { name: "b@example.com", description: "   " },
            { name: "c@example.com", description: 42 },
            { name: "d@example.com" },
          ],
        },
      }),
    );
    expect(await client.listPrincipals("individual")).toEqual([
      { name: "a@example.com", emails: [], description: "Loja Exemplo" },
      { name: "b@example.com", emails: [] },
      { name: "c@example.com", emails: [] },
      { name: "d@example.com", emails: [] },
    ]);
  });
});
