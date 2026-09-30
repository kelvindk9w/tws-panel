/**
 * caddy-targets.test.ts — um domínio por porta (validação real, cassino): o
 * site na porta 3200 e a carteira na 8009, no mesmo serviço. Domínio sem porta
 * própria usa a do projeto; domínios com a mesma porta ficam no mesmo bloco.
 */
import { describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { projectCaddyTargets } from "../src/engine.js";

const base = {
  slug: "cassino",
  domain: "cassino.exemplo.com",
  aliases: ["www.cassino.exemplo.com", "carteira.exemplo.com"],
  websocket: false,
  proxyService: "wallet",
  proxyPort: 3200,
  detection: { type: "compose", proxyPort: 3200 },
} as unknown as Project;

describe("projectCaddyTargets", () => {
  it("sem portas por domínio: um bloco com todos os domínios", () => {
    expect(projectCaddyTargets(base, "cassino:3200")).toEqual([
      { domain: "cassino.exemplo.com", aliases: ["www.cassino.exemplo.com", "carteira.exemplo.com"], upstream: "cassino:3200", websocket: false },
    ]);
  });

  it("domínio com porta própria vira outro bloco, no mesmo host", () => {
    const p = { ...base, domainPorts: { "carteira.exemplo.com": 8009 } } as Project;
    expect(projectCaddyTargets(p, "cassino:3200")).toEqual([
      { domain: "cassino.exemplo.com", aliases: ["www.cassino.exemplo.com"], upstream: "cassino:3200", websocket: false },
      { domain: "carteira.exemplo.com", aliases: [], upstream: "cassino:8009", websocket: false },
    ]);
  });
});
