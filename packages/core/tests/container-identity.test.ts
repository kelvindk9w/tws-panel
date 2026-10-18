/**
 * container-identity.ts — labels forjadas (M9): uma imagem com
 * `LABEL paas.project=vitima` não torna o container do atacante "da vítima".
 */
import { describe, expect, it } from "vitest";
import { containerIdentity } from "../src/index.js";

const labels = (o: Record<string, string>) => new Map(Object.entries(o));

describe("containerIdentity", () => {
  it("container do compose: o dono é o projeto do compose, não a label paas.project herdada da imagem", () => {
    const id = containerIdentity(
      labels({ "com.docker.compose.project": "paas-atacante", "paas.project": "vitima", "paas.managed": "true" }),
    );
    expect(id).toEqual({ managed: true, projectSlug: "atacante", composeProject: "paas-atacante" });
  });

  it("compose de fora do painel com labels do painel herdadas: não é gerenciado nem de projeto algum", () => {
    const id = containerIdentity(labels({ "com.docker.compose.project": "outra-coisa", "paas.project": "vitima", "paas.managed": "true" }));
    expect(id).toEqual({ managed: false, projectSlug: null, composeProject: "outra-coisa" });
  });

  it("'paas-' sozinho não é projeto", () => {
    expect(containerIdentity(labels({ "com.docker.compose.project": "paas-" })).projectSlug).toBeNull();
  });

  it("container criado pelo painel (sem label do compose): vale paas.project com paas.managed=true", () => {
    expect(containerIdentity(labels({ "paas.managed": "true", "paas.project": "loja" }))).toEqual({
      managed: true,
      projectSlug: "loja",
      composeProject: null,
    });
  });

  it("paas.project sem paas.managed=true não vale; Caddy/Stalwart seguem gerenciados sem projeto", () => {
    expect(containerIdentity(labels({ "paas.project": "vitima" }))).toEqual({ managed: false, projectSlug: null, composeProject: null });
    expect(containerIdentity(labels({ "paas.managed": "true", "paas.role": "caddy" }))).toEqual({
      managed: true,
      projectSlug: null,
      composeProject: null,
    });
  });

  it("aceita objeto simples além de Map", () => {
    expect(containerIdentity({ "com.docker.compose.project": "paas-x" }).projectSlug).toBe("x");
  });
});
