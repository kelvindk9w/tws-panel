import { describe, expect, it } from "vitest";
import { decodeHeaderWords, parseSendHook, queueIdFromHex } from "../src/send-hook.js";

type H = Array<[string, string]>;

/** Aviso real do Stalwart v0.11.8 (capturado num container), com valores de exemplo. */
function payload(over: { headers?: H; contents?: string; size?: number; login?: unknown; queue?: unknown; to?: unknown; from?: unknown; stage?: unknown } = {}) {
  return {
    context: {
      stage: over.stage ?? "data",
      client: { ip: "10.0.0.3", port: 34444, ptr: null, helo: "[127.0.0.1]", activeConnections: 1 },
      sasl: { login: over.login ?? "App@example.com" },
      tls: { version: "TLSv1.3", cipher: "TLS13_AES_256_GCM_SHA384" },
      server: { name: "Stalwart Mail Server v0.11.8", port: 587, ip: "::" },
      queue: { id: over.queue ?? "4ab14d0b7ef4000" },
      protocol: { version: 1 },
    },
    envelope: {
      from: { address: over.from ?? "app@example.com" },
      to: over.to ?? [{ address: "dest@nonexistent-domain-zzz.example.org" }],
    },
    message: {
      headers: over.headers ?? [
        ["From", " app@example.com\r\n"],
        ["To", " dest@nonexistent-domain-zzz.example.org\r\n"],
        ["Subject", " =?UTF-8?Q?Assunto_de_teste_=C3=A7=C3=A3=C3=B3?=\r\n"],
        ["Message-ID", " <63b4f5c2@example.com>\r\n"],
        ["Content-Type", ' multipart/mixed; boundary="--_Nm-Part_1"\r\n'],
      ],
      contents:
        over.contents ??
        "----_Nm-Part_1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nCorpo da mensagem secreto 123\r\n----_Nm-Part_1\r\nContent-Type: text/plain; name=a.txt\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\neHh4eA==\r\n----_Nm-Part_1--",
      size: over.size ?? 667,
    },
  };
}

const opts = { maxBodyBytes: 1024, withContent: true };

describe("parseSendHook", () => {
  it("aviso real: caixa, id da fila em decimal, envelope, assunto, corpo e anexo (só nome e tamanho)", () => {
    const r = parseSendHook(payload(), opts);
    expect(r).toEqual({
      ok: true,
      value: {
        queueId: "336385483840897024",
        login: "app@example.com",
        from: "app@example.com",
        to: ["dest@nonexistent-domain-zzz.example.org"],
        size: 667,
        messageId: "<63b4f5c2@example.com>",
        subject: "Assunto de teste çãó",
        body: "Corpo da mensagem secreto 123",
        bodyTruncated: false,
        attachments: [{ name: "a.txt", size: 4 }],
      },
    });
  });

  it("sem gravar conteúdo: nem assunto nem corpo saem, anexos (metadado) sim", () => {
    const r = parseSendHook(payload(), { maxBodyBytes: 1024, withContent: false });
    expect(r.ok && r.value.subject).toBeNull();
    expect(r.ok && r.value.body).toBeNull();
    expect(r.ok && r.value.bodyTruncated).toBe(false);
    expect(r.ok && r.value.attachments).toHaveLength(1);
  });

  it.each([
    ["payload", null],
    ["payload", []],
    ["stage", payload({ stage: "mail" })],
    ["login", payload({ login: "" })],
    ["login", payload({ login: 5 })],
    ["login", payload({ login: "x".repeat(400) })],
    ["queue_id", payload({ queue: "zz" })],
    ["queue_id", payload({ queue: 5 })],
    ["envelope", payload({ to: [] })],
    ["envelope", payload({ to: "x" })],
    ["envelope", payload({ to: [{ address: "a b@x.com" }] })],
    ["envelope", payload({ to: Array.from({ length: 501 }, (_, i) => ({ address: `u${i}@x.com` })) })],
    ["envelope", payload({ from: 3 })],
    ["envelope", payload({ from: "" })],
  ])("recusa (%s)", (reason, body) => {
    expect(parseSendHook(body, opts)).toEqual({ ok: false, reason });
  });

  it("recusa mensagem malformada", () => {
    const base = payload();
    expect(parseSendHook({ ...base, message: null }, opts)).toEqual({ ok: false, reason: "message" });
    expect(parseSendHook({ ...base, message: { headers: "x", contents: "" } }, opts)).toEqual({ ok: false, reason: "message" });
    expect(parseSendHook({ ...base, message: { headers: [["a"]], contents: "" } }, opts)).toEqual({ ok: false, reason: "message" });
    expect(parseSendHook({ ...base, message: { headers: [], contents: 5 } }, opts)).toEqual({ ok: false, reason: "message" });
  });

  it("destinatários repetidos contam uma vez; tamanho inválido vira 0; sem Message-ID", () => {
    const r = parseSendHook(payload({ to: [{ address: "A@x.com" }, { address: "a@x.com" }], size: -1, headers: [] , contents: "oi"}), opts);
    expect(r.ok && r.value.to).toEqual(["a@x.com"]);
    expect(r.ok && r.value.size).toBe(0);
    expect(r.ok && r.value.messageId).toBeNull();
    expect(r.ok && r.value.subject).toBeNull();
    expect(r.ok && r.value.body).toBe("oi");
  });

  it("corpo maior que o teto é cortado em fronteira de caractere", () => {
    const r = parseSendHook(payload({ headers: [], contents: "ã".repeat(100) }), { maxBodyBytes: 11, withContent: true });
    expect(r.ok && r.value.body).toBe("ã".repeat(5));
    expect(r.ok && r.value.bodyTruncated).toBe(true);
  });

  it("só HTML: vira texto sem marcação", () => {
    const html = "<html><style>p{}</style><body><p>Olá &amp; bem-vindo</p><br>linha<script>x()</script></body></html>";
    const r = parseSendHook(payload({ headers: [["Content-Type", "text/html; charset=utf-8"]], contents: html }), opts);
    expect(r.ok && r.value.body).toBe("Olá & bem-vindo\n\nlinha".replace("\n\n", "\n\n"));
  });

  it("quoted-printable, base64 e charset latin1", () => {
    const qp = parseSendHook(
      payload({ headers: [["Content-Type", "text/plain; charset=iso-8859-1"], ["Content-Transfer-Encoding", "quoted-printable"]], contents: "a=E7=E3o=\r\n!" }),
      opts,
    );
    expect(qp.ok && qp.value.body).toBe("ação!");
    const b64 = parseSendHook(
      payload({ headers: [["Content-Type", "text/plain"], ["Content-Transfer-Encoding", "base64"]], contents: Buffer.from("olá").toString("base64") }),
      opts,
    );
    expect(b64.ok && b64.value.body).toBe("olá");
    const weird = parseSendHook(
      payload({ headers: [["Content-Type", "text/plain; charset=nao-existe"], ["Content-Transfer-Encoding", "base64"]], contents: Buffer.from("ok").toString("base64") }),
      opts,
    );
    expect(weird.ok && weird.value.body).toBe("ok");
  });

  it("multipart/alternative prefere o texto; anexos grandes não são decodificados, só medidos", () => {
    const big = Buffer.alloc(30000, 1).toString("base64");
    const contents = [
      "--B",
      "Content-Type: multipart/alternative; boundary=C",
      "",
      "--C",
      "Content-Type: text/html",
      "",
      "<p>html</p>",
      "--C",
      "Content-Type: text/plain",
      "",
      "texto",
      "--C--",
      "--B",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="=?UTF-8?B?cmVsYXTDs3Jpby5wZGY=?="',
      "Content-Transfer-Encoding: base64",
      "",
      big,
      "--B",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "",
      "AAAA",
      "--B--",
    ].join("\r\n");
    const r = parseSendHook(payload({ headers: [["Content-Type", 'multipart/mixed; boundary="B"']], contents }), opts);
    expect(r.ok && r.value.body).toBe("texto");
    expect(r.ok && r.value.attachments).toEqual([
      { name: "relatório.pdf", size: 30000 },
      { name: "—", size: 3 },
    ]);
  });

  it("limita anexos listados, profundidade e partes", () => {
    const parts = Array.from({ length: 30 }, (_, i) => `--B\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename=f${i}.csv\r\n\r\nx`).join("\r\n");
    const r = parseSendHook(payload({ headers: [["Content-Type", "multipart/mixed; boundary=B"]], contents: `${parts}\r\n--B--` }), opts);
    expect(r.ok && r.value.attachments).toHaveLength(20);
    let nested = "x";
    for (let i = 0; i < 8; i++) nested = `--B${i}\r\nContent-Type: multipart/mixed; boundary=B${i + 1}\r\n\r\n${nested}\r\n--B${i}--`;
    const deep = parseSendHook(payload({ headers: [["Content-Type", "multipart/mixed; boundary=B0"]], contents: nested }), opts);
    expect(deep.ok && deep.value.body).toBeNull();
    const many = Array.from({ length: 80 }, () => "--B\r\nContent-Type: text/plain\r\n\r\nx").join("\r\n");
    expect(parseSendHook(payload({ headers: [["Content-Type", "multipart/mixed; boundary=B"]], contents: many }), opts).ok).toBe(true);
  });

  it("multipart sem boundary ou texto sem corpo", () => {
    const r = parseSendHook(payload({ headers: [["Content-Type", "multipart/mixed"]], contents: "algo" }), opts);
    expect(r.ok && r.value.attachments).toEqual([{ name: "—", size: 4 }]);
    const none = parseSendHook(payload({ headers: [["Content-Type", "application/octet-stream"]], contents: "" }), opts);
    expect(none.ok && none.value.body).toBeNull();
  });

  it("cabeçalhos dobrados e parte sem linha em branco", () => {
    const contents = "--B\r\nContent-Type: text/plain;\r\n charset=utf-8\r\nX-Sem-Corpo: 1\r\n--B\r\nsem-dois-pontos\r\n\r\ncorpo\r\n--B--";
    const r = parseSendHook(payload({ headers: [["Content-Type", "multipart/mixed; boundary=B"]], contents }), opts);
    expect(r.ok && r.value.body).toBe("corpo");
  });

  it("assunto: controle removido e tamanho limitado; sem assunto = null", () => {
    const r = parseSendHook(payload({ headers: [["Subject", `a\u0007b ${"x".repeat(2000)}`]], contents: "" }), opts);
    expect(r.ok && r.value.subject?.length).toBe(998);
    expect(r.ok && r.value.subject?.startsWith("a b")).toBe(true);
  });
});

describe("queueIdFromHex / decodeHeaderWords", () => {
  it("converte o id da fila", () => {
    expect(queueIdFromHex("4ab14d0b7ef4000")).toBe("336385483840897024");
    expect(queueIdFromHex("")).toBeNull();
    expect(queueIdFromHex("12345678901234567")).toBeNull();
    expect(queueIdFromHex("xyz")).toBeNull();
  });

  it("palavras codificadas vizinhas, B e Q, charset desconhecido", () => {
    expect(decodeHeaderWords("=?UTF-8?B?w6E=?= =?UTF-8?Q?=C3=A9?=")).toBe("áé");
    expect(decodeHeaderWords("=?ISO-8859-1?Q?a=E7=E3o_x?=")).toBe("ação x");
    expect(decodeHeaderWords("=?x-nada?Q?ok?=")).toBe("ok");
    expect(decodeHeaderWords("=?utf-8*pt?Q?z?=")).toBe("z");
    expect(decodeHeaderWords("=?us-ascii?Q?abc?=")).toBe("abc");
    expect(decodeHeaderWords("puro\r\n texto")).toBe("puro texto");
    expect(decodeHeaderWords("=?UTF-8?Q?a=ZZb?=")).toBe("a=ZZb");
  });
});

describe("HTML hostil (CPU em tempo linear)", () => {
  const big = { maxBodyBytes: 512 * 1024, withContent: true };
  const html = (contents: string) => parseSendHook(payload({ headers: [["Content-Type", "text/html; charset=utf-8"]], contents }), big);
  const N = 256 * 1024;
  const cases: Array<[string, string]> = [
    ["só '<' (sem '>')", "<".repeat(N)],
    ["'<' com um '>' no fim", "<".repeat(N) + ">"],
    ["'<script' sem fechar", "<script ".repeat(N / 8)],
    ["script sem fechamento", "<script>" + "x".repeat(N)],
    ["tags abertas sem fim", "<a ".repeat(N / 3)],
    ["espaços e depois texto", " ".repeat(N) + "x"],
    ["espaços antes de quebra de linha", (" ".repeat(1000) + "\n").repeat(N / 1001)],
    ["quebras de linha", "\n".repeat(N)],
    ["entidades", "&amp;&lt;".repeat(N / 9)],
    ["'<' e '</' alternados", "</<".repeat(N / 3)],
  ];

  it.each(cases)("%s: termina rápido e devolve texto", (_name, body) => {
    const t0 = performance.now();
    const r = html(body);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    // antes da correção: 21 s com 256 KiB de '<'
    expect(ms).toBeLessThan(500);
  });

  it("HTML enorme: só o começo é processado (teto menor que o do texto simples)", () => {
    const t0 = performance.now();
    const r = html("<p>início</p>" + "<b>x</b>".repeat(5_000_000));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.ok && r.value.body?.startsWith("início")).toBe(true);
  });

  it("extrai o texto: quebras de bloco, entidades e sem script/style", () => {
    const r = html("<style>p{x:y}</style><h1>Título</h1><p>um &amp; dois</p><div>três<br/>quatro</div><SCRIPT>evil()</SCRIPT><ul><li>a</li><li>b</li></ul>fim <b>negrito</b> &lt;ok&gt; 5 < 6");
    expect(r.ok && r.value.body).toBe("Título\num & dois\ntrês\nquatro\n a\nb\nfim negrito <ok> 5 < 6");
  });

  it("'<' solto sem '>' continua sendo texto", () => {
    const r = html("a < b e c <d");
    expect(r.ok && r.value.body).toBe("a < b e c <d");
  });
});
