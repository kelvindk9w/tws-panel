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

/** Ambiente dos comandos de build: o filtrado do compose, pedindo BuildKit (sem isso o CLI usa o builder clássico). */
export function buildkitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...composeEnv(base), DOCKER_BUILDKIT: "1", COMPOSE_DOCKER_CLI_BUILD: "1" };
}

export type BuildxCheck = { ok: true; version: string } | { ok: false; detail: string };

type BuildxRunner = (file: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** `docker buildx version` com o ambiente de build: ok com a versão, ou o motivo de não estar disponível. */
export async function checkBuildx(runner: BuildxRunner): Promise<BuildxCheck> {
  const r = await runner("docker", ["buildx", "version"], { timeoutMs: 30_000, env: buildkitEnv() });
  if (r.code === 0) return { ok: true, version: r.stdout.trim().split("\n")[0]?.slice(0, 200) ?? "" };
  return { ok: false, detail: (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "" };
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
  return sinais.some((re) => re.test(text)) ? BUILDX_MISSING_MESSAGE : null;
}
