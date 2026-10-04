/**
 * Leitura do registro (stdout) do Stalwart v0.11.8 para o histórico de
 * envios. As linhas abaixo são REAIS: saíram de um Stalwart v0.11.8 em
 * Docker (validação local de 04/10/2026), com um servidor SMTP de mentira
 * do outro lado respondendo 250, 451 e 550, e trocadas só no tamanho.
 */
import { describe, expect, it } from "vitest";
import {
  DeliveryLogReader,
  isDeliveryLogLine,
  logValueText,
  parseStalwartLogLine,
  sanitizeLogText,
} from "../src/delivery-log.js";

const SPAN = (id: string, to: string) =>
  `queueId = ${id}, from = "app@exemplo.test", to = ["${to}"], size = 189, total = 1`;

const L = {
  queued: `2026-10-04T02:22:32Z INFO Queued message submission for delivery (queue.queue-message-authenticated) listenerId = "submissions", localPort = 465, remoteIp = 172.17.0.1, remotePort = 46466, queueId = 333028896586428416, from = "app@exemplo.test", to = ["ok1@destino.test"], size = 189, nextRetry = 2026-10-04T02:22:32Z, nextDsn = 2026-10-05T02:22:32Z, expires = 2026-10-09T02:22:32Z`,
  okStart: `2026-10-04T02:22:32Z INFO Delivery attempt started (delivery.attempt-start) ${SPAN("333028896586428416", "ok1@destino.test")}`,
  okDomain: `2026-10-04T02:22:32Z INFO New delivery attempt for domain (delivery.domain-delivery-start) ${SPAN("333028896586428416", "ok1@destino.test")}, domain = "destino.test", total = 0`,
  okDelivered: `2026-10-04T02:22:32Z INFO Message delivered (delivery.delivered) ${SPAN("333028896586428416", "ok1@destino.test")}, hostname = "host.docker.internal", to = "ok1@destino.test", code = 250, details = "OK 1700000000 abc123 - gsmtp", elapsed = 1ms`,
  okDsn: `2026-10-04T02:22:32Z INFO DSN success notification (delivery.dsn-success) ${SPAN("333028896586428416", "ok1@destino.test")}, to = "ok1@destino.test", hostname = "host.docker.internal", code = 250, details = "OK"`,
  okCompleted: `2026-10-04T02:22:32Z INFO Delivery completed (delivery.completed) ${SPAN("333028896586428416", "ok1@destino.test")}, elapsed = 0ms`,
  okEnd: `2026-10-04T02:22:32Z INFO Delivery attempt ended (delivery.attempt-end) ${SPAN("333028896586428416", "ok1@destino.test")}, elapsed = 112ms`,

  tempStart: `2026-10-04T02:22:32Z INFO Delivery attempt started (delivery.attempt-start) ${SPAN("333028896599011329", "temp1@destino.test")}`,
  tempDomain: `2026-10-04T02:22:32Z INFO New delivery attempt for domain (delivery.domain-delivery-start) ${SPAN("333028896599011329", "temp1@destino.test")}, domain = "destino.test", total = 0`,
  tempRejected: `2026-10-04T02:22:32Z INFO SMTP RCPT TO rejected (delivery.rcpt-to-rejected) ${SPAN("333028896599011329", "temp1@destino.test")}, hostname = "host.docker.internal", to = "temp1@destino.test", code = 451, details = "Our system has detected an unusual rate of unsolicited mail", elapsed = 0ms`,
  tempRescheduled: `2026-10-04T02:22:32Z INFO Message rescheduled for delivery (queue.rescheduled) ${SPAN("333028896599011329", "temp1@destino.test")}, nextRetry = 2026-10-04T02:23:32Z, nextDsn = 2026-10-05T02:22:32Z, expires = 2026-10-09T02:22:32Z`,

  nopeRejected: `2026-10-04T02:22:32Z INFO SMTP RCPT TO rejected (delivery.rcpt-to-rejected) ${SPAN("333028896613691394", "nope1@destino.test")}, hostname = "host.docker.internal", to = "nope1@destino.test", code = 550, details = "The email account that you tried to reach does not exist", elapsed = 0ms`,
  nopeDsn: `2026-10-04T02:22:32Z INFO DSN permanent failure notification (delivery.dsn-perm-fail) ${SPAN("333028896613691394", "nope1@destino.test")}, to = "nope1@destino.test", hostname = "host.docker.internal", code = 550, details = "The email account that you tried to reach does not exist", total = 0`,
  nopeQueueDsn: `2026-10-04T02:22:32Z INFO Queued DSN for delivery (queue.queue-dsn) ${SPAN("333028896613691394", "nope1@destino.test")}, queueId = 333028896877932550, from = <>, to = ["app@exemplo.test"], size = 1627, nextRetry = 2026-10-04T02:22:32Z, nextDsn = 2026-10-09T02:22:42Z, expires = 2026-10-09T02:22:32Z`,

  invalidMx: `2026-10-04T02:22:32Z INFO MX record lookup failed (delivery.mx-lookup-failed) ${SPAN("333028896636760068", "ninguem@nao-existe.invalid")}, domain = "nao-existe.invalid", details = No MX records were found, attempting implicit MX., elapsed = 0ms`,
  invalidDsn: `2026-10-04T02:22:32Z INFO DSN permanent failure notification (delivery.dsn-perm-fail) ${SPAN("333028896636760068", "ninguem@nao-existe.invalid")}, to = "ninguem@nao-existe.invalid", details = SMTP error occurred (smtp.error) { details = Connection Error, reason = "record not found for MX" }, total = 0`,

  downStart: `2026-10-04T02:27:29Z INFO Delivery attempt started (delivery.attempt-start) ${SPAN("333029518685360128", "alguem@fora.test")}`,
  downDomain: `2026-10-04T02:27:29Z INFO New delivery attempt for domain (delivery.domain-delivery-start) ${SPAN("333029518685360128", "alguem@fora.test")}, domain = "fora.test", total = 0`,
  downConnect: `2026-10-04T02:27:29Z INFO Connection error (delivery.connect-error) ${SPAN("333029518685360128", "alguem@fora.test")}, domain = "fora.test", hostname = "host.docker.internal", localIp = (null), remoteIp = 192.168.65.254, remotePort = 2599, causedBy = SMTP error occurred (smtp.error) { details = I/O Error, reason = "Connection refused (os error 111)" }, elapsed = 3ms`,
  downRescheduled: `2026-10-04T02:27:29Z INFO Message rescheduled for delivery (queue.rescheduled) ${SPAN("333029518685360128", "alguem@fora.test")}, nextRetry = 2026-10-04T02:28:29Z, nextDsn = 2026-10-05T02:27:29Z, expires = 2026-10-09T02:27:29Z`,

  /** Aviso de entrega do próprio servidor (remetente vazio): não entra no histórico. */
  dsnOfDsn: `2026-10-04T02:22:32Z INFO DSN success notification (delivery.dsn-success) queueId = 333028896877932550, from = <>, to = ["app@exemplo.test"], size = 1627, total = 1, to = "app@exemplo.test", hostname = "localhost", code = 250, details = "OK"`,
};

function feed(lines: string[]) {
  const reader = new DeliveryLogReader();
  return lines.flatMap((l) => reader.push(l));
}

describe("parseStalwartLogLine", () => {
  it("lê hora, nível, evento e campos (texto, número, lista, valor sem aspas)", () => {
    const line = parseStalwartLogLine(L.queued)!;
    expect(line.at).toBe("2026-10-04T02:22:32.000Z");
    expect(line.level).toBe("INFO");
    expect(line.event).toBe("queue.queue-message-authenticated");
    expect(line.get("from")).toBe("app@exemplo.test");
    expect(line.get("to")).toEqual(["ok1@destino.test"]);
    expect(line.get("queueId")).toBe("333028896586428416");
    expect(line.get("nextRetry")).toBe("2026-10-04T02:22:32Z");
  });

  it("campo repetido: get() devolve o último, all() todos", () => {
    const line = parseStalwartLogLine(L.okDsn)!;
    expect(line.get("to")).toBe("ok1@destino.test");
    expect(line.all("to")).toEqual([["ok1@destino.test"], "ok1@destino.test"]);
    expect(line.get("inexistente")).toBeUndefined();
  });

  it("valor sem aspas com vírgula dentro (texto fixo do Stalwart)", () => {
    const line = parseStalwartLogLine(L.invalidMx)!;
    expect(line.get("details")).toBe("No MX records were found, attempting implicit MX.");
    expect(line.get("elapsed")).toBe("0ms");
  });

  it("valor que é outro evento, com campos entre chaves", () => {
    const line = parseStalwartLogLine(L.downConnect)!;
    expect(logValueText(line.get("causedBy"))).toBe("I/O Error: Connection refused (os error 111)");
    expect(line.get("localIp")).toBe("(null)");
  });

  it("aspas dentro do texto (o Stalwart não as escapa) e escapes \\n, \\t, \\\\", () => {
    const line = parseStalwartLogLine(
      `2026-10-04T02:22:32Z INFO X (delivery.delivered) details = "disse "oi" e saiu\\nlinha\\t\\\\fim", code = 250`,
    )!;
    expect(line.get("details")).toBe('disse "oi" e saiu\nlinha\t\\fim');
    expect(line.get("code")).toBe("250");
  });

  it("lista vazia, lista de vários e evento sem campos", () => {
    const line = parseStalwartLogLine(`2026-10-04T02:22:32Z WARN Y (queue.back-pressure) a = [], b = ["x", "y"], c = Evento (x.y)`)!;
    expect(line.get("a")).toEqual([]);
    expect(line.get("b")).toEqual(["x", "y"]);
    expect(logValueText(line.get("c"))).toBe("Evento");
  });

  it("evento sem nenhum campo (com e sem espaço no fim)", () => {
    const line = parseStalwartLogLine("2026-10-04T02:22:17Z INFO Housekeeper process started (housekeeper.start) ")!;
    expect(line.event).toBe("housekeeper.start");
    expect(line.fields).toEqual([]);
    expect(parseStalwartLogLine("2026-10-04T02:22:17Z INFO Housekeeper process started (housekeeper.start)")!.fields).toEqual([]);
  });

  it("lista com números sem aspas, texto sem aspa de fechamento e resto que não é campo", () => {
    const line = parseStalwartLogLine(`2026-10-04T02:22:32Z INFO X (a.b) mailboxId = [0, 12], details = "sem fim`)!;
    expect(line.get("mailboxId")).toEqual(["0", "12"]);
    expect(line.get("details")).toBe("sem fim");
    expect(parseStalwartLogLine("2026-10-04T02:22:32Z INFO X (a.b) sem chave nenhuma")!.fields).toEqual([]);
  });

  it("linha que não é do formato → null", () => {
    expect(parseStalwartLogLine("")).toBeNull();
    expect(parseStalwartLogLine("qualquer coisa")).toBeNull();
    expect(parseStalwartLogLine("2026-10-04T02:22:32Z INFO sem evento")).toBeNull();
    expect(parseStalwartLogLine("nao-e-data INFO X (a.b) k = 1")).toBeNull();
  });
});

describe("logValueText", () => {
  it("texto, lista e ausente", () => {
    expect(logValueText("a")).toBe("a");
    expect(logValueText(["a", "b"])).toBe("a, b");
    expect(logValueText(undefined)).toBe("");
  });

  it("evento com só um dos campos conhecidos, ou com outros campos", () => {
    const only = parseStalwartLogLine(`2026-10-04T02:22:32Z INFO X (a.b) e = Erro (smtp.error) { reason = "só o motivo" }`)!;
    expect(logValueText(only.get("e"))).toBe("só o motivo");
    const other = parseStalwartLogLine(`2026-10-04T02:22:32Z INFO X (a.b) e = Erro (smtp.error) { code = 1 }`)!;
    expect(logValueText(other.get("e"))).toBe("Erro");
  });
});

describe("sanitizeLogText", () => {
  it("tira controle e cores, junta espaços e limita", () => {
    expect(sanitizeLogText("a\u0007b\u001b[31m  c\n d")).toBe("a b c d");
    expect(sanitizeLogText("x".repeat(400)).length).toBe(300);
    expect(sanitizeLogText("x".repeat(400)).endsWith("…")).toBe(true);
  });
});

describe("isDeliveryLogLine", () => {
  it("só as linhas de entrega e de nova tentativa interessam", () => {
    expect(isDeliveryLogLine(L.okDelivered)).toBe(true);
    expect(isDeliveryLogLine(L.tempRescheduled)).toBe(true);
    expect(isDeliveryLogLine(L.queued)).toBe(false);
    expect(isDeliveryLogLine("2026-10-04T02:22:32Z INFO Message ingested (message-ingest.ham) x = 1")).toBe(false);
  });
});

describe("DeliveryLogReader", () => {
  it("entregue: a resposta do DATA (da linha 'delivered') vale mais que a do aviso", () => {
    const events = feed([L.queued, L.okStart, L.okDomain, L.okDelivered, L.okDsn, L.okCompleted, L.okEnd]);
    expect(events).toEqual([
      {
        at: "2026-10-04T02:22:32.000Z",
        queueId: "333028896586428416",
        from: "app@exemplo.test",
        to: "ok1@destino.test",
        toDomain: "destino.test",
        state: "delivered",
        code: 250,
        detail: "OK 1700000000 abc123 - gsmtp",
        remoteHost: "host.docker.internal",
        nextRetryAt: null,
      },
    ]);
  });

  it("entregue sem a linha 'delivered' (entrega local): usa a do aviso", () => {
    const [event] = feed([L.okDsn]);
    expect(event).toMatchObject({ state: "delivered", code: 250, detail: "OK" });
  });

  it("adiada pelo destinatário (451): motivo e próxima tentativa", () => {
    const events = feed([L.tempStart, L.tempDomain, L.tempRejected, L.tempRescheduled]);
    expect(events).toEqual([
      expect.objectContaining({
        state: "deferred",
        to: "temp1@destino.test",
        code: 451,
        detail: "Our system has detected an unusual rate of unsolicited mail",
        remoteHost: "host.docker.internal",
        nextRetryAt: "2026-10-04T02:23:32.000Z",
      }),
    ]);
  });

  it("adiada por falha de conexão (sem resposta do destinatário): o motivo vem da falha do domínio", () => {
    const events = feed([L.downStart, L.downDomain, L.downConnect, L.downRescheduled]);
    expect(events).toEqual([
      expect.objectContaining({
        state: "deferred",
        to: "alguem@fora.test",
        code: null,
        detail: "I/O Error: Connection refused (os error 111)",
        remoteHost: "host.docker.internal",
        nextRetryAt: "2026-10-04T02:28:29.000Z",
      }),
    ]);
  });

  it("recusada (550): o aviso de falha definitiva vira 'recusada'", () => {
    const events = feed([L.nopeRejected, L.nopeDsn, L.nopeQueueDsn]);
    expect(events).toEqual([
      expect.objectContaining({
        state: "bounced",
        to: "nope1@destino.test",
        code: 550,
        detail: "The email account that you tried to reach does not exist",
      }),
    ]);
  });

  it("recusada sem código (domínio sem MX): motivo vem do evento aninhado", () => {
    const events = feed([L.invalidMx, L.invalidDsn]);
    expect(events).toEqual([
      expect.objectContaining({ state: "bounced", code: null, detail: "Connection Error: record not found for MX", remoteHost: null }),
    ]);
  });

  it("avisos do próprio servidor (remetente vazio) ficam de fora", () => {
    expect(feed([L.dsnOfDsn])).toEqual([]);
  });

  it("o mesmo resultado lido duas vezes não duplica", () => {
    const reader = new DeliveryLogReader();
    expect(reader.push(L.okDsn)).toHaveLength(1);
    expect(reader.push(L.okDsn)).toHaveLength(0);
  });

  it("linhas fora do formato ou sem interesse não geram nada", () => {
    expect(feed(["lixo", L.queued, L.okEnd])).toEqual([]);
  });

  it("nova tentativa sem nenhum motivo registrado: adiada sem detalhe", () => {
    const events = feed([L.tempStart, L.tempDomain, L.tempRescheduled]);
    expect(events).toEqual([expect.objectContaining({ state: "deferred", detail: null, code: null, remoteHost: null })]);
  });

  it("nova tentativa sem linha de início (leitura começou no meio): vale para todos os destinatários pendentes", () => {
    const events = feed([L.downRescheduled]);
    expect(events).toEqual([expect.objectContaining({ state: "deferred", to: "alguem@fora.test" })]);
  });

  it("mensagem com dois domínios: só o domínio tentado fica adiado; o já entregue não", () => {
    const span = `queueId = 9, from = "app@exemplo.test", to = ["a@um.test", "b@dois.test", "c@tres.test"], size = 1, total = 3`;
    const events = feed([
      `2026-10-04T03:00:00Z INFO S (delivery.attempt-start) ${span}`,
      `2026-10-04T03:00:00Z INFO D (delivery.domain-delivery-start) ${span}, domain = "um.test", total = 0`,
      `2026-10-04T03:00:00Z INFO D (delivery.domain-delivery-start) ${span}, domain = "dois.test", total = 0`,
      `2026-10-04T03:00:00Z INFO C (delivery.connect-error) ${span}, domain = "dois.test", hostname = "mx.dois.test", causedBy = E (smtp.error) { details = I/O Error, reason = "timeout" }`,
      `2026-10-04T03:00:00Z INFO OK (delivery.dsn-success) ${span}, to = "a@um.test", hostname = "mx.um.test", code = 250, details = "OK"`,
      `2026-10-04T03:00:00Z INFO R (queue.rescheduled) ${span}, nextRetry = 2026-10-04T03:05:00Z`,
    ]);
    expect(events.map((e) => [e.to, e.state, e.detail])).toEqual([
      ["a@um.test", "delivered", "OK"],
      ["b@dois.test", "deferred", "I/O Error: timeout"],
    ]);
  });

  it("falha sem domínio indicado (ex.: limite de envio) vale para todos os tentados", () => {
    const span = `queueId = 10, from = "app@exemplo.test", to = ["a@um.test"], size = 1, total = 1`;
    const events = feed([
      `2026-10-04T03:00:00Z INFO S (delivery.attempt-start) ${span}`,
      `2026-10-04T03:00:00Z INFO D (delivery.domain-delivery-start) ${span}, domain = "um.test", total = 0`,
      `2026-10-04T03:00:00Z WARN L (delivery.rate-limit-exceeded) ${span}, id = "limite"`,
      `2026-10-04T03:00:00Z INFO R (queue.rescheduled) ${span}, nextRetry = 2026-10-04T03:05:00Z`,
    ]);
    expect(events).toEqual([expect.objectContaining({ state: "deferred", detail: "L" })]);
  });

  it("nova tentativa com data inválida: sem próxima tentativa", () => {
    const span = `queueId = 11, from = "app@exemplo.test", to = ["a@um.test"], size = 1, total = 1`;
    const events = feed([`2026-10-04T03:00:00Z INFO R (queue.rescheduled) ${span}, nextRetry = nunca`]);
    expect(events[0]!.nextRetryAt).toBeNull();
  });

  it("campos que faltam: sem domínio, sem destinatário, sem próxima tentativa, motivo vazio", () => {
    const span = `queueId = 12, from = "app@exemplo.test", to = ["a@um.test"], size = 1, total = 1`;
    const events = feed([
      "lixo sem formato (delivery.dsn-success)",
      `2026-10-04T03:00:00Z INFO D (delivery.domain-delivery-start) ${span}`,
      `2026-10-04T03:00:00Z INFO M (delivery.delivered) ${span}, code = 250`,
      `2026-10-04T03:00:00Z INFO R (queue.rescheduled) ${span}`,
      `2026-10-04T03:00:01Z INFO F (delivery.dsn-perm-fail) ${span}, to = "a@um.test", details = ""`,
    ]);
    expect(events).toEqual([
      expect.objectContaining({ state: "deferred", nextRetryAt: null }),
      expect.objectContaining({ state: "bounced", detail: null }),
    ]);
  });

  it("linha de entrega sem fila, remetente ou destinatário é ignorada", () => {
    expect(feed([`2026-10-04T03:00:00Z INFO OK (delivery.dsn-success) to = "a@um.test"`])).toEqual([]);
    expect(feed([`2026-10-04T03:00:00Z INFO OK (delivery.dsn-success) queueId = 1, from = "x@y.test", code = 250`])).toEqual([]);
    expect(feed([`2026-10-04T03:00:00Z INFO R (queue.rescheduled) queueId = 1, nextRetry = 2026-10-04T03:05:00Z`])).toEqual([]);
  });

  it("depois de muitas mensagens, esquece as mais antigas (memória limitada)", () => {
    const reader = new DeliveryLogReader({ maxTracked: 2 });
    for (const id of ["1", "2", "3"]) {
      reader.push(`2026-10-04T03:00:00Z INFO S (delivery.attempt-start) queueId = ${id}, from = "a@b.test", to = ["x@y.test"]`);
      reader.push(`2026-10-04T03:00:00Z INFO OK (delivery.dsn-success) queueId = ${id}, from = "a@b.test", to = ["x@y.test"], to = "x@y.test", code = 250, details = "OK"`);
    }
    // a 1 foi esquecida: a mesma linha volta a contar
    expect(
      reader.push(`2026-10-04T03:00:00Z INFO OK (delivery.dsn-success) queueId = 1, from = "a@b.test", to = ["x@y.test"], to = "x@y.test", code = 250, details = "OK"`),
    ).toHaveLength(1);
  });
});
