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
import { TerminalRelayRunner } from "../src/services/terminal-runner.js";
import { TerminalService } from "../src/services/terminal-service.js";
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

function setup(opts?: { failOpen?: boolean; audit?: (detail: string) => void }) {
  const ptys: FakePty[] = [];
  const terminal = new TerminalService({
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
