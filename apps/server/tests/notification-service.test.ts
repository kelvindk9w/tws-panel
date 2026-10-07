/**
 * notification-service.test.ts — serviço central de notificações.
 *
 * Telegram e e-mail simulados (sem rede). Cobre: token cifrado em disco e
 * nunca devolvido, conectar a conversa, teste, escolha por tipo, agrupamento
 * de repetidos, limite por hora, nova tentativa com recuo, histórico sem
 * conteúdo e a auditoria sem segredo.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsStatus } from "@paas/core";
import { NotificationService, maskSensitive, type EmailSender } from "../src/services/notification-service.js";
import { TelegramError, type TelegramClient } from "../src/services/telegram-client.js";

const TOKEN = "123456789:AAEXEMPLOxxxxxxxxxxxxxxxxxxxxxxxxxx";

let dir: string;
let clock: number;
let telegram: TelegramClient & {
  sent: Array<{ chatId: string; text: string }>;
  failNext: TelegramError[];
  chat: { chatId: string; title: string; type: string } | null;
};
let audits: Array<{ action: string; detail: string; actor?: string }>;
let logs: string[];

function makeTelegram() {
  const t = {
    sent: [] as Array<{ chatId: string; text: string }>,
    failNext: [] as TelegramError[],
    chat: { chatId: "42", title: "Maria Silva", type: "private" } as { chatId: string; title: string; type: string } | null,
    getMe: vi.fn(async (token: string) => {
      if (token !== TOKEN) throw new TelegramError("invalid_token", "O Telegram não reconheceu o token.", true);
      return { username: "meu_painel_bot", name: "Avisos" };
    }),
    findLatestChat: vi.fn(async () => t.chat),
    sendMessage: vi.fn(async (_token: string, chatId: string, text: string) => {
      const err = t.failNext.shift();
      if (err) throw err;
      t.sent.push({ chatId, text });
    }),
  };
  return t;
}

function makeEmail(ready = true) {
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const failNext: Error[] = [];
  const sender: EmailSender & { sent: typeof sent; failNext: Error[]; ready: boolean } = {
    sent,
    failNext,
    ready,
    readiness: async () =>
      sender.ready
        ? { ready: true, reason: null, from: "postmaster@envio.exemplo.com.br" }
        : { ready: false, reason: "O servidor de e-mail do painel está parado.", from: null },
    send: async (msg) => {
      const err = failNext.shift();
      if (err) throw err;
      sent.push(msg);
    },
  };
  return sender;
}

function service(overrides: Partial<ConstructorParameters<typeof NotificationService>[0]> = {}) {
  return new NotificationService({
    dataDir: dir,
    telegram,
    now: () => clock,
    audit: { record: async (e) => void audits.push(e) },
    log: (m) => void logs.push(m),
    groupWindowMs: 10 * 60_000,
    maxPerHour: 20,
    retryDelaysMs: [30_000, 120_000],
    ...overrides,
  });
}

async function connected(s: NotificationService): Promise<void> {
  await s.setTelegramToken(TOKEN, "admin");
  await s.connectTelegram("admin");
}

async function httpErrorOf(p: Promise<unknown>): Promise<{ statusCode: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { statusCode: number; code: string; message: string };
  }
  throw new Error("esperava erro");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-notif-"));
  clock = Date.parse("2026-10-07T12:00:00Z");
  telegram = makeTelegram();
  audits = [];
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Telegram: conectar", () => {
  it("sem nada configurado: estado 'none', e-mail indisponível sem o servidor de e-mail, tipos no padrão", async () => {
    const st = await service().status();
    expect(st.telegram).toEqual({ state: "none", botUsername: null, chatTitle: null, connectedAt: null, testedAt: null });
    expect(st.email.available).toBe(false);
    expect(st.email.unavailableReason).toMatch(/servidor de e-mail/);
    expect(st.kinds.panel).toBe(false);
    expect(st.kinds.security).toBe(true);
    expect(st.history).toEqual([]);
  });

  it("token conferido: aguarda a conversa; o token fica CIFRADO em disco e nunca volta", async () => {
    const s = service();
    const st = await s.setTelegramToken(`  ${TOKEN}  `, "admin");
    expect(st.telegram.state).toBe("awaiting_chat");
    expect(st.telegram.botUsername).toBe("meu_painel_bot");
    expect(JSON.stringify(st)).not.toContain("AAEXEMPLO");
    const raw = await readFile(path.join(dir, "notifications.json"), "utf8");
    expect(raw).not.toContain("AAEXEMPLO");
    expect(raw).not.toContain("123456789");
    expect((await stat(path.join(dir, "notifications.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, "notifications-key"))).mode & 0o777).toBe(0o600);
    // auditoria sem o token
    expect(audits.map((a) => a.action)).toContain("notifications.telegram_token");
    expect(JSON.stringify(audits)).not.toContain("AAEXEMPLO");
  });

  it("token recusado pelo Telegram: 400 com a explicação, nada gravado", async () => {
    const s = service();
    const err = await httpErrorOf(s.setTelegramToken("1:errado", "admin"));
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("invalid_token");
    expect((await s.status()).telegram.state).toBe("none");
  });

  it("sem resposta do Telegram ao conferir o token: 502", async () => {
    vi.mocked(telegram.getMe).mockRejectedValueOnce(new TelegramError("network", "Sem resposta.", false));
    const err = await httpErrorOf(service().setTelegramToken(TOKEN, "admin"));
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("telegram_unreachable");
  });

  it("conectar sem token: 409", async () => {
    const err = await httpErrorOf(service().connectTelegram("admin"));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("telegram_no_token");
  });

  it("conectar antes do /start: 409 explicando o que fazer", async () => {
    const s = service();
    await s.setTelegramToken(TOKEN, "admin");
    telegram.chat = null;
    const err = await httpErrorOf(s.connectTelegram("admin"));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("telegram_no_chat");
    expect(err.message).toContain("@meu_painel_bot");
    expect(err.message).toContain("/start");
  });

  it("conectar com erro do Telegram (webhook): 409 com a mensagem dele", async () => {
    const s = service();
    await s.setTelegramToken(TOKEN, "admin");
    telegram.findLatestChat = vi.fn(async () => {
      throw new TelegramError("webhook_active", "Este robô está ligado a um webhook.", true);
    });
    const err = await httpErrorOf(s.connectTelegram("admin"));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/webhook/);
  });

  it("conectar depois do /start: mostra o nome da conversa; sobrevive a reiniciar o painel", async () => {
    const s = service();
    await connected(s);
    const st = await s.status();
    expect(st.telegram.state).toBe("connected");
    expect(st.telegram.chatTitle).toBe("Maria Silva");
    expect(st.telegram.connectedAt).toBe(new Date(clock).toISOString());
    // outra instância (reinício) lê o mesmo arquivo e decifra o token
    const again = service();
    expect((await again.status()).telegram.state).toBe("connected");
    await again.testTelegram("admin");
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(TOKEN, "42", expect.any(String));
  });

  it("trocar o token desfaz a conversa ligada e o teste", async () => {
    const s = service();
    await connected(s);
    await s.testTelegram("admin");
    const st = await s.setTelegramToken(TOKEN, "admin");
    expect(st.telegram).toMatchObject({ state: "awaiting_chat", chatTitle: null, testedAt: null });
  });

  it("arquivo adulterado (token não decifra): volta a 'none' e registra no log", async () => {
    const s = service();
    await connected(s);
    const file = path.join(dir, "notifications.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    data.telegram.token.data = Buffer.from("lixo").toString("base64");
    await writeFile(file, JSON.stringify(data));
    const st = await service().status();
    expect(st.telegram.state).toBe("none");
    expect(logs.join("\n")).toMatch(/decifrar/);
  });

  it("arquivos ilegíveis ou chave de tamanho errado: começa do zero", async () => {
    await writeFile(path.join(dir, "notifications.json"), "{não é json");
    await writeFile(path.join(dir, "notifications-history.json"), "{não é json");
    await writeFile(path.join(dir, "notifications-key"), "abcd\n");
    const s = service();
    expect((await s.status()).telegram.state).toBe("none");
    await connected(s);
    expect((await s.status()).telegram.state).toBe("connected");
  });

  it("desconectar apaga o token e registra na auditoria", async () => {
    const s = service();
    await connected(s);
    const st = await s.removeTelegram("admin");
    expect(st.telegram.state).toBe("none");
    expect(audits.map((a) => a.action)).toContain("notifications.telegram_removed");
    const raw = await readFile(path.join(dir, "notifications.json"), "utf8");
    expect(JSON.parse(raw).telegram).toBeNull();
  });
});

describe("Telegram: enviar teste", () => {
  it("sem conversa conectada: 409", async () => {
    const err = await httpErrorOf(service().testTelegram("admin"));
    expect(err.statusCode).toBe(409);
  });

  it("teste enviado: marca testado, entra no histórico (só o assunto) e na auditoria", async () => {
    const s = service();
    await connected(s);
    const st = await s.testTelegram("admin");
    expect(st.telegram.testedAt).toBe(new Date(clock).toISOString());
    expect(telegram.sent[0]!.text).toMatch(/TWS Panel/);
    expect(telegram.sent[0]!.text).toMatch(/teste/i);
    expect(st.history[0]).toMatchObject({ channel: "telegram", kind: "test", status: "sent", detail: null });
    expect(audits.find((a) => a.action === "notifications.test")?.detail).toMatch(/Telegram.*enviado/);
  });

  it("teste que falha: 502 com o motivo, histórico 'failed', não marca testado", async () => {
    const s = service();
    await connected(s);
    telegram.failNext.push(new TelegramError("blocked", "O robô foi bloqueado.", true));
    const err = await httpErrorOf(s.testTelegram("admin"));
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/bloqueado/);
    const st = await s.status();
    expect(st.telegram.testedAt).toBeNull();
    expect(st.history[0]).toMatchObject({ status: "failed", detail: "O robô foi bloqueado." });
  });
});

describe("E-mail", () => {
  it("servidor de e-mail não pronto: indisponível com o motivo; salvar endereços é recusado", async () => {
    const s = service();
    s.setEmailSender(makeEmail(false));
    const st = await s.status();
    expect(st.email).toMatchObject({ available: false, unavailableReason: "O servidor de e-mail do painel está parado." });
    const err = await httpErrorOf(s.setEmailRecipients(["pessoa@exemplo.org"], "admin"));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("email_unavailable");
  });

  it("checagem do servidor de e-mail que falha: indisponível, sem derrubar a tela", async () => {
    const s = service();
    s.setEmailSender({
      readiness: async () => {
        throw new Error("docker fora");
      },
      send: async () => undefined,
    });
    const st = await s.status();
    expect(st.email.available).toBe(false);
    expect(st.email.unavailableReason).toMatch(/conferir/);
  });

  it("endereços: valida, tira repetidos e espaços; recusa inválido, vazio e mais de 5", async () => {
    const s = service();
    s.setEmailSender(makeEmail());
    const st = await s.setEmailRecipients([" Pessoa@Exemplo.org ", "pessoa@exemplo.org", "outra@exemplo.org"], "admin");
    expect(st.email.recipients).toEqual(["pessoa@exemplo.org", "outra@exemplo.org"]);
    expect(st.email.from).toBe("postmaster@envio.exemplo.com.br");
    expect(audits.find((a) => a.action === "notifications.email_saved")?.detail).toMatch(/2 endereço/);
    expect(JSON.stringify(audits)).not.toContain("pessoa@exemplo.org");
    expect((await httpErrorOf(s.setEmailRecipients(["não é e-mail"], "admin"))).code).toBe("invalid_recipient");
    expect((await httpErrorOf(s.setEmailRecipients(["  "], "admin"))).code).toBe("invalid_recipient");
    const six = Array.from({ length: 6 }, (_, i) => `p${i}@exemplo.org`);
    expect((await httpErrorOf(s.setEmailRecipients(six, "admin"))).code).toBe("too_many_recipients");
  });

  it("trocar os endereços desfaz o 'testado'; manter os mesmos não", async () => {
    const s = service();
    s.setEmailSender(makeEmail());
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    await s.testEmail("admin");
    expect((await s.setEmailRecipients(["a@exemplo.org"], "admin")).email.testedAt).not.toBeNull();
    expect((await s.setEmailRecipients(["b@exemplo.org"], "admin")).email.testedAt).toBeNull();
  });

  it("teste: um e-mail para cada endereço, texto e HTML; marca testado", async () => {
    const s = service();
    const email = makeEmail();
    s.setEmailSender(email);
    await s.setEmailRecipients(["a@exemplo.org", "b@exemplo.org"], "admin");
    const st = await s.testEmail("admin");
    expect(email.sent.map((m) => m.to)).toEqual(["a@exemplo.org", "b@exemplo.org"]);
    expect(email.sent[0]!.subject).toMatch(/^\[TWS Panel\]/);
    expect(email.sent[0]!.html).toMatch(/<p>/);
    expect(st.email.testedAt).not.toBeNull();
    expect(st.history.filter((h) => h.channel === "email" && h.kind === "test")).toHaveLength(2);
  });

  it("teste sem endereço: 409; sem servidor pronto: 409; envio recusado: 502 sem marcar testado", async () => {
    const s = service();
    const email = makeEmail();
    s.setEmailSender(email);
    expect((await httpErrorOf(s.testEmail("admin"))).statusCode).toBe(409);
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    email.failNext.push(new Error("550 recusado"));
    const err = await httpErrorOf(s.testEmail("admin"));
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("550 recusado");
    expect((await s.status()).email.testedAt).toBeNull();
    email.ready = false;
    expect((await httpErrorOf(s.testEmail("admin"))).code).toBe("email_unavailable");
  });

  it("remover o e-mail: sem endereços", async () => {
    const s = service();
    s.setEmailSender(makeEmail());
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    const st = await s.removeEmail("admin");
    expect(st.email.recipients).toEqual([]);
    expect(audits.map((a) => a.action)).toContain("notifications.email_removed");
  });
});

describe("tipos de aviso", () => {
  it("liga e desliga por tipo; ignora tipo desconhecido; a escolha fica gravada", async () => {
    const s = service();
    const st = await s.setKinds({ panel: true, disk: false, inventado: true } as never, "admin");
    expect(st.kinds).toMatchObject({ panel: true, disk: false, security: true });
    expect(st.kinds).not.toHaveProperty("inventado");
    expect((await service().status()).kinds.panel).toBe(true);
    expect(audits.find((a) => a.action === "notifications.kinds")?.detail).toMatch(/Painel reiniciado: sim/);
  });
});

describe("notify: envio dos avisos", () => {
  it("sem canal conectado ou com o tipo desligado: não manda nada", async () => {
    const s = service();
    await s.notify({ kind: "security", key: "a", title: "Porta nova" });
    await connected(s);
    await s.notify({ kind: "panel", key: "p", title: "Painel iniciado" });
    expect(telegram.sent).toHaveLength(0);
  });

  it("manda pelos dois canais; IP e endereço sslip são mascarados; com link do painel", async () => {
    const email = makeEmail();
    const s = service({ panelUrl: async () => "https://painel.exemplo.com.br" });
    s.setEmailSender(email);
    await connected(s);
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    await s.notify({
      kind: "security",
      key: "scan:porta",
      title: "Porta nova em 203.0.113.10",
      body: ["Endereço 203-0-113-10.sslip.io <script>"],
      path: "/alerts",
    });
    expect(telegram.sent).toHaveLength(1);
    const text = telegram.sent[0]!.text;
    expect(text).not.toContain("203.0.113.10");
    expect(text).not.toContain("203-0-113-10");
    expect(text).toContain("https://painel.exemplo.com.br/alerts");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.subject).not.toContain("203.0.113.10");
    expect(email.sent[0]!.html).toContain("&lt;script&gt;");
    expect(email.sent[0]!.html).toContain('href="https://painel.exemplo.com.br/alerts"');
    const st = await s.status();
    expect(st.history.filter((h) => h.kind === "security")).toHaveLength(2);
    expect(JSON.stringify(st.history)).not.toContain("203.0.113.10");
  });

  it("sem domínio próprio do painel: sem link (o endereço pelo IP não vai na mensagem)", async () => {
    const s = service({
      panelUrl: async () => {
        throw new Error("falhou");
      },
    });
    await connected(s);
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    expect(telegram.sent[0]!.text).toMatch(/Veja os detalhes no painel/);
    expect(telegram.sent[0]!.text).not.toMatch(/https?:/);
  });

  it("repetidos: o mesmo assunto em 10 min vira UM resumo no fim da janela", async () => {
    const s = service();
    await connected(s);
    await s.notify({ kind: "security", key: "k", title: "Porta nova" });
    await s.notify({ kind: "security", key: "k", title: "Porta nova" });
    await s.notify({ kind: "security", key: "k", title: "Porta nova" });
    expect(telegram.sent).toHaveLength(1);
    clock += 5 * 60_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(1);
    clock += 6 * 60_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent[1]!.text).toMatch(/repetiu 2 vezes/);
    // janela encerrada: o próximo sai na hora de novo
    await s.notify({ kind: "security", key: "k", title: "Porta nova" });
    expect(telegram.sent).toHaveLength(3);
    // assunto que não repetiu não gera resumo
    clock += 11 * 60_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(3);
  });

  it("um tipo desligado depois de agrupar: o resumo não sai", async () => {
    const s = service();
    await connected(s);
    await s.notify({ kind: "deploy", key: "k", title: "Deploy falhou" });
    await s.notify({ kind: "deploy", key: "k", title: "Deploy falhou" });
    await s.setKinds({ deploy: false }, "admin");
    clock += 11 * 60_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(1);
  });

  it("limite por hora: o excesso não sai, e um resumo avisa quantos ficaram de fora quando a hora libera", async () => {
    const s = service({ maxPerHour: 2 });
    await connected(s);
    for (let i = 0; i < 5; i += 1) await s.notify({ kind: "security", key: `k${i}`, title: `Alerta ${i}` });
    expect(telegram.sent).toHaveLength(2);
    // o que ficou de fora não enche o histórico: vira um resumo depois
    expect((await s.status()).history).toHaveLength(2);
    clock += 61 * 60_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(3);
    expect(telegram.sent[2]!.text).toMatch(/3 avisos/);
    expect((await s.status()).history[0]).toMatchObject({ kind: "summary", status: "sent" });
  });

  it("falha temporária: tenta de novo com recuo (30 s, depois 2 min) até dar certo", async () => {
    const s = service();
    await connected(s);
    telegram.failNext.push(new TelegramError("network", "Sem resposta.", false), new TelegramError("network", "Sem resposta.", false));
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    let st = await s.status();
    expect(st.history[0]).toMatchObject({ status: "retrying", detail: "Sem resposta." });
    clock += 10_000;
    await s.tick();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    clock += 25_000;
    await s.tick();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sent).toHaveLength(0);
    clock += 121_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(1);
    st = await s.status();
    expect(st.history).toHaveLength(1);
    expect(st.history[0]).toMatchObject({ status: "sent", detail: null });
  });

  it("limite do Telegram (429) com tempo pedido maior que o recuo: espera o tempo pedido", async () => {
    const s = service();
    await connected(s);
    telegram.failNext.push(new TelegramError("rate_limited", "Espere.", false, 90_000));
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    clock += 60_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(0);
    clock += 31_000;
    await s.tick();
    expect(telegram.sent).toHaveLength(1);
  });

  it("falha temporária que não passa: desiste depois das tentativas e registra 'failed' sem derrubar nada", async () => {
    const s = service();
    await connected(s);
    for (let i = 0; i < 3; i += 1) telegram.failNext.push(new TelegramError("network", "Sem resposta.", false));
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    clock += 31_000;
    await s.tick();
    clock += 121_000;
    await s.tick();
    const st = await s.status();
    expect(st.history[0]).toMatchObject({ status: "failed" });
    expect(logs.join("\n")).toMatch(/não foi enviado/);
  });

  it("falha permanente: não tenta de novo", async () => {
    const s = service();
    await connected(s);
    telegram.failNext.push(new TelegramError("blocked", "Bloqueado.", true));
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    clock += 31_000;
    await s.tick();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect((await s.status()).history[0]).toMatchObject({ status: "failed", detail: "Bloqueado." });
  });

  it("e-mail que falha também tenta de novo; e-mail fora do ar na hora do aviso: falha registrada", async () => {
    const email = makeEmail();
    const s = service();
    s.setEmailSender(email);
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    email.failNext.push(new Error("conexão recusada"));
    await s.notify({ kind: "disk", key: "disk", title: "Disco quase cheio" });
    clock += 31_000;
    await s.tick();
    expect(email.sent).toHaveLength(1);
    email.ready = false;
    await s.notify({ kind: "disk", key: "disk2", title: "Disco quase cheio de novo" });
    expect((await s.status()).history[0]).toMatchObject({ status: "retrying" });
  });

  it("canal removido enquanto havia nova tentativa pendente: desiste sem erro", async () => {
    const s = service();
    await connected(s);
    telegram.failNext.push(new TelegramError("network", "Sem resposta.", false));
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    await s.removeTelegram("admin");
    clock += 31_000;
    await s.tick();
    expect((await s.status()).history.at(-1)).toMatchObject({ status: "failed" });
  });

  it("histórico guarda só os 50 últimos e sobrevive a reiniciar", async () => {
    const s = service({ maxPerHour: 1000 });
    await connected(s);
    for (let i = 0; i < 55; i += 1) await s.notify({ kind: "security", key: `k${i}`, title: `Alerta ${i}` });
    await s.flush();
    const st = await service().status();
    expect(st.history).toHaveLength(50);
    expect(st.history[0]!.title).toBe("Alerta 54");
  });
});

describe("facts (roteiro de primeiros passos)", () => {
  it("diz quais canais estão conectados e testados", async () => {
    const s = service();
    s.setEmailSender(makeEmail());
    expect(await s.facts()).toEqual({
      channels: [
        { id: "telegram", connected: false, tested: false },
        { id: "email", connected: false, tested: false },
      ],
    });
    await connected(s);
    await s.testTelegram("admin");
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    expect((await s.facts()).channels).toEqual([
      { id: "telegram", connected: true, tested: true },
      { id: "email", connected: true, tested: false },
    ]);
  });
});

describe("agendador", () => {
  it("start roda tick periodicamente; stop para", async () => {
    vi.useFakeTimers();
    try {
      const s = service();
      const tick = vi.spyOn(s, "tick").mockResolvedValue();
      s.start(1000);
      s.start(1000); // segunda chamada não cria outro timer
      vi.advanceTimersByTime(3500);
      expect(tick).toHaveBeenCalledTimes(3);
      s.stop();
      vi.advanceTimersByTime(3000);
      expect(tick).toHaveBeenCalledTimes(3);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tick com erro inesperado só vai para o log", async () => {
    vi.useFakeTimers();
    try {
      const s = service();
      vi.spyOn(s, "tick").mockRejectedValue(new Error("boom"));
      s.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(logs.join("\n")).toMatch(/boom/);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("defesas", () => {
  it("lista vazia de endereços: 400", async () => {
    const s = service();
    s.setEmailSender(makeEmail());
    expect((await httpErrorOf(s.setEmailRecipients([], "admin"))).code).toBe("invalid_recipient");
  });

  it("falha ao gravar no disco: vai para o log, sem derrubar a ação", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "notifications.json"));
    const s = service();
    await connected(s);
    await s.flush();
    expect((await s.status()).telegram.state).toBe("connected");
    expect(logs.join("\n")).toMatch(/não foi possível gravar/);
  });

  it("auditoria que falha não derruba a ação; padrões de relógio e log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const s = new NotificationService({
        dataDir: dir,
        telegram,
        audit: { record: async () => Promise.reject(new Error("disco cheio")) },
      });
      await s.setTelegramToken(TOKEN, "admin");
      const st = await s.connectTelegram("admin");
      expect(Date.parse(st.telegram.connectedAt!)).toBeGreaterThan(0);
      // arquivo adulterado + log padrão (console.warn)
      const file = path.join(dir, "notifications.json");
      await s.flush();
      const data = JSON.parse(await readFile(file, "utf8"));
      data.telegram.token.tag = Buffer.alloc(16).toString("base64");
      await writeFile(file, JSON.stringify(data));
      expect((await new NotificationService({ dataDir: dir, telegram }).status()).telegram.state).toBe("none");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("casos de borda do envio", () => {
  it("arquivos gravados sem os campos (versão antiga): completa com o padrão", async () => {
    await writeFile(path.join(dir, "notifications.json"), "{}");
    await writeFile(path.join(dir, "notifications-history.json"), "{}");
    const st = await service().status();
    expect(st.email.recipients).toEqual([]);
    expect(st.kinds.security).toBe(true);
    expect(st.history).toEqual([]);
  });

  it("servidor de e-mail 'não pronto' sem motivo: texto padrão", async () => {
    const s = service();
    s.setEmailSender({ readiness: async () => ({ ready: false, reason: null, from: null }), send: async () => undefined });
    expect((await s.status()).email.unavailableReason).toMatch(/não está pronto/);
  });

  it("link do painel sem tela específica: só o endereço; barra final removida", async () => {
    const s = service({ panelUrl: async () => "https://painel.exemplo.com.br/" });
    await connected(s);
    await s.testTelegram("admin");
    expect(telegram.sent[0]!.text.endsWith("Abrir o painel: https://painel.exemplo.com.br")).toBe(true);
  });

  it("repetiu uma vez só; resumo leva o link da tela", async () => {
    const s = service({ panelUrl: async () => "https://painel.exemplo.com.br" });
    await connected(s);
    await s.notify({ kind: "security", key: "k", title: "Porta nova", path: "/alerts" });
    await s.notify({ kind: "security", key: "k", title: "Porta nova", path: "/alerts" });
    clock += 11 * 60_000;
    await s.tick();
    expect(telegram.sent[1]!.text).toMatch(/repetiu 1 vez nos/);
    expect(telegram.sent[1]!.text).toContain("https://painel.exemplo.com.br/alerts");
  });

  it("e-mail recusado de vez (erro permanente, não-Error): falha registrada e no log", async () => {
    const s = service();
    const email = makeEmail();
    s.setEmailSender({
      readiness: email.readiness,
      send: async () => {
        throw Object.assign(new Error("550 caixa inexistente <a@exemplo.org>"), { permanent: true });
      },
    });
    await s.setEmailRecipients(["a@exemplo.org"], "admin");
    await s.notify({ kind: "deploy", key: "d", title: "Deploy falhou" });
    const st = await s.status();
    expect(st.history[0]).toMatchObject({ status: "failed", detail: "550 caixa inexistente <[endereço]>" });
    expect(logs.join("\n")).toMatch(/pelo e-mail/);
    s.setEmailSender({
      readiness: email.readiness,
      send: async () => {
        throw "texto solto";
      },
    });
    expect((await httpErrorOf(s.testEmail("admin"))).message).toContain("texto solto");
  });

  it("limite por hora no e-mail: resumo sai para cada endereço; sem vaga ainda, espera", async () => {
    const s = service({ maxPerHour: 1 });
    const email = makeEmail();
    s.setEmailSender(email);
    await s.setEmailRecipients(["a@exemplo.org", "b@exemplo.org"], "admin");
    await s.notify({ kind: "disk", key: "1", title: "Um" });
    await s.notify({ kind: "disk", key: "2", title: "Dois" });
    expect(email.sent).toHaveLength(2);
    clock += 30 * 60_000;
    await s.tick();
    expect(email.sent).toHaveLength(2);
    clock += 31 * 60_000;
    await s.tick();
    expect(email.sent.map((m) => m.to)).toEqual(["a@exemplo.org", "b@exemplo.org", "a@exemplo.org", "b@exemplo.org"]);
    expect(email.sent[2]!.subject).toMatch(/1 avisos não foram enviados/);
  });

  it("tick que rejeita com valor que não é Error: vai para o log", async () => {
    vi.useFakeTimers();
    try {
      const s = service();
      vi.spyOn(s, "tick").mockRejectedValue("falhou");
      s.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(logs.join("\n")).toMatch(/falhou/);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("maskSensitive", () => {
  it("mascara IPv4, IPv6 e nomes sslip.io; mantém o resto", () => {
    expect(maskSensitive("Porta em 203.0.113.10 e 2001:db8::1, via 203-0-113-10.sslip.io; versão 1.2.3")).toBe(
      "Porta em [IP oculto] e [IP oculto], via [endereço pelo IP]; versão 1.2.3",
    );
    // horário não é IPv6
    expect(maskSensitive("às 12:00:00")).toBe("às 12:00:00");
  });
});

// o tipo de status precisa continuar sem o token (guarda contra regressão)
const _semToken: keyof NotificationsStatus["telegram"] extends "token" ? never : true = true;
void _semToken;
