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
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { MailTestUncontrolled } from "@paas/core";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 24;
const MAX_RESULTS = 40;

const MAIL_WORD = /(?:^|_)(?:SMTP|MAIL|MAILER|EMAIL)(?:_|$)/;
const SMTP_SUFFIX = /(?:HOST|URL|URI|DSN|SERVER|ADDRESS|ADDR|TRANSPORT|DRIVER|MAILER|SCHEME|ENDPOINT|RELAY)$/;
const NOT_DELIVERY = /(?:^|_)(?:FROM|REPLY|SENDER|NAME|SUBJECT|TO|TEMPLATE|LOGO)(?:_|$)/;
const API_PROVIDER = /(?:^|_)(?:SENDGRID|RESEND|MAILGUN|POSTMARK|MANDRILL|SPARKPOST|BREVO|SENDINBLUE|MAILJET|SES|MAILERSEND|SMTP2GO|ELASTICEMAIL)(?:_|$)/;
const API_SUFFIX = /(?:KEY|TOKEN|SECRET|API|URL|ENDPOINT)$/;

/**
 * O que o nome parece ser, ou null se não parece de e-mail (ou se é só remetente/assunto). Aceita minúsculas e `__`
 * como separador (Ghost: mail__options__host; Gitea: GITEA__mailer__SMTP_ADDR): a comparação é feita em maiúsculas,
 * com `__` tratado como `_`. Um nome sem separador (uma chave `mailer:` do YAML, por exemplo) não é variável.
 */
export function mailVariableKind(name: string): "smtp" | "api" | null {
  const n = name.toUpperCase().replace(/__+/g, "_");
  if (!n.includes("_")) {
    // sem separador só vale em MAIÚSCULAS e com cara de servidor (SMTPHOST, MAILHOST, RELAYHOST): `mailer:` do YAML não é variável
    return name === name.toUpperCase() && /^(?:SMTP|MAIL|EMAIL|RELAY)[A-Z0-9]*(?:HOST|SERVER|RELAY|URL|DSN)$/.test(n) ? "smtp" : null;
  }
  if (API_PROVIDER.test(n) && API_SUFFIX.test(n)) return "api";
  // HOST_NAME é um só termo (o nome do host), não um "nome" de remetente
  const delivery = n.replace(/HOST_NAME/g, "HOSTNAME");
  if (NOT_DELIVERY.test(delivery)) return null;
  if (MAIL_WORD.test(n) && SMTP_SUFFIX.test(n)) return "smtp";
  // padrões genéricos: qualquer SMTP com host/servidor/relay, MAIL…HOST e RELAY
  if (/SMTP/.test(delivery) && /(?:HOST|SERVER|ADDR|RELAY|URL|URI|DSN)/.test(delivery)) return "smtp";
  if (/MAIL.*HOST/.test(delivery) || /RELAY/.test(delivery)) return "smtp";
  return null;
}

async function readRegular(file: string, root: string): Promise<string | null> {
  try {
    const resolved = path.resolve(file);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    const st = await lstat(resolved);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) return null;
    // o caminho REAL (links de pastas intermediárias resolvidos) também tem de ficar dentro da pasta do projeto
    const [realRoot, real] = await Promise.all([realpath(root), realpath(resolved)]);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return await readFile(real, "utf8");
  } catch {
    return null;
  }
}

/** Nomes definidos num .env ou no `environment:` de um compose: `NOME=valor`, `NOME: valor`, `- NOME=valor`. */
function definedNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?(?:-\s*)?["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*[:=]/.exec(line);
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
    const pairs = [...matchAllNames(rest)];
    if (pairs.length > 0) out.push(...pairs);
    else {
      const first = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(rest);
      if (first) out.push(first[1]!);
    }
  }
  return out;
}

/** Nomes de `NOME=` numa linha de ENV/ARG (maiúsculas ou minúsculas). */
function* matchAllNames(rest: string): Generator<string> {
  for (const x of rest.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=/g)) yield x[1]!;
}

/** Caminhos citados sob uma chave do compose (`env_file:` ou `include:`): na mesma linha, em lista ou em `path:`. */
function blockRefs(compose: string, key: "env_file" | "include"): string[] {
  const refs: string[] = [];
  const lines = compose.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^(\\s*)${key}:\\s*(.*)$`).exec(lines[i]!);
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
      // `- arquivo`, `- path: arquivo` ou `path: arquivo` (as demais chaves do include, como project_directory, não são arquivos)
      const item = /^\s*(?:-\s*)?(?:path:\s*)?["']?([^"'#\s:[\]]+)["']?\s*$/.exec(l) ?? /^\s*-?\s*path:\s*["']?([^"'#\s[\]]+)/.exec(l);
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
    // compose principal, arquivos de `include:` (recursivo, até 3 níveis) e os `env_file` de cada um: sempre relativos
    // ao arquivo que os cita e dentro da pasta do projeto (readRegular recusa o que sai dela e links)
    const scanCompose = async (rel: string, depth: number): Promise<void> => {
      const text = await scan(rel, definedNames);
      if (text === null) return;
      const dir = path.dirname(path.resolve(root, rel));
      for (const ref of blockRefs(text, "env_file")) await scan(path.relative(root, path.resolve(dir, ref)), definedNames);
      if (depth < 3) for (const ref of blockRefs(text, "include")) await scanCompose(path.relative(root, path.resolve(dir, ref)), depth + 1);
    };
    if (opts.composeFile) await scanCompose(opts.composeFile, 0);
  }
  return [...found.values()].slice(0, MAX_RESULTS);
}
