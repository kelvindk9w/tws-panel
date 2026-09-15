/**
 * terminal-runner.test.ts — integração: o executor de fases roda DENTRO do
 * terminal web (TerminalRelayRunner + TerminalService):
 *  - execStream vai ao PTY (saída ao vivo) e o exit code vem do marcador;
 *  - fallback ao runner direto quando o terminal está indisponível;
 *  - falha DEPOIS de o comando começar NUNCA re-executa (sem dupla aplicação);
 *  - fluxo completo de uma fase via SecurityExecutor: saída no stream do
 *    terminal + job concluído.
 */
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { SecurityExecutor, type ExecResult, type TargetRunner } from "@paas/security";
import type { SecurityTargetProfile } from "@paas/core";
import type { TerminalControlMessage } from "@paas/core";
import { BackgroundMirrorRunner, TerminalRelayRunner } from "../src/services/terminal-runner.js";
import { SudoElevationError, TerminalService, buildElevatedCommand } from "../src/services/terminal-service.js";
import type { RemotePty } from "../src/services/docker-socket.js";

class FakePty implements RemotePty {
  readonly inputs: string[] = [];
  readonly stream: Duplex;
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
  end(): void {
    this.stream.push(null);
  }
  resize(): void {}
  async kill(): Promise<void> {
    this.end();
  }
}

/** Runner base falso: exec/execStream diretos retornam valores-prova de caminho. */
class FakeBaseRunner implements TargetRunner {
  readonly label = "fake";
  profile: SecurityTargetProfile = "container";
  streamCalls: string[] = [];
  execCalls: string[] = [];
  uploaded = false;
  async ensureReady(): Promise<void> {}
  async exec(cmd: string): Promise<ExecResult> {
    this.execCalls.push(cmd);
    return { code: 9, stdout: "[base] direto", stderr: "" };
  }
  async uploadDir(): Promise<void> {
    this.uploaded = true;
  }
  async execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    this.streamCalls.push(cmd);
    onData("[base-runner] saída direta\n");
    return 7;
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function setup(opts?: { failOpen?: boolean; audit?: (detail: string) => void; elevation?: "none" | "sudo" }) {
  const ptys: FakePty[] = [];
  const terminal = new TerminalService({
    watchSudoPrompt: opts?.elevation === "sudo",
    openPty: () => {
      if (opts?.failOpen) return Promise.reject(new Error("sem docker.sock"));
      const pty = new FakePty();
      ptys.push(pty);
      return Promise.resolve(pty);
    },
  });
  const base = new FakeBaseRunner();
  const runner = new TerminalRelayRunner(base, terminal, {
    ...(opts?.audit ? { onAudit: opts.audit } : {}),
    ...(opts?.elevation ? { elevation: opts.elevation } : {}),
  });
  return { terminal, base, runner, ptys };
}

function nonceOf(inputs: string[], kind: "BEGIN" | "EXIT"): string {
  const m = new RegExp(`:::PAAS_${kind}_([0-9a-f]+)`).exec(inputs.join(""));
  if (!m?.[1]) throw new Error(`marcador ${kind} não encontrado`);
  return m[1];
}

describe("TerminalRelayRunner — fases dentro do terminal", () => {
  it("execStream roda no PTY: saída ao vivo + exit code do marcador (sem tocar o base)", async () => {
    const { runner, base, ptys } = setup();
    const seen: string[] = [];
    const promise = runner.execStream("bash '/opt/paas-hardening/00-update.sh' --dry-run", (c) =>
      seen.push(c),
    );
    await flush();
    const pty = ptys[0]!;
    expect(pty.inputs.join("")).toContain("00-update.sh");
    const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(pty.inputs.join(""))?.[1];
    pty.emit(":::PAAS_STEP Atualizando pacotes\r\n");
    pty.emit("Reading package lists...\r\n");
    pty.emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    await expect(promise).resolves.toBe(0);
    expect(base.streamCalls).toHaveLength(0); // NÃO usou o caminho direto
    expect(seen.join("")).toContain("Reading package lists...");
    expect(seen.join("")).not.toContain("PAAS_EXIT");
  });

  it("terminal indisponível ANTES do comando → fallback ao runner direto", async () => {
    const { runner, base } = setup({ failOpen: true });
    const seen: string[] = [];
    const code = await runner.execStream("bash x.sh", (c) => seen.push(c));
    expect(code).toBe(7); // código do base runner
    expect(base.streamCalls).toEqual(["bash x.sh"]);
    expect(seen.join("")).toContain("saída direta");
  });

  it("sessão morre NO MEIO do comando → erro, SEM fallback (nunca re-executa)", async () => {
    const { runner, base, ptys } = setup();
    const promise = runner.execStream("bash '/opt/paas-hardening/02-ssh.sh'", () => undefined);
    await flush();
    ptys[0]!.end();
    await expect(promise).rejects.toThrow(/terminal foi encerrado/);
    expect(base.streamCalls).toHaveLength(0);
  });

  it("fluxo completo: SecurityExecutor aplica uma fase e a saída flui pelo terminal", async () => {
    const { runner, terminal, ptys } = setup();
    const terminalView: string[] = [];
    terminal.onOutput((c) => terminalView.push(c));

    const executor = new SecurityExecutor({ runner, scriptsDir: "/tmp/nao-importa" });
    const job = await executor.startJob("00", true); // dry-run da fase 00
    await flush();
    await flush();
    const pty = ptys[0]!;
    // o executor escreveu o script da fase no terminal (usuário vê o comando real)
    expect(pty.inputs.join("")).toContain("00-update.sh");
    const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(pty.inputs.join(""))?.[1];
    pty.emit(":::PAAS_STEP Verificando atualizações\r\n");
    pty.emit("[dry-run] apt-get upgrade\r\n");
    pty.emit(`:::PAAS_EXIT_${nonce}:0\r\n`);

    // espera o job terminar
    for (let i = 0; i < 50 && job.status !== "success"; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(job.status).toBe("success");
    expect(job.log).toContain("[dry-run] apt-get upgrade");
    // a MESMA saída apareceu no stream do terminal (visão dupla)
    expect(terminalView.join("")).toContain("[dry-run] apt-get upgrade");
    await terminal.dispose();
  });
});

describe("TerminalRelayRunner — exec (checks somente-leitura) dentro do terminal", () => {
  it("exec roda no PTY com captura limpa (sem eco) e NÃO toca o base runner", async () => {
    const audits: string[] = [];
    const { runner, base, ptys } = setup({ audit: (d) => audits.push(d) });
    const promise = runner.exec("hostname");
    await flush();
    const pty = ptys[0]!;
    const begin = nonceOf(pty.inputs, "BEGIN");
    const exit = nonceOf(pty.inputs, "EXIT");
    expect(begin).toBe(exit);
    // eco do comando digitado (como num SSH real) + saída + marcadores
    pty.emit(`echo ":::PAAS_BEGIN_${begin}"; hostname; echo ":::PAAS_EXIT_${exit}:$?"\r\n`);
    pty.emit(`:::PAAS_BEGIN_${begin}\r\n`);
    pty.emit("minha-vps\r\n");
    pty.emit(`:::PAAS_EXIT_${exit}:0\r\n`);

    const result = await promise;
    expect(result).toEqual({ code: 0, stdout: "minha-vps\n", stderr: "" });
    expect(base.execCalls).toHaveLength(0);
    expect(audits.some((d) => d.includes("hostname"))).toBe(true);
  });

  it("terminal indisponível ANTES do exec → fallback ao runner direto", async () => {
    const { runner, base } = setup({ failOpen: true });
    const result = await runner.exec("cat /etc/os-release");
    expect(result.code).toBe(9); // prova de que o base respondeu
    expect(base.execCalls).toEqual(["cat /etc/os-release"]);
  });

  it("sessão morre NO MEIO do exec → erro, SEM fallback (nunca re-executa)", async () => {
    const { runner, base, ptys } = setup();
    const promise = runner.exec("hostname");
    await flush();
    ptys[0]!.end();
    await expect(promise).rejects.toThrow(/terminal foi encerrado/);
    expect(base.execCalls).toHaveLength(0);
  });

  it("perfil host: comando FORA da allowlist não sobe pelo terminal (vai ao base, fail-closed)", async () => {
    const { runner, base, ptys } = setup();
    base.profile = "host";
    const result = await runner.exec("rm -rf /; cat /etc/shadow");
    expect(base.execCalls).toEqual(["rm -rf /; cat /etc/shadow"]);
    expect(ptys).toHaveLength(0); // terminal nem foi aberto
    expect(result.code).toBe(9);
  });

  it("perfil host: check da allowlist sobe pelo terminal normalmente", async () => {
    const { runner, base, ptys } = setup();
    base.profile = "host";
    // comando real de um check do scanner (fixo em packages/security/src/checks.ts)
    const checkCmd = "awk -F: '$3 == 0 {print $1}' /etc/passwd";
    const promise = runner.exec(checkCmd);
    await flush();
    const pty = ptys[0]!;
    const nonce = nonceOf(pty.inputs, "BEGIN");
    pty.emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    pty.emit("root\r\n");
    pty.emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.stdout).toBe("root\n");
    expect(base.execCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Modo senha: comandos elevados com sudo DENTRO do terminal do usuário
// ---------------------------------------------------------------------------

const CHECK = "awk -F: '$3 == 0 {print $1}' /etc/passwd";
const PHASE = "bash '/opt/paas-hardening/00-update.sh' --dry-run";

function lastNonce(pty: FakePty): string {
  const all = [...pty.inputs.join("").matchAll(/PAAS_EXIT_([0-9a-f]+):/g)];
  return all[all.length - 1]?.[1] ?? "";
}

describe("TerminalRelayRunner — modo senha (elevation: sudo)", () => {
  function senha(opts?: { failOpen?: boolean; audit?: (detail: string) => void }) {
    const h = setup({ ...opts, elevation: "sudo" });
    h.base.profile = "host";
    return h;
  }

  it("exec: check da allowlist é digitado ELEVADO inteiro, com captura e código do comando", async () => {
    const audits: string[] = [];
    const { runner, base, ptys } = senha({ audit: (d) => audits.push(d) });
    const promise = runner.exec(CHECK);
    await flush();
    const pty = ptys[0]!;
    const n = lastNonce(pty);
    expect(pty.inputs.join("")).toBe(`${buildElevatedCommand(CHECK, n)}; echo ":::PAAS_EXIT_${n}:$?"\n`);
    pty.emit(`:::PAAS_BEGIN_${n}\r\nroot\r\n:::PAAS_EXIT_${n}:0\r\n`);
    await expect(promise).resolves.toEqual({ code: 0, stdout: "root\n", stderr: "" });
    expect(base.execCalls).toHaveLength(0);
    expect(audits).toEqual([`host-exec (terminal, sudo): ${CHECK}`]);
  });

  it("allowlist checada no comando ORIGINAL: fora dela nunca vira sudo (vai ao base, que recusa)", async () => {
    const { runner, base, ptys } = senha();
    await runner.exec("cat /etc/shadow");
    await runner.execStream("rm -rf / --no-preserve-root", () => undefined);
    expect(base.execCalls).toEqual(["cat /etc/shadow"]);
    expect(base.streamCalls).toEqual(["rm -rf / --no-preserve-root"]);
    expect(ptys).toHaveLength(0);
  });

  it("allowlist vale mesmo se o perfil não for host (sudo nunca recebe string arbitrária)", async () => {
    const h = setup({ elevation: "sudo" }); // perfil container
    await h.runner.exec("cat /etc/shadow");
    expect(h.base.execCalls).toEqual(["cat /etc/shadow"]);
    expect(h.ptys).toHaveLength(0);
  });

  it("ensureReady valida o sudo (sudo -v) uma vez antes da execução longa", async () => {
    const { runner, ptys } = senha();
    const ready = runner.ensureReady();
    await flush();
    const pty = ptys[0]!;
    expect(pty.inputs.join("")).toContain("sudo -p '[sudo] senha para %p: ' -v;");
    pty.emit(`[sudo] senha para kelvin: `);
    pty.emit(`\r\n:::PAAS_EXIT_${lastNonce(pty)}:0\r\n`);
    await expect(ready).resolves.toBeUndefined();
  });

  it("execStream renova a credencial (sudo -v) e roda o script elevado", async () => {
    const { runner, ptys } = senha();
    const seen: string[] = [];
    const promise = runner.execStream(PHASE, (c) => seen.push(c));
    await flush();
    const pty = ptys[0]!;
    expect(pty.inputs.join("")).toContain(" -v;");
    pty.emit(`:::PAAS_EXIT_${lastNonce(pty)}:0\r\n`); // credencial ainda válida: sem prompt
    await flush();
    const n = lastNonce(pty);
    expect(pty.inputs.join("")).toContain(buildElevatedCommand(PHASE, n));
    pty.emit(`:::PAAS_BEGIN_${n}\r\n:::PAAS_STEP Atualizando\r\n:::PAAS_EXIT_${n}:0\r\n`);
    await expect(promise).resolves.toBe(0);
    expect(seen.join("")).toContain(":::PAAS_STEP Atualizando");
  });

  it("falha do sudo num check: trava os próximos (sem pedir senha de novo) e fica registrada", async () => {
    const { runner, ptys } = senha();
    const first = runner.exec(CHECK);
    await flush();
    const pty = ptys[0]!;
    pty.emit(`[sudo] senha para kelvin: \r\nsudo: 3 incorrect password attempts\r\n`);
    pty.emit(`:::PAAS_EXIT_${lastNonce(pty)}:1\r\n`);
    await expect(first).rejects.toBeInstanceOf(SudoElevationError);
    const typedBefore = pty.inputs.length;
    await expect(runner.exec(CHECK)).rejects.toBeInstanceOf(SudoElevationError);
    await expect(runner.execStream(PHASE, () => undefined)).rejects.toBeInstanceOf(SudoElevationError);
    expect(pty.inputs.length).toBe(typedBefore); // nada novo digitado
    const failure = runner.takeElevationFailure();
    expect(failure?.reason).toBe("exhausted");
    expect(runner.takeElevationFailure()).toBeNull(); // consumida
  });

  it("ensureReady zera a trava de uma execução anterior e, se o sudo falhar, rejeita", async () => {
    const { runner, ptys } = senha();
    const first = runner.exec(CHECK);
    await flush();
    const pty = ptys[0]!;
    pty.emit(`:::PAAS_EXIT_${lastNonce(pty)}:1\r\n`);
    await expect(first).rejects.toBeInstanceOf(SudoElevationError);

    const ready = runner.ensureReady();
    await flush();
    pty.emit(`[sudo] senha para kelvin: \r\nkelvin is not in the sudoers file.\r\n`);
    pty.emit(`:::PAAS_EXIT_${lastNonce(pty)}:1\r\n`);
    await expect(ready).rejects.toMatchObject({ reason: "not-permitted" });
    expect(runner.takeElevationFailure()?.reason).toBe("not-permitted");
  });

  it("terminal indisponível: NÃO cai para o host bridge como root — falha com mensagem clara", async () => {
    const { runner, base } = senha({ failOpen: true });
    await expect(runner.exec(CHECK)).rejects.toThrow(/modo senha.*nada foi executado/i);
    await expect(runner.execStream(PHASE, () => undefined)).rejects.toThrow(/modo senha/);
    await expect(runner.ensureReady()).rejects.toThrow(/modo senha/);
    expect(base.execCalls).toHaveLength(0);
    expect(base.streamCalls).toHaveLength(0);
  });

  it("erro que não é do sudo (sessão caiu) propaga sem travar execuções futuras", async () => {
    const { runner, ptys } = senha();
    const promise = runner.exec(CHECK);
    await flush();
    ptys[0]!.end();
    await expect(promise).rejects.toThrow(/terminal foi encerrado/);
    expect(runner.takeElevationFailure()).toBeNull();
  });

  it("fluxo completo: SecurityExecutor com senha errada 3x falha o job com mensagem acionável", async () => {
    const { runner, ptys, terminal } = senha();
    const executor = new SecurityExecutor({ runner, scriptsDir: "/tmp/nao-importa" });
    const job = await executor.startJob("00", true);
    await flush();
    await flush();
    const pty = ptys[0]!;
    pty.emit(`[sudo] senha para kelvin: \r\nsudo: 3 incorrect password attempts\r\n`);
    pty.emit(`:::PAAS_EXIT_${lastNonce(pty)}:1\r\n`);
    for (let i = 0; i < 50 && job.status !== "failed"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/recusou a senha 3 vezes/);
    await terminal.dispose();
  });
});

// ---------------------------------------------------------------------------
// Modo segundo-plano: host bridge + espelho só de visualização
// ---------------------------------------------------------------------------

describe("BackgroundMirrorRunner — modo segundo-plano", () => {
  function background() {
    const ptys: FakePty[] = [];
    const terminal = new TerminalService({
      openPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return Promise.resolve(pty);
      },
    });
    const base = new FakeBaseRunner();
    base.profile = "host";
    const runner = new BackgroundMirrorRunner(base, terminal);
    const view: string[] = [];
    terminal.onOutput((c) => view.push(c));
    const events: TerminalControlMessage[] = [];
    terminal.onControl((m) => events.push(m));
    return { terminal, base, runner, ptys, view, events };
  }

  it("exec vai ao host bridge (base) e a saída é ESPELHADA com cabeçalho de segundo plano", async () => {
    const h = background();
    const r = await h.runner.exec(CHECK, { timeoutMs: 1234 });
    expect(r).toEqual({ code: 9, stdout: "[base] direto", stderr: "" });
    expect(h.base.execCalls).toEqual([CHECK]);
    const text = h.view.join("");
    expect(text).toContain("segundo plano");
    expect(text).toContain("root");
    expect(text).toContain(CHECK);
    expect(text).toContain("│\x1b[0m [base] direto");
    expect(text).toContain("código de saída 9");
    expect(text).not.toMatch(/[^\r]\n/); // quebras normalizadas para o xterm
    expect(h.events).toEqual([
      { type: "background-exec", state: "start", command: CHECK },
      { type: "background-exec", state: "end", command: CHECK, code: 9 },
    ]);
  });

  it("o espelho NUNCA escreve no stdin do PTY do usuário (nem abre sessão)", async () => {
    const h = background();
    await h.runner.exec(CHECK);
    await h.runner.execStream(PHASE, () => undefined);
    expect(h.ptys).toHaveLength(0);
    const { replay } = await h.terminal.connect(); // operador abre o terminal depois
    expect(replay).toContain("[base-runner] saída direta"); // viu no scrollback
    expect(h.ptys[0]!.inputs).toEqual([]); // e nada foi digitado no shell dele
    await h.terminal.dispose();
  });

  it("execStream: chunks crus ao executor e prefixados no espelho, linha a linha", async () => {
    const h = background();
    h.base.execStream = async (cmd, onData) => {
      h.base.streamCalls.push(cmd);
      onData("linha 1\nlinha");
      onData(" 2\r\nfim");
      return 0;
    };
    const seen: string[] = [];
    await expect(h.runner.execStream(PHASE, (c) => seen.push(c))).resolves.toBe(0);
    expect(seen).toEqual(["linha 1\nlinha", " 2\r\nfim"]);
    const text = h.view.join("");
    expect(text).toContain("│\x1b[0m linha 1\r\n\x1b[35m│\x1b[0m linha 2\r\n\x1b[35m│\x1b[0m fim\r\n");
    expect(text).toContain("código de saída 0");
  });

  it("falha do base (ex.: fora da allowlist) aparece no espelho e propaga", async () => {
    const h = background();
    h.base.exec = async () => {
      throw new Error("comando fora da allowlist do host bridge: x");
    };
    await expect(h.runner.exec("x")).rejects.toThrow(/allowlist/);
    expect(h.view.join("")).toContain("falhou: comando fora da allowlist");
    expect(h.events.at(-1)).toEqual({ type: "background-exec", state: "end", command: "x", code: null });
    h.base.execStream = async () => {
      throw "falha não-Error";
    };
    await expect(h.runner.execStream("y", () => undefined)).rejects.toBe("falha não-Error");
    expect(h.view.join("")).toContain("falhou: falha não-Error");
  });

  it("saída grande de um check é truncada no espelho (o executor recebe tudo)", async () => {
    const h = background();
    const big = "x".repeat(20_000);
    h.base.exec = async () => ({ code: 0, stdout: big, stderr: "aviso" });
    const r = await h.runner.exec(CHECK);
    expect(r.stdout).toBe(big);
    const text = h.view.join("");
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("saída truncada no espelho");
  });

  it("caracteres de controle no comando não viram sequência de terminal no cabeçalho", async () => {
    const h = background();
    await h.runner.exec("echo \x1b[2Jlimpa");
    expect(h.view.join("")).toContain("echo ?[2Jlimpa");
  });

  it("delegações: label, perfil, ensureReady e upload (anunciado no espelho)", async () => {
    const h = background();
    expect(h.runner.label).toBe("fake");
    expect(h.runner.profile).toBe("host");
    await h.runner.ensureReady();
    await h.runner.uploadDir("/local", "/opt/paas-hardening");
    expect(h.base.uploaded).toBe(true);
    expect(h.view.join("")).toContain("/opt/paas-hardening");
  });
});
