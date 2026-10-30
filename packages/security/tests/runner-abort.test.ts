/**
 * NsenterHostRunner.exec com AbortSignal: quando o chamador desiste, o cliente do Docker morre E o helper
 * descartável é removido (`docker rm -f`). Um execFile abortado tem name "AbortError" e `killed` indefinido, então
 * sem tratar o nome o helper ficaria rodando até o timeout. Usa um `docker` falso no PATH (nada de Docker de verdade).
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJournalCommand } from "../src/host-journal.js";
import { NsenterHostRunner } from "../src/runner.js";

let dir = "";
let log = "";
let oldPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-fake-docker-"));
  log = path.join(dir, "calls.log");
  await writeFile(path.join(dir, "docker"), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = run ]; then sleep 20; fi\n`);
  await chmod(path.join(dir, "docker"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
});
afterEach(async () => {
  process.env.PATH = oldPath;
  await rm(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("NsenterHostRunner.exec: cancelamento", () => {
  it("sinal abortado: devolve falha rápido e remove o helper pelo nome", async () => {
    const runner = new NsenterHostRunner({ image: "alpine:3" });
    const ac = new AbortController();
    const started = Date.now();
    const pending = runner.exec(buildJournalCommand("docker", 10, null), { timeoutMs: 15_000, signal: ac.signal });
    await wait(300);
    ac.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.code).not.toBe(0);
    await wait(300);
    const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    expect(calls.some((c) => c.startsWith("run "))).toBe(true);
    const removal = calls.find((c) => c.startsWith("rm -f paas-host-exec-"));
    expect(removal).toBeDefined();
    // o nome removido é o mesmo do helper criado
    const created = /--name (paas-host-exec-[0-9a-f]+)/.exec(calls.find((c) => c.startsWith("run "))!)?.[1];
    expect(removal).toBe(`rm -f ${created}`);
  });

  it("sem cancelar, o comando segue normal e nada é removido", async () => {
    await writeFile(path.join(dir, "docker"), `#!/bin/sh\necho "$@" >> "${log}"\necho ok\n`);
    const runner = new NsenterHostRunner({ image: "alpine:3" });
    const result = await runner.exec(buildJournalCommand("ssh", 5, null), { timeoutMs: 5_000 });
    expect(result).toMatchObject({ code: 0, stdout: "ok\n" });
    expect((await readFile(log, "utf8")).includes("rm -f")).toBe(false);
  });
});
