import { describe, expect, it } from "vitest";
import { exitCodeFromStatus, isCompletedOneShot } from "../src/deploy";

describe("isCompletedOneShot", () => {
  const base = { state: "exited", exitCode: 0, restartPolicy: "no", awaitedByDependents: false } as const;

  it("saiu com 0 sem reinício: concluído", () => {
    expect(isCompletedOneShot(base)).toBe(true);
    expect(isCompletedOneShot({ ...base, restartPolicy: null })).toBe(true);
    expect(isCompletedOneShot({ ...base, restartPolicy: undefined })).toBe(true);
    expect(isCompletedOneShot({ ...base, restartPolicy: "on-failure" })).toBe(true);
  });

  it("alguém espera por ele (service_completed_successfully): concluído mesmo com política de reinício", () => {
    expect(isCompletedOneShot({ ...base, restartPolicy: "always", awaitedByDependents: true })).toBe(true);
  });

  it("serviço de longa duração que saiu com 0 (always/unless-stopped, ninguém espera): não é concluído", () => {
    expect(isCompletedOneShot({ ...base, restartPolicy: "always" })).toBe(false);
    expect(isCompletedOneShot({ ...base, restartPolicy: "unless-stopped" })).toBe(false);
  });

  it("saiu com erro, sem código ou ainda rodando: nunca concluído", () => {
    expect(isCompletedOneShot({ ...base, exitCode: 1, awaitedByDependents: true })).toBe(false);
    expect(isCompletedOneShot({ ...base, exitCode: null })).toBe(false);
    expect(isCompletedOneShot({ ...base, exitCode: undefined })).toBe(false);
    expect(isCompletedOneShot({ ...base, state: "running" })).toBe(false);
  });
});

describe("exitCodeFromStatus", () => {
  it("lê o código do status do docker ps", () => {
    expect(exitCodeFromStatus("Exited (0) 12 minutes ago")).toBe(0);
    expect(exitCodeFromStatus("Exited (137) 3 seconds ago")).toBe(137);
    expect(exitCodeFromStatus("Up 2 minutes (healthy)")).toBeNull();
  });
});
