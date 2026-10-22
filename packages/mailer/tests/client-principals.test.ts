/**
 * Cliente da API do Stalwart: lista de principals (domínios e caixas) para o
 * painel adotar o que veio num backup. O Stalwart manda o campo `secrets`
 * (hash/senha) em cada caixa; o cliente nunca o repassa.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StalwartApiError, StalwartClient } from "../src/client.js";

const client = new StalwartClient("http://stalwart.test:8080", "admin", "segredo-de-teste");

function mockPages(...pages: string[]) {
  const fn = vi.fn(async () => new Response(pages.shift() ?? `{"data":{"items":[],"total":0}}`, { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StalwartClient.listPrincipals", () => {
  it("devolve nome e endereços e descarta secrets e o resto", async () => {
    const fetchFn = mockPages(
      JSON.stringify({
        data: {
          total: 2,
          items: [
            {
              id: 7,
              type: "individual",
              name: "Contato@Cassp.Example.com",
              secrets: ["$6$salt$hashhashhash", "app-password-abc"],
              emails: ["contato@cassp.example.com"],
              roles: ["user"],
              quota: 0,
            },
            { id: 8, type: "individual", name: "postmaster@cassp.example.com", emails: "postmaster@cassp.example.com" },
          ],
        },
      }),
    );
    const list = await client.listPrincipals("individual");
    expect(list).toEqual([
      { name: "contato@cassp.example.com", emails: ["contato@cassp.example.com"] },
      { name: "postmaster@cassp.example.com", emails: ["postmaster@cassp.example.com"] },
    ]);
    expect(JSON.stringify(list)).not.toContain("hash");
    expect(JSON.stringify(list)).not.toContain("app-password");
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://stalwart.test:8080/api/principal?type=individual&limit=500&page=1");
  });

  it("aceita itens que são só o nome e ignora o que não é texto", async () => {
    mockPages(`{"data":{"items":["example.com", 5, {"id":1}, {"name":""}],"total":4}}`);
    expect(await client.listPrincipals("domain")).toEqual([{ name: "example.com", emails: [] }]);
  });

  it("pagina até acabar", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ name: `d${i}.example.com` }));
    const fetchFn = mockPages(
      JSON.stringify({ data: { items: full, total: 501 } }),
      JSON.stringify({ data: { items: [{ name: "last.example.com" }], total: 501 } }),
    );
    const list = await client.listPrincipals("domain");
    expect(list).toHaveLength(501);
    expect((fetchFn.mock.calls[1] as unknown as [string])[0]).toContain("page=2");
  });

  it("sem dados devolve lista vazia; 401 vira StalwartApiError 401", async () => {
    mockPages(`{"data":null}`);
    expect(await client.listPrincipals("domain")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"detail":"nope"}`, { status: 401 })));
    await expect(client.listPrincipals("individual")).rejects.toMatchObject({ status: 401 });
    await expect(client.listPrincipals("individual")).rejects.toBeInstanceOf(StalwartApiError);
  });
});

describe("StalwartClient.findDkimPublicKey", () => {
  const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".padEnd(300, "A");
  const respond = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

  it("devolve a chave quando existe", async () => {
    respond(200, JSON.stringify({ data: KEY }));
    expect(await client.findDkimPublicKey("rsa-x.example.com")).toBe(KEY);
  });

  it("404 e resposta sem chave dizem que não existe (null)", async () => {
    respond(404, `{"detail":"not found"}`);
    expect(await client.findDkimPublicKey("rsa-x.example.com")).toBeNull();
    respond(200, `{"error":"notFound"}`);
    expect(await client.findDkimPublicKey("rsa-x.example.com")).toBeNull();
    respond(200, "");
    expect(await client.findDkimPublicKey("rsa-x.example.com")).toBeNull();
  });

  it("401, 500, rede e chave curta sobem como erro (não significam que não existe)", async () => {
    respond(401, `{"detail":"x"}`);
    await expect(client.findDkimPublicKey("rsa-x.example.com")).rejects.toMatchObject({ status: 401 });
    respond(500, `{"detail":"x"}`);
    await expect(client.findDkimPublicKey("rsa-x.example.com")).rejects.toMatchObject({ status: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(client.findDkimPublicKey("rsa-x.example.com")).rejects.toBeInstanceOf(StalwartApiError);
    respond(200, JSON.stringify({ data: "curta" }));
    await expect(client.findDkimPublicKey("rsa-x.example.com")).rejects.toBeInstanceOf(StalwartApiError);
  });
});

describe("StalwartClient.listPrincipalsChecked", () => {
  const page = (n: number) => JSON.stringify({ data: { items: Array.from({ length: n }, (_, i) => ({ name: `u${i}@x.example.com` })) } });
  it("exatamente no teto, com a página seguinte vazia: não está cortada", async () => {
    const pages = [...Array.from({ length: 40 }, () => page(500)), page(0)];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(pages.shift()!, { status: 200 })));
    const r = await client.listPrincipalsChecked("individual");
    expect(r.items).toHaveLength(20_000);
    expect(r.truncated).toBe(false);
  });
  it("página seguinte ao teto ainda com itens: cortada", async () => {
    const pages = [...Array.from({ length: 40 }, () => page(500)), page(1)];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(pages.shift()!, { status: 200 })));
    const r = await client.listPrincipalsChecked("individual");
    expect(r.items).toHaveLength(20_000);
    expect(r.truncated).toBe(true);
  });
});

describe("StalwartClient.mailboxPasswordMatches", () => {
  const reply = (data: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })));

  it("a senha guardada está entre as do servidor: true", async () => {
    reply({ name: "a@x.example.com", secrets: ["outra", "senha-do-painel"] });
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBe(true);
  });

  it("uma senha só, em texto: aceita string no lugar de lista", async () => {
    reply({ secrets: "senha-do-painel" });
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBe(true);
  });

  it("senha em texto diferente: false", async () => {
    reply({ secrets: ["senha-antiga-do-backup"] });
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBe(false);
  });

  it.each([["$6$salt$hash"], ["$argon2id$v=19$m=1,t=1,p=1$x$y"], ["{SHA}abc="], ["$app$nome$hash"]])("só hash (%s): não dá para comparar, null", async (secret) => {
    reply({ secrets: [secret] });
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBeNull();
  });

  it("sem o campo de senhas, lista vazia ou corpo vazio: null", async () => {
    reply({ name: "a@x.example.com" });
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBeNull();
    reply({ secrets: [] });
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBeNull();
    reply(null);
    expect(await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel")).toBeNull();
  });

  it("erro HTTP sobe como StalwartApiError (quem chama decide); a senha não vai à mensagem", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"detail":"nada"}`, { status: 404 })));
    const err = await client.mailboxPasswordMatches("a@x.example.com", "senha-do-painel").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StalwartApiError);
    expect((err as StalwartApiError).status).toBe(404);
    expect((err as Error).message).not.toContain("senha-do-painel");
  });
});
