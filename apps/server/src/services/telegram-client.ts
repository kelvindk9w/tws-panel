/**
 * telegram-client.ts — o mínimo da API de robôs do Telegram que as
 * notificações usam: getMe (conferir o token), getUpdates (descobrir a
 * conversa depois do /start) e sendMessage (texto simples).
 *
 * O token do robô vai NA URL (https://api.telegram.org/bot<token>/método) —
 * é assim que a API funciona. Por isso nenhuma mensagem de erro daqui repete
 * a URL ou o texto de erro da camada de rede (que pode citá-la): só o código
 * do problema e a descrição que o próprio Telegram devolveu.
 */

export interface TelegramFetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export type TelegramFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<TelegramFetchResponse>;

export type TelegramErrorCode =
  | "invalid_token"
  | "chat_not_found"
  | "blocked"
  | "webhook_active"
  | "rate_limited"
  | "network"
  | "api_error";

export class TelegramError extends Error {
  constructor(
    public readonly code: TelegramErrorCode,
    message: string,
    /** Tentar de novo não resolve (token errado, robô bloqueado…). */
    public readonly permanent: boolean,
    /** 429: quanto o Telegram pediu para esperar. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface TelegramChat {
  chatId: string;
  title: string;
  type: string;
}

export interface TelegramClient {
  getMe(token: string): Promise<{ username: string; name: string }>;
  /** Conversa da atualização mais recente (null = nenhuma mensagem ainda). */
  findLatestChat(token: string): Promise<TelegramChat | null>;
  sendMessage(token: string, chatId: string, text: string): Promise<void>;
}

export interface TelegramClientOptions {
  fetch?: TelegramFetch;
  baseUrl?: string;
  /** Tempo máximo de cada pedido (padrão 15 s). */
  timeoutMs?: number;
}

interface ApiReply {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: number };
}

interface RawChat {
  id?: number | string;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

function chatTitle(chat: RawChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  if (name) return name;
  if (chat.username) return `@${chat.username}`;
  return `Conversa ${String(chat.id)}`;
}

function errorFor(status: number, body: ApiReply): TelegramError {
  const description = typeof body.description === "string" ? body.description : "";
  if (status === 401 || status === 404) {
    return new TelegramError(
      "invalid_token",
      "O Telegram não reconheceu o token. Copie de novo a linha inteira que o @BotFather mandou (números, dois-pontos e letras).",
      true,
    );
  }
  if (status === 409) {
    return new TelegramError(
      "webhook_active",
      "Este robô está ligado a um webhook (outro sistema recebe as mensagens dele). Use um robô só para o painel.",
      true,
    );
  }
  if (status === 429) {
    const after = body.parameters?.retry_after;
    return new TelegramError(
      "rate_limited",
      "O Telegram pediu para esperar antes de mandar mais mensagens.",
      false,
      typeof after === "number" ? after * 1000 : null,
    );
  }
  if (status === 403) {
    return new TelegramError(
      "blocked",
      "O robô não pode falar nessa conversa (foi bloqueado ou removido). Abra a conversa com ele, mande /start e conecte de novo.",
      true,
    );
  }
  if (status === 400 && /chat not found/i.test(description)) {
    return new TelegramError(
      "chat_not_found",
      "O Telegram não achou a conversa. Mande /start para o robô e conecte de novo.",
      true,
    );
  }
  if (status >= 400 && status < 500) {
    return new TelegramError("api_error", `O Telegram recusou: ${description || `erro ${status}`}.`, true);
  }
  return new TelegramError("api_error", `O Telegram respondeu com erro (${status}). Tente de novo em instantes.`, false);
}

export function createTelegramClient(opts: TelegramClientOptions = {}): TelegramClient {
  const baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch: TelegramFetch = opts.fetch ?? ((url, init) => fetch(url, init));

  async function call(token: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: TelegramFetchResponse;
    try {
      res = await doFetch(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      // A mensagem original pode conter a URL (com o token): não repassa.
      throw new TelegramError("network", "Não foi possível falar com o Telegram (sem resposta). Confira a internet da VPS.", false);
    } finally {
      clearTimeout(timer);
    }
    let body: ApiReply;
    try {
      body = (await res.json()) as ApiReply;
    } catch {
      body = {};
    }
    if (res.status !== 200 || body.ok !== true) {
      throw errorFor(res.status === 200 ? 502 : res.status, body);
    }
    return body.result;
  }

  return {
    async getMe(token) {
      const result = (await call(token, "getMe", {})) as { username?: string; first_name?: string } | undefined;
      if (!result?.username) {
        throw new TelegramError("api_error", "O Telegram respondeu sem o nome do robô. Tente de novo.", false);
      }
      return { username: result.username, name: result.first_name ?? result.username };
    },

    async findLatestChat(token) {
      const result = await call(token, "getUpdates", { limit: 100, timeout: 0 });
      if (!Array.isArray(result)) return null;
      for (const update of [...(result as Array<Record<string, { chat?: RawChat } | undefined>>)].reverse()) {
        const source = update.message ?? update.edited_message ?? update.channel_post ?? update.my_chat_member;
        const chat = source?.chat;
        if (chat && chat.id !== undefined) {
          return { chatId: String(chat.id), title: chatTitle(chat), type: chat.type ?? "private" };
        }
      }
      return null;
    },

    async sendMessage(token, chatId, text) {
      await call(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
    },
  };
}
