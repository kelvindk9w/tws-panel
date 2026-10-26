/**
 * build-context.ts — o que entra no contexto de um `docker build` do usuário.
 *
 * O painel grava as Variáveis do projeto num `.env` dentro de `src` (o compose lê para interpolar
 * `${VAR}` e para `env_file: .env`). Um Dockerfile com `COPY . .` e sem `.dockerignore` que exclua o
 * `.env` levaria TODOS os segredos para uma camada da imagem. Por isso, durante o build, o `.env`
 * que o PAINEL gravou sai do contexto por um `.dockerignore` mesclado só naquele momento:
 *
 *  - o BuildKit lê `<Dockerfile>.dockerignore` (ao lado do Dockerfile) no lugar do `.dockerignore`;
 *  - o arquivo temporário leva o `.dockerignore` do usuário (ou o `<Dockerfile>.dockerignore` que ele já
 *    tinha) e, por último, as linhas do painel — a exclusão vale mesmo com um `!.env` do usuário;
 *  - ao fim do build (com sucesso ou não) o estado anterior é restaurado: arquivo apagado se não existia,
 *    conteúdo de volta se existia, link simbólico de volta se era um link. O arquivo do usuário nunca é apagado.
 *  - antes de tocar em qualquer arquivo o painel grava um DIÁRIO na pasta de trabalho (fora do código): se o
 *    painel cair no meio do build, o próximo build e a subida do painel restauram a partir dele. Sem isso a
 *    sobra seria tomada por arquivo do usuário e passaria a valer no lugar do `.dockerignore` dele.
 *  - `.dockerignore` que é link para dentro do projeto é seguido; para fora, grande demais ou ilegível,
 *    o deploy é recusado (nunca se segue com uma base vazia).
 *
 * Só o `.env` com o cabeçalho do painel é excluído: um `.env` do próprio repositório é do dono (as Variáveis
 * nunca vão para ele — ver project-dotenv.ts) e pode ser lido de propósito pelo build (Vite, por exemplo).
 */
import { lstat, mkdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { resolveRealPath } from "./compose-model.js";
import { GENERATED_HEADER } from "./project-dotenv.js";
import { readRegularFileLimited, writeFileNoFollow } from "./safe-fs.js";

const IGNORE_MAX_BYTES = 1024 * 1024;
const BLOCK_START = "# >>> TWS Panel (temporário, só durante o build)";
const BLOCK_END = "# <<< TWS Panel";

/** Linhas que o painel acrescenta ao .dockerignore durante o build. */
export const PANEL_IGNORE_BLOCK = [
  BLOCK_START,
  "# O .env gravado pelo painel (Variáveis do projeto) nunca entra no contexto do build.",
  ".env",
  BLOCK_END,
  "",
].join("\n");

/** O `.env` da pasta foi gravado pelo painel (tem o cabeçalho dele)? Arquivo comum; link não conta. */
export async function hasPanelDotenv(src: string): Promise<boolean> {
  const head = await readRegularFileLimited(path.join(src, ".env"), GENERATED_HEADER.length * 4);
  return head?.startsWith(GENERATED_HEADER) ?? false;
}

/** Tira de um .dockerignore o bloco do painel (sobra de um build interrompido). */
export function stripPanelBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  if (start === -1) return content;
  const end = content.indexOf(BLOCK_END, start);
  const after = end === -1 ? "" : content.slice(end + BLOCK_END.length).replace(/^\r?\n/, "");
  return content.slice(0, start) + after;
}

/** O .dockerignore do usuário com as linhas do painel por último (a última regra vence). */
export function mergeDockerignore(base: string): string {
  const clean = stripPanelBlock(base);
  return (clean === "" || clean.endsWith("\n") ? clean : `${clean}\n`) + PANEL_IGNORE_BLOCK;
}

type Snapshot = { kind: "absent" } | { kind: "file"; content: string } | { kind: "link"; target: string };

/** Diário do que o painel mexeu: gravado ANTES de tocar nos arquivos, na pasta de trabalho (fora do código). */
export const IGNORE_JOURNAL = "paas.dockerignore.journal";
interface JournalEntry {
  /** Caminho REAL do arquivo (sem link simbólico na pasta): é com ele que a raiz real é comparada. */
  file: string;
  before: Snapshot;
  /** O que o painel gravou. Diferente no arquivo = a pessoa mexeu depois (as linhas dela são preservadas). */
  written?: string;
}
interface Journal {
  /** Pasta do código (real): só se restaura o que está dentro dela. */
  root: string;
  entries: JournalEntry[];
}

async function readJournal(workDir: string): Promise<Journal | null> {
  const text = await readRegularFileLimited(path.join(workDir, IGNORE_JOURNAL), 4 * IGNORE_MAX_BYTES);
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as Journal;
    if (typeof parsed.root === "string" && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // diário ilegível: não dá para restaurar, e deixá-lo travaria todo build
  }
  await rm(path.join(workDir, IGNORE_JOURNAL), { force: true });
  return null;
}

async function writeJournal(workDir: string, journal: Journal): Promise<void> {
  const file = path.join(workDir, IGNORE_JOURNAL);
  if (journal.entries.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(workDir, { recursive: true });
  await writeFileNoFollow(file, JSON.stringify(journal), 0o600);
}

/** Devolve um arquivo de ignore ao estado de antes do painel, só se ainda for o temporário dele (tem o bloco). */
async function restoreEntry(root: string, entry: JournalEntry): Promise<void> {
  // caminho real da pasta (a pasta de projetos pode estar atrás de um link) + o nome do arquivo
  const file = path.join(resolveRealPath(path.dirname(entry.file)), path.basename(entry.file));
  if (!file.endsWith(".dockerignore") || !file.startsWith(root + path.sep)) return;
  const current = await readRegularFileLimited(file, 4 * IGNORE_MAX_BYTES);
  if (current === undefined || !current.includes(BLOCK_START)) return; // sumiu ou a pessoa mexeu depois: não é mais o nosso
  if (entry.written !== undefined && current !== entry.written) {
    // a pessoa acrescentou linhas e manteve o bloco: sai só o bloco do painel, o resto fica
    const kept = stripPanelBlock(current);
    if (kept.trim() === "" && entry.before.kind === "absent") await rm(file, { force: true });
    else await writeFileNoFollow(file, kept, 0o644);
    return;
  }
  if (entry.before.kind === "file") {
    await writeFileNoFollow(file, stripPanelBlock(entry.before.content), 0o644);
  } else if (entry.before.kind === "link") {
    await rm(file, { force: true });
    await symlink(entry.before.target, file);
  } else {
    await rm(file, { force: true });
  }
}

/**
 * Restaura o que um build interrompido (queda do painel, falta de memória, reinício) deixou para trás.
 * Chamada no começo de todo build e na subida do painel. Não lança: devolve o que não conseguiu restaurar
 * (fica no diário para a próxima tentativa).
 */
export async function restoreIgnoreJournal(workDir: string): Promise<string[]> {
  const journal = await readJournal(workDir);
  if (!journal) return [];
  const failed: JournalEntry[] = [];
  const messages: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      await restoreEntry(journal.root, entry);
    } catch (err) {
      failed.push(entry);
      messages.push(`${path.basename(entry.file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await writeJournal(workDir, { root: journal.root, entries: failed });
  } catch (err) {
    messages.push(`diário: ${err instanceof Error ? err.message : String(err)}`);
  }
  return messages;
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Lê um arquivo de ignore SEGUINDO links, desde que o destino real fique dentro de `root`. Ausente = undefined.
 * Link para fora, destino que não é arquivo comum, acima do teto ou ilegível = erro com mensagem clara:
 * seguir com uma base vazia faria o build valer só com a linha do painel e as exclusões da pessoa sumiriam.
 */
async function readIgnoreFollowing(file: string, root: string): Promise<string | undefined> {
  const name = path.basename(file);
  try {
    await lstat(file);
  } catch {
    return undefined;
  }
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new Error(`${name} é um link quebrado: o painel não consegue saber o que ele exclui do build. Corrija o link e faça o deploy de novo.`);
  }
  if (!inside(root, real)) {
    throw new Error(`${name} é um link para fora da pasta do projeto: o painel não o lê. Coloque o arquivo dentro do projeto (ou troque o link por um arquivo) e faça o deploy de novo.`);
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`${name} não é um arquivo comum: o painel não consegue tirar o .env dele do contexto do build. Troque por um arquivo de verdade e faça o deploy de novo.`);
  }
  if (info.size > IGNORE_MAX_BYTES) {
    throw new Error(`${name} tem mais de 1 MB: o painel não o lê inteiro e não vai montar um build com exclusões cortadas. Reduza o arquivo e faça o deploy de novo.`);
  }
  const content = await readRegularFileLimited(real, IGNORE_MAX_BYTES);
  if (content === undefined) throw new Error(`${name} não pôde ser lido. Confira as permissões e faça o deploy de novo.`);
  return content;
}

async function snapshotOf(file: string, root: string): Promise<{ before: Snapshot; own: string | undefined; note?: string }> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return { before: { kind: "absent" }, own: undefined };
  }
  const own = await readIgnoreFollowing(file, root);
  if (info.isSymbolicLink()) return { before: { kind: "link", target: await readlink(file) }, own };
  if (own!.includes(BLOCK_START)) {
    // sobra do painel sem diário (diário perdido ou ilegível): o arquivo não é da pessoa. Só o bloco sai; o que
    // sobrar é dela e fica; se não sobrar nada, é como se o arquivo não existisse (nunca vira um arquivo vazio).
    const kept = stripPanelBlock(own!);
    const note = `${path.basename(file)} tinha sobra de um build interrompido do painel (sem diário): só o bloco do painel foi tirado.`;
    return kept.trim() === "" ? { before: { kind: "absent" }, own: undefined, note } : { before: { kind: "file", content: kept }, own: kept, note };
  }
  return { before: { kind: "file", content: own! }, own };
}

/** O que o BuildKit leria: o `<Dockerfile>.dockerignore` se existir, senão o `.dockerignore` do contexto. */
async function effectiveIgnore(
  context: string,
  dockerfile: string,
): Promise<{ before: Snapshot; base: string; root: string; file: string; note?: string }> {
  const root = resolveRealPath(context);
  if (!inside(root, resolveRealPath(dockerfile))) {
    throw new Error("O Dockerfile fica fora da pasta do projeto: o painel não grava arquivos fora dela e não consegue tirar o .env do contexto. Use um Dockerfile dentro do projeto.");
  }
  // caminho real da pasta do Dockerfile (o nome do arquivo não é resolvido: pode ser um link do usuário)
  const file = path.join(resolveRealPath(path.dirname(dockerfile)), `${path.basename(dockerfile)}.dockerignore`);
  const { before, own, note } = await snapshotOf(file, root);
  const base = own ?? (await readIgnoreFollowing(path.join(context, ".dockerignore"), root)) ?? "";
  return { before, base, root, file, note };
}

/** Linhas que excluem o `.env` (a leitura é simples de propósito: só para decidir se vale avisar). */
const EXCLUDES_DOTENV = new Set([".env", "/.env", ".env*", "*.env", "**/.env", "**/.env*", "*"]);

/**
 * O `.env` do PRÓPRIO repositório (sem o cabeçalho do painel) está no contexto do build e nenhum
 * `.dockerignore` o exclui? Só serve para avisar: o painel não mexe nele (o build pode lê-lo de propósito).
 */
export async function ownDotenvInContext(context: string, dockerfile: string): Promise<boolean> {
  if ((await readRegularFileLimited(path.join(context, ".env"), 1)) === undefined) return false;
  if (await hasPanelDotenv(context)) return false;
  try {
    const { base } = await effectiveIgnore(context, dockerfile);
    return !base.split(/\r?\n/).some((line) => EXCLUDES_DOTENV.has(line.trim()));
  } catch {
    return true;
  }
}

/**
 * Põe o `.env` do painel fora do contexto de `context` para o Dockerfile `dockerfile` (caminho absoluto).
 * Antes de tocar no arquivo, grava o diário em `workDir` (fora do código). Devolve a função que restaura o
 * estado anterior — chame-a sempre (try/finally). Se o painel cair no meio, o diário restaura no próximo build.
 */
export async function excludePanelDotenv(
  context: string,
  dockerfile: string,
  workDir: string,
  onNote: (message: string) => void = () => undefined,
): Promise<() => Promise<void>> {
  const { before, base, root, file: ignoreFile, note } = await effectiveIgnore(context, dockerfile);
  const journal = (await readJournal(workDir)) ?? { root, entries: [] };
  // este arquivo já está sob o diário (dois serviços com o mesmo Dockerfile): a primeira entrada manda,
  // e uma segunda "restauração" gravaria de volta o arquivo que o painel acabou de criar
  if (journal.entries.some((e) => e.file === ignoreFile)) return async () => undefined;
  if (note) onNote(note);
  const written = mergeDockerignore(base);
  const entry: JournalEntry = { file: ignoreFile, before, written };
  journal.root = root;
  journal.entries.push(entry);
  await writeJournal(workDir, journal);
  await writeFileNoFollow(ignoreFile, written, 0o644);
  return async () => {
    await restoreEntry(root, entry);
    const current = (await readJournal(workDir)) ?? { root, entries: [] };
    current.entries = current.entries.filter((e) => e.file !== ignoreFile);
    await writeJournal(workDir, current);
  };
}

/** Contexto e Dockerfile de cada serviço com `build:` do modelo resolvido do compose. */
export interface ComposeBuildTarget {
  service: string;
  /** Pasta do contexto (absoluta). */
  context: string;
  /** Dockerfile (absoluto). */
  dockerfile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serviços com build de Dockerfile do modelo resolvido (`docker compose config`). Fora da lista: sem
 * `build`, `dockerfile_inline` (não há arquivo) e contexto remoto (git/URL: nada local para vazar).
 */
export function composeBuildTargets(model: unknown, src: string): ComposeBuildTarget[] {
  const services = isRecord(model) && isRecord(model.services) ? model.services : {};
  const out: ComposeBuildTarget[] = [];
  for (const [service, def] of Object.entries(services)) {
    if (!isRecord(def) || def.build === undefined || def.build === null) continue;
    const cfg = isRecord(def.build) ? def.build : { context: def.build };
    if (typeof cfg.dockerfile_inline === "string" && cfg.dockerfile_inline !== "") continue;
    const rawContext = typeof cfg.context === "string" && cfg.context !== "" ? cfg.context : ".";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawContext) || /^git@/.test(rawContext)) continue;
    const context = path.resolve(src, rawContext);
    const dockerfile = path.resolve(context, typeof cfg.dockerfile === "string" && cfg.dockerfile !== "" ? cfg.dockerfile : "Dockerfile");
    out.push({ service, context, dockerfile });
  }
  return out;
}
