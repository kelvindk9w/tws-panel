import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { rememberStartupTimezone, resolveStartupTimezone } from "./services/host-timezone.js";
import { DockerCli } from "./services/backup-docker.js";
import { restorePanelAtBoot } from "./services/panel-restore.js";
import { RestoreReconciliation } from "./services/restore-reconciliation.js";
import { PAAS_STALWART_CONTAINER, PAAS_WEBMAIL_CONTAINER } from "@paas/core";

// Restauração do painel pedida antes do reinício: troca o estado ANTES de
// qualquer serviço ler o disco (ver services/panel-restore.ts). Termina uma
// troca interrompida ou a desfaz; se nem desfazer der, o painel não sobe com
// metade dos dados trocada (sai com erro; o Docker tenta de novo).
const restoreOk = await Promise.resolve()
  .then(() =>
    restorePanelAtBoot(loadConfig().dataDir, console, {
      // scripts/restaurar-painel.sh não passa pela conferência da tela: compara o estado restaurado com o Docker agora.
      afterApplied: async (dataDir) => {
        const config = loadConfig();
        const docker = new DockerCli({ socketPath: config.dockerSocketPath, helperImage: config.hostHelperImage });
        const warnings = await new RestoreReconciliation({
          dataDir,
          containers: { stalwart: PAAS_STALWART_CONTAINER, webmail: PAAS_WEBMAIL_CONTAINER },
          probes: { container: (name) => docker.probe(name) },
          log: (m) => console.warn(m),
        }).planStaged(dataDir);
        for (const w of warnings) console.warn(w);
      },
    }),
  )
  .catch((err: unknown) => {
    console.error("A restauração do painel não pôde ser conferida:", err);
    return false;
  });
if (!restoreOk) process.exit(1);

// Fuso da VPS (backups às 03:00 no horário dela, não no UTC do container):
// TZ do .env, o último lido da VPS (data/timezone.json) ou o /etc/localtime
// montado. Depois de subir, o painel confere pelo host bridge
// (services/timezone-service.ts). Vem depois da restauração: o
// timezone.json que vale é o do estado que ficou.
await resolveStartupTimezone({ dataDir: loadConfig().dataDir })
  .then(rememberStartupTimezone)
  .catch(() => null);

const app = await buildApp();

try {
  await app.listen({ port: app.config.port, host: app.config.host });
  app.log.info(`TWS Panel (setup) ouvindo em http://${app.config.host}:${app.config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
