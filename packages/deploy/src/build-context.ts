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
 *
 * Só o `.env` com o cabeçalho do painel é excluído: um `.env` do próprio repositório é do dono (as Variáveis
 * nunca vão para ele — ver project-dotenv.ts) e pode ser lido de propósito pelo build (Vite, por exemplo).
 */
import { lstat, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
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

async function snapshotOf(file: string): Promise<Snapshot> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return { kind: "absent" };
  }
  if (info.isSymbolicLink()) return { kind: "link", target: await readlink(file) };
  if (info.isFile()) {
    const content = await readRegularFileLimited(file, IGNORE_MAX_BYTES);
    if (content !== undefined) return { kind: "file", content };
  }
  throw new Error(
    `${path.basename(file)} não é um arquivo comum: o painel não consegue tirar o .env dele do contexto do build. Troque por um arquivo de verdade e faça o deploy de novo.`,
  );
}

/**
 * Põe o `.env` do painel fora do contexto de `context` para o Dockerfile `dockerfile` (caminho absoluto).
 * Devolve a função que restaura o estado anterior — chame-a sempre (try/finally).
 */
export async function excludePanelDotenv(context: string, dockerfile: string): Promise<() => Promise<void>> {
  const ignoreFile = `${dockerfile}.dockerignore`;
  const before = await snapshotOf(ignoreFile);
  // o .dockerignore de quem NÃO tem o específico; o específico, quando existe como arquivo, vale no lugar dele
  const base =
    before.kind === "file"
      ? before.content
      : ((await readRegularFileLimited(path.join(context, ".dockerignore"), IGNORE_MAX_BYTES)) ?? "");
  await writeFileNoFollow(ignoreFile, mergeDockerignore(base), 0o644);
  return async () => {
    if (before.kind === "file") {
      await writeFileNoFollow(ignoreFile, stripPanelBlock(before.content), 0o644);
    } else if (before.kind === "link") {
      await rm(ignoreFile, { force: true });
      await symlink(before.target, ignoreFile);
    } else {
      await rm(ignoreFile, { force: true });
    }
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
