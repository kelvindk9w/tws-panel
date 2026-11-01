import { describe, expect, it } from "vitest";
import { completionDependencies, exitCodeFromStatus, isCompletedOneShot } from "../src/deploy";

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

describe("completionDependencies", () => {
  it("lê só as dependências por conclusão do rótulo depends_on", () => {
    expect(completionDependencies(undefined)).toEqual([]);
    expect(completionDependencies("")).toEqual([]);
    expect(completionDependencies("a:service_completed_successfully:true,b:service_started:false,:service_completed_successfully:true,c")).toEqual(["a"]);
  });
});

describe("exitCodeFromStatus", () => {
  it("lê o código do status do docker ps", () => {
    expect(exitCodeFromStatus("Exited (0) 12 minutes ago")).toBe(0);
    expect(exitCodeFromStatus("Exited (137) 3 seconds ago")).toBe(137);
    expect(exitCodeFromStatus("Up 2 minutes (healthy)")).toBeNull();
  });
});
