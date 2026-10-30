/**
 * token-policy-database.test.ts — a aba Banco é só da pessoa: nenhum token, de nenhum escopo, alcança as rotas
 * do banco, e a marca "projeto de desenvolvimento" (que muda o padrão do backup) também não se muda por token.
 */
import { describe, expect, it } from "vitest";
import { classifyRoute, refineAccess } from "../src/services/token-policy.js";

describe("aba Banco e tokens de API", () => {
  it.each([
    ["GET", "/api/projects/:id/database"],
    ["GET", "/api/projects/:id/database/jobs/:jobId"],
    ["POST", "/api/projects/:id/database/sql/read"],
    ["POST", "/api/projects/:id/database/sql/write"],
    ["POST", "/api/projects/:id/database/truncate"],
    ["POST", "/api/projects/:id/database/reset"],
    ["POST", "/api/projects/:id/database/command"],
  ])("%s %s: nenhum token alcança", (method, pattern) => {
    expect(classifyRoute(method, pattern).kind).toBe("denied");
  });

  it("PATCH do projeto com a marca de desenvolvimento é recusado para token; sem ela segue como antes", () => {
    const write = { kind: "scope", scope: "write" } as const;
    expect(refineAccess(write, "PATCH", "/api/projects/:id", { body: { development: true } }).kind).toBe("denied");
    expect(refineAccess(write, "PATCH", "/api/projects/:id", { body: { development: false } }).kind).toBe("denied");
    expect(refineAccess(write, "PATCH", "/api/projects/:id", { body: { name: "x" } })).toEqual(write);
  });
});
