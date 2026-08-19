import type { FastifyPluginAsync } from "fastify";
import { scanSystemHealth } from "../services/system-info.js";

const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness público (sem auth) — usado pelo HEALTHCHECK do Docker e por
  // balanceadores/monitoramento externos.
  app.get("/api/healthz", async () => ({ status: "ok" }));

  app.get("/api/health/scan", async (_request, reply) => {
    const result = await scanSystemHealth();
    return reply.send(result);
  });
};

export default healthRoutes;
