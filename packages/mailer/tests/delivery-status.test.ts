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

  const USER = "postmaster@envio.exemplo.com.br";
  const SECRET = "tws-teste-0123456789abcdef-aaaaaaaaaaaaaaaaaaaaaaaa";
  const OK_TEXT = `<${TO}> (delivered to 'mx' with code 250 (2.0.0) 'OK')`;
  const BOUNCE_TEXT = `<${TO}> (host 'mx' rejected command 'RCPT TO' with code 550 (5.1.1) 'No such user')`;
  const dsnOf = (envId: string) => `Reporting-MTA: dns;mail.envio.exemplo.com.br\r\nOriginal-Envelope-Id: ${envId}\r\n\r\n`;
  const opts = { baseUrl: "http://paas-stalwart:8080", username: USER, password: "senha", to: TO, envId: SECRET, since: new Date() };

  interface Mail {
    subject: string;
    text: string;
    /** Remetente do JMAP (padrão: o MAILER-DAEMON do domínio do painel). */
    from?: string | null;
    /** Corpo da parte message/delivery-status. */
    dsn?: string;
    /** Cabeçalhos originais (message/rfc822). */
    headers?: string;
  }

  /**
   * JMAP de mentira no formato do aviso do Stalwart (dsn.rs v0.11.8): o texto
   * por destinatário em textBody; o message/delivery-status (`dsn`) e o
   * message/rfc822 só com cabeçalhos (`headers`) em attachments, baixados
   * pelo download do JMAP.
   */
  function stubJmap(
    emails: Mail[],
    calls: Array<{ url: string; body?: unknown; auth?: string | null }> = [],
    session: Record<string, unknown> = {
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
      downloadUrl: "http://mail.envio.exemplo.com.br:8080/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
    },
  ) {
    const blobs = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") });
        if (url.endsWith("/.well-known/jmap")) return Response.json(session);
        const download = /\/jmap\/download\/[^/]+\/([^/]+)\//.exec(url);
        if (download) {
          const blob = blobs.get(decodeURIComponent(download[1]!));
          return blob === undefined ? new Response("", { status: 404 }) : new Response(blob);
        }
        return Response.json({
          methodResponses: [
            ["Email/query", { ids: emails.map((_, i) => `e${i}`) }, "q"],
            [
              "Email/get",
              {
                list: emails.map((e, i) => {
                  const attachments: Array<{ partId: string; blobId: string; type: string }> = [];
                  if (e.dsn !== undefined) {
                    blobs.set(`b-dsn-${i}`, e.dsn);
                    attachments.push({ partId: "2", blobId: `b-dsn-${i}`, type: "message/delivery-status" });
                  }
                  if (e.headers !== undefined) {
                    blobs.set(`b-hdr-${i}`, e.headers);
                    attachments.push({ partId: "3", blobId: `b-hdr-${i}`, type: "message/rfc822" });
                  }
                  return {
                    id: `e${i}`,
                    subject: e.subject,
                    from: e.from === null ? null : [{ name: "x", email: e.from ?? "MAILER-DAEMON@envio.exemplo.com.br" }],
                    receivedAt: "2026-10-01T12:00:05Z",
                    textBody: [{ partId: `p${i}` }],
                    bodyValues: { [`p${i}`]: { value: e.text } },
                    attachments,
                  };
                }),
              },
              "g",
            ],
          ],
        });
      }),
    );
  }

  const legit: Mail = { subject: "Successfully delivered message", text: OK_TEXT, dsn: dsnOf(SECRET) };

  it("autentica como a caixa, consulta só o que chegou depois do envio e acha o aviso do servidor", async () => {
    const calls: Array<{ url: string; body?: unknown; auth?: string | null }> = [];
    stubJmap([{ subject: "Relatório DMARC", text: "nada" }, legit], calls);
    const report = await findDeliveryReport({ ...opts, since: new Date("2026-10-01T12:00:00.123Z") });
    expect(report).toMatchObject({ state: "delivered" });
    expect(calls[0]!.url).toBe("http://paas-stalwart:8080/.well-known/jmap");
    expect(calls[1]!.url).toBe("http://paas-stalwart:8080/jmap/");
    const expectedAuth = `Basic ${Buffer.from(`${USER}:senha`).toString("base64")}`;
    expect(calls.every((c) => c.auth === expectedAuth)).toBe(true);
    const body = calls[1]!.body as { methodCalls: Array<[string, Record<string, unknown>, string]> };
    expect(body.methodCalls[0]![1]).toMatchObject({ accountId: "acc1", filter: { after: "2026-10-01T12:00:00Z" } });
    expect(body.methodCalls[1]![1]).toMatchObject({ properties: expect.arrayContaining(["from", "attachments"]) });
    // baixa pelo endereço interno, no caminho que a sessão anuncia
    expect(calls.some((c) => c.url === "http://paas-stalwart:8080/jmap/download/acc1/b-dsn-1/aviso?accept=application%2Foctet-stream")).toBe(true);
  });

  // Achado 19: aviso de OUTRA mensagem ao mesmo destinatário.
  it("o aviso de OUTRA mensagem ao mesmo destinatário não serve; o da própria serve", async () => {
    const outro: Mail = { subject: "Failed to deliver message", text: BOUNCE_TEXT, dsn: dsnOf("tws-teste-aaaa-bbbb") };
    stubJmap([outro]);
    await expect(findDeliveryReport(opts)).resolves.toBeNull();
    stubJmap([outro, legit]);
    await expect(findDeliveryReport(opts)).resolves.toMatchObject({ state: "delivered" });
  });

  // Recibo forjado: um destinatário externo vê o Message-ID e o texto e
  // responde ao postmaster@ com assunto de falha.
  describe("recibo forjado por quem recebeu o teste", () => {
    it("remetente externo, mesmo com o ENVID certo na parte delivery-status: recusado", async () => {
      stubJmap([{ subject: "Failed to deliver message", text: BOUNCE_TEXT, from: "atacante@gmail.com", dsn: dsnOf(SECRET) }]);
      await expect(findDeliveryReport(opts)).resolves.toBeNull();
    });

    it("remetente que só imita o nome (mailer-daemon@dominio-alheio): recusado", async () => {
      stubJmap([{ subject: "Failed to deliver message", text: BOUNCE_TEXT, from: "MAILER-DAEMON@gmail.com", dsn: dsnOf(SECRET) }]);
      await expect(findDeliveryReport(opts)).resolves.toBeNull();
    });

    it("sem remetente no JMAP: recusado", async () => {
      stubJmap([{ subject: "Failed to deliver message", text: BOUNCE_TEXT, from: null, dsn: dsnOf(SECRET) }]);
      await expect(findDeliveryReport(opts)).resolves.toBeNull();
    });

    it("do remetente certo, mas com o ENVID só em texto livre (corpo ou cabeçalho original): recusado", async () => {
      stubJmap([
        { subject: "Failed to deliver message", text: `${BOUNCE_TEXT}\n${SECRET}` },
        { subject: "Failed to deliver message", text: BOUNCE_TEXT, headers: `Message-ID: <${SECRET}@envio.exemplo.com.br>` },
        { subject: "Failed to deliver message", text: BOUNCE_TEXT, dsn: `Reporting-MTA: dns;x\r\nX-Nota: ${SECRET}\r\n` },
        { subject: "Failed to deliver message", text: BOUNCE_TEXT, dsn: `Reporting-MTA: dns;x\r\nOriginal-Envelope-Id: ${SECRET}-extra\r\n` },
      ]);
      await expect(findDeliveryReport(opts)).resolves.toBeNull();
    });

    it("ENVID só no texto que o atacante controla, de remetente externo e com anexo: recusado", async () => {
      stubJmap([{ subject: "Failed to deliver message", text: `${BOUNCE_TEXT} ${SECRET}`, from: "atacante@gmail.com", headers: `Message-ID: <${SECRET}@x>` }]);
      await expect(findDeliveryReport(opts)).resolves.toBeNull();
    });
  });

  it("remetentes do próprio servidor aceitos: MAILER-DAEMON do domínio, do host mail. e o padrão do Stalwart", async () => {
    for (const from of ["MAILER-DAEMON@envio.exemplo.com.br", "mailer-daemon@mail.envio.exemplo.com.br", "MAILER-DAEMON@mail.localhost", "postmaster@envio.exemplo.com.br"]) {
      stubJmap([{ ...legit, from }]);
      await expect(findDeliveryReport(opts)).resolves.toMatchObject({ state: "delivered" });
    }
  });

  // Vários domínios: o aviso vem de report.domain (domínio dono do hostname),
  // que pode não ser o da caixa que envia o teste.
  it("caixa de outro domínio: o aviso de MAILER-DAEMON do domínio do hostname vale se ele foi informado", async () => {
    const alheio = { ...legit, from: "MAILER-DAEMON@a.exemplo.com.br" };
    stubJmap([alheio]);
    await expect(findDeliveryReport(opts)).resolves.toBeNull(); // sem informar, continua recusado
    stubJmap([alheio]);
    await expect(findDeliveryReport({ ...opts, senderDomains: ["a.exemplo.com.br", "envio.exemplo.com.br"] })).resolves.toMatchObject({ state: "delivered" });
    stubJmap([{ ...legit, from: "mailer-daemon@mail.a.exemplo.com.br" }]);
    await expect(findDeliveryReport({ ...opts, senderDomains: ["a.exemplo.com.br"] })).resolves.toMatchObject({ state: "delivered" });
    // domínio informado não abre a porta para outros nem para outros nomes locais
    stubJmap([{ ...alheio, from: "MAILER-DAEMON@gmail.com" }]);
    await expect(findDeliveryReport({ ...opts, senderDomains: ["a.exemplo.com.br"] })).resolves.toBeNull();
    stubJmap([{ ...alheio, from: "atacante@a.exemplo.com.br" }]);
    await expect(findDeliveryReport({ ...opts, senderDomains: ["a.exemplo.com.br"] })).resolves.toBeNull();
  });

  it("bounce legítimo (recusa) é lido do aviso do servidor", async () => {
    stubJmap([{ subject: "Failed to deliver message", text: BOUNCE_TEXT, dsn: dsnOf(SECRET) }]);
    await expect(findDeliveryReport(opts)).resolves.toMatchObject({ state: "bounced" });
  });

  it("sem aviso ainda → null", async () => {
    stubJmap([]);
    await expect(findDeliveryReport(opts)).resolves.toBeNull();
  });

  it("sessão sem downloadUrl usa o caminho padrão do JMAP", async () => {
    const calls: Array<{ url: string }> = [];
    stubJmap([legit], calls, { primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } });
    await expect(findDeliveryReport(opts)).resolves.toMatchObject({ state: "delivered" });
    expect(calls.some((c) => c.url.startsWith("http://paas-stalwart:8080/jmap/download/acc1/"))).toBe(true);
  });

  it("anexo que não é delivery-status (ou sem blobId) não é baixado; download recusado vira erro", async () => {
    const calls: Array<{ url: string }> = [];
    const respond = (attachments: unknown[], download: Response) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          calls.push({ url });
          if (url.endsWith("/.well-known/jmap")) return Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } });
          if (url.includes("/jmap/download/")) return download;
          return Response.json({
            methodResponses: [
              [
                "Email/get",
                {
                  list: [
                    {
                      subject: "Successfully delivered message",
                      from: [{ email: "MAILER-DAEMON@envio.exemplo.com.br" }],
                      textBody: [{ partId: "1" }],
                      bodyValues: { "1": { value: OK_TEXT } },
                      attachments,
                    },
                  ],
                },
                "g",
              ],
            ],
          });
        }),
      );
    respond(
      [{ blobId: "img", type: "image/png" }, { type: "message/delivery-status" }, { blobId: "sem-tipo" }, { blobId: "r", type: "message/rfc822" }],
      new Response("", { status: 403 }),
    );
    await expect(findDeliveryReport(opts)).resolves.toBeNull();
    expect(calls.some((c) => c.url.includes("/jmap/download/"))).toBe(false);
    respond([{ blobId: "b", type: "message/delivery-status" }], new Response("", { status: 403 }));
    await expect(findDeliveryReport(opts)).rejects.toThrow(/403/);
  });

  it("e-mail sem remetente/partes, ou resposta sem Email/get → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/.well-known/jmap")
          ? Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } })
          : Response.json({ methodResponses: [["Email/get", { list: [{ id: "1" }, { id: "2", from: [{}], textBody: [{}], bodyValues: { p: {} } }] }, "g"]] }),
      ),
    );
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
    await expect(findDeliveryReport(opts)).rejects.toThrow(/401/);
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
