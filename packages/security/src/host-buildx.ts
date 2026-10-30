/**
 * host-buildx.ts — o plugin buildx do Docker DA VPS (Saúde da VPS → Docker e BuildKit).
 *
 * Sem o buildx o `docker build` / `docker compose build` da VPS cai no "classic builder" e recusa Dockerfiles
 * modernos (COPY --chmod, RUN --mount, segredos, heredocs). O pacote certo depende de onde o Docker veio:
 *  - repositório oficial (docker-ce)  -> docker-buildx-plugin
 *  - arquivo do Ubuntu (docker.io)    -> docker-buildx
 *  - snap ou origem desconhecida      -> o painel NÃO instala; mostra os comandos para a pessoa conferir.
 *
 * Mesma regra do restante do host bridge: nenhuma entrada do cliente vira shell. A origem vem de uma lista
 * fechada e o nome do pacote sai de uma tabela; a allowlist só aceita o que o próprio construtor montaria,
 * comparado byte a byte.
 */

/** De onde veio o Docker da VPS. */
export type DockerOrigin = "docker-ce" | "docker.io" | "snap" | "unknown";

/** Pacote do plugin por origem que o painel sabe instalar. */
export const BUILDX_PACKAGE_BY_ORIGIN = {
  "docker-ce": "docker-buildx-plugin",
  "docker.io": "docker-buildx",
} as const;

export type FixableDockerOrigin = keyof typeof BUILDX_PACKAGE_BY_ORIGIN;

export function isFixableDockerOrigin(origin: string): origin is FixableDockerOrigin {
  return Object.prototype.hasOwnProperty.call(BUILDX_PACKAGE_BY_ORIGIN, origin);
}

/**
 * Pacote INSTALADO de verdade: `dpkg -s` também responde para pacote removido que deixou só a configuração
 * (estado "config-files"), então a origem seria declarada errada. O estado precisa ser exatamente "installed".
 */
function installedTest(pkg: string): string {
  return "[ \"$(dpkg-query -W -f='${db:Status-Status}' " + pkg + " 2>/dev/null)\" = installed ]";
}

/**
 * Somente leitura: o buildx responde? e de onde veio o Docker? Duas linhas `buildx=<0|1>` e `origin=<...>`.
 * `docker buildx version` é leve e não mexe em nada.
 */
export const HOST_BUILDX_STATUS_COMMAND =
  "if docker buildx version >/dev/null 2>&1; then echo buildx=1; else echo buildx=0; fi; " +
  "if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then echo origin=snap; " +
  "elif " + installedTest("docker-ce") + "; then echo origin=docker-ce; " +
  "elif " + installedTest("docker.io") + "; then echo origin=docker.io; " +
  "else echo origin=unknown; fi; true";

export interface HostBuildxStatus {
  /** null = a saída não foi reconhecida (não dá para afirmar nada). */
  buildx: boolean | null;
  origin: DockerOrigin;
}

/** Lê a saída de HOST_BUILDX_STATUS_COMMAND. Origem não reconhecida vira "unknown" (nunca instala nada). */
export function parseBuildxStatus(output: string): HostBuildxStatus {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  const flag = lines.find((l) => l === "buildx=1" || l === "buildx=0");
  const originRaw = lines.find((l) => l.startsWith("origin="))?.slice("origin=".length);
  const origin: DockerOrigin =
    originRaw === "docker-ce" || originRaw === "docker.io" || originRaw === "snap" ? originRaw : "unknown";
  return { buildx: flag === undefined ? null : flag === "buildx=1", origin };
}

/**
 * Instala o pacote do plugin (e confere com `docker buildx version`). Só o plugin: não atualiza o docker-ce,
 * então o daemon NÃO reinicia (o painel roda num container mantido por ele). needrestart só lista.
 */
export function buildBuildxInstallCommand(origin: FixableDockerOrigin): string {
  const pkg = BUILDX_PACKAGE_BY_ORIGIN[origin];
  const env = "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l";
  return `${env} apt-get update -qq && ${env} apt-get install -y -qq ${pkg} && docker buildx version`;
}

/** true só para um comando que o buildBuildxInstallCommand montaria (ou o de leitura). */
export function isBuildxCommand(cmd: string): boolean {
  if (cmd === HOST_BUILDX_STATUS_COMMAND) return true;
  return (Object.keys(BUILDX_PACKAGE_BY_ORIGIN) as FixableDockerOrigin[]).some((o) => buildBuildxInstallCommand(o) === cmd);
}

/** Comandos para a pessoa rodar por SSH quando o painel não instala (origem não reconhecida) ou como conferência. */
export function buildxManualCommands(origin: DockerOrigin): string[] {
  const check = "docker buildx version";
  if (isFixableDockerOrigin(origin)) {
    return ["sudo apt-get update", `sudo apt-get install -y ${BUILDX_PACKAGE_BY_ORIGIN[origin]}`, check];
  }
  if (origin === "snap") {
    return ["# Docker instalado por snap: o plugin vem junto com o snap. Atualize-o:", "sudo snap refresh docker", check];
  }
  return [
    "# Docker do repositório oficial (docker-ce):",
    "sudo apt-get update && sudo apt-get install -y docker-buildx-plugin",
    "# Docker do pacote docker.io do Ubuntu:",
    "sudo apt-get update && sudo apt-get install -y docker-buildx",
    check,
  ];
}
