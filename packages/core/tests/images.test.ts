/**
 * images.ts — as imagens que o painel roda como root no host têm de estar
 * fixadas por digest (A3): uma tag sozinha pode ser regravada por um projeto.
 */
import { describe, expect, it } from "vitest";
import {
  CADDY_IMAGE,
  HOST_HELPER_IMAGE,
  MAILPIT_IMAGE,
  NODE_BUILD_IMAGE,
  NODE_SERVER_DEFAULT_MAJOR,
  NODE_SERVER_IMAGES,
  NODE_SERVER_MAJORS,
  PANEL_IMAGE_REPOSITORIES,
  STALWART_IMAGE_REF,
  STATIC_SERVER_IMAGE,
} from "../src/index.js";

const REFS = {
  HOST_HELPER_IMAGE,
  CADDY_IMAGE,
  MAILPIT_IMAGE,
  STALWART_IMAGE_REF,
  NODE_BUILD_IMAGE,
  STATIC_SERVER_IMAGE,
  ...Object.fromEntries(Object.entries(NODE_SERVER_IMAGES).map(([major, ref]) => [`NODE_SERVER_IMAGES[${major}]`, ref])),
};

describe("imagens do painel", () => {
  it.each(Object.entries(REFS))("%s está fixada por digest sha256 completo", (_nome, ref) => {
    expect(ref).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it("o repositório de cada uma está na lista que nenhum projeto pode regravar", () => {
    for (const ref of Object.values(REFS)) {
      const repo = ref.slice(0, ref.indexOf(":", ref.lastIndexOf("/") + 1));
      expect(PANEL_IMAGE_REPOSITORIES, repo).toContain(repo);
    }
  });

  it("o node do servidor tem uma imagem alpine por major suportado e o padrão é o LTS 22", () => {
    for (const major of NODE_SERVER_MAJORS) {
      expect(NODE_SERVER_IMAGES[major]).toMatch(new RegExp(`^node:${major}-alpine@sha256:`));
    }
    expect(Object.keys(NODE_SERVER_IMAGES).map(Number)).toEqual([...NODE_SERVER_MAJORS]);
    expect(NODE_SERVER_DEFAULT_MAJOR).toBe(22);
    expect(NODE_SERVER_MAJORS).toContain(NODE_SERVER_DEFAULT_MAJOR);
  });
});
