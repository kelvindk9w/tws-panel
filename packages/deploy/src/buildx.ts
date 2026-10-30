/**
 * buildx.ts — o build precisa do BuildKit, e o BuildKit só é usado pelo CLI do Docker com o plugin buildx.
 *
 * Sem o plugin o CLI avisa "buildx Docker CLI plugin not found: falling back to the classic builder" e o build
 * quebra no meio, em qualquer Dockerfile moderno (COPY --chmod/--link, RUN --mount, segredos, heredocs):
 * "the --chmod option requires BuildKit". Aqui ficam o teste feito ANTES do build (falhar cedo, com mensagem
 * acionável), o ambiente que pede BuildKit e o reconhecimento dessas mensagens no diagnóstico.
 */
import { composeEnv } from "./compose-config.js";
import type { ExecResult } from "./exec.js";

/** Mensagem de quem tenta o build sem o buildx (aparece no log e no erro do deploy). */
export const BUILDX_MISSING_MESSAGE =
  "O Docker do painel está sem o plugin buildx, necessário para o build com BuildKit (COPY --chmod, RUN --mount, segredos). " +
  "Atualize o painel para a versão mais recente (a imagem passa a trazer o buildx) e confira em Saúde da máquina → Docker e BuildKit; " +
  "se o Docker da própria VPS estiver sem o buildx, clique em Corrigir ali.";

/** O plugin existe, mas não roda: o estado dele (BUILDX_CONFIG) não é gravável, ou o daemon não responde. */
export const BUILDX_UNUSABLE_MESSAGE =
  "O plugin buildx do painel não conseguiu rodar (provavelmente não pode gravar o estado dele: BUILDX_CONFIG precisa apontar para uma pasta gravável, como /data/.docker/buildx). " +
  "Atualize o painel para a versão mais recente e recrie o container; se continuar, veja o detalhe abaixo e a página Saúde da máquina → Docker e BuildKit.";

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
export async function checkBuildx(runner: BuildxRunner): Promise<BuildxCheck> {
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
  return /buildx[^\n]{0,160}read-only file system/i.test(text) ? BUILDX_UNUSABLE_MESSAGE : null;
}
