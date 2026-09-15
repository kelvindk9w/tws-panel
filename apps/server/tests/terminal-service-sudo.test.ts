/**
 * terminal-service-sudo.test.ts — modo "senha" (PAAS_ROOT_MODE=senha):
 *  - o comando é elevado INTEIRO (`sudo ... -- bash -c '<comando>'`), com
 *    quoting provado contra um bash de verdade (sudo falso no PATH);
 *  - marcadores BEGIN/EXIT e código de saída do COMANDO, não do sudo;
 *  - o pedido de senha é detectado na SAÍDA do PTY e vira evento de controle
 *    (pedido, senha errada, esgotamento, sem permissão, tempo esgotado);
 *  - o INPUT (a senha) nunca é inspecionado, logado ou auditado;
 *  - espera de senha com relógio próprio, separado do timeout do comando;
 *  - espelho só de visualização: nunca escreve no stdin do PTY.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TerminalControlMessage } from "@paas/core";
import { SECURITY_CHECKS, buildPhaseScriptCommand } from "@paas/security";
import {
  CaptureDesyncError,
  SUDO_PROMPT,
  SudoElevationError,
  TerminalService,
  buildElevatedCommand,
  buildSudoValidateCommand,
  shellSingleQuote,
} from "../src/services/terminal-service.js";
import type { RemotePty } from "../src/services/docker-socket.js";

class FakePty implements RemotePty {
  readonly inputs: string[] = [];
  readonly stream: Duplex;
  killed = false;
  constructor() {
    this.stream = new Duplex({
      write: (chunk, _enc, cb) => {
        this.inputs.push(Buffer.from(chunk).toString("utf8"));
        cb();
      },
      read: () => undefined,
    });
  }
  emit(data: string): void {
    this.stream.push(data);
  }
  resize(): void {}
  async kill(): Promise<void> {
    this.killed = true;
    this.stream.push(null);
  }
}

function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeService(opts?: { watchSudoPrompt?: boolean; sudoPasswordTimeoutMs?: number }) {
  const ptys: FakePty[] = [];
  const audits: Array<{ action: string; detail: string }> = [];
  const service = new TerminalService({
    openPty: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return Promise.resolve(pty);
    },
    audit: (action, detail) => audits.push({ action, detail }),
    watchSudoPrompt: opts?.watchSudoPrompt ?? true,
    ...(opts?.sudoPasswordTimeoutMs !== undefined ? { sudoPasswordTimeoutMs: opts.sudoPasswordTimeoutMs } : {}),
  });
  const events: TerminalControlMessage[] = [];
  service.onControl((m) => events.push(m));
  const output: string[] = [];
  service.onOutput((c) => output.push(c));
  const pty = () => {
    const p = ptys[ptys.length - 1];
    if (!p) throw new Error("nenhum PTY criado ainda");
    return p;
  };
  const nonce = () => {
    const all = [...pty().inputs.join("").matchAll(/PAAS_EXIT_([0-9a-f]+):/g)];
    return all[all.length - 1]?.[1] ?? "";
  };
  return { service, ptys, audits, events, output, pty, nonce };
}

const PROMPT = "[sudo] senha para kelvin: ";

// ---------------------------------------------------------------------------
// Montagem do comando elevado — provada contra um bash real
// ---------------------------------------------------------------------------

describe("buildElevatedCommand — o comando INTEIRO roda elevado", () => {
  let dir = "";
  let argvFile = "";
  const PATH_WITH_FAKE_SUDO = () => `${dir}:${process.env.PATH ?? ""}`;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-fake-sudo-"));
    argvFile = path.join(dir, "argv");
    // sudo falso: grava o argv recebido (NUL-separado) e executa o que vem
    // depois de "--" com PAAS_FAKE_SUDO=1 — o que prova o que "roda elevado".
    // Com FAKE_SUDO_FAIL=1 simula o sudo recusando (não executa nada).
    await writeFile(
      path.join(dir, "sudo"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\0' "$@" > "${argvFile}"`,
        'if [ "$FAKE_SUDO_FAIL" = 1 ]; then echo "sudo: 3 incorrect password attempts" >&2; exit 1; fi',
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        "shift",
        'PAAS_FAKE_SUDO=1 exec "$@"',
        "",
      ].join("\n"),
    );
    await chmod(path.join(dir, "sudo"), 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runTyped(line: string, extraEnv: Record<string, string> = {}) {
    const env: Record<string, string> = { PATH: PATH_WITH_FAKE_SUDO(), HOME: dir, ...extraEnv };
    return spawnSync("bash", ["--noprofile", "--norc", "-c", line], { env, encoding: "utf8" });
  }

  async function receivedArgv(): Promise<string[]> {
    const raw = await readFile(argvFile, "utf8");
    return raw.split("\0").slice(0, -1);
  }

  it("formato: sudo com prompt próprio, -- e bash -c com o comando entre aspas simples", () => {
    expect(SUDO_PROMPT).toBe("[sudo] senha para %p: ");
    expect(buildElevatedCommand("ufw status", "abc")).toBe(
      `sudo -p '[sudo] senha para %p: ' -- bash -c 'echo ":::PAAS_BEGIN_abc"; ufw status'`,
    );
    expect(buildSudoValidateCommand()).toBe(`sudo -p '[sudo] senha para %p: ' -v`);
    expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("todo check do scanner chega ao bash elevado BYTE A BYTE igual ao original", async () => {
    const pubkey = `ssh-ed25519 ${"A".repeat(68)} operador@notebook`;
    const commands = [
      ...SECURITY_CHECKS.map((c) => c.command),
      buildPhaseScriptCommand({
        remoteDir: "/opt/paas-hardening",
        script: "01-user.sh",
        dryRun: true,
        rollbackDelaySec: 300,
        sshUser: "kelvin",
        sshPublicKey: pubkey,
      }),
    ];
    expect(commands.length).toBeGreaterThan(10);
    for (const cmd of commands) {
      // FAKE_SUDO_FAIL: só grava o argv, não executa o check na máquina de teste
      const r = runTyped(buildElevatedCommand(cmd, "n0nce"), { FAKE_SUDO_FAIL: "1" });
      expect(r.status).toBe(1);
      expect(await receivedArgv()).toEqual([
        "-p",
        "[sudo] senha para %p: ",
        "--",
        "bash",
        "-c",
        `echo ":::PAAS_BEGIN_n0nce"; ${cmd}`,
      ]);
    }
  });

  it("pipelines, && e ; rodam INTEIROS elevados (não só o primeiro comando)", () => {
    const cmd =
      `echo "a=$PAAS_FAKE_SUDO" | cat; ` +
      `true && sh -c 'echo "b=$PAAS_FAKE_SUDO"' | tr a-z A-Z; ` +
      `echo x | grep -q x && echo "c=$PAAS_FAKE_SUDO"`;
    const r = runTyped(`${buildElevatedCommand(cmd, "n1")}; echo ":::PAAS_EXIT_n1:$?"`);
    expect(r.stdout).toBe(":::PAAS_BEGIN_n1\na=1\nB=1\nc=1\n:::PAAS_EXIT_n1:0\n");
  });

  it("o código de saída capturado é o do COMANDO (sudo deu certo)", () => {
    const r = runTyped(`${buildElevatedCommand("echo saida; exit 3", "n2")}; echo ":::PAAS_EXIT_n2:$?"`);
    expect(r.stdout).toBe(":::PAAS_BEGIN_n2\nsaida\n:::PAAS_EXIT_n2:3\n");
  });

  it("sudo recusado: BEGIN nunca aparece (é assim que o serviço distingue do código do comando)", () => {
    const r = runTyped(`${buildElevatedCommand("echo nunca", "n3")}; echo ":::PAAS_EXIT_n3:$?"`, {
      FAKE_SUDO_FAIL: "1",
    });
    expect(r.stdout).toBe(":::PAAS_EXIT_n3:1\n");
  });
});

// ---------------------------------------------------------------------------
// Execução elevada dentro do terminal
// ---------------------------------------------------------------------------

describe("TerminalService — comando elevado com captura", () => {
  it("digita o comando elevado; prompt fora da captura; código do comando", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("cat /etc/ssh/sshd_config | grep -i permitroot", { elevate: true });
    await flush();
    const n = h.nonce();
    const typed = h.pty().inputs.join("");
    expect(typed).toBe(
      `${buildElevatedCommand("cat /etc/ssh/sshd_config | grep -i permitroot", n)}; echo ":::PAAS_EXIT_${n}:$?"\n`,
    );

    h.pty().emit(`${typed.trimEnd()}\r\n`); // eco
    h.pty().emit(PROMPT);
    await flush();
    expect(h.events).toEqual([{ type: "sudo-password-requested", user: "kelvin" }]);
    expect(h.service.sudoPromptOpen).toBe(true);

    h.pty().emit("\r\n"); // Enter (a senha em si NÃO ecoa)
    h.pty().emit(`:::PAAS_BEGIN_${n}\r\nPermitRootLogin no\r\n:::PAAS_EXIT_${n}:1\r\n`);
    const result = await promise;
    expect(result).toEqual({ code: 1, output: "PermitRootLogin no\n" });
    expect(h.events).toEqual([
      { type: "sudo-password-requested", user: "kelvin" },
      { type: "sudo-password-prompt-closed", outcome: "answered" },
    ]);
    expect(h.service.sudoPromptOpen).toBe(false);
    // o operador viu o prompt no terminal
    expect(h.output.join("")).toContain(PROMPT);
    await h.service.dispose();
  });

  it("credencial em cache (sem prompt): nenhum evento, captura normal", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true });
    await flush();
    const n = h.nonce();
    h.pty().emit(`:::PAAS_BEGIN_${n}\r\nStatus: active\r\n:::PAAS_EXIT_${n}:0\r\n`);
    await expect(promise).resolves.toEqual({ code: 0, output: "Status: active\n" });
    expect(h.events).toEqual([]);
    await h.service.dispose();
  });

  it("senha errada e depois certa: rejected → novo pedido → answered", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("id -u", { elevate: true });
    await flush();
    const n = h.nonce();
    h.pty().emit(PROMPT);
    h.pty().emit("\r\n");
    await flush();
    expect(h.events).toHaveLength(1); // só whitespace depois do prompt: ainda aberto
    h.pty().emit(`Sorry, try again.\r\n${PROMPT}`); // mesma leitura: erro + prompt novo
    await flush();
    h.pty().emit(`\r\n:::PAAS_BEGIN_${n}\r\n0\r\n:::PAAS_EXIT_${n}:0\r\n`);
    await expect(promise).resolves.toEqual({ code: 0, output: "0\n" });
    expect(h.events).toEqual([
      { type: "sudo-password-requested", user: "kelvin" },
      { type: "sudo-password-prompt-closed", outcome: "rejected" },
      { type: "sudo-password-requested", user: "kelvin" },
      { type: "sudo-password-prompt-closed", outcome: "answered" },
    ]);
    await h.service.dispose();
  });

  it("prompt partido entre leituras do socket ainda é detectado", async () => {
    const h = makeService();
    void h.service.runCommandCaptured("id -u", { elevate: true }).catch(() => undefined);
    await flush();
    h.pty().emit("[sudo] senha pa");
    await flush();
    expect(h.events).toEqual([]);
    h.pty().emit("ra kelvin:");
    h.pty().emit(" ");
    await flush();
    expect(h.events).toEqual([{ type: "sudo-password-requested", user: "kelvin" }]);
    await h.service.dispose();
  });

  it("prompt em inglês (locale padrão do Ubuntu) e com cores também é detectado", async () => {
    const h = makeService();
    await h.service.connect();
    h.pty().emit("\x1b[0m[sudo] password for deploy: ");
    await flush();
    expect(h.events).toEqual([{ type: "sudo-password-requested", user: "deploy" }]);
    await h.service.dispose();
  });

  it("o eco do PRÓPRIO comando digitado (que contém o texto do -p) não dispara pedido de senha", async () => {
    const h = makeService();
    void h.service.runCommandCaptured("id -u", { elevate: true }).catch(() => undefined);
    await flush();
    const typed = h.pty().inputs.join("");
    const cut = typed.indexOf("%p: ") + "%p: ".length;
    h.pty().emit(typed.slice(0, cut)); // leitura termina exatamente depois de "%p: "
    await flush();
    h.pty().emit(typed.slice(cut));
    await flush();
    expect(h.events).toEqual([]);
    await h.service.dispose();
  });

  it("3 senhas erradas: falha com SudoElevationError (esgotamento), sem retentativa e nunca como resultado", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true });
    await flush();
    const n = h.nonce();
    h.pty().emit(`${PROMPT}\r\nSorry, try again.\r\n${PROMPT}\r\nSorry, try again.\r\n${PROMPT}\r\n`);
    h.pty().emit(`sudo: 3 incorrect password attempts\r\n:::PAAS_EXIT_${n}:1\r\n`);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SudoElevationError);
    expect(err).not.toBeInstanceOf(CaptureDesyncError);
    expect((err as SudoElevationError).reason).toBe("exhausted");
    expect((err as Error).message).toMatch(/recusou a senha.*Nada foi executado como root/);
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "exhausted" });
    // nenhuma segunda tentativa digitada (retentativa pediria senha de novo)
    expect(h.pty().inputs.join("").match(/PAAS_EXIT_/g)).toHaveLength(1);
    await h.service.dispose();
  });

  it("usuário sem sudo: falha acionável (not-permitted)", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true });
    await flush();
    const n = h.nonce();
    h.pty().emit(`${PROMPT}\r\nkelvin is not in the sudoers file.  This incident will be reported.\r\n`);
    h.pty().emit(`:::PAAS_EXIT_${n}:1\r\n`);
    const err = (await promise.catch((e: unknown) => e)) as SudoElevationError;
    expect(err).toBeInstanceOf(SudoElevationError);
    expect(err.reason).toBe("not-permitted");
    expect(err.message).toMatch(/não tem permissão de sudo/);
    expect(err.message).toMatch(/segundo-plano/);
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "not-permitted" });
    await h.service.dispose();
  });

  it("sudo sai sem executar e sem mensagem reconhecida: not-executed (nunca desync/retry)", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true });
    await flush();
    h.pty().emit(`:::PAAS_EXIT_${h.nonce()}:1\r\n`);
    const err = (await promise.catch((e: unknown) => e)) as SudoElevationError;
    expect(err).toBeInstanceOf(SudoElevationError);
    expect(err.reason).toBe("not-executed");
    expect(h.pty().inputs.join("").match(/PAAS_EXIT_/g)).toHaveLength(1);
    await h.service.dispose();
  });

  it("mensagens do sudo em português também são classificadas", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true });
    await flush();
    const n = h.nonce();
    h.pty().emit(`${PROMPT}\r\nDesculpe, tente novamente.\r\n${PROMPT}\r\n`);
    h.pty().emit(`sudo: 3 tentativas de senha incorretas\r\n:::PAAS_EXIT_${n}:1\r\n`);
    await expect(promise).rejects.toMatchObject({ reason: "exhausted" });
    expect(h.events.map((e) => (e.type === "sudo-password-prompt-closed" ? e.outcome : e.type))).toEqual([
      "sudo-password-requested",
      "rejected",
      "sudo-password-requested",
      "exhausted",
    ]);
    await h.service.dispose();
  });
});

describe("TerminalService — comando elevado em stream (scripts de fase)", () => {
  it("BEGIN oculto, saída ao vivo e código do script", async () => {
    const h = makeService();
    const seen: string[] = [];
    const promise = h.service.runCommand("bash '/opt/paas-hardening/00-update.sh' --dry-run", (c) => seen.push(c), {
      elevate: true,
    });
    await flush();
    const n = h.nonce();
    h.pty().emit(`:::PAAS_BEGIN_${n}\r\n:::PAAS_STEP Atualizando\r\n:::PAAS_EXIT_${n}:4\r\n`);
    await expect(promise).resolves.toBe(4);
    expect(seen.join("")).toContain(":::PAAS_STEP Atualizando");
    expect(seen.join("")).not.toContain("PAAS_BEGIN");
    expect(h.output.join("")).not.toContain("PAAS_BEGIN");
    await h.service.dispose();
  });

  it("sudo falhou antes do script: rejeita (não devolve o código 1 do sudo como se fosse do script)", async () => {
    const h = makeService();
    const promise = h.service.runCommand("bash '/opt/paas-hardening/00-update.sh'", () => undefined, {
      elevate: true,
    });
    await flush();
    h.pty().emit(`${PROMPT}\r\nsudo: 3 incorrect password attempts\r\n:::PAAS_EXIT_${h.nonce()}:1\r\n`);
    await expect(promise).rejects.toBeInstanceOf(SudoElevationError);
    await h.service.dispose();
  });
});

describe("TerminalService — validateSudo (sudo -v no início de uma execução longa)", () => {
  it("credencial válida (ou senha aceita): resolve", async () => {
    const h = makeService();
    const promise = h.service.validateSudo();
    await flush();
    const n = h.nonce();
    expect(h.pty().inputs.join("")).toBe(`${buildSudoValidateCommand()}; echo ":::PAAS_EXIT_${n}:$?"\n`);
    h.pty().emit(`${PROMPT}\r\n:::PAAS_EXIT_${n}:0\r\n`);
    await expect(promise).resolves.toBeUndefined();
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "answered" });
    await h.service.dispose();
  });

  it("falha: rejeita com o motivo detectado, ou not-executed", async () => {
    const h = makeService();
    const p1 = h.service.validateSudo();
    await flush();
    h.pty().emit(`${PROMPT}\r\nsudo: 3 incorrect password attempts\r\n:::PAAS_EXIT_${h.nonce()}:1\r\n`);
    await expect(p1).rejects.toMatchObject({ reason: "exhausted" });
    const p2 = h.service.validateSudo();
    await flush();
    h.pty().emit(`:::PAAS_EXIT_${h.nonce()}:1\r\n`);
    await expect(p2).rejects.toMatchObject({ reason: "not-executed" });
    await h.service.dispose();
  });
});

// ---------------------------------------------------------------------------
// REGRA DE OURO no modo senha
// ---------------------------------------------------------------------------

describe("TerminalService — a senha digitada nunca é inspecionada", () => {
  it("o input vai ao PTY e não aparece em eventos, auditoria nem scrollback", async () => {
    const h = makeService();
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true });
    await flush();
    const n = h.nonce();
    h.pty().emit(PROMPT);
    await flush();
    h.service.write("minha-senha-secreta\r");
    h.pty().emit("\r\n"); // o sudo não ecoa a senha
    h.pty().emit(`:::PAAS_BEGIN_${n}\r\nok\r\n:::PAAS_EXIT_${n}:0\r\n`);
    await promise;

    expect(h.pty().inputs.join("")).toContain("minha-senha-secreta");
    const { replay } = await h.service.connect();
    const everything = JSON.stringify({ events: h.events, audits: h.audits, replay, output: h.output });
    expect(everything).not.toContain("minha-senha-secreta");
    await h.service.dispose();
  });

  it("detecção olha só a SAÍDA: digitar o texto do prompt não gera evento", async () => {
    const h = makeService();
    await h.service.connect();
    h.service.write("[sudo] senha para kelvin: ");
    await flush();
    expect(h.events).toEqual([]);
    await h.service.dispose();
  });

  it("write() não consulta o detector (espião no método de classificação)", async () => {
    const h = makeService();
    await h.service.connect();
    const spy = vi.spyOn(h.service as unknown as { watchSudoOutput: (c: string) => void }, "watchSudoOutput");
    h.service.write("qualquer-coisa\r");
    expect(spy).not.toHaveBeenCalled();
    h.pty().emit("saida\r\n");
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    await h.service.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tempo de espera pela senha
// ---------------------------------------------------------------------------

describe("TerminalService — espera pela senha tem relógio próprio", () => {
  it("com o prompt aberto o timeout curto do comando NÃO dispara; o de senha sim, com mensagem clara", async () => {
    const h = makeService({ sudoPasswordTimeoutMs: 150 });
    const promise = h.service.runCommandCaptured("ufw status", { elevate: true, timeoutMs: 20 });
    const settled = promise.catch((e: unknown) => e);
    await flush();
    const n = h.nonce();
    h.pty().emit(PROMPT);
    await flush(80); // bem além dos 20ms do comando
    expect(h.pty().inputs.join("")).not.toContain("\x03");
    await flush(120); // passa dos 150ms de espera pela senha
    expect(h.pty().inputs.join("")).toContain("\x03"); // Ctrl-C: o sudo não fica pendurado
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "timeout" });
    expect(h.service.sudoPromptOpen).toBe(false);
    h.pty().emit(`^C\r\n:::PAAS_EXIT_${n}:1\r\n`);
    const err = (await settled) as SudoElevationError;
    expect(err).toBeInstanceOf(SudoElevationError);
    expect(err.reason).toBe("timeout");
    expect(err.message).toMatch(/tempo esgotado aguardando a senha do sudo/);
    expect(h.output.join("")).toContain("tempo esgotado aguardando a senha do sudo");
    await h.service.dispose();
  });

  it("sem marcador depois do Ctrl-C (bash abortou a lista): rejeita após a folga", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = makeService({ sudoPasswordTimeoutMs: 1_000 });
      const settled = h.service.runCommandCaptured("ufw status", { elevate: true }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1);
      h.pty().emit(PROMPT);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(h.pty().inputs.join("")).toContain("\x03");
      await vi.advanceTimersByTimeAsync(5_001);
      const err = (await settled) as SudoElevationError;
      expect(err.reason).toBe("timeout");
      // a fila segue: o próximo comando é digitado normalmente
      const next = h.service.runCommand("echo depois", () => undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.pty().inputs.join("")).toContain("echo depois");
      h.pty().emit(`:::PAAS_EXIT_${h.nonce()}:0\r\n`);
      await vi.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toBe(0);
      await h.service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("depois de respondido, o relógio do comando volta a correr", async () => {
    const h = makeService({ sudoPasswordTimeoutMs: 10_000 });
    const settled = h.service
      .runCommandCaptured("ufw status", { elevate: true, timeoutMs: 40 })
      .catch((e: unknown) => e);
    await flush();
    const n = h.nonce();
    h.pty().emit(PROMPT);
    await flush(80);
    expect(h.pty().inputs.join("")).not.toContain("\x03");
    h.pty().emit(`\r\n:::PAAS_BEGIN_${n}\r\n`); // respondido; o comando trava
    await flush(80);
    expect(h.pty().inputs.join("")).toContain("\x03"); // agora o timeout do comando vale
    h.pty().emit(`:::PAAS_EXIT_${n}:130\r\n`);
    await expect(settled).resolves.toEqual({ code: 130, output: "" });
    await h.service.dispose();
  });

  it("sessão encerrada com o prompt aberto: evento session-ended", async () => {
    const h = makeService();
    const settled = h.service.runCommandCaptured("ufw status", { elevate: true }).catch((e: unknown) => e);
    await flush();
    h.pty().emit(PROMPT);
    await flush();
    await h.pty().kill();
    await flush();
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "session-ended" });
    expect(await settled).toBeInstanceOf(Error);
  });

  it("dispose com o prompt aberto também fecha o prompt (session-ended)", async () => {
    const h = makeService();
    const settled = h.service.runCommandCaptured("ufw status", { elevate: true }).catch((e: unknown) => e);
    await flush();
    h.pty().emit(PROMPT);
    await flush();
    await h.service.dispose();
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "session-ended" });
    expect(await settled).toBeInstanceOf(Error);
  });

  it("sudo digitado pelo próprio operador (sem comando do painel): eventos, mas nenhum relógio", async () => {
    const h = makeService({ sudoPasswordTimeoutMs: 20 });
    await h.service.connect();
    h.pty().emit(PROMPT);
    await flush(60);
    expect(h.pty().inputs.join("")).not.toContain("\x03");
    expect(h.events).toEqual([{ type: "sudo-password-requested", user: "kelvin" }]);
    h.pty().emit("\r\nroot\r\n");
    await flush();
    expect(h.events.at(-1)).toEqual({ type: "sudo-password-prompt-closed", outcome: "answered" });
    await h.service.dispose();
  });
});

describe("TerminalService — sem detecção (legado/segundo-plano)", () => {
  it("watchSudoPrompt=false: prompt na saída não gera evento", async () => {
    const h = makeService({ watchSudoPrompt: false });
    await h.service.connect();
    h.pty().emit(PROMPT);
    await flush();
    expect(h.events).toEqual([]);
    expect(h.service.sudoPromptOpen).toBe(false);
    await h.service.dispose();
  });
});

// ---------------------------------------------------------------------------
// Espelho (modo segundo-plano) e canal de controle
// ---------------------------------------------------------------------------

describe("TerminalService — espelho e controle", () => {
  it("mirror() chega aos clientes e ao scrollback, sem abrir sessão nem escrever no PTY", async () => {
    const h = makeService();
    h.service.mirror("saída em segundo plano\r\n");
    expect(h.ptys).toHaveLength(0); // nenhum PTY aberto por causa do espelho
    expect(h.output.join("")).toBe("saída em segundo plano\r\n");
    const { replay } = await h.service.connect();
    expect(replay).toContain("saída em segundo plano");
    h.service.mirror("mais\r\n");
    expect(h.pty().inputs).toEqual([]); // stdin do PTY intocado
    await h.service.dispose();
  });

  it("emitControl entrega aos assinantes; unsubscribe e assinante com erro não quebram", () => {
    const h = makeService();
    const extra: TerminalControlMessage[] = [];
    const off = h.service.onControl((m) => extra.push(m));
    h.service.onControl(() => {
      throw new Error("cliente quebrado");
    });
    const msg: TerminalControlMessage = { type: "background-exec", state: "start", command: "ufw status" };
    h.service.emitControl(msg);
    off();
    h.service.emitControl(msg);
    expect(extra).toEqual([msg]);
    expect(h.events).toEqual([msg, msg]);
  });
});
