/**
 * images.ts — as imagens que o painel roda como root no host têm de estar
 * fixadas por digest (A3): uma tag sozinha pode ser regravada por um projeto.
 */
import { describe, expect, it } from "vitest";
import {
  CADDY_IMAGE,
  HOST_HELPER_IMAGE,
  NODE_BUILD_IMAGE,
  PANEL_IMAGE_REPOSITORIES,
  STALWART_IMAGE_REF,
  STATIC_SERVER_IMAGE,
} from "../src/index.js";

const REFS = { HOST_HELPER_IMAGE, CADDY_IMAGE, STALWART_IMAGE_REF, NODE_BUILD_IMAGE, STATIC_SERVER_IMAGE };

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
});
