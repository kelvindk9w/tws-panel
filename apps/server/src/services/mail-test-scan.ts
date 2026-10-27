/**
 * mail-test-scan.ts — varredura das variáveis de e-mail que a caixa de teste NÃO controla.
 *
 * Com a caixa ligada, o painel injeta o conjunto completo de variáveis de SMTP que conhece (inclusive URL única)
 * em todos os containers, acima do .env versionado, do `environment:`/`env_file:` do compose e do ENV do Dockerfile.
 * Mas ele não bloqueia a rede: um nome que ele não conhece (ou um provedor de e-mail por API HTTP) continua
 * valendo. Esta varredura lê o .env* da raiz, o compose, os env_file que ele cita e os Dockerfile da raiz, junto
 * com os nomes das Variáveis do painel, e devolve os NOMES de aparência de e-mail que não estão no conjunto
 * redirecionado, para a tela avisar. Nunca lê nem devolve valores; só arquivos regulares dentro da pasta do
 * projeto (sem seguir link); tamanho e quantidade limitados.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MailTestUncontrolled } from "@paas/core";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 24;
const MAX_RESULTS = 40;

const MAIL_WORD = /(?:^|_)(?:SMTP|MAIL|MAILER|EMAIL)(?:_|$)/;
const SMTP_SUFFIX = /(?:HOST|URL|URI|DSN|SERVER|ADDRESS|TRANSPORT|DRIVER|MAILER|SCHEME|ENDPOINT|RELAY)$/;
const NOT_DELIVERY = /(?:^|_)(?:FROM|REPLY|SENDER|NAME|SUBJECT|TO|TEMPLATE|LOGO)(?:_|$)/;
const API_PROVIDER = /(?:^|_)(?:SENDGRID|RESEND|MAILGUN|POSTMARK|MANDRILL|SPARKPOST|BREVO|SENDINBLUE|MAILJET|SES|MAILERSEND|SMTP2GO|ELASTICEMAIL)(?:_|$)/;
const API_SUFFIX = /(?:KEY|TOKEN|SECRET|API|URL|ENDPOINT)$/;

/** O que o nome parece ser, ou null se não parece de e-mail (ou se é só remetente/assunto). */
export function mailVariableKind(name: string): "smtp" | "api" | null {
  if (API_PROVIDER.test(name) && API_SUFFIX.test(name)) return "api";
  if (MAIL_WORD.test(name) && SMTP_SUFFIX.test(name) && !NOT_DELIVERY.test(name)) return "smtp";
  return null;
}

async function readRegular(file: string, root: string): Promise<string | null> {
  try {
    const resolved = path.resolve(file);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    const st = await lstat(resolved);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) return null;
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

/** Nomes definidos num .env ou no `environment:` de um compose: `NOME=valor`, `NOME: valor`, `- NOME=valor`. */
function definedNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?(?:-\s*)?["']?([A-Z][A-Z0-9_]*)["']?\s*[:=]/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Nomes de ENV/ARG num Dockerfile (`ENV A=1 B=2`, `ENV A 1`, `ARG A`). */
function dockerfileNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(ENV|ARG)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const rest = m[2]!;
    const pairs = [...rest.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)].map((x) => x[1]!);
    if (pairs.length > 0) out.push(...pairs);
    else {
      const first = /^([A-Z][A-Z0-9_]*)\b/.exec(rest);
      if (first) out.push(first[1]!);
    }
  }
  return out;
}

/** Caminhos citados em `env_file:` (valor na mesma linha ou lista). */
function envFileRefs(compose: string): string[] {
  const refs: string[] = [];
  const lines = compose.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)env_file:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const inline = m[2]!.replace(/#.*$/, "").trim();
    if (inline) {
      for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
        const v = part.trim().replace(/^["']|["']$/g, "");
        if (v) refs.push(v);
      }
      continue;
    }
    const indent = m[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "") continue;
      const lead = l.length - l.trimStart().length;
      if (lead <= indent) break;
      const item = /^\s*-\s*(?:path:\s*)?["']?([^"'#\s]+)["']?/.exec(l);
      if (item) refs.push(item[1]!);
    }
  }
  return refs;
}

export async function scanUncontrolledMail(opts: {
  /** Pasta do código do projeto (null = ainda sem código). */
  srcDir: string | null;
  composeFile: string | null;
  /** Nomes das Variáveis salvas no painel. */
  panelNames: string[];
  /** Nomes que a caixa de teste redireciona (não entram no aviso). */
  controlled: ReadonlySet<string>;
}): Promise<MailTestUncontrolled[]> {
  const found = new Map<string, MailTestUncontrolled>();
  const add = (name: string, file: string): void => {
    const kind = mailVariableKind(name);
    if (!kind || opts.controlled.has(name) || found.size >= MAX_RESULTS) return;
    const key = `${file}\0${name}`;
    if (!found.has(key)) found.set(key, { name, file, kind });
  };

  for (const name of opts.panelNames) add(name, "Variáveis do painel");

  if (opts.srcDir) {
    const root = path.resolve(opts.srcDir);
    const read = new Set<string>();
    let budget = MAX_FILES;
    const scan = async (rel: string, parse: (text: string) => string[]): Promise<string | null> => {
      const abs = path.resolve(root, rel);
      const shown = path.relative(root, abs) || rel;
      if (read.has(abs) || budget <= 0) return null;
      read.add(abs);
      const text = await readRegular(abs, root);
      if (text === null) return null;
      budget--;
      for (const name of parse(text)) add(name, shown);
      return text;
    };

    let entries: string[] = [];
    try {
      entries = (await readdir(root)).sort();
    } catch {
      // pasta ilegível: só as Variáveis do painel valem
    }
    for (const entry of entries) {
      if (/^\.env(?:\.|$)/.test(entry)) await scan(entry, definedNames);
      else if (/^Dockerfile(?:\.|$)/i.test(entry) || /\.dockerfile$/i.test(entry)) await scan(entry, dockerfileNames);
    }
    if (opts.composeFile) {
      const composeDir = path.dirname(path.resolve(root, opts.composeFile));
      const compose = await scan(opts.composeFile, definedNames);
      if (compose !== null) {
        for (const ref of envFileRefs(compose)) await scan(path.relative(root, path.resolve(composeDir, ref)), definedNames);
      }
    }
  }
  return [...found.values()].slice(0, MAX_RESULTS);
}
