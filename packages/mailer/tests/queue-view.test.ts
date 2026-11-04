/**
 * Fila do Stalwart (GET /api/queue/messages?values=1, v0.11.8) vista pela
 * página Envios: o id grande da fila não pode perder precisão (é com ele que
 * "Tentar agora" e "Cancelar" funcionam) e cada destinatário ganha um estado
 * e o motivo da última falha. Formatos copiados de um Stalwart real.
 */
import { describe, expect, it } from "vitest";
import { parseQueueResponse, queueItemFromMessage, isQueueId } from "../src/queue-view.js";

const REAL = `{"data":{"items":[{"id":333028896599011329,"return_path":"app@exemplo.test","domains":[{"name":"destino.test","status":"scheduled","recipients":[{"address":"temp1@destino.test","status":{"temp_fail":"Code: 451, Enhanced code: 4.7.28, Message: Our system has detected an unusual rate of unsolicited mail"}}],"retry_num":2,"next_retry":"2026-10-04T02:25:33Z","next_notify":"2026-10-05T02:22:32Z","expires":"2026-10-09T02:22:32Z"}],"created":"2026-10-04T02:22:32Z","size":191,"blob_hash":"abc"},{"id":333029518685360128,"return_path":"app@exemplo.test","domains":[{"name":"fora.test","status":{"temp_fail":"Connection to 'mx.fora.test' failed: I/O error: Connection refused (os error 111)"},"recipients":[{"address":"alguem@fora.test","status":"scheduled"}],"retry_num":1,"next_retry":"2026-10-04T02:28:29Z","next_notify":"2026-10-05T02:27:29Z","expires":"2026-10-09T02:27:29Z"}],"created":"2026-10-04T02:27:29Z","size":188,"blob_hash":"def"}],"total":2,"status":true}}`;

describe("isQueueId", () => {
  it("só números de até 20 dígitos", () => {
    expect(isQueueId("333028896599011329")).toBe(true);
    expect(isQueueId("12a")).toBe(false);
    expect(isQueueId("")).toBe(false);
    expect(isQueueId("1".repeat(21))).toBe(false);
  });
});

describe("parseQueueResponse", () => {
  it("guarda o id como texto, sem perder dígitos", () => {
    const { items, total } = parseQueueResponse(REAL);
    expect(total).toBe(2);
    expect(items.map((m) => m.id)).toEqual(["333028896599011329", "333029518685360128"]);
    // JSON.parse direto arredondaria: 333028896599011300
    expect(String(JSON.parse(REAL).data.items[0].id)).not.toBe("333028896599011329");
  });

  it("não mexe em números dentro de textos", () => {
    const text = `{"data":{"items":[{"id":5,"return_path":"x\\"id\\":7@a.test","domains":[],"created":"2026-10-04T02:22:32Z","size":1,"blob_hash":""}],"total":1}}`;
    const { items } = parseQueueResponse(text);
    expect(items[0]!.id).toBe("5");
    expect(items[0]!.return_path).toBe('x"id":7@a.test');
  });

  it("resposta sem itens, sem data ou com itens que não são objetos", () => {
    expect(parseQueueResponse(`{"data":{"items":[],"total":0}}`)).toEqual({ items: [], total: 0 });
    expect(parseQueueResponse(`{}`)).toEqual({ items: [], total: 0 });
    expect(parseQueueResponse(`{"data":{"items":[1,null,{"id":2,"domains":[]}]}}`).items).toHaveLength(1);
  });
});

describe("queueItemFromMessage", () => {
  const [temp, down] = parseQueueResponse(REAL).items;

  it("destinatário recusado por enquanto: adiado, com o motivo limpo", () => {
    expect(queueItemFromMessage(temp!)).toEqual({
      id: "333028896599011329",
      from: "app@exemplo.test",
      createdAt: "2026-10-04T02:22:32.000Z",
      size: 191,
      recipients: [
        {
          address: "temp1@destino.test",
          domain: "destino.test",
          state: "deferred",
          detail: "451 4.7.28 Our system has detected an unusual rate of unsolicited mail",
        },
      ],
      attempts: 2,
      nextRetryAt: "2026-10-04T02:25:33.000Z",
      expiresAt: "2026-10-09T02:22:32.000Z",
      lastError: "451 4.7.28 Our system has detected an unusual rate of unsolicited mail",
    });
  });

  it("sem resposta do destinatário: vale a falha do domínio (conexão recusada)", () => {
    const item = queueItemFromMessage(down!);
    expect(item.recipients[0]).toMatchObject({ state: "deferred", detail: expect.stringContaining("Connection refused") });
    expect(item.lastError).toContain("Connection refused");
  });

  it("aguardando, entregue e recusado; próxima tentativa só dos domínios pendentes", () => {
    const item = queueItemFromMessage({
      id: "1",
      return_path: "",
      created: "2026-10-04T02:00:00Z",
      size: 10,
      blob_hash: "",
      domains: [
        {
          name: "um.test",
          status: "scheduled",
          recipients: [{ address: "A@Um.test", status: "scheduled" }],
          retry_num: 0,
          next_retry: "2026-10-04T03:00:00Z",
          next_notify: null,
          expires: "2026-10-09T02:00:00Z",
        },
        {
          name: "dois.test",
          status: { completed: "" },
          recipients: [{ address: "b@dois.test", status: { completed: "Code: 250, Enhanced code: 2.0.0, Message: OK" } }],
          retry_num: 1,
          next_retry: "2026-10-04T02:01:00Z",
          next_notify: null,
          expires: "2026-10-09T02:00:00Z",
        },
        {
          name: "tres.test",
          status: { perm_fail: "Domínio sem MX" },
          recipients: [
            { address: "c@tres.test", status: "scheduled" },
            { address: "d@tres.test", status: { perm_fail: "Code: 550, Enhanced code: 5.1.1, Message: nao existe" } },
          ],
          retry_num: 3,
          next_retry: null,
          next_notify: null,
          expires: "2026-10-09T02:00:00Z",
        },
      ],
    });
    expect(item.recipients.map((r) => [r.address, r.domain, r.state, r.detail])).toEqual([
      ["A@Um.test", "um.test", "waiting", null],
      ["b@dois.test", "dois.test", "delivered", "250 2.0.0 OK"],
      ["c@tres.test", "tres.test", "bounced", "Domínio sem MX"],
      ["d@tres.test", "tres.test", "bounced", "550 5.1.1 nao existe"],
    ]);
    expect(item.attempts).toBe(3);
    expect(item.nextRetryAt).toBe("2026-10-04T03:00:00.000Z");
    expect(item.expiresAt).toBe("2026-10-09T02:00:00.000Z");
    expect(item.lastError).toBe("Domínio sem MX");
  });

  it("datas ausentes ou inválidas", () => {
    const item = queueItemFromMessage({
      id: "2",
      return_path: "x@y.test",
      created: "data ruim",
      size: 1,
      blob_hash: "",
      domains: [
        {
          name: "um.test",
          status: "scheduled",
          recipients: [],
          retry_num: 0,
          next_retry: null,
          next_notify: null,
          expires: "",
        },
      ],
    });
    expect(item).toMatchObject({ createdAt: null, nextRetryAt: null, expiresAt: null, lastError: null, attempts: 0 });
  });

  it("mensagem sem domínios (formato inesperado) não quebra", () => {
    const item = queueItemFromMessage({ id: "3", return_path: "x@y.test", created: "2026-10-04T02:00:00Z", size: 1, blob_hash: "", domains: undefined as never });
    expect(item.recipients).toEqual([]);
  });
});
