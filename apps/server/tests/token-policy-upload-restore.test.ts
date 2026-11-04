/**
 * token-policy-upload-restore.test.ts — "Restaurar de um arquivo" é só da pessoa: nenhum token, de nenhum escopo,
 * alcança o envio nem a restauração (pedem senha de login e código do 2FA, que um token não digita).
 */
import { describe, expect, it } from "vitest";
import { EXPECTED_ROUTE_ACCESS, EXPECTED_ROUTE_REACH } from "../src/services/token-policy-table.js";
import { classifyRoute } from "../src/services/token-policy.js";

const ROUTES: Array<[string, string]> = [
  ["GET", "/api/backups/projects/:id/upload-restore"],
  ["POST", "/api/backups/projects/:id/upload-restore/precheck"],
  ["PUT", "/api/backups/projects/:id/upload-restore/files"],
  ["POST", "/api/backups/projects/:id/upload-restore/files/:uploadId/check"],
  ["DELETE", "/api/backups/projects/:id/upload-restore/files/:uploadId"],
  ["POST", "/api/backups/projects/:id/upload-restore"],
  ["GET", "/api/backups/projects/:id/upload-restore/jobs/:jobId"],
];

describe("restaurar de um arquivo e tokens de API", () => {
  it.each(ROUTES)("%s %s: nenhum token alcança", (method, pattern) => {
    expect(classifyRoute(method, pattern).kind).toBe("denied");
    expect(EXPECTED_ROUTE_ACCESS[`${method} ${pattern}`]).toBe("denied");
    expect(EXPECTED_ROUTE_REACH[`${method} ${pattern}`]).toBe("project");
  });
});
