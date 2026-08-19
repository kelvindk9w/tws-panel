/**
 * docker-service.ts — visão não-invasiva dos containers Docker da máquina.
 * Lista TUDO (inclusive stacks que o painel não gerencia), marcando como
 * "externos" os que não têm labels do painel. Somente leitura.
 */
import {
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  type DockerContainerInfo,
} from "@paas/core";
import { run } from "@paas/deploy";

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

interface PsJson {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Labels: string;
  Ports: string;
}

function parseLabels(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx > 0) map.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return map;
}

/** Classifica um container como gerenciado pelo painel ou externo. */
export function classifyContainer(labels: Map<string, string>): {
  managed: boolean;
  projectSlug: string | null;
  composeProject: string | null;
} {
  const composeProject = labels.get(COMPOSE_PROJECT_LABEL) ?? null;
  const directProject = labels.get(PAAS_LABEL_PROJECT) ?? null;
  const managedByLabel = labels.get(PAAS_LABEL_MANAGED) === "true";
  const managedByCompose = composeProject?.startsWith("paas-") ?? false;
  const managed = managedByLabel || managedByCompose;
  const projectSlug = directProject ?? (managedByCompose ? composeProject!.slice(5) : null);
  return { managed, projectSlug, composeProject };
}

/** Lista todos os containers (gerenciados + externos). */
export async function listContainers(): Promise<DockerContainerInfo[]> {
  const r = await run("docker", ["ps", "-a", "--format", "{{json .}}"]);
  if (r.code !== 0) return [];
  const containers: DockerContainerInfo[] = [];
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    let parsed: PsJson;
    try {
      parsed = JSON.parse(line) as PsJson;
    } catch {
      continue;
    }
    const labels = parseLabels(parsed.Labels ?? "");
    const { managed, projectSlug, composeProject } = classifyContainer(labels);
    containers.push({
      id: parsed.ID,
      name: parsed.Names,
      image: parsed.Image,
      state: parsed.State,
      status: parsed.Status,
      managed,
      projectSlug,
      composeProject,
      ports: (parsed.Ports ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    });
  }
  return containers.sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name));
}
