import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { applyHostTimezone } from "./services/host-timezone.js";
import { applyPendingPanelRestore } from "./services/panel-restore.js";

// Fuso da VPS (backups às 03:00 no horário dela, não no UTC do container).
await applyHostTimezone().catch(() => null);

// Restauração do painel pedida antes do reinício: troca o estado ANTES de
// qualquer serviço ler o disco (ver services/panel-restore.ts).
const restored = await Promise.resolve()
  .then(() => applyPendingPanelRestore(loadConfig().dataDir))
  .catch((err: unknown) => {
    console.error("Restauração do painel não aplicada:", err);
    return null;
  });
if (restored) console.warn(`Painel restaurado do backup ${restored.fileName} (pedido por ${restored.actor}).`);

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
