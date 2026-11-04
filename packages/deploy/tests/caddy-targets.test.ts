/**
 * caddy-targets.test.ts — quais projetos entram no proxy central.
 *
 * Antes: só os com o ÚLTIMO deploy bem-sucedido. Dois defeitos: domínio de
 * projeto ainda não publicado não respondia nada (pedido do dono do produto,
 * 01/10/2026), e um site no ar cujo redeploy falhava SUMIA do proxy no próximo
 * ajuste, mesmo com os containers antigos rodando.
 */
import { describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { caddyTargetsFor } from "../src/engine.js";

function projeto(over: Partial<Project>): Project {
  return {
    id: over.slug ?? "x",
    name: over.slug ?? "x",
    slug: "x",
    ingestMode: "git",
    source: "https://github.com/k/x",
    branch: "main",
    domain: "x.exemplo.com",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...over,
  } as Project;
}

const upstream = (p: Project) => `${p.slug}:80`;

describe("caddyTargetsFor", () => {
  it("projeto nunca publicado entra, marcado como não publicado (página 'em configuração')", () => {
    const [t] = caddyTargetsFor([projeto({ slug: "novo", domain: "novo.exemplo.com" })], upstream);
    expect(t).toMatchObject({ domain: "novo.exemplo.com", upstream: "novo:80", published: false });
  });

  it("publicado antes e com o último deploy falho continua no ar (publicado)", () => {
    const [t] = caddyTargetsFor(
      [projeto({ slug: "loja", domain: "loja.exemplo.com", lastDeployStatus: "failed", deployedSource: "https://github.com/k/loja" })],
      upstream,
    );
    expect(t).toMatchObject({ domain: "loja.exemplo.com", published: true });
  });

  it("último deploy bem-sucedido: publicado", () => {
    const [t] = caddyTargetsFor([projeto({ slug: "ok", domain: "ok.exemplo.com", lastDeployStatus: "success" })], upstream);
    expect(t?.published).toBe(true);
  });

  it("domínios adicionais vão junto", () => {
    const [t] = caddyTargetsFor([projeto({ slug: "a", domain: "a.exemplo.com", aliases: ["www.a.exemplo.com"] })], upstream);
    expect(t?.aliases).toEqual(["www.a.exemplo.com"]);
  });
});
