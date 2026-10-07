/**
 * telegram-client.test.ts — conversa com a API de robôs do Telegram
 * (getMe, getUpdates, sendMessage) com o HTTP simulado. O token vai na URL
 * (é assim que a API funciona) e por isso nunca pode aparecer numa mensagem
 * de erro.
 */
import { describe, expect, it, vi } from "vitest";
import { createTelegramClient, TelegramError, type TelegramFetch } from "../src/services/telegram-client.js";

const TOKEN = "123456789:AAEXEMPLOxxxxxxxxxxxxxxxxxxxxxxxxxx";

function reply(status: number, body: unknown): Awaited<ReturnType<TelegramFetch>> {
  return { status, json: async () => body };
}

function fakeFetch(handler: (method: string, body: Record<string, unknown> | null) => Awaited<ReturnType<TelegramFetch>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetch: TelegramFetch = vi.fn(async (url, init) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const method = url.slice(url.lastIndexOf("/") + 1);
    return handler(method, body);
  });
  return { fetch, calls };
}

async function errorOf(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain("AAEXEMPLO");
    return err as TelegramError;
  }
  throw new Error("esperava erro");
}

describe("getMe", () => {
  it("confere o token e devolve o @ do robô", async () => {
    const { fetch, calls } = fakeFetch(() =>
      reply(200, { ok: true, result: { id: 1, is_bot: true, first_name: "Avisos", username: "meu_painel_bot" } }),
    );
    const client = createTelegramClient({ fetch });
    expect(await client.getMe(TOKEN)).toEqual({ username: "meu_painel_bot", name: "Avisos" });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it.each([401, 404])("token recusado (%i): erro invalid_token, sem o token na mensagem", async (status) => {
    const { fetch } = fakeFetch(() => reply(status, { ok: false, error_code: status, description: "Unauthorized" }));
    const err = await errorOf(createTelegramClient({ fetch }).getMe(TOKEN));
    expect(err.code).toBe("invalid_token");
    expect(err.permanent).toBe(true);
  });

  it("sem resposta (rede): erro network, temporário", async () => {
    const fetch: TelegramFetch = async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`);
    };
    const err = await errorOf(createTelegramClient({ fetch }).getMe(TOKEN));
    expect(err.code).toBe("network");
    expect(err.permanent).toBe(false);
  });

  it("resposta sem JSON válido: erro api_error", async () => {
    const fetch: TelegramFetch = async () => ({ status: 502, json: async () => Promise.reject(new Error("html")) });
    const err = await errorOf(createTelegramClient({ fetch }).getMe(TOKEN));
    expect(err.code).toBe("api_error");
    expect(err.permanent).toBe(false);
  });

  it("robô sem nome de exibição: usa o @", async () => {
    const { fetch } = fakeFetch(() => reply(200, { ok: true, result: { username: "so_bot" } }));
    expect(await createTelegramClient({ fetch }).getMe(TOKEN)).toEqual({ username: "so_bot", name: "so_bot" });
  });

  it("robô sem @ (resposta estranha): api_error", async () => {
    const { fetch } = fakeFetch(() => reply(200, { ok: true, result: { id: 1 } }));
    const err = await errorOf(createTelegramClient({ fetch }).getMe(TOKEN));
    expect(err.code).toBe("api_error");
  });

  it("tempo esgotado vira erro network", async () => {
    const fetch: TelegramFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const err = await errorOf(createTelegramClient({ fetch, timeoutMs: 10 }).getMe(TOKEN));
    expect(err.code).toBe("network");
  });
});

describe("findLatestChat", () => {
  it("pega a conversa da mensagem mais recente (pessoa: nome e sobrenome)", async () => {
    const { fetch } = fakeFetch(() =>
      reply(200, {
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 111, type: "private", first_name: "Antiga" }, text: "oi" } },
          {
            update_id: 2,
            message: { chat: { id: 222, type: "private", first_name: "Maria", last_name: "Silva" }, text: "/start" },
          },
        ],
      }),
    );
    expect(await createTelegramClient({ fetch }).findLatestChat(TOKEN)).toEqual({
      chatId: "222",
      title: "Maria Silva",
      type: "private",
    });
  });

  it("grupo (robô adicionado) e canal: usa o título; pessoa só com @: usa o @", async () => {
    const group = fakeFetch(() =>
      reply(200, {
        ok: true,
        result: [{ update_id: 5, my_chat_member: { chat: { id: -100, type: "supergroup", title: "Equipe" } } }],
      }),
    );
    expect(await createTelegramClient({ fetch: group.fetch }).findLatestChat(TOKEN)).toEqual({
      chatId: "-100",
      title: "Equipe",
      type: "supergroup",
    });
    const channel = fakeFetch(() =>
      reply(200, { ok: true, result: [{ update_id: 6, channel_post: { chat: { id: -200, type: "channel", title: "Avisos" } } }] }),
    );
    expect((await createTelegramClient({ fetch: channel.fetch }).findLatestChat(TOKEN))?.title).toBe("Avisos");
    const handle = fakeFetch(() =>
      reply(200, { ok: true, result: [{ update_id: 7, edited_message: { chat: { id: 9, type: "private", username: "maria" } } }] }),
    );
    expect((await createTelegramClient({ fetch: handle.fetch }).findLatestChat(TOKEN))?.title).toBe("@maria");
    const nameless = fakeFetch(() => reply(200, { ok: true, result: [{ update_id: 8, message: { chat: { id: 10 } } }] }));
    expect(await createTelegramClient({ fetch: nameless.fetch }).findLatestChat(TOKEN)).toEqual({
      chatId: "10",
      title: "Conversa 10",
      type: "private",
    });
  });

  it("nenhuma mensagem ainda: null", async () => {
    const { fetch } = fakeFetch(() => reply(200, { ok: true, result: [{ update_id: 1, poll: {} }] }));
    expect(await createTelegramClient({ fetch }).findLatestChat(TOKEN)).toBeNull();
    const empty = fakeFetch(() => reply(200, { ok: true, result: "estranho" }));
    expect(await createTelegramClient({ fetch: empty.fetch }).findLatestChat(TOKEN)).toBeNull();
  });

  it("robô com webhook (409): explica que outro sistema recebe as mensagens", async () => {
    const { fetch } = fakeFetch(() => reply(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" }));
    const err = await errorOf(createTelegramClient({ fetch }).findLatestChat(TOKEN));
    expect(err.code).toBe("webhook_active");
    expect(err.message).toMatch(/webhook/i);
  });
});

describe("sendMessage", () => {
  it("manda texto simples (sem formatação) para a conversa", async () => {
    const { fetch, calls } = fakeFetch(() => reply(200, { ok: true, result: { message_id: 1 } }));
    await createTelegramClient({ fetch }).sendMessage(TOKEN, "222", "Olá");
    expect(calls[0]!.url).toMatch(/\/sendMessage$/);
    expect(calls[0]!.body).toEqual({ chat_id: "222", text: "Olá", disable_web_page_preview: true });
  });

  it("conversa não encontrada (400) e robô bloqueado (403): permanentes", async () => {
    const notFound = fakeFetch(() => reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    const e1 = await errorOf(createTelegramClient({ fetch: notFound.fetch }).sendMessage(TOKEN, "1", "x"));
    expect(e1.code).toBe("chat_not_found");
    expect(e1.permanent).toBe(true);
    const blocked = fakeFetch(() => reply(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
    const e2 = await errorOf(createTelegramClient({ fetch: blocked.fetch }).sendMessage(TOKEN, "1", "x"));
    expect(e2.code).toBe("blocked");
    expect(e2.permanent).toBe(true);
  });

  it("400 sem descrição e 200 com ok:false: mensagens genéricas", async () => {
    const semDescricao = fakeFetch(() => reply(400, { ok: false }));
    expect((await errorOf(createTelegramClient({ fetch: semDescricao.fetch }).sendMessage(TOKEN, "1", "x"))).message).toMatch(/erro 400/);
    const okFalse = fakeFetch(() => reply(200, { ok: false }));
    const err = await errorOf(createTelegramClient({ fetch: okFalse.fetch }).sendMessage(TOKEN, "1", "x"));
    expect(err.code).toBe("api_error");
    expect(err.permanent).toBe(false);
  });

  it("outro 400: api_error permanente, com a descrição do Telegram", async () => {
    const { fetch } = fakeFetch(() => reply(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" }));
    const err = await errorOf(createTelegramClient({ fetch }).sendMessage(TOKEN, "1", "x"));
    expect(err.code).toBe("api_error");
    expect(err.permanent).toBe(true);
    expect(err.message).toContain("message is too long");
  });

  it("limite do Telegram (429): temporário, com o tempo de espera pedido", async () => {
    const { fetch } = fakeFetch(() =>
      reply(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 33 } }),
    );
    const err = await errorOf(createTelegramClient({ fetch }).sendMessage(TOKEN, "1", "x"));
    expect(err.code).toBe("rate_limited");
    expect(err.permanent).toBe(false);
    expect(err.retryAfterMs).toBe(33_000);
    const semTempo = fakeFetch(() => reply(429, { ok: false }));
    expect((await errorOf(createTelegramClient({ fetch: semTempo.fetch }).sendMessage(TOKEN, "1", "x"))).retryAfterMs).toBeNull();
  });

  it("erro do servidor do Telegram (5xx): temporário", async () => {
    const { fetch } = fakeFetch(() => reply(500, {}));
    const err = await errorOf(createTelegramClient({ fetch }).sendMessage(TOKEN, "1", "x"));
    expect(err.code).toBe("api_error");
    expect(err.permanent).toBe(false);
  });
});

describe("fetch padrão", () => {
  it("sem fetch injetado usa o fetch do Node (servidor HTTP local no lugar do Telegram)", async () => {
    const { createServer } = await import("node:http");
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { username: "meu_painel_bot", first_name: "Avisos" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const client = createTelegramClient({ baseUrl: `http://127.0.0.1:${port}` });
      expect(await client.getMe(TOKEN)).toEqual({ username: "meu_painel_bot", name: "Avisos" });
      expect(seen).toEqual([`POST /bot${TOKEN}/getMe`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
