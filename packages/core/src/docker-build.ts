/**
 * docker-build.ts — Saúde da VPS → Docker e BuildKit: o plugin buildx no Docker do painel (o CLI que faz os
 * deploys) e no Docker da própria VPS (o que a pessoa usa por SSH). Tipos compartilhados entre servidor e interface.
 */

/** De onde veio o Docker da VPS. */
export type DockerOriginKind = "docker-ce" | "docker.io" | "snap" | "unknown";

export interface DockerBuildStatusResponse {
  /** O CLI do Docker que roda dentro do painel (é ele que faz o build dos deploys). */
  panel: {
    buildx: boolean;
    /** Primeira linha de `docker buildx version`, quando responde. */
    version: string | null;
    /** Motivo quando o buildx não responde. */
    detail: string | null;
  };
  /** O Docker instalado na própria VPS (lido pelo host bridge). */
  host: {
    /** false fora da VPS real, ou quando o host bridge não respondeu (veja `reason`). */
    available: boolean;
    reason: string | null;
    /** null = não foi possível verificar. */
    buildx: boolean | null;
    origin: DockerOriginKind | null;
    /** O painel sabe instalar o plugin desta origem (um clique). */
    fixable: boolean;
    /** Comandos para rodar por SSH quando o painel não instala (ou para conferir). */
    manualCommands: string[];
  };
  /** Tudo o que foi possível verificar está com o buildx. */
  ok: boolean;
}

/** POST /api/health/docker-build/fix */
export interface DockerBuildFixResponse {
  status: DockerBuildStatusResponse;
  alertWarning?: string;
}
