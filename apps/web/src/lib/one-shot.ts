import { exitCodeFromStatus, isCompletedOneShot, type ComposeServiceInfo, type DockerContainerInfo } from "@paas/core";

/** Código de saída do container: o que o servidor mandou ou, em respostas antigas, o do texto do status. */
export function exitCodeOf(c: Pick<DockerContainerInfo, "status" | "exitCode">): number | null {
  return c.exitCode ?? exitCodeFromStatus(c.status);
}

/**
 * Containers de execução única que já terminaram bem (job de migração, seed): saíram com 0 e ou outro serviço
 * espera a conclusão deles (`service_completed_successfully`), ou a política de reinício não os religa.
 * A regra é a mesma do vigia do servidor (isCompletedOneShot). Sem a lista de serviços (projeto que não é
 * compose) nada é "concluído".
 */
export function completedContainerIds(
  services: ComposeServiceInfo[] | undefined,
  containers: DockerContainerInfo[],
): Set<string> {
  const done = new Set<string>();
  if (!services) return done;
  for (const c of containers) {
    const svc = services.find((s) => s.name === c.service);
    if (!svc) continue;
    const awaited = services.some((o) =>
      o.dependsOn.some((d) => d.service === svc.name && d.condition === "service_completed_successfully"),
    );
    if (isCompletedOneShot({ state: c.state, exitCode: exitCodeOf(c), restartPolicy: svc.restart ?? null, awaitedByDependents: awaited })) {
      done.add(c.id);
    }
  }
  return done;
}
