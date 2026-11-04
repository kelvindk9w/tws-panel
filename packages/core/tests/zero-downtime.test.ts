import { describe, expect, it } from "vitest";
import { ZERO_DOWNTIME_PHASES, zeroDowntimeAvailable, zeroDowntimeEnabled } from "../src/deploy";

const of = (type: string | null, zeroDowntime?: boolean) => ({
  detection: type ? ({ type } as never) : null,
  ...(zeroDowntime === undefined ? {} : { zeroDowntime }),
});

describe("troca sem queda: padrão por tipo", () => {
  it("disponível só em projetos de um container", () => {
    for (const t of ["node-server", "static", "static-node", "dockerfile"]) expect(zeroDowntimeAvailable(of(t))).toBe(true);
    expect(zeroDowntimeAvailable(of("compose"))).toBe(false);
    expect(zeroDowntimeAvailable(of("unknown"))).toBe(false);
    expect(zeroDowntimeAvailable(of(null))).toBe(false);
  });

  it("ligada por padrão em Next.js e estáticos; desligada em Dockerfile", () => {
    expect(zeroDowntimeEnabled(of("node-server"))).toBe(true);
    expect(zeroDowntimeEnabled(of("static"))).toBe(true);
    expect(zeroDowntimeEnabled(of("static-node"))).toBe(true);
    expect(zeroDowntimeEnabled(of("dockerfile"))).toBe(false);
  });

  it("a escolha da pessoa vale; compose nunca", () => {
    expect(zeroDowntimeEnabled(of("node-server", false))).toBe(false);
    expect(zeroDowntimeEnabled(of("dockerfile", true))).toBe(true);
    expect(zeroDowntimeEnabled(of("compose", true))).toBe(false);
  });

  it("quatro fases, na ordem do log", () => {
    expect(ZERO_DOWNTIME_PHASES).toEqual(["Subindo nova versão", "Verificando saúde", "Trocando tráfego", "Desligando versão anterior"]);
  });
});
