import { describe, expect, it } from "vitest";
import { awaitedServiceNames, exitCodeFromStatus, isCompletedOneShot } from "../src/deploy";

describe("isCompletedOneShot", () => {
  const base = { state: "exited", exitCode: 0, awaitedByDependents: true } as const;

  it("saiu com 0 e outro serviço espera pela conclusão: concluído", () => {
    expect(isCompletedOneShot(base)).toBe(true);
  });

  it("saiu com 0 sem ninguém esperando: serviço comum parado (postgres e apps saem com 0 no SIGTERM)", () => {
    expect(isCompletedOneShot({ ...base, awaitedByDependents: false })).toBe(false);
  });

  it("saiu com erro, sem código ou ainda rodando: nunca concluído", () => {
    expect(isCompletedOneShot({ ...base, exitCode: 1 })).toBe(false);
    expect(isCompletedOneShot({ ...base, exitCode: null })).toBe(false);
    expect(isCompletedOneShot({ ...base, exitCode: undefined })).toBe(false);
    expect(isCompletedOneShot({ ...base, state: "running" })).toBe(false);
  });
});

describe("awaitedServiceNames", () => {
  it("junta os serviços esperados por conclusão; ignora outras condições e lista ausente", () => {
    const set = awaitedServiceNames([
      { dependsOn: [{ service: "app-migrate", condition: "service_completed_successfully" }, { service: "db", condition: "service_healthy" }] },
      { dependsOn: [{ service: "cache", condition: null }] },
    ]);
    expect([...set]).toEqual(["app-migrate"]);
    expect(awaitedServiceNames(undefined).size).toBe(0);
    expect(awaitedServiceNames([{} as never]).size).toBe(0);
  });
});

describe("exitCodeFromStatus", () => {
  it("lê o código do status do docker ps", () => {
    expect(exitCodeFromStatus("Exited (0) 12 minutes ago")).toBe(0);
    expect(exitCodeFromStatus("Exited (137) 3 seconds ago")).toBe(137);
    expect(exitCodeFromStatus("Up 2 minutes (healthy)")).toBeNull();
  });
});
