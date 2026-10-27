/**
 * mail-test-client.ts — fala com a API do Mailpit de um projeto (a que o painel alcança pela rede
 * interna; nada disso é público). Devolve só o que a tela usa, já no formato do painel.
 *
 * O conteúdo das mensagens é texto NÃO CONFIÁVEL (vem do app do projeto, e este pode ter recebido
 * qualquer coisa): aqui ele só é lido e normalizado; quem o mostra (a rota do HTML) é quem o
 * isola — CSP, sandbox, sem scripts nem imagens remotas.
 */
import type { MailTestAddress, MailTestAttachment, MailTestListResponse, MailTestMessage, MailTestMessageSummary } from "@paas/core";
import { httpError } from "./http-error.js";

export interface MailpitClientOptions {
  baseUrl: string;
  user: string;
  password: string;
  fetch?: typeof fetch;
  /** Tempo máximo de cada chamada (ms). */
  timeoutMs?: number;
}

/** Teto de um anexo baixado pelo painel (a memória do painel não é do Mailpit). */
export const MAILTEST_PART_MAX_BYTES = 25 * 1024 * 1024;
/** Teto do JSON de uma mensagem (HTML grande demais não vale a pena abrir). */
const JSON_MAX_BYTES = 15 * 1024 * 1024;

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function address(v: unknown): MailTestAddress | null {
  if (!isObject(v)) return null;
  const a = str(v.Address);
  return a || str(v.Name) ? { name: str(v.Name), address: a } : null;
}

function addresses(v: unknown): MailTestAddress[] {
  return Array.isArray(v) ? v.map(address).filter((a): a is MailTestAddress => a !== null) : [];
}

function summary(m: Raw): MailTestMessageSummary {
  return {
    id: str(m.ID),
    subject: str(m.Subject),
    from: address(m.From),
    to: addresses(m.To),
    created: str(m.Created),
    read: m.Read === true,
    size: num(m.Size),
    attachments: num(m.Attachments),
    snippet: str(m.Snippet),
  };
}

/** Endereços http(s) do corpo (texto e atributos href), sem repetir, no máximo 50. */
export function extractLinks(text: string, html: string): string[] {
  const found = new Set<string>();
  const add = (raw: string): void => {
    const url = raw.replace(/&amp;/gi, "&").replace(/[)\].,;>"']+$/, "");
    if (/^https?:\/\/[^\s<>"']+$/i.test(url) && url.length <= 2000) found.add(url);
  };
  for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add((m[1] ?? m[2] ?? "").trim());
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(m[0]);
  return [...found].slice(0, 50);
}

export class MailpitClient {
  private readonly doFetch: typeof fetch;
  private readonly auth: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: MailpitClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.opts.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: this.auth,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw httpError(502, "mail_test_unreachable", "Não foi possível falar com a caixa de teste agora. Ela pode estar iniciando; tente de novo em instantes.");
    }
    if (res.status === 404) throw httpError(404, "mail_test_message_not_found", "Mensagem não encontrada (talvez já tenha sido apagada).");
    if (!res.ok) throw httpError(502, "mail_test_error", `A caixa de teste respondeu com erro (${res.status}).`);
    return res;
  }

  private async json(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const res = await this.call(path, init);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > JSON_MAX_BYTES) throw httpError(413, "mail_test_too_large", "A mensagem é grande demais para abrir no painel.");
    const text = await res.text();
    if (text.length > JSON_MAX_BYTES) throw httpError(413, "mail_test_too_large", "A mensagem é grande demais para abrir no painel.");
    try {
      return text === "" ? {} : JSON.parse(text);
    } catch {
      throw httpError(502, "mail_test_error", "A caixa de teste respondeu algo que o painel não entendeu.");
    }
  }

  async list(start: number, limit: number): Promise<MailTestListResponse> {
    const raw = await this.json(`/api/v1/messages?start=${start}&limit=${limit}`);
    const r = isObject(raw) ? raw : {};
    return {
      total: num(r.total ?? r.messages_count),
      unread: num(r.unread ?? r.messages_unread),
      start: num(r.start),
      messages: (Array.isArray(r.messages) ? r.messages : []).filter(isObject).map(summary),
    };
  }

  /** Só os totais (para o cartão do projeto, sem trazer a lista). */
  async counts(): Promise<{ total: number; unread: number }> {
    const { total, unread } = await this.list(0, 1);
    return { total, unread };
  }

  /** A mensagem inteira (texto, cabeçalhos, anexos). O HTML NÃO vai aqui: tem rota própria, isolada. */
  async message(id: string): Promise<{ message: MailTestMessage; html: string; inline: Array<{ partId: string; contentId: string }> }> {
    const [raw, rawHeaders] = await Promise.all([
      this.json(`/api/v1/message/${encodeURIComponent(id)}`),
      this.json(`/api/v1/message/${encodeURIComponent(id)}/headers`).catch(() => ({})),
    ]);
    const m = isObject(raw) ? raw : {};
    const attachment = (inline: boolean) => (a: unknown): MailTestAttachment | null =>
      isObject(a) ? { partId: str(a.PartID), fileName: str(a.FileName), contentType: str(a.ContentType), size: num(a.Size), inline } : null;
    const list = [
      ...(Array.isArray(m.Attachments) ? m.Attachments.map(attachment(false)) : []),
      ...(Array.isArray(m.Inline) ? m.Inline.map(attachment(true)) : []),
    ].filter((a): a is MailTestAttachment => a !== null && a.partId !== "");
    const headers: Array<{ name: string; value: string }> = [];
    if (isObject(rawHeaders)) {
      for (const [name, values] of Object.entries(rawHeaders)) {
        for (const value of Array.isArray(values) ? values : [values]) if (typeof value === "string") headers.push({ name, value });
      }
    }
    const text = str(m.Text);
    const html = str(m.HTML);
    const inline = (Array.isArray(m.Inline) ? m.Inline : [])
      .filter(isObject)
      .map((a) => ({ partId: str(a.PartID), contentId: str(a.ContentID) }))
      .filter((a) => a.partId !== "" && a.contentId !== "");
    const base = summary({ ...m, Created: m.Date ?? m.Created, Read: true, Attachments: list.filter((a) => !a.inline).length });
    return {
      message: {
        ...base,
        id: str(m.ID) || id,
        cc: addresses(m.Cc),
        bcc: addresses(m.Bcc),
        replyTo: addresses(m.ReplyTo),
        text,
        hasHtml: html !== "",
        headers,
        attachmentList: list,
        links: extractLinks(text, html),
      },
      html,
      inline,
    };
  }

  /** Uma parte (anexo ou imagem embutida). Passa do teto: recusa sem ler tudo. */
  async part(id: string, partId: string): Promise<{ body: Buffer; contentType: string }> {
    const res = await this.call(`/api/v1/message/${encodeURIComponent(id)}/part/${encodeURIComponent(partId)}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAILTEST_PART_MAX_BYTES) throw httpError(413, "mail_test_too_large", "O anexo é grande demais para baixar pelo painel.");
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAILTEST_PART_MAX_BYTES) throw httpError(413, "mail_test_too_large", "O anexo é grande demais para baixar pelo painel.");
    return { body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  /** Apaga uma mensagem (`ids`) ou todas (sem `ids`). */
  async remove(ids?: string[]): Promise<void> {
    await this.call("/api/v1/messages", { method: "DELETE", ...(ids ? { body: { IDs: ids } } : {}) });
  }
}
