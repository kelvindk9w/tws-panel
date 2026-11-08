/**
 * container-identity.ts — labels forjadas (M9): uma imagem com
 * `LABEL paas.project=vitima` não torna o container do atacante "da vítima".
 */
import { describe, expect, it } from "vitest";
import { containerIdentity, isRestoreCheckSandbox } from "../src/index.js";

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

describe("label do compose vazia (o painel a grava vazia nos containers de docker run)", () => {
  it("vazia vale como ausente: o dono vem de paas.project + paas.managed=true", () => {
    expect(containerIdentity(labels({ "com.docker.compose.project": "", "paas.managed": "true", "paas.project": "loja" }))).toEqual({
      managed: true,
      projectSlug: "loja",
      composeProject: null,
    });
  });

  it("vazia sem as labels do painel: de ninguém", () => {
    expect(containerIdentity(labels({ "com.docker.compose.project": "" }))).toEqual({ managed: false, projectSlug: null, composeProject: null });
  });

  it("imagem que forja a label do compose da vítima e o painel a zerou: o container é do slug registrado, não da vítima", () => {
    // `docker run --label com.docker.compose.project=` vence o LABEL da imagem
    const id = containerIdentity(labels({ "com.docker.compose.project": "", "paas.managed": "true", "paas.project": "atacante" }));
    expect(id.projectSlug).toBe("atacante");
  });
});

describe("container descartável do teste de restauração (tws.restore-check)", () => {
  const NAME = "tws-rc-0a1b2c3d4e5f6a7b";
  const none = { managed: false, projectSlug: null, composeProject: null };

  it("nome exato + tws.restore-check=1 + label do compose vazia: de projeto nenhum, mesmo com paas.* herdadas", () => {
    expect(containerIdentity(labels({ "tws.restore-check": "1", "paas.managed": "true", "paas.project": "loja" }), NAME)).toEqual(none);
    expect(containerIdentity(labels({ "tws.restore-check": "1", "com.docker.compose.project": "", "paas.managed": "true", "paas.project": "loja" }), `/${NAME}`)).toEqual(none);
    expect(isRestoreCheckSandbox(labels({ "tws.restore-check": "1" }), NAME)).toBe(true);
  });

  it("LABEL no Dockerfile de um projeto NÃO esconde o container: com label do compose, outro nome, outro valor ou sem nome", () => {
    // container do compose com o rótulo forjado na imagem: continua do projeto
    expect(containerIdentity(labels({ "tws.restore-check": "1", "com.docker.compose.project": "paas-loja" }), NAME).projectSlug).toBe("loja");
    // docker run do painel com o rótulo herdado (o painel o zera, mas mesmo sem zerar): nome de projeto
    expect(containerIdentity(labels({ "tws.restore-check": "1", "paas.managed": "true", "paas.project": "loja" }), "paas-loja-app").projectSlug).toBe("loja");
    for (const n of ["tws-rc-0A1B2C3D4E5F6A7B", `${NAME}x`, "tws-rc-cafe", "", null, undefined]) {
      expect(containerIdentity(labels({ "tws.restore-check": "1", "paas.managed": "true", "paas.project": "loja" }), n).projectSlug, String(n)).toBe("loja");
    }
    for (const v of ["", "0", "true"]) expect(isRestoreCheckSandbox(labels({ "tws.restore-check": v }), NAME), v).toBe(false);
    expect(isRestoreCheckSandbox(new Map([["tws.restore-check", "1"], ["com.docker.compose.project", "  "]]), NAME)).toBe(true);
  });
});
