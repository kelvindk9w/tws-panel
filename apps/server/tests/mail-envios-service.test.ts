/**
 * MailEnviosService — página Envios: fila agora, histórico guardado a partir
 * do registro do Stalwart (só metadados, 30 dias), volume e taxas.
 * Sem Docker: a fila, o registro e os remetentes são dublês; o relógio é fixo.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StalwartApiError, type QueueMessageRaw } from "@paas/mailer";
import { MailEnviosService, type MailEnviosDeps } from "../src/services/mail-envios-service.js";

const NOW = Date.parse("2026-10-04T15:00:00Z");
let dir = "";
let clock = NOW;
let logLines: string[] = [];
let sinceAsked: Array<Date | null> = [];
let queueItems: QueueMessageRaw[] = [];
let created = true;

const SPAN = (id: string, from: string, to: string) => `queueId = ${id}, from = "${from}", to = ["${to}"], size = 1, total = 1`;
function delivered(at: string, id: string, from: string, to: string) {
  return `${at} INFO DSN success notification (delivery.dsn-success) ${SPAN(id, from, to)}, to = "${to}", hostname = "mx.dest.test", code = 250, details = "OK"`;
}
function bounced(at: string, id: string, from: string, to: string) {
  return `${at} INFO DSN permanent failure notification (delivery.dsn-perm-fail) ${SPAN(id, from, to)}, to = "${to}", hostname = "mx.dest.test", code = 550, details = "User unknown"`;
}
function deferred(at: string, id: string, from: string, to: string) {
  return [
    `${at} INFO SMTP RCPT TO rejected (delivery.rcpt-to-rejected) ${SPAN(id, from, to)}, hostname = "mx.dest.test", to = "${to}", code = 451, details = "Try later"`,
    `${at} INFO Message rescheduled for delivery (queue.rescheduled) ${SPAN(id, from, to)}, nextRetry = 2026-10-04T16:00:00Z`,
  ];
}

function deps(over: Partial<MailEnviosDeps> = {}): MailEnviosDeps {
  return {
    dataDir: dir,
    serverCreated: async () => created,
    listQueue: async () => ({ items: queueItems, total: queueItems.length }),
    retry: async () => true,
    cancel: async () => true,
    senders: async () => [
      { address: "loja@envio.test", mailbox: "loja@envio.test", projectId: "p1", system: false },
      { address: "postmaster@envio.test", mailbox: "postmaster@envio.test", projectId: null, system: true },
      { address: "avulsa@envio.test", mailbox: "avulsa@envio.test", projectId: null, system: false },
    ],
    projectNames: async () => new Map([["p1", "Loja"]]),
    readLogs: async (since, onLine) => {
      sinceAsked.push(since);
      for (const l of logLines) onLine(l);
    },
    now: () => clock,
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-envios-"));
  clock = NOW;
  logLines = [];
  sinceAsked = [];
  queueItems = [];
  created = true;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const TEMP: QueueMessageRaw = {
  id: "333028896599011329",
  return_path: "loja@envio.test",
  created: "2026-10-04T14:00:00Z",
  size: 191,
  blob_hash: "",
  domains: [
    {
      name: "gmail.com",
      status: "scheduled",
      recipients: [{ address: "pessoa@gmail.com", status: { temp_fail: "Code: 451, Enhanced code: 4.7.28, Message: rate" } }],
      retry_num: 2,
      next_retry: "2026-10-04T15:05:00Z",
      next_notify: null,
      expires: "2026-10-09T14:00:00Z",
    },
  ],
};

describe("fila agora", () => {
  it("lista com remetente, projeto, tentativas e motivo", async () => {
    queueItems = [TEMP, { ...TEMP, id: "2", return_path: "" }];
    const res = await new MailEnviosService(deps()).queue();
    expect(res.available).toBe(true);
    expect(res.total).toBe(2);
    expect(res.items[0]).toMatchObject({
      id: "333028896599011329",
      sender: { address: "loja@envio.test", mailbox: "loja@envio.test", projectId: "p1", projectName: "Loja", system: false },
      attempts: 2,
      nextRetryAt: "2026-10-04T15:05:00.000Z",
      lastError: "451 4.7.28 rate",
    });
    expect(res.items[1]!.sender).toEqual({ address: "", mailbox: null, projectId: null, projectName: null, system: true });
  });

  it("servidor de e-mail não criado: indisponível com explicação, sem chamar o Stalwart", async () => {
    created = false;
    const listQueue = vi.fn();
    const res = await new MailEnviosService(deps({ listQueue })).queue();
    expect(res).toMatchObject({ available: false, items: [], total: 0 });
    expect(res.message).toMatch(/não foi criado/);
    expect(listQueue).not.toHaveBeenCalled();
  });

  it("Stalwart fora do ar: indisponível com o motivo", async () => {
    const res = await new MailEnviosService(deps({ listQueue: async () => Promise.reject(new Error("Sem conexão")) })).queue();
    expect(res).toMatchObject({ available: false, message: expect.stringContaining("Sem conexão") });
  });

  it("tentar agora: ok; mensagem que já saiu → 404; id inválido → 400", async () => {
    const retry = vi.fn(async () => true);
    const s = new MailEnviosService(deps({ retry }));
    expect(await s.retry("123")).toMatchObject({ ok: true });
    await expect(s.retry("abc")).rejects.toMatchObject({ statusCode: 400 });
    retry.mockResolvedValueOnce(false);
    await expect(s.retry("123")).rejects.toMatchObject({ statusCode: 404 });
    retry.mockRejectedValueOnce(new StalwartApiError(404, "Stalwart: not found"));
    await expect(s.retry("123")).rejects.toMatchObject({ statusCode: 404 });
    retry.mockRejectedValueOnce(new StalwartApiError(0, "Sem conexão com o Stalwart"));
    await expect(s.retry("123")).rejects.toMatchObject({ statusCode: 502 });
    retry.mockRejectedValueOnce(new Error("outro"));
    await expect(s.retry("123")).rejects.toThrow("outro");
  });

  it("cancelar: tira da fila e registra 'cancelada' no histórico para os destinatários pendentes", async () => {
    queueItems = [TEMP];
    const cancel = vi.fn(async () => true);
    const s = new MailEnviosService(deps({ cancel }));
    expect(await s.cancel(TEMP.id)).toMatchObject({ ok: true });
    expect(cancel).toHaveBeenCalledWith(TEMP.id);
    const h = await s.history({ days: 1 });
    expect(h.items).toEqual([
      expect.objectContaining({ state: "cancelled", to: "pessoa@gmail.com", queueId: TEMP.id, detail: "Cancelada no painel." }),
    ]);
  });

  it("cancelar mensagem que já saiu da fila → 404", async () => {
    const s = new MailEnviosService(deps({ cancel: async () => false }));
    await expect(s.cancel("999")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("leitura do registro (histórico)", () => {
  it("guarda só os eventos de entrega, por dia, e lembra até onde leu", async () => {
    logLines = [
      delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com"),
      bounced("2026-10-04T14:01:00Z", "2", "loja@envio.test", "b@outlook.com"),
      ...deferred("2026-10-04T14:02:00Z", "3", "avulsa@envio.test", "c@yahoo.com"),
      "2026-10-04T14:03:00Z INFO Housekeeper (housekeeper.start)",
    ];
    const s = new MailEnviosService(deps());
    expect(await s.collect()).toEqual({ added: 3 });
    expect(sinceAsked).toEqual([null]);
    const files = await readdir(path.join(dir, "mail", "envios"));
    expect(files.sort()).toEqual(["2026-10-04.jsonl", "estado.json"]);
    const saved = await readFile(path.join(dir, "mail", "envios", "2026-10-04.jsonl"), "utf8");
    expect(saved.trim().split("\n")).toHaveLength(3);
    // só metadados: nada de corpo/assunto
    expect(saved).not.toMatch(/subject|body/i);
    expect((await stat(path.join(dir, "mail", "envios", "estado.json"))).mode & 0o777).toBe(0o600);

    // segunda leitura: pede desde a última linha (com folga) e não duplica
    const again = new MailEnviosService(deps());
    expect(await again.collect()).toEqual({ added: 0 });
    expect(sinceAsked[1]!.toISOString()).toBe("2026-10-04T14:01:50.000Z");
  });

  it("linha nova no mesmo segundo da última lida entra; a repetida não", async () => {
    logLines = [delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com")];
    const s = new MailEnviosService(deps());
    await s.collect();
    logLines = [
      delivered("2026-10-04T13:59:59Z", "0", "loja@envio.test", "velha@gmail.com"),
      delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com"),
      delivered("2026-10-04T14:00:00Z", "9", "loja@envio.test", "z@gmail.com"),
      "linha estranha (delivery.x)",
    ];
    expect(await new MailEnviosService(deps()).collect()).toEqual({ added: 1 });
  });

  it("servidor não criado: não lê nada", async () => {
    created = false;
    const readLogs = vi.fn();
    expect(await new MailEnviosService(deps({ readLogs })).collect()).toEqual({ added: 0 });
    expect(readLogs).not.toHaveBeenCalled();
  });

  it("falha ao ler o registro fica guardada e aparece no histórico", async () => {
    const s = new MailEnviosService(deps({ readLogs: async () => Promise.reject(new Error("No such container: paas-stalwart")) }));
    await expect(s.collect()).resolves.toEqual({ added: 0 });
    const h = await s.history({ days: 7, refresh: false });
    expect(h.collectError).toContain("No such container");
    expect(h.collectedAt).toBeNull();
  });

  it("duas leituras ao mesmo tempo viram uma", async () => {
    let calls = 0;
    const s = new MailEnviosService(
      deps({
        readLogs: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 10));
        },
      }),
    );
    await Promise.all([s.collect(), s.collect()]);
    expect(calls).toBe(1);
  });

  it("apaga os dias mais antigos que 30 dias", async () => {
    const enviosDir = path.join(dir, "mail", "envios");
    await mkdir(enviosDir, { recursive: true });
    await writeFile(path.join(enviosDir, "2026-08-01.jsonl"), "{}\n");
    await writeFile(path.join(enviosDir, "2026-09-10.jsonl"), "{}\n");
    await writeFile(path.join(enviosDir, "outro.txt"), "x");
    await new MailEnviosService(deps()).collect();
    const files = (await readdir(enviosDir)).sort();
    expect(files).toEqual(["2026-09-10.jsonl", "estado.json", "outro.txt"]);
  });

  it("estado corrompido: recomeça do zero sem quebrar", async () => {
    await mkdir(path.join(dir, "mail", "envios"), { recursive: true });
    await writeFile(path.join(dir, "mail", "envios", "estado.json"), "{lixo");
    logLines = [delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com")];
    expect(await new MailEnviosService(deps()).collect()).toEqual({ added: 1 });
  });
});

describe("histórico com filtros", () => {
  async function seeded() {
    logLines = [
      delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com"),
      bounced("2026-10-04T14:01:00Z", "2", "loja@envio.test", "b@outlook.com"),
      ...deferred("2026-10-04T14:02:00Z", "3", "avulsa@envio.test", "c@yahoo.com"),
      delivered("2026-10-04T14:03:00Z", "4", "postmaster@envio.test", "d@gmail.com"),
      delivered("2026-10-04T14:04:00Z", "5", "estranho@outro.test", "e@gmail.com"),
      delivered("2026-09-20T10:00:00Z", "6", "loja@envio.test", "velho@gmail.com"),
    ];
    const s = new MailEnviosService(deps());
    await s.collect();
    return s;
  }

  it("mais recentes primeiro, com remetente e projeto; listas para os filtros", async () => {
    const h = await (await seeded()).history({ days: 7 });
    expect(h.items.map((i) => i.to)).toEqual(["e@gmail.com", "d@gmail.com", "c@yahoo.com", "b@outlook.com", "a@gmail.com"]);
    expect(h.total).toBe(5);
    expect(h.retentionDays).toBe(30);
    expect(h.collectedAt).toBe(new Date(NOW).toISOString());
    expect(h.items.find((i) => i.to === "a@gmail.com")!.sender).toMatchObject({ projectId: "p1", projectName: "Loja" });
    expect(h.items.find((i) => i.to === "e@gmail.com")!.sender).toMatchObject({ projectId: null, mailbox: null, system: false });
    expect(h.projects).toEqual([{ id: "p1", name: "Loja" }]);
    expect(h.mailboxes).toEqual(["avulsa@envio.test", "estranho@outro.test", "loja@envio.test", "postmaster@envio.test"]);
    expect(h.domains).toEqual(["gmail.com", "outlook.com", "yahoo.com"]);
  });

  it("período maior traz os dias antigos", async () => {
    const h = await (await seeded()).history({ days: 30 });
    expect(h.total).toBe(6);
  });

  it("filtra por estado, projeto, sem projeto, caixa, domínio e busca", async () => {
    const s = await seeded();
    expect((await s.history({ days: 7, state: "bounced" })).items.map((i) => i.to)).toEqual(["b@outlook.com"]);
    expect((await s.history({ days: 7, projectId: "p1" })).total).toBe(2);
    expect((await s.history({ days: 7, projectId: "none" })).total).toBe(3);
    expect((await s.history({ days: 7, mailbox: "avulsa@envio.test" })).items[0]!.to).toBe("c@yahoo.com");
    expect((await s.history({ days: 7, domain: "gmail.com" })).total).toBe(3);
    expect((await s.history({ days: 7, q: "USER UNKNOWN" })).items.map((i) => i.to)).toEqual(["b@outlook.com"]);
    expect((await s.history({ days: 7, q: "nada-disso" })).total).toBe(0);
  });

  it("paginação", async () => {
    const s = await seeded();
    const page = await s.history({ days: 7, limit: 2, offset: 2 });
    expect(page.items.map((i) => i.to)).toEqual(["c@yahoo.com", "b@outlook.com"]);
    expect(page.total).toBe(5);
  });

  it("refresh lê o registro antes, se a última leitura tiver mais de 1 minuto", async () => {
    const s = await seeded();
    sinceAsked = [];
    await s.history({ days: 7, refresh: true });
    expect(sinceAsked).toHaveLength(0);
    clock = NOW + 61_000;
    await s.history({ days: 7, refresh: true });
    expect(sinceAsked).toHaveLength(1);
  });

  it("linha corrompida no arquivo do dia é ignorada", async () => {
    const s = await seeded();
    await writeFile(path.join(dir, "mail", "envios", "2026-10-04.jsonl"), "{lixo\n", { flag: "a" });
    expect((await s.history({ days: 7 })).total).toBe(5);
  });
});

describe("volume e taxas", () => {
  it("14 dias no fuso de quem pede, por projeto, com taxas e limites", async () => {
    logLines = [
      // 02:00 UTC do dia 04 = 23:00 do dia 03 em Brasília (UTC-3)
      delivered("2026-10-04T02:00:00Z", "1", "loja@envio.test", "a@gmail.com"),
      delivered("2026-10-04T14:00:00Z", "2", "loja@envio.test", "b@gmail.com"),
      bounced("2026-10-04T14:01:00Z", "3", "loja@envio.test", "c@gmail.com"),
      ...deferred("2026-10-04T14:02:00Z", "4", "avulsa@envio.test", "d@gmail.com"),
      ...deferred("2026-10-04T14:12:00Z", "4", "avulsa@envio.test", "d@gmail.com"),
      delivered("2026-10-04T14:20:00Z", "4", "avulsa@envio.test", "d@gmail.com"),
    ];
    const s = new MailEnviosService(deps());
    await s.collect();
    await s.cancel("77").catch(() => undefined);
    const v = await s.volume({ days: 14, tzOffsetMinutes: 180 });
    expect(v.days).toHaveLength(14);
    expect(v.days.at(-1)).toEqual({ date: "2026-10-04", delivered: 2, bounced: 1, deferred: 1, cancelled: 0 });
    expect(v.days.at(-2)).toEqual({ date: "2026-10-03", delivered: 1, bounced: 0, deferred: 0, cancelled: 0 });
    expect(v.days[0]!.date).toBe("2026-09-21");
    expect(v.totals).toEqual({ delivered: 3, bounced: 1, deferred: 1, cancelled: 0, recipients: 4 });
    expect(v.bounceRate).toEqual({ value: 0.25, limit: 0.02, high: true });
    expect(v.deferRate).toEqual({ value: 0.25, limit: 0.05, high: true });
    expect(v.complaintRate).toBeNull();
    expect(v.lowVolume).toBe(true);
    expect(v.byProject).toEqual([
      { projectId: "p1", name: "Loja", delivered: 2, bounced: 1, deferred: 0 },
      { projectId: null, name: "Sem projeto", delivered: 1, bounced: 0, deferred: 1 },
    ]);
  });

  it("sem envios: taxas vazias", async () => {
    const v = await new MailEnviosService(deps()).volume({ days: 14, tzOffsetMinutes: 0 });
    expect(v.bounceRate).toEqual({ value: null, limit: 0.02, high: false });
    expect(v.deferRate.value).toBeNull();
    expect(v.byProject).toEqual([]);
  });

  it("resumo de 7 dias (para a nota) e o primeiro envio já visto", async () => {
    logLines = [
      delivered("2026-09-20T10:00:00Z", "6", "loja@envio.test", "velho@gmail.com"),
      delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com"),
      bounced("2026-10-04T14:01:00Z", "2", "loja@envio.test", "b@outlook.com"),
      ...deferred("2026-10-04T14:02:00Z", "3", "avulsa@envio.test", "c@yahoo.com"),
    ];
    const s = new MailEnviosService(deps());
    expect(await s.firstEventAt()).toBeNull();
    await s.collect();
    expect(await s.summary7d()).toEqual({ delivered: 1, bounced: 1, deferredRecipients: 1, recipients: 3 });
    expect(await s.firstEventAt()).toBe("2026-09-20T10:00:00.000Z");
  });
});

describe("agendamento", () => {
  it("lê o registro 1 min depois de iniciar e a cada 5 min; parar cancela", async () => {
    vi.useFakeTimers();
    const s = new MailEnviosService(deps());
    const readLogs = vi.spyOn(s, "collect").mockResolvedValue({ added: 0 });
    s.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(readLogs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readLogs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(readLogs).toHaveBeenCalledTimes(2);
    s.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(readLogs).toHaveBeenCalledTimes(2);
  });
});

describe("casos de borda", () => {
  it("erros que não são do tipo Error, outro erro do Stalwart e projeto sem nome", async () => {
    const s = new MailEnviosService(
      deps({
        listQueue: async () => Promise.reject("texto"),
        readLogs: async () => Promise.reject("sem docker"),
        retry: async () => Promise.reject(new StalwartApiError(500, "Stalwart: falhou")),
      }),
    );
    expect((await s.queue()).message).toContain("texto");
    await s.collect();
    expect((await s.history({ days: 1 })).collectError).toBe("sem docker");
    await expect(s.retry("1")).rejects.toMatchObject({ status: 500 });

    logLines = [delivered("2026-10-04T14:00:00Z", "1", "x@envio.test", "a@gmail.com")];
    const t = new MailEnviosService(
      deps({ senders: async () => [{ address: "x@envio.test", mailbox: "x@envio.test", projectId: "p9", system: false }] }),
    );
    await t.collect();
    const h = await t.history({ days: 1 });
    expect(h.items[0]!.sender).toMatchObject({ projectId: "p9", projectName: null });
    expect(h.projects).toEqual([{ id: "p9", name: "p9" }]);
  });

  it("cancelada entra no volume e na busca; eventos no mesmo instante e no futuro não quebram", async () => {
    logLines = [
      delivered("2026-10-04T14:00:00Z", "1", "loja@envio.test", "a@gmail.com"),
      delivered("2026-10-04T14:00:00Z", "2", "loja@envio.test", "b@gmail.com"),
      delivered("2026-10-06T14:00:00Z", "3", "loja@envio.test", "futuro@gmail.com"),
    ];
    queueItems = [TEMP];
    const s = new MailEnviosService(deps());
    await s.collect();
    await s.cancel(TEMP.id);
    const v = await s.volume({ days: 14, tzOffsetMinutes: 0 });
    expect(v.totals.cancelled).toBe(1);
    expect(v.days.at(-1)!.cancelled).toBe(1);
    expect((await s.history({ days: 1, q: "painel" })).total).toBe(1);
    expect((await s.history({ days: 1, q: "gmail" })).total).toBe(4);
    expect((await s.summary7d()).recipients).toBe(4);
  });
});
