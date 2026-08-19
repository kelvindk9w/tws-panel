import { buildApp } from "./app.js";

const app = await buildApp();

try {
  await app.listen({ port: app.config.port, host: app.config.host });
  app.log.info(`Painel PaaS (setup) ouvindo em http://${app.config.host}:${app.config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
