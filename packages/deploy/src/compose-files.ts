/**
 * compose-files.ts — nomes de arquivo compose, em ordem de prioridade: o feito
 * para rodar atrás do painel (compose.paas.*) primeiro, depois o de produção.
 * Lista ÚNICA, usada pela detecção e pelos guardrails: antes cada um tinha a
 * sua, e os guardrails analisavam o compose.prod enquanto o deploy usava o
 * compose.paas (validação real, cassino).
 */
export const COMPOSE_CANDIDATES: readonly string[] = [
  "compose.paas.yml",
  "compose.paas.yaml",
  "compose.prod.yml",
  "compose.prod.yaml",
  "compose.production.yml",
  "docker-compose.prod.yml",
  "docker-compose.prod.yaml",
  "docker-compose.production.yml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];
