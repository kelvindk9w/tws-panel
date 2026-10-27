/**
 * mail-test-client.ts — a API do Mailpit traduzida para o formato do painel, com fetch em dublê.
 */
import { describe, expect, it, vi } from "vitest";
import { MAILTEST_PART_MAX_BYTES, MailpitClient, extractLinks } from "../src/services/mail-test-client.js";

type Reply = { status?: number; json?: unknown; text?: string; bytes?: Buffer; headers?: Record<string, string> };

function clientWith(handler: (url: string, init: RequestInit) => Reply | Promise<Reply> | Error) {
  const calls: Array<{ url: string; method: string; body: string | undefined; auth: string | undefined }> = [];
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const r = await handler(url, init ?? {});
    if (r instanceof Error) throw r;
    const body = r.bytes ?? (r.text !== undefined ? r.text : r.json !== undefined ? JSON.stringify(r.json) : "");
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return { client: new MailpitClient({ baseUrl: "http://10.0.0.5:8025", user: "panel", password: "segredo", fetch: fetchFake }), calls };
}

const RAW_MESSAGE = {
  ID: "abc123",
  Subject: "Redefinir senha",
  From: { Name: "App", Address: "app@example.com" },
  To: [{ Name: "", Address: "cliente@example.com" }],
  Cc: [{ Name: "Copia", Address: "copia@example.com" }],
  Bcc: [],
  ReplyTo: [{ Name: "", Address: "suporte@example.com" }],
  Date: "2026-10-27T10:00:00Z",
  Text: "Acesse https://app.example.com/reset?t=1&x=2 para redefinir.",
  HTML: '<p><a href="https://app.example.com/reset?t=1&amp;x=2">Redefinir</a><img src="cid:logo"></p>',
  Size: 2048,
  Inline: [{ PartID: "2", FileName: "logo.png", ContentType: "image/png", ContentID: "logo", Size: 10 }],
  Attachments: [{ PartID: "3", FileName: "fatura.pdf", ContentType: "application/pdf", Size: 500 }, "lixo"],
};

describe("MailpitClient", () => {
  it("lista as mensagens no formato do painel e autentica com Basic", async () => {
    const { client, calls } = clientWith(() => ({
      json: {
        total: 7,
        unread: 2,
        start: 10,
        messages: [
          { ID: "m1", Subject: "Oi", Read: true, From: { Name: "A", Address: "a@example.com" }, To: [{ Address: "b@example.com" }], Created: "2026-10-27T10:00:00Z", Size: 99, Attachments: 1, Snippet: "texto" },
          "ignorado",
        ],
      },
    }));
    const list = await client.list(10, 20);
    expect(list).toEqual({
      total: 7,
      unread: 2,
      start: 10,
      messages: [
        { id: "m1", subject: "Oi", from: { name: "A", address: "a@example.com" }, to: [{ name: "", address: "b@example.com" }], created: "2026-10-27T10:00:00Z", read: true, size: 99, attachments: 1, snippet: "texto" },
      ],
    });
    expect(calls[0]!.url).toBe("http://10.0.0.5:8025/api/v1/messages?start=10&limit=20");
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("panel:segredo").toString("base64")}`);
  });

  it("aceita as chaves antigas da contagem e resposta vazia/estranha", async () => {
    expect((await clientWith(() => ({ json: { messages_count: 3, messages_unread: 1 } })).client.list(0, 1)).total).toBe(3);
    expect(await clientWith(() => ({ json: [] })).client.list(0, 1)).toEqual({ total: 0, unread: 0, start: 0, messages: [] });
    expect(await clientWith(() => ({ json: { total: 4, unread: 1 } })).client.counts()).toEqual({ total: 4, unread: 1 });
    expect((await clientWith(() => ({ text: "" })).client.list(0, 1)).total).toBe(0);
  });

  it("abre uma mensagem: texto, cabeçalhos, anexos, links e imagens embutidas (sem o HTML na lista)", async () => {
    const { client } = clientWith((url) =>
      url.endsWith("/headers") ? { json: { Received: ["from a", "from b"], Subject: ["Redefinir senha"], Estranho: [1] } } : { json: RAW_MESSAGE },
    );
    const { message, html, inline } = await client.message("abc123");
    expect(message.id).toBe("abc123");
    expect(message.subject).toBe("Redefinir senha");
    expect(message.created).toBe("2026-10-27T10:00:00Z");
    expect(message.read).toBe(true);
    expect(message.cc).toEqual([{ name: "Copia", address: "copia@example.com" }]);
    expect(message.replyTo[0]!.address).toBe("suporte@example.com");
    expect(message.hasHtml).toBe(true);
    expect(message.attachments).toBe(1);
    expect(message.attachmentList).toEqual([
      { partId: "3", fileName: "fatura.pdf", contentType: "application/pdf", size: 500, inline: false },
      { partId: "2", fileName: "logo.png", contentType: "image/png", size: 10, inline: true },
    ]);
    expect(message.headers).toEqual([
      { name: "Received", value: "from a" },
      { name: "Received", value: "from b" },
      { name: "Subject", value: "Redefinir senha" },
    ]);
    expect(message.links).toEqual(["https://app.example.com/reset?t=1&x=2"]);
    expect(html).toContain("cid:logo");
    expect(inline).toEqual([{ partId: "2", contentId: "logo" }]);
  });

  it("cabeçalhos que falham não impedem abrir a mensagem; mensagem só de texto", async () => {
    const { client } = clientWith((url) => (url.endsWith("/headers") ? { status: 500 } : { json: { ID: "x", Text: "oi", Subject: "S" } }));
    const { message, html } = await client.message("x");
    expect(message.headers).toEqual([]);
    expect(message.hasHtml).toBe(false);
    expect(html).toBe("");
    expect(message.from).toBeNull();
  });

  it("resposta sem objeto na mensagem usa o id pedido", async () => {
    const { client } = clientWith(() => ({ json: [] }));
    expect((await client.message("pedido")).message.id).toBe("pedido");
  });

  it("baixa uma parte e respeita o teto de tamanho", async () => {
    const { client, calls } = clientWith(() => ({ bytes: Buffer.from("PDF"), headers: { "content-type": "application/pdf" } }));
    const part = await client.part("a b", "1.2");
    expect(part.body.toString()).toBe("PDF");
    expect(part.contentType).toBe("application/pdf");
    expect(calls[0]!.url).toContain("/message/a%20b/part/1.2");
    expect((await clientWith(() => ({ bytes: Buffer.from("x") })).client.part("a", "1")).contentType).toBe("application/octet-stream");
    await expect(clientWith(() => ({ bytes: Buffer.from("x"), headers: { "content-length": String(MAILTEST_PART_MAX_BYTES + 1) } })).client.part("a", "1")).rejects.toMatchObject({ code: "mail_test_too_large" });
  });

  it("apaga uma, várias ou todas", async () => {
    const { client, calls } = clientWith(() => ({ json: "OK" }));
    await client.remove(["m1"]);
    await client.remove();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "http://10.0.0.5:8025/api/v1/messages", body: JSON.stringify({ IDs: ["m1"] }) });
    expect(calls[1]).toMatchObject({ method: "DELETE", body: undefined });
  });

  it("erros viram mensagens em português com o código certo", async () => {
    await expect(clientWith(() => new Error("ECONNREFUSED")).client.list(0, 1)).rejects.toMatchObject({ statusCode: 502, code: "mail_test_unreachable" });
    await expect(clientWith(() => ({ status: 404 })).client.message("x")).rejects.toMatchObject({ statusCode: 404, code: "mail_test_message_not_found" });
    await expect(clientWith(() => ({ status: 500 })).client.list(0, 1)).rejects.toMatchObject({ statusCode: 502, code: "mail_test_error" });
    await expect(clientWith(() => ({ text: "<html>não é json" })).client.list(0, 1)).rejects.toMatchObject({ code: "mail_test_error" });
    await expect(clientWith(() => ({ json: {}, headers: { "content-length": String(20 * 1024 * 1024) } })).client.list(0, 1)).rejects.toMatchObject({ code: "mail_test_too_large" });
    await expect(clientWith(() => ({ text: "x".repeat(16 * 1024 * 1024) })).client.list(0, 1)).rejects.toMatchObject({ code: "mail_test_too_large" });
    await expect(clientWith(() => ({ bytes: Buffer.alloc(MAILTEST_PART_MAX_BYTES + 1) })).client.part("a", "1")).rejects.toMatchObject({ code: "mail_test_too_large" });
  });

  it("resposta em pedaços (sem content-length) é cortada ao passar do teto, sem ler o resto", async () => {
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFake = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const client = new MailpitClient({ baseUrl: "http://10.0.0.5:8025", user: "panel", password: "x", fetch: fetchFake });
    await expect(client.list(0, 1)).rejects.toMatchObject({ code: "mail_test_too_large" });
    expect(cancelled).toBe(true);
    // parou perto do teto (15 MB), não leu "tudo": o fluxo era infinito
    expect(produced).toBeLessThan(40);
  });

  it("resposta sem corpo vale como parte vazia", async () => {
    const fetchFake = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const client = new MailpitClient({ baseUrl: "http://10.0.0.5:8025", user: "panel", password: "x", fetch: fetchFake });
    expect((await client.part("a", "1")).body.length).toBe(0);
  });

  it("usa o fetch global quando nenhum é passado", () => {
    expect(() => new MailpitClient({ baseUrl: "http://10.0.0.5:8025", user: "u", password: "p", timeoutMs: 100 })).not.toThrow();
  });
});

describe("extractLinks", () => {
  it("junta href e endereços do texto, sem repetir nem pontuação final, só http(s)", () => {
    const links = extractLinks(
      "Veja https://a.example.com/x. e (https://b.example.com/y) ou https://a.example.com/x",
      `<a href="https://a.example.com/x">1</a><a href='mailto:x@example.com'>2</a><a href="javascript:alert(1)">3</a><a href="http://c.example.com/z?a=1&amp;b=2">4</a><a href="">5</a>`,
    );
    expect(links).toEqual(["https://a.example.com/x", "http://c.example.com/z?a=1&b=2", "https://b.example.com/y"]);
  });

  it("limita a 50 endereços e ignora os longos demais", () => {
    const many = Array.from({ length: 80 }, (_, i) => `https://e.example.com/${i}`).join(" ");
    expect(extractLinks(many, "")).toHaveLength(50);
    expect(extractLinks(`https://e.example.com/${"a".repeat(2100)}`, "")).toEqual([]);
  });
});
