/**
 * Cliente da API do Stalwart: os três pedidos da fila da página Envios
 * (listar, tentar agora, cancelar), com o fetch simulado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StalwartApiError, StalwartClient } from "../src/client.js";

const client = new StalwartClient("http://stalwart.test:8080", "admin", "segredo-de-teste");

function mockFetch(status: number, body: string) {
  const fn = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StalwartClient — fila", () => {
  it("listQueue pede a fila com valores e limite e preserva o id", async () => {
    const fetchFn = mockFetch(200, `{"data":{"items":[{"id":333028896599011329,"return_path":"a@b.test","domains":[]}],"total":1}}`);
    const { items, total } = await client.listQueue(50);
    expect(items[0]!.id).toBe("333028896599011329");
    expect(total).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://stalwart.test:8080/api/queue/messages?values=1&limit=50");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it("retryQueuedMessage usa PATCH no id", async () => {
    const fetchFn = mockFetch(200, `{"data":true}`);
    await expect(client.retryQueuedMessage("333028896599011329")).resolves.toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://stalwart.test:8080/api/queue/messages/333028896599011329");
    expect(init.method).toBe("PATCH");
  });

  it("cancelQueuedMessage usa DELETE no id; false quando nada foi feito", async () => {
    const fetchFn = mockFetch(200, `{"data":false}`);
    await expect(client.cancelQueuedMessage("12")).resolves.toBe(false);
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
  });

  it("id que não é número é recusado sem chamar o servidor", async () => {
    const fetchFn = mockFetch(200, `{"data":true}`);
    await expect(client.retryQueuedMessage("../principal")).rejects.toBeInstanceOf(StalwartApiError);
    await expect(client.cancelQueuedMessage("1;2")).rejects.toBeInstanceOf(StalwartApiError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("mensagem que já saiu da fila → erro 404 com o texto do Stalwart", async () => {
    mockFetch(404, `{"type":"about:blank","status":404,"title":"Not Found","detail":"The requested resource does not exist on this server."}`);
    await expect(client.cancelQueuedMessage("12")).rejects.toMatchObject({ status: 404, message: expect.stringContaining("does not exist") });
  });

  it("erro sem corpo JSON e servidor fora do ar", async () => {
    mockFetch(500, "falhou");
    await expect(client.retryQueuedMessage("12")).rejects.toMatchObject({ status: 500, message: "Stalwart: HTTP 500" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(client.listQueue()).rejects.toMatchObject({ status: 0 });
  });

  it("resposta de sucesso sem JSON não quebra os outros pedidos", async () => {
    mockFetch(200, "");
    await expect(client.retryQueuedMessage("12")).resolves.toBe(false);
  });
});
