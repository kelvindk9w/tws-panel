/**
 * Testes do destino do e-mail de teste (delivery-status.ts): leitura da fila
 * do Stalwart v0.11.8 (formato conferido no código-fonte da tag) e do aviso
 * de entrega (DSN) que ele deixa na caixa postmaster@ pela API JMAP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanSmtpResponse,
  deliveryFromQueue,
  findDeliveryReport,
  interpretDeliveryReport,
  type QueuedMessage,
} from "../src/delivery-status.js";
import { StalwartClient } from "../src/client.js";

const TO = "pessoa@gmail.com";

function queued(domainStatus: QueuedMessage["domains"][number]["status"], rcptStatus: QueuedMessage["domains"][number]["status"], nextRetry = "2026-10-01T12:05:00Z"): QueuedMessage {
  // Formato de GET /api/queue/messages?values=1 (Message/Domain/Recipient
  // de crates/jmap/src/api/management/queue.rs, v0.11.8).
  return {
    id: 123,
    return_path: "postmaster@envio.exemplo.com.br",
    created: "2026-10-01T12:00:00Z",
    size: 1024,
    env_id: "tws-teste-abc",
    blob_hash: "x",
    domains: [
      {
        name: "gmail.com",
        status: domainStatus,
        recipients: [{ address: "Pessoa@gmail.com", status: rcptStatus }],
        retry_num: 1,
        next_retry: nextRetry,
        next_notify: null,
        expires: "2026-10-06T12:00:00Z",
      },
    ],
  };
}

describe("deliveryFromQueue", () => {
  it("scheduled → na fila", () => {
    expect(deliveryFromQueue(queued("scheduled", "scheduled"), TO)).toEqual({ state: "queued", detail: null, nextRetryAt: null });
  });

  it("falha de conexão no domínio (destinatário ainda scheduled) → adiada com o motivo e a próxima tentativa", () => {
    const result = deliveryFromQueue(
      queued({ temp_fail: "Connection to 'gmail-smtp-in.l.google.com' failed: Connection timed out" }, "scheduled"),
      TO,
    );
    expect(result).toEqual({
      state: "deferred",
      detail: "Connection to 'gmail-smtp-in.l.google.com' failed: Connection timed out",
      nextRetryAt: "2026-10-01T12:05:00Z",
    });
  });

  it("recusa temporária do destinatário → adiada com a resposta limpa", () => {
    const result = deliveryFromQueue(
      queued({ temp_fail: "x" }, { temp_fail: "Code: 421, Enhanced code: 4.7.0, Message: Try again later" }),
      TO,
    );
    expect(result.state).toBe("deferred");
    expect(result.detail).toBe("421 4.7.0 Try again later");
  });

  it("recusa definitiva → recusado com o motivo", () => {
    const result = deliveryFromQueue(
      queued("scheduled", { perm_fail: "Code: 550, Enhanced code: 5.7.1, Message: Our system has detected an unusual rate" }),
      TO,
    );
    expect(result).toMatchObject({ state: "bounced", detail: "550 5.7.1 Our system has detected an unusual rate" });
  });

  it("recusa definitiva no domínio (ex.: DNS) com destinatário scheduled → recusado", () => {
    const result = deliveryFromQueue(queued({ perm_fail: "DNS lookup failed: no MX" }, "scheduled"), TO);
    expect(result).toMatchObject({ state: "bounced", detail: "DNS lookup failed: no MX" });
  });

  it("completed (antes de sair da fila) → entregue", () => {
    const result = deliveryFromQueue(queued({ completed: "" }, { completed: "Code: 250, Enhanced code: 2.0.0, Message: OK gsmtp" }), TO);
    expect(result).toMatchObject({ state: "delivered", detail: "250 2.0.0 OK gsmtp" });
  });

  it("destinatário que não está na mensagem → na fila (sem detalhe)", () => {
    expect(deliveryFromQueue(queued("scheduled", "scheduled"), "outra@gmail.com").state).toBe("queued");
  });

  it("domínio concluído sem texto e destinatário sem resposta → entregue sem detalhe", () => {
    expect(deliveryFromQueue(queued({ completed: "" }, "scheduled"), TO)).toEqual({ state: "delivered", detail: null, nextRetryAt: null });
  });
});

describe("cleanSmtpResponse", () => {
  it("transforma o formato do Stalwart em código + texto; outros textos passam como estão", () => {
    expect(cleanSmtpResponse("Code: 550, Enhanced code: 5.1.1, Message: No such user")).toBe("550 5.1.1 No such user");
    expect(cleanSmtpResponse("Code: 550, Enhanced code: 0.0.0, Message: Rejected")).toBe("550 Rejected");
    expect(cleanSmtpResponse("TLS error from 'mx': handshake")).toBe("TLS error from 'mx': handshake");
  });
});

describe("interpretDeliveryReport (texto do aviso de entrega do Stalwart)", () => {
  it("entregue: 'Successfully delivered message'", () => {
    const text =
      "Your message has been successfully delivered to the following recipients:\r\n\r\n" +
      "<Pessoa@gmail.com> (delivered to 'gmail-smtp-in.l.google.com' with code 250 (2.0.0) 'OK  1696160000 gsmtp')\r\n";
    expect(interpretDeliveryReport("Successfully delivered message", text, TO)).toEqual({
      state: "delivered",
      detail: "delivered to 'gmail-smtp-in.l.google.com' with code 250 (2.0.0) 'OK  1696160000 gsmtp'",
    });
  });

  it("recusado: 'Failed to deliver message'", () => {
    const text =
      "Your message could not be delivered to the following recipients:\r\n\r\n" +
      "<pessoa@gmail.com> (host 'gmail-smtp-in.l.google.com' rejected command 'RCPT TO:<pessoa@gmail.com>' with code 550 (5.1.1) 'The email account does not exist')\r\n";
    expect(interpretDeliveryReport("Failed to deliver message", text, TO)).toMatchObject({ state: "bounced" });
    expect(interpretDeliveryReport("Failed to deliver message", text, TO)?.detail).toContain("does not exist");
  });

  it("aviso de atraso → adiada", () => {
    const text = "There was a temporary problem delivering your message to the following recipients:\r\n\r\n<pessoa@gmail.com> (connection to 'mx' failed: timed out)\r\n";
    expect(interpretDeliveryReport("Warning: Delay in message delivery", text, TO)?.state).toBe("deferred");
  });

  it("entrega parcial: a linha do destinatário decide; falhas mistas → recusado", () => {
    expect(interpretDeliveryReport("Partially delivered message", `<${TO}> (delivered to 'mx' with code 250)`, TO)?.state).toBe("delivered");
    expect(interpretDeliveryReport("Partially delivered message", `<${TO}> (host 'mx' rejected transaction)`, TO)?.state).toBe("bounced");
    expect(
      interpretDeliveryReport("Warning: Temporary and permanent failures during message delivery", `<${TO}> (rate limited)`, TO)?.state,
    ).toBe("bounced");
  });

  it("aviso de outro destinatário ou assunto desconhecido → ignora", () => {
    expect(interpretDeliveryReport("Successfully delivered message", "<outra@gmail.com> (delivered to 'x')", TO)).toBeNull();
    expect(interpretDeliveryReport("Olá", `<${TO}> qualquer`, TO)).toBeNull();
  });
});

describe("findDeliveryReport (JMAP na caixa postmaster@)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubJmap(emails: Array<{ subject: string; text: string; receivedAt?: string }>, calls: Array<{ url: string; body?: unknown; auth?: string | null }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") });
        if (url.endsWith("/.well-known/jmap")) {
          return Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } });
        }
        return Response.json({
          methodResponses: [
            ["Email/query", { ids: emails.map((_, i) => `e${i}`) }, "q"],
            [
              "Email/get",
              {
                list: emails.map((e, i) => ({
                  id: `e${i}`,
                  subject: e.subject,
                  receivedAt: e.receivedAt ?? "2026-10-01T12:00:05Z",
                  textBody: [{ partId: `p${i}` }],
                  bodyValues: { [`p${i}`]: { value: e.text } },
                })),
              },
              "g",
            ],
          ],
        });
      }),
    );
  }

  it("autentica como a caixa, consulta só o que chegou depois do envio e acha o aviso do destinatário", async () => {
    const calls: Array<{ url: string; body?: unknown; auth?: string | null }> = [];
    stubJmap(
      [
        { subject: "Relatório DMARC", text: "nada" },
        { subject: "Successfully delivered message", text: `<${TO}> (delivered to 'mx' with code 250 (2.0.0) 'OK')` },
      ],
      calls,
    );
    const report = await findDeliveryReport({
      baseUrl: "http://paas-stalwart:8080",
      username: "postmaster@envio.exemplo.com.br",
      password: "senha",
      to: TO,
      since: new Date("2026-10-01T12:00:00.123Z"),
    });
    expect(report).toMatchObject({ state: "delivered" });
    expect(calls[0]!.url).toBe("http://paas-stalwart:8080/.well-known/jmap");
    expect(calls[1]!.url).toBe("http://paas-stalwart:8080/jmap/");
    const expectedAuth = `Basic ${Buffer.from("postmaster@envio.exemplo.com.br:senha").toString("base64")}`;
    expect(calls.every((c) => c.auth === expectedAuth)).toBe(true);
    const body = calls[1]!.body as { methodCalls: Array<[string, Record<string, unknown>, string]> };
    expect(body.methodCalls[0]![1]).toMatchObject({ accountId: "acc1", filter: { after: "2026-10-01T12:00:00Z" } });
  });

  it("sem aviso ainda → null", async () => {
    stubJmap([], []);
    await expect(
      findDeliveryReport({ baseUrl: "http://x", username: "u", password: "p", to: TO, since: new Date() }),
    ).resolves.toBeNull();
  });

  it("e-mail sem partes de texto, sem assunto, ou resposta sem Email/get → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/.well-known/jmap")
          ? Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } })
          : Response.json({ methodResponses: [["Email/get", { list: [{ id: "1" }, { id: "2", textBody: [{}], bodyValues: {} }] }, "g"]] }),
      ),
    );
    const opts = { baseUrl: "http://x", username: "u", password: "p", to: TO, since: new Date(), timeoutMs: 1000 };
    await expect(findDeliveryReport(opts)).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/.well-known/jmap") ? Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } }) : Response.json({}),
      ),
    );
    await expect(findDeliveryReport(opts)).resolves.toBeNull();
  });

  it("caixa sem conta de e-mail ou consulta recusada → erro", async () => {
    const opts = { baseUrl: "http://x", username: "u", password: "p", to: TO, since: new Date() };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    await expect(findDeliveryReport(opts)).rejects.toThrow(/conta de e-mail/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/.well-known/jmap")
          ? Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } })
          : new Response("", { status: 500 }),
      ),
    );
    await expect(findDeliveryReport(opts)).rejects.toThrow(/500/);
  });

  it("falha na API → erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(
      findDeliveryReport({ baseUrl: "http://x", username: "u", password: "p", to: TO, since: new Date() }),
    ).rejects.toThrow(/401/);
  });
});

describe("StalwartClient.listQueuedMessages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET /api/queue/messages?values=1&text=<destino> e devolve data.items", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return Response.json({ data: { items: [queued("scheduled", "scheduled")], total: 1, status: true } });
      }),
    );
    const client = new StalwartClient("http://paas-stalwart:8080", "admin", "s");
    const items = await client.listQueuedMessages("Pessoa@Gmail.com");
    expect(urls).toEqual(["http://paas-stalwart:8080/api/queue/messages?values=1&text=pessoa%40gmail.com"]);
    expect(items[0]?.env_id).toBe("tws-teste-abc");
  });

  it("fila vazia → lista vazia", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { items: [], total: 0, status: true } })));
    const client = new StalwartClient("http://x", "admin", "s");
    await expect(client.listQueuedMessages("a@b.com")).resolves.toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: null })));
    await expect(client.listQueuedMessages("a@b.com")).resolves.toEqual([]);
  });
});

describe("StalwartClient.setMailboxPassword", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCH /api/principal/<caixa> trocando a senha (campo secrets)", async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({ data: null });
      }),
    );
    const client = new StalwartClient("http://paas-stalwart:8080", "admin", "s");
    await client.setMailboxPassword("vendas@exemplo.com.br", "nova-senha-forte-123");
    expect(calls).toEqual([
      {
        url: "http://paas-stalwart:8080/api/principal/vendas%40exemplo.com.br",
        method: "PATCH",
        body: [{ action: "set", field: "secrets", value: ["nova-senha-forte-123"] }],
      },
    ]);
  });
});

describe("StalwartClient — aliases da caixa (endereço de envio do projeto)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function capture() {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({ data: null });
      }),
    );
    return calls;
  }

  it("adiciona e remove um endereço da caixa (campo emails)", async () => {
    const calls = capture();
    const client = new StalwartClient("http://paas-stalwart:8080", "admin", "s");
    await client.addMailboxAlias("loja@exemplo.com.br", "nao-responda@exemplo.com.br");
    await client.removeMailboxAlias("loja@exemplo.com.br", "nao-responda@exemplo.com.br");
    expect(calls).toEqual([
      {
        url: "http://paas-stalwart:8080/api/principal/loja%40exemplo.com.br",
        method: "PATCH",
        body: [{ action: "addItem", field: "emails", value: "nao-responda@exemplo.com.br" }],
      },
      {
        url: "http://paas-stalwart:8080/api/principal/loja%40exemplo.com.br",
        method: "PATCH",
        body: [{ action: "removeItem", field: "emails", value: "nao-responda@exemplo.com.br" }],
      },
    ]);
  });
});

describe("StalwartClient — endereços de uma caixa (migração do dmarc@)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function answer(data: unknown) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return Response.json({ data });
      }),
    );
    return urls;
  }

  it("lê o campo emails da caixa (lista ou um endereço só), em minúsculas", async () => {
    const client = new StalwartClient("http://paas-stalwart:8080", "admin", "s");
    const urls = answer({ name: "postmaster@exemplo.com.br", emails: ["postmaster@exemplo.com.br", "Abuse@exemplo.com.br"] });
    expect(await client.mailboxEmails("postmaster@exemplo.com.br")).toEqual([
      "postmaster@exemplo.com.br",
      "abuse@exemplo.com.br",
    ]);
    expect(urls).toEqual(["http://paas-stalwart:8080/api/principal/postmaster%40exemplo.com.br"]);

    answer({ emails: "postmaster@exemplo.com.br" });
    expect(await client.mailboxEmails("postmaster@exemplo.com.br")).toEqual(["postmaster@exemplo.com.br"]);

    answer({ name: "x" });
    expect(await client.mailboxEmails("postmaster@exemplo.com.br")).toEqual([]);
    answer(null);
    expect(await client.mailboxEmails("postmaster@exemplo.com.br")).toEqual([]);
  });
});
