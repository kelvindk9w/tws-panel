/**
 * docker-service.ts — visão não-invasiva dos containers Docker da máquina.
 * Lista TUDO (inclusive stacks que o painel não gerencia), marcando como
 * "externos" os que não têm labels do painel. Somente leitura.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  type DockerContainerInfo,
} from "@paas/core";

const execFileAsync = promisify(execFile);

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * Falha de domínio: Docker ausente/inacessível. NUNCA deve ser confundida
 * com "zero containers" — quem chama listContainers() precisa decidir o que
 * fazer com uma indisponibilidade real (ex.: a rota HTTP devolve 503 em vez
 * de 200 com `containers: []`, que daria falso senso de "tudo certo").
 */
export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

// Mesmo default de config.ts (ServerConfig.dockerSocketPath), duplicado de
// propósito aqui: listContainers() é chamada sem argumentos por
// deploy-service.ts e routes/projects.ts (fora do escopo desta correção) —
// então o caminho do socket precisa de um default utilizável sem depender
// de DI de ServerConfig. Quem PASSA o parâmetro explicitamente (ex.: a rota
// /api/docker/containers) já respeita DOCKER_SOCKET_PATH hoje; isto garante
// que quem NÃO passa nada também respeita — é o mesmo valor.
const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

function defaultDockerSocketPath(): string {
  return process.env.DOCKER_SOCKET_PATH ?? DEFAULT_DOCKER_SOCKET_PATH;
}

/** Formato aceito por DOCKER_HOST — caminho cru de socket vira `unix://<path>`. */
function dockerHostFromSocketPath(socketPath: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) ? socketPath : `unix://${socketPath}`;
}

/**
 * Roda `docker` via subprocesso com DOCKER_HOST apontando para o socket
 * configurado — ao contrário de `@paas/deploy`'s `run()` (que não aceita
 * env override), isto faz DOCKER_SOCKET_PATH valer também para a listagem
 * do dashboard, não só para o terminal (docker-socket.ts).
 */
async function runDocker(
  args: string[],
  socketPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DOCKER_HOST: dockerHostFromSocketPath(socketPath) },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr || e.message || "erro desconhecido ao executar docker",
    };
  }
}

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

/**
 * Lista todos os containers (gerenciados + externos).
 *
 * @param dockerSocketPath Socket do Docker a usar (default: DOCKER_SOCKET_PATH
 *   ou /var/run/docker.sock — mesma resolução de ServerConfig.dockerSocketPath).
 * @throws DockerUnavailableError quando o binário `docker` está ausente ou o
 *   socket é inacessível — NUNCA devolve `[]` nesse caso (200 com lista vazia
 *   seria indistinguível de "nenhum container", escondendo a indisponibilidade).
 */
export async function listContainers(
  dockerSocketPath: string = defaultDockerSocketPath(),
): Promise<DockerContainerInfo[]> {
  const r = await runDocker(["ps", "-a", "--format", "{{json .}}"], dockerSocketPath);
  if (r.code !== 0) {
    throw new DockerUnavailableError(
      `não foi possível listar containers via Docker (socket ${dockerSocketPath}): ${r.stderr.trim() || "erro desconhecido"}`,
    );
  }
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
