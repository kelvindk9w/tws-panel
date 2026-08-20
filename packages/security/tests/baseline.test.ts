/**
 * Testes do baseline de segurança (baseline.ts): parsing das saídas brutas
 * (dpkg, ss -tulpnH com fallback /proc/net, sha256sum) via runner mockado e
 * o diff entre dois snapshots — pacote adicionado/removido, porta nova,
 * arquivo crítico alterado.
 */
import { describe, expect, it } from "vitest";
import type { SecurityBaseline } from "@paas/core";
import { collectBaseline, diffBaseline, isDiffEmpty } from "../src/baseline.js";
import type { ExecResult, TargetRunner } from "../src/runner.js";

const SS_OUTPUT = [
  "tcp   LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*    users:((\"sshd\",pid=1,fd=3))",
  "tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:((\"caddy\",pid=99,fd=7))",
  "udp   UNCONN 0      0          127.0.0.53%lo:53   0.0.0.0:*    users:((\"systemd-resolve\",pid=50,fd=12))",
  "",
].join("\n");

const PROC_NET_OUTPUT = [
  "== tcp",
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt",
  "   0: 0100007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000",
  "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000",
  "== udp",
  "  sl  local_address rem_address   st",
  "   0: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000",
  "",
].join("\n");

const PACKAGES_OUTPUT = "bash=5.2.15-2\ncoreutils=9.1-1\nopenssh-server=1:9.2p1-2\n";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const FILES_OUTPUT = `${HASH_A}  /etc/ssh/sshd_config\n${HASH_B}  /etc/ufw/user.rules\n`;

function mockRunner(outputs: Partial<Record<"packages" | "ports" | "files", ExecResult>>): TargetRunner {
  return {
    label: "container:teste",
    ensureReady: async () => undefined,
    exec: async (cmd) => {
      if (cmd.includes("dpkg-query")) return outputs.packages ?? { code: 0, stdout: "", stderr: "" };
      if (cmd.includes("ss -tulpnH")) return outputs.ports ?? { code: 0, stdout: "", stderr: "" };
      if (cmd.includes("sha256sum")) return outputs.files ?? { code: 0, stdout: "", stderr: "" };
      throw new Error(`comando inesperado: ${cmd}`);
    },
    execStream: async () => 0,
  } as TargetRunner;
}

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function makeBaseline(overrides: Partial<SecurityBaseline> = {}): SecurityBaseline {
  return {
    id: "base",
    createdAt: new Date().toISOString(),
    target: "container:teste",
    packages: [],
    ports: [],
    files: {},
    ...overrides,
  };
}

describe("collectBaseline — parsing das saídas brutas", () => {
  it("pacotes: linhas nome=versão, ignorando lixo", async () => {
    const baseline = await collectBaseline(
      mockRunner({ packages: ok(PACKAGES_OUTPUT + "linha-sem-igual\n\n") }),
    );
    expect(baseline.packages).toEqual(["bash=5.2.15-2", "coreutils=9.1-1", "openssh-server=1:9.2p1-2"]);
  });

  it("portas: parse de ss -tulpnH com proto, porta, processo e ordenação", async () => {
    const baseline = await collectBaseline(mockRunner({ ports: ok(SS_OUTPUT) }));
    expect(baseline.ports).toEqual([
      { proto: "tcp", port: 22, process: "sshd" },
      { proto: "udp", port: 53, process: "systemd-resolve" },
      { proto: "tcp", port: 80, process: "caddy" },
    ]);
  });

  it("portas: fallback /proc/net (hex) quando ss não existe", async () => {
    const baseline = await collectBaseline(mockRunner({ ports: ok(PROC_NET_OUTPUT) }));
    // 0x0035=53 (tcp LISTEN 0A), 0x0016=22 (tcp LISTEN), 0x14E9=5353 (udp 07)
    expect(baseline.ports).toEqual([
      { proto: "tcp", port: 22, process: null },
      { proto: "tcp", port: 53, process: null },
      { proto: "udp", port: 5353, process: null },
    ]);
  });

  it("arquivos: hashes sha256 indexados por caminho + sshd_config rastreado mesmo ausente", async () => {
    const baseline = await collectBaseline(mockRunner({ files: ok(FILES_OUTPUT) }));
    expect(baseline.files["/etc/ssh/sshd_config"]).toBe(HASH_A);
    expect(baseline.files["/etc/ufw/user.rules"]).toBe(HASH_B);

    const semSshd = await collectBaseline(mockRunner({ files: ok(`${HASH_B}  /etc/ufw/user.rules\n`) }));
    expect(semSshd.files["/etc/ssh/sshd_config"]).toBeNull();
  });

  it("portas: ignora protocolos desconhecidos, portas inválidas e duplicadas (ss)", async () => {
    const suja = [
      "tcp   LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*    users:((\"sshd\",pid=1,fd=3))",
      // mesmo proto/porta de novo: o primeiro processo vence (dedup pela chave)
      "tcp   LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*    users:((\"outro\",pid=2,fd=4))",
      "icmp  UNCONN 0      0          0.0.0.0:7          0.0.0.0:*", // proto não-tcp/udp
      "tcp   LISTEN 0      4096         0.0.0.0:abc       0.0.0.0:*", // porta não numérica
      "tcp   LISTEN 0      4096         0.0.0.0:0         0.0.0.0:*", // porta 0
      "tcp   LISTEN 0      4096         0.0.0.0:443       0.0.0.0:*", // sem users: → processo null
      "", // linha vazia
    ].join("\n");
    const baseline = await collectBaseline(mockRunner({ ports: ok(suja) }));
    expect(baseline.ports).toEqual([
      { proto: "tcp", port: 22, process: "sshd" },
      { proto: "tcp", port: 443, process: null },
    ]);
  });

  it("portas: /proc ignora estados não-LISTEN e endereços malformados", async () => {
    const proc = [
      "== tcp",
      "  sl  local_address rem_address   st",
      "   0: 0100007F:0035 00000000:0000 01 00000000:00000000 00:00000000 00000000", // st 01 = SYN_SENT
      "   1: SEMDOISPONTOS 00000000:0000 0A 00000000:00000000 00:00000000 00000000", // sem "<hex>:<porta>"
      "   2: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000", // 0x50 = 80 LISTEN
    ].join("\n");
    const baseline = await collectBaseline(mockRunner({ ports: ok(proc) }));
    expect(baseline.ports).toEqual([{ proto: "tcp", port: 80, process: null }]);
  });

  it("comando falho (exit != 0) degrada para lista vazia sem lançar", async () => {
    const baseline = await collectBaseline(
      mockRunner({ packages: { code: 1, stdout: "erro", stderr: "erro" } }),
    );
    expect(baseline.packages).toEqual([]);
    expect(baseline.target).toBe("container:teste");
  });

  it("ss indisponível (exit != 0) → portas vazias, mesmo com saída parcial", async () => {
    const baseline = await collectBaseline(
      mockRunner({ ports: { code: 1, stdout: SS_OUTPUT, stderr: "ss: command not found" } }),
    );
    expect(baseline.ports).toEqual([]);
  });
});

describe("diffBaseline", () => {
  it("detecta pacote adicionado e removido", () => {
    const before = makeBaseline({ packages: ["bash=1", "curl=1", "vim=1"] });
    const after = makeBaseline({ packages: ["bash=1", "curl=1", "telnet=1"] });
    const diff = diffBaseline(before, after);
    expect(diff.newPackages).toEqual(["telnet=1"]);
    expect(diff.removedPackages).toEqual(["vim=1"]);
  });

  it("detecta porta nova e porta fechada (chave proto/porta)", () => {
    const before = makeBaseline({
      ports: [{ proto: "tcp", port: 22, process: "sshd" }],
    });
    const after = makeBaseline({
      ports: [
        { proto: "tcp", port: 22, process: "sshd" },
        { proto: "tcp", port: 3306, process: "mysqld" },
      ],
    });
    const diff = diffBaseline(before, after);
    expect(diff.newPorts).toEqual([{ proto: "tcp", port: 3306, process: "mysqld" }]);
    expect(diff.closedPorts).toEqual([]);
    expect(diffBaseline(after, before).closedPorts).toEqual([
      { proto: "tcp", port: 3306, process: "mysqld" },
    ]);
  });

  it("mesma porta em protocolo diferente conta como porta nova", () => {
    const before = makeBaseline({ ports: [{ proto: "tcp", port: 53, process: null }] });
    const after = makeBaseline({
      ports: [
        { proto: "tcp", port: 53, process: null },
        { proto: "udp", port: 53, process: null },
      ],
    });
    expect(diffBaseline(before, after).newPorts).toHaveLength(1);
  });

  it("detecta arquivo alterado, criado e removido", () => {
    const before = makeBaseline({
      files: { "/etc/ssh/sshd_config": HASH_A, "/etc/ufw/user.rules": HASH_B, "/etc/old.conf": HASH_A },
    });
    const after = makeBaseline({
      files: { "/etc/ssh/sshd_config": HASH_B, "/etc/ufw/user.rules": HASH_B, "/etc/new.conf": HASH_A },
    });
    const diff = diffBaseline(before, after);
    expect(diff.changedFiles).toEqual(["/etc/ssh/sshd_config"]);
    expect(diff.addedFiles).toEqual(["/etc/new.conf"]);
    expect(diff.removedFiles).toEqual(["/etc/old.conf"]);
  });

  it("transições null ↔ hash: arquivo rastreado que some/reaparece", () => {
    const antes = makeBaseline({ files: { "/etc/ssh/sshd_config": HASH_A } });
    const depois = makeBaseline({ files: { "/etc/ssh/sshd_config": null } });
    expect(diffBaseline(antes, depois).removedFiles).toEqual(["/etc/ssh/sshd_config"]);
    expect(diffBaseline(depois, antes).addedFiles).toEqual(["/etc/ssh/sshd_config"]);
  });

  it("snapshots idênticos → diff vazio", () => {
    const snapshot = makeBaseline({
      packages: ["bash=1"],
      ports: [{ proto: "tcp", port: 22, process: "sshd" }],
      files: { "/etc/ssh/sshd_config": HASH_A },
    });
    const diff = diffBaseline(snapshot, { ...snapshot, id: "outro" });
    expect(isDiffEmpty(diff)).toBe(true);
  });

  it("isDiffEmpty: qualquer mudança torna o diff não-vazio", () => {
    const diff = diffBaseline(makeBaseline(), makeBaseline({ packages: ["malware=1"] }));
    expect(isDiffEmpty(diff)).toBe(false);
  });
});
