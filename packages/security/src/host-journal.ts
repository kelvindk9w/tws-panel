/**
 * host-journal.ts — leitura SOMENTE LEITURA do journal (systemd) da VPS para a página "Logs do servidor".
 *
 * Só duas fontes, com unidades FIXAS: o Docker (`docker.service`) e o SSH (`ssh.service`/`sshd.service`, o nome
 * depende da distribuição). O comando é sempre `journalctl` com as mesmas opções; a única coisa que varia é a
 * quantidade de linhas (inteiro de 1 a 2000) e o início da janela (segundos desde a época, convertido em data UTC
 * montada aqui). Nada vindo do cliente vira texto de shell: a allowlist recompõe o comando a partir desses dois
 * números e compara byte a byte com o recebido.
 *
 * O journal do SSH traz endereços IP de quem tentou entrar. É de propósito (o dono da VPS precisa ver), e por isso
 * a rota que lê isto é só de sessão (nenhum token de API alcança; ver token-policy-table.ts).
 */

/** Fontes do journal que o painel sabe ler, com as unidades de cada uma. */
export const JOURNAL_SOURCES = {
  docker: ["docker.service"],
  ssh: ["ssh.service", "sshd.service"],
} as const;

export type JournalSource = keyof typeof JOURNAL_SOURCES;

export const JOURNAL_LINES_MAX = 2000;

export function isJournalSource(value: string): value is JournalSource {
  return Object.prototype.hasOwnProperty.call(JOURNAL_SOURCES, value);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Segundos desde a época → "AAAA-MM-DD HH:MM:SS UTC" (formato que o journalctl entende). */
export function journalTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/**
 * Comando de leitura. `sinceEpoch` = início da janela (segundos) ou null. SEM pipe: o código de saída é o do
 * próprio `journalctl`, então uma falha dele (permissão, journal corrompido) aparece como "indisponível" e não como
 * "sem linhas". O corte de linhas longas (e dos caracteres UTF-8) é feito em Node, que também limita a resposta.
 */
export function buildJournalCommand(source: JournalSource, lines: number, sinceEpoch: number | null): string {
  if (!isJournalSource(source)) throw new Error("fonte do journal desconhecida");
  if (!Number.isInteger(lines) || lines < 1 || lines > JOURNAL_LINES_MAX) throw new Error("quantidade de linhas inválida");
  if (sinceEpoch !== null && (!Number.isInteger(sinceEpoch) || sinceEpoch < 1_000_000_000 || sinceEpoch > 9_999_999_999)) {
    throw new Error("início da janela inválido");
  }
  const units = JOURNAL_SOURCES[source].map((u) => `-u ${u}`).join(" ");
  const since = sinceEpoch === null ? "" : ` --since '${journalTimestamp(sinceEpoch)}'`;
  return `journalctl ${units} --no-pager -q -o short-iso --utc -n ${lines}${since}`;
}

const COMMAND_RE =
  /^journalctl (?:-u [a-z.]+ )+--no-pager -q -o short-iso --utc -n (\d{1,4})(?: --since '(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC')?$/;

/** true só para um comando que o próprio buildJournalCommand montaria. */
export function isJournalCommand(cmd: string): boolean {
  const m = COMMAND_RE.exec(cmd);
  if (!m) return false;
  const lines = Number(m[1]);
  let since: number | null = null;
  if (m[2] !== undefined) {
    since = Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])) / 1000;
  }
  return (Object.keys(JOURNAL_SOURCES) as JournalSource[]).some((source) => {
    try {
      return buildJournalCommand(source, lines, since) === cmd;
    } catch {
      return false;
    }
  });
}

export interface JournalLine {
  /** ISO 8601 (UTC). */
  time: string | null;
  text: string;
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)) (.*)$/;

/** Interpreta a saída `short-iso`; linha sem horário (continuação) fica com time null. */
export function parseJournalOutput(output: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("-- ")) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      out.push({ time: null, text: line });
      continue;
    }
    const iso = m[1]!.replace(",", ".").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(iso);
    out.push({ time: Number.isNaN(ms) ? null : new Date(ms).toISOString(), text: m[2]! });
  }
  return out;
}
