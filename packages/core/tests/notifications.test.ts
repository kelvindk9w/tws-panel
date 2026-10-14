import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_KINDS,
  MAX_NOTIFICATION_RECIPIENTS,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
} from "../src/index";

describe("notificações: tipos e padrão", () => {
  it("todo tipo tem padrão e texto para a tela", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(typeof DEFAULT_NOTIFICATION_KINDS[kind]).toBe("boolean");
      expect(NOTIFICATION_KIND_LABELS[kind].title.length).toBeGreaterThan(0);
      expect(NOTIFICATION_KIND_LABELS[kind].description.length).toBeGreaterThan(0);
    }
  });

  it("padrão sensato: o que pede ação ligado, 'painel reiniciado' desligado", () => {
    expect(DEFAULT_NOTIFICATION_KINDS).toEqual({
      security: true,
      deploy: true,
      certificate: true,
      blacklist: true,
      disk: true,
      panel: false,
    });
    expect(MAX_NOTIFICATION_RECIPIENTS).toBe(5);
  });
});
