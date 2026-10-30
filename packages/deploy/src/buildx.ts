/**
 * buildx.ts — o build precisa do BuildKit, e o BuildKit só é usado pelo CLI do Docker com o plugin buildx.
 *
 * Sem o plugin o CLI avisa "buildx Docker CLI plugin not found: falling back to the classic builder" e o build
 * quebra no meio, em qualquer Dockerfile moderno (COPY --chmod/--link, RUN --mount, segredos, heredocs):
 * "the --chmod option requires BuildKit". Aqui ficam o teste feito ANTES do build (falhar cedo, com mensagem
 * acionável), o ambiente que pede BuildKit e o reconhecimento dessas mensagens no diagnóstico.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { composeEnv } from "./compose-config.js";
import type { ExecResult } from "./exec.js";

/** Mensagem de quem tenta o build sem o buildx (aparece no log e no erro do deploy). */
export const BUILDX_MISSING_MESSAGE =
  "O Docker do painel está sem o plugin buildx, necessário para o build com BuildKit (COPY --chmod, RUN --mount, segredos). " +
  "Atualize o painel para a versão mais recente (a imagem passa a trazer o buildx) e confira em Saúde da máquina → Docker e BuildKit; " +
  "se o Docker da própria VPS estiver sem o buildx, clique em Corrigir ali.";

/** O plugin existe, mas não roda: as pastas de configuração do Docker/buildx não são graváveis, ou o daemon não responde. */
export const BUILDX_UNUSABLE_MESSAGE =
  "O Docker do painel não consegue gravar a configuração dele (DOCKER_CONFIG e BUILDX_CONFIG precisam apontar para uma pasta gravável, como /data/.docker). " +
  "O BuildKit precisa dela até para baixar o frontend do Dockerfile (# syntax=docker/dockerfile:1). " +
  "Atualize o painel para a versão mais recente e recrie o container; se continuar, veja o detalhe abaixo e a página Saúde da máquina → Docker e BuildKit.";

/** Variáveis que apontam as pastas onde o CLI do Docker e o buildx gravam estado (config.json, credenciais, instances...). */
const CONFIG_DIR_VARS = ["DOCKER_CONFIG", "BUILDX_CONFIG"] as const;

/**
 * Cria (se faltar) e prova a escrita em cada pasta de configuração apontada por DOCKER_CONFIG/BUILDX_CONFIG.
 * Devolve o motivo da primeira que não serve, ou null. Variável ausente é ignorada (fora do container o padrão do
 * Docker, ~/.docker, é do usuário e não é tocado).
 */
export function probeConfigDirs(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of CONFIG_DIR_VARS) {
    const dir = env[name];
    if (!dir) continue;
    const probe = path.join(dir, `.paas-escrita-${process.pid}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(probe, "");
      rmSync(probe, { force: true });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "erro";
      return `${name}=${dir} não é gravável (${code}${code === "EROFS" ? ": read-only file system" : ""})`;
    }
  }
  return null;
}

/** Ambiente dos comandos de build: o filtrado do compose, pedindo BuildKit (sem isso o CLI usa o builder clássico). */
export function buildkitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...composeEnv(base), DOCKER_BUILDKIT: "1", COMPOSE_DOCKER_CLI_BUILD: "1" };
}

export type BuildxCheck = { ok: true; version: string } | { ok: false; detail: string; reason: "missing" | "unusable" };

/** Algum serviço do modelo do compose tem `build` (de Dockerfile, inline ou contexto remoto): então o BuildKit é necessário. */
export function composeHasBuild(model: unknown): boolean {
  const services = model && typeof model === "object" ? (model as { services?: unknown }).services : undefined;
  if (!services || typeof services !== "object") return false;
  return Object.values(services as Record<string, unknown>).some(
    (def) => def !== null && typeof def === "object" && (def as { build?: unknown }).build != null,
  );
}

type BuildxRunner = (file: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

const firstLine = (r: ExecResult) => (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "";

/**
 * `docker buildx version` (o plugin existe?) e `docker buildx inspect` (ele roda? grava o estado em BUILDX_CONFIG
 * — instances, defaults, activity — e fala com o daemon?), com o ambiente de build. Num rootfs somente leitura sem
 * BUILDX_CONFIG gravável, só o segundo acusa o problema, antes de o build quebrar no meio.
 */
export async function checkBuildx(runner: BuildxRunner, probe: () => string | null = () => probeConfigDirs()): Promise<BuildxCheck> {
  const unwritable = probe();
  if (unwritable) return { ok: false, detail: unwritable, reason: "unusable" };
  const opts = { timeoutMs: 30_000, env: buildkitEnv() };
  const v = await runner("docker", ["buildx", "version"], opts);
  if (v.code !== 0) return { ok: false, detail: firstLine(v), reason: "missing" };
  const i = await runner("docker", ["buildx", "inspect"], opts);
  if (i.code !== 0) return { ok: false, detail: firstLine(i), reason: "unusable" };
  return { ok: true, version: v.stdout.trim().split("\n")[0]?.slice(0, 200) ?? "" };
}

/**
 * A saída do build é do BuildKit/CLI ("requires BuildKit", "buildx ... not found", "falling back to the classic
 * builder"): devolve a dica certa, ou null se for outra falha.
 */
export function buildxHintFromOutput(output: string): string | null {
  const text = output.slice(-60_000);
  const sinais = [
    /falling back to the classic builder/i,
    /requires BuildKit/i,
    /buildx[^\n]{0,80}(?:not found|not installed)/i,
  ];
  if (sinais.some((re) => re.test(text))) return BUILDX_MISSING_MESSAGE;
  const readOnly = /buildx[^\n]{0,160}read-only file system/i.test(text) || /mkdir [^\n]*\.docker[^\n]*read-only file system/i.test(text);
  return readOnly ? BUILDX_UNUSABLE_MESSAGE : null;
}
