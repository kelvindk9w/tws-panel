/**
 * host-access.ts: comandos do host bridge para chaves SSH, senha Linux e fail2ban.
 * Os comandos de chave são EXECUTADOS de verdade com bash, num HOME temporário, com
 * getent/id/install/chown falsos (sem root, sem tocar a máquina).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSshPublicKey } from "@paas/core";
import {
  ACCESS_READ_ONLY_COMMANDS,
  CHPASSWD_COMMAND,
  FAIL2BAN_LIST_COMMAND,
  SSH_FACTS_COMMAND,
  blobForFingerprint,
  buildChpasswdInput,
  buildNsenterArgv,
  buildSshKeyAddCommand,
  buildSshKeyRemoveCommand,
  buildSshKeysListCommand,
  buildUnbanCommand,
  isAccessCommand,
  isAllowedHostCommand,
  parseAuthorizedKeys,
  parseFail2banList,
  parseSshFacts,
  sshFingerprint,
} from "../src/index.js";
import { ed25519Line, rsaLine } from "./ssh-fixture.js";

let dir: string;
let home: string;
let bin: string;

function stub(name: string, body: string): void {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "paas-host-access-"));
  home = path.join(dir, "home", "admin");
  mkdirSync(home, { recursive: true });
  bin = path.join(dir, "bin");
  mkdirSync(bin);
  stub("getent", `[ "$2" = admin ] && echo "admin:x:1000:1000::${home}:/bin/bash"; exit 0`);
  stub("id", `echo admin`);
  stub("chown", `exit 0`);
  stub(
    "install",
    `target="\${@: -1}"; for a in "$@"; do [ "$a" = "-d" ] && { mkdir -p "$target"; exit 0; }; done; : > "$target"`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(cmd: string) {
  return spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } });
}
const keysFile = () => path.join(home, ".ssh", "authorized_keys");
const backups = () => readdirSync(path.join(home, ".ssh")).filter((f) => f.includes(".paas-bak-"));

describe("chaves SSH (executadas de verdade)", () => {
  it("lista: arquivo ausente = vazio; usuário inexistente sai com 3", () => {
    expect(run(buildSshKeysListCommand("admin")).stdout).toBe("");
    const none = run(buildSshKeysListCommand("ninguem"));
    expect(none.status).toBe(3);
    expect(none.stdout).toContain("::sem-usuario");
  });

  it("adiciona sem apagar as existentes, com backup, permissões e sem repetir", () => {
    const first = ed25519Line("notebook");
    const second = ed25519Line("reserva");
    mkdirSync(path.join(home, ".ssh"));
    // arquivo existente SEM quebra de linha final: a nova não pode colar na anterior
    writeFileSync(keysFile(), first);
    const r = run(buildSshKeyAddCommand("admin", second));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("::adicionada");
    expect(readFileSync(keysFile(), "utf8")).toBe(`${first}\n${second}\n`);
    expect(statSync(keysFile()).mode & 0o777).toBe(0o600);
    expect(backups()).toHaveLength(1);
    expect(readFileSync(path.join(home, ".ssh", backups()[0]!), "utf8")).toBe(first);
    // repetir não duplica
    const again = run(buildSshKeyAddCommand("admin", second));
    expect(again.stdout).toContain("::ja-existe");
    expect(readFileSync(keysFile(), "utf8")).toBe(`${first}\n${second}\n`);
  });

  it("cria a pasta e o arquivo quando não existem", () => {
    const line = ed25519Line("novo");
    const r = run(buildSshKeyAddCommand("admin", line));
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(keysFile(), "utf8")).toBe(`${line}\n`);
  });

  it("usuário inexistente: sai com 3 sem criar nada", () => {
    const r = run(buildSshKeyAddCommand("ninguem", ed25519Line()));
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("::sem-usuario");
  });

  it("remove só a chave pedida (por impressão digital), com backup", () => {
    const a = ed25519Line("a");
    const b = ed25519Line("b");
    const c = ed25519Line("c");
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(keysFile(), `# comentário\n${a}\n${b}\n\n${c}\n`);
    const blob = blobForFingerprint(readFileSync(keysFile(), "utf8"), sshFingerprint(parseSshPublicKey(b)!.blob))!;
    const r = run(buildSshKeyRemoveCommand("admin", blob));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("::removida");
    expect(readFileSync(keysFile(), "utf8")).toBe(`# comentário\n${a}\n\n${c}\n`);
    expect(backups()).toHaveLength(1);
  });

  it("nunca remove a última chave", () => {
    const only = ed25519Line("unica");
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(keysFile(), `${only}\n`);
    const r = run(buildSshKeyRemoveCommand("admin", parseSshPublicKey(only)!.blob));
    expect(r.status).toBe(5);
    expect(r.stdout).toContain("::ultima");
    expect(readFileSync(keysFile(), "utf8")).toBe(`${only}\n`);
  });

  it("chave que não está lá, ou arquivo ausente: sai com 6", () => {
    const a = ed25519Line();
    const b = ed25519Line();
    expect(run(buildSshKeyRemoveCommand("admin", parseSshPublicKey(a)!.blob)).stdout).toContain("::nao-encontrada");
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(keysFile(), `${a}\n${ed25519Line()}\n`);
    const r = run(buildSshKeyRemoveCommand("admin", parseSshPublicKey(b)!.blob));
    expect(r.status).toBe(6);
    expect(r.stdout).toContain("::nao-encontrada");
  });

  it("remove também a linha com opções na frente que contém a chave", () => {
    const a = ed25519Line("a");
    const b = ed25519Line("b");
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(keysFile(), `${a}\nfrom="203.0.113.7" ${b}\n`);
    const r = run(buildSshKeyRemoveCommand("admin", parseSshPublicKey(b)!.blob));
    expect(r.stdout).toContain("::removida");
    expect(readFileSync(keysFile(), "utf8")).toBe(`${a}\n`);
  });

  it("usuário inexistente na remoção: sai com 3", () => {
    expect(run(buildSshKeyRemoveCommand("ninguem", parseSshPublicKey(ed25519Line())!.blob)).status).toBe(3);
  });
});

describe("construtores recusam parâmetro perigoso", () => {
  it("usuário: root e injeção", () => {
    for (const bad of ["root", "a'; rm -rf /; '", "Admin", "", "a b"]) {
      expect(() => buildSshKeysListCommand(bad)).toThrow(/usuário inválido/);
      expect(() => buildChpasswdInput(bad, "senha-boa-123456")).toThrow(/usuário inválido/);
    }
  });

  it("chave: formato inválido, opções e aspas", () => {
    expect(() => buildSshKeyAddCommand("admin", "lixo")).toThrow(/chave pública/);
    expect(() => buildSshKeyAddCommand("admin", `command="x" ${ed25519Line()}`)).toThrow();
    expect(() => buildSshKeyRemoveCommand("admin", "a'b")).toThrow(/chave inválida/);
  });

  it("senha: vazia ou com quebra de linha; a linha do chpasswd termina em \\n", () => {
    expect(() => buildChpasswdInput("admin", "")).toThrow(/senha inválida/);
    expect(() => buildChpasswdInput("admin", "a\nroot:b")).toThrow(/senha inválida/);
    expect(buildChpasswdInput("admin", "uma:senha longa")).toBe("admin:uma:senha longa\n");
  });

  it("IP: só endereços válidos", () => {
    expect(buildUnbanCommand("203.0.113.9")).toContain("unbanip '203.0.113.9'");
    expect(buildUnbanCommand("2001:db8::1")).toContain("unbanip '2001:db8::1'");
    for (const bad of ["", "abc", "1.2.3.4; reboot", "999.1.1.1", "1.2.3.4' && x '"]) {
      expect(() => buildUnbanCommand(bad)).toThrow(/IP inválido/);
    }
  });
});

describe("allowlist do host bridge", () => {
  const key = ed25519Line("x");
  const blob = parseSshPublicKey(key)!.blob;

  it("aceita o que os construtores montam", () => {
    for (const cmd of [
      buildSshKeysListCommand("admin"),
      buildSshKeyAddCommand("admin", key),
      buildSshKeyRemoveCommand("admin", blob),
      buildUnbanCommand("203.0.113.9"),
      CHPASSWD_COMMAND,
      FAIL2BAN_LIST_COMMAND,
      SSH_FACTS_COMMAND,
    ]) {
      expect(isAccessCommand(cmd), cmd).toBe(true);
      expect(isAllowedHostCommand(cmd, "/opt/paas-hardening"), cmd).toBe(true);
    }
    expect(ACCESS_READ_ONLY_COMMANDS).toContain(FAIL2BAN_LIST_COMMAND);
  });

  it("recusa variações, anexos e comandos soltos", () => {
    const list = buildSshKeysListCommand("admin");
    for (const cmd of [
      `${list}; reboot`,
      list.replace("admin", "root"),
      `${buildSshKeyAddCommand("admin", key)}; id`,
      buildSshKeyAddCommand("admin", key).replace("admin", "root"),
      buildSshKeyRemoveCommand("admin", blob).replace("rm -f", "rm -rf /"),
      `${buildUnbanCommand("203.0.113.9")}; reboot`,
      buildUnbanCommand("203.0.113.9").replace("203.0.113.9", "203.0.113.10"),
      "chpasswd -e",
      "chpasswd\nid",
      `${list}\nid`,
      "u='admin'; k='x'; ",
      "u='admin'; k='" + "a".repeat(60) + "'; ",
      "u='admin'; b='AAAA'; ",
      "ok=0; fail2ban-client set sshd unbanip 'zzz'",
      "id",
    ]) {
      expect(isAccessCommand(cmd), cmd).toBe(false);
    }
  });

  it("o helper entrega a entrada padrão só quando pedido", () => {
    expect(buildNsenterArgv("img", "chpasswd", "n").slice(0, 3)).toEqual(["run", "--rm", "--name"]);
    const argv = buildNsenterArgv("img", "chpasswd", "n", { stdin: true });
    expect(argv.slice(0, 4)).toEqual(["run", "--rm", "-i", "--name"]);
  });
});

describe("interpretação das saídas", () => {
  it("authorized_keys: tipo, comentário, bits, linhas com opções e lixo", () => {
    const a = ed25519Line("notebook");
    const rsa = rsaLine(3072);
    const opt = ed25519Line("restrita");
    const content = `# antigas\n\n${a}\n${rsa}\nfrom="203.0.113.7",no-pty ${opt}\nssh-dss AAAA coisa\nlixo\n`;
    const keys = parseAuthorizedKeys(content);
    expect(keys.map((k) => [k.type, k.comment, k.bits, k.hasOptions])).toEqual([
      ["ssh-ed25519", "notebook", null, false],
      ["ssh-rsa", "", 3072, false],
      ["ssh-ed25519", "restrita", null, true],
    ]);
    expect(keys[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(blobForFingerprint(content, keys[2]!.fingerprint)).toBe(parseSshPublicKey(opt)!.blob);
    expect(blobForFingerprint(content, "SHA256:nao-existe")).toBeNull();
  });

  it("fingerprint bate com o do ssh-keygen quando ele existe", () => {
    const line = ed25519Line("fp");
    const file = path.join(dir, "k.pub");
    writeFileSync(file, `${line}\n`);
    const r = spawnSync("ssh-keygen", ["-lf", file], { encoding: "utf8" });
    if (r.status !== 0) return; // sem ssh-keygen neste ambiente
    expect(r.stdout).toContain(sshFingerprint(parseSshPublicKey(line)!.blob));
  });

  it("fail2ban: IPs por jail, vazio, IPv6, lixo e ausente", () => {
    const out = [
      "::jail sshd",
      "Status for the jail: sshd",
      "|- Filter",
      "|  `- Currently failed:\t0",
      "`- Actions",
      "   |- Currently banned:\t2",
      "   `- Banned IP list:\t203.0.113.9 2001:db8::1 naoeip",
      "::jail recidive",
      "Status for the jail: recidive",
      "   `- Banned IP list:\t",
    ].join("\n");
    expect(parseFail2banList(out)).toEqual([
      { jail: "sshd", ips: ["203.0.113.9", "2001:db8::1"] },
      { jail: "recidive", ips: [] },
    ]);
    expect(parseFail2banList("::jail sshd\nbash: fail2ban-client: command not found\n::jail recidive\n")).toBeNull();
    expect(parseFail2banList("Banned IP list: 203.0.113.1")).toBeNull();
  });

  it("fatos do SSH: chaves do servidor e porta", () => {
    const out = "256 SHA256:abcdef host (ED25519)\nruído\n3072 SHA256:ghijkl host (RSA)\n::porta\nport 22\n";
    expect(parseSshFacts(out)).toEqual({ hostKeys: ["256 SHA256:abcdef host (ED25519)", "3072 SHA256:ghijkl host (RSA)"], port: 22 });
    expect(parseSshFacts("::porta\n")).toEqual({ hostKeys: [], port: null });
    expect(parseSshFacts("::porta\nport 99999")).toEqual({ hostKeys: [], port: null });
    expect(parseSshFacts("")).toEqual({ hostKeys: [], port: null });
  });
});
