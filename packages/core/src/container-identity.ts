/**
 * container-identity.ts — de qual projeto é um container (achado M9).
 *
 * As labels `paas.project` e `paas.managed` NÃO provam nada sozinhas: uma
 * imagem pode trazê-las num `LABEL` do Dockerfile (e o container herda), e o
 * compose do usuário podia declará-las. Um projeto "forjava" assim ser o de
 * outro: o painel parava, removia, fazia backup ou mostrava como dele o
 * container errado.
 *
 * O que o projeto NÃO consegue forjar: `com.docker.compose.project`, que o
 * próprio compose grava na criação POR CIMA de qualquer label da imagem (e o
 * guardrail recusa a do compose do usuário). Então:
 *  - container com label do compose: o dono é só o projeto do compose
 *    (`paas-<slug>`); `paas.project` é ignorada;
 *  - container sem label do compose (criado pelo painel com `docker run`,
 *    modos node/estático; o painel a grava VAZIA, o que vale como ausente):
 *    vale `paas.project`, e só com `paas.managed=true`.
 */
import { PAAS_LABEL_MANAGED, PAAS_LABEL_PROJECT } from "./deploy.js";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

type Labels = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function get(labels: Labels, key: string): string | undefined {
  return labels instanceof Map ? labels.get(key) : (labels as Record<string, string>)[key];
}

export interface ContainerIdentity {
  /** Gerenciado pelo painel (dono conhecido). */
  managed: boolean;
  /** Slug do projeto dono; null = não é de projeto nenhum. */
  projectSlug: string | null;
  /** Valor da label do compose, quando há. */
  composeProject: string | null;
}

export function containerIdentity(labels: Labels): ContainerIdentity {
  // vazia = ausente: o painel grava a label VAZIA nos containers de `docker run` para que a label
  // herdada de uma imagem (`LABEL com.docker.compose.project=paas-vitima`) não valha
  const composeProject = get(labels, COMPOSE_PROJECT_LABEL)?.trim() || null;
  if (composeProject !== null) {
    const ours = composeProject.startsWith("paas-") && composeProject.length > 5;
    return { managed: ours, projectSlug: ours ? composeProject.slice(5) : null, composeProject };
  }
  const direct = get(labels, PAAS_LABEL_PROJECT) ?? null;
  const managed = get(labels, PAAS_LABEL_MANAGED) === "true";
  return { managed, projectSlug: managed ? direct : null, composeProject: null };
}
