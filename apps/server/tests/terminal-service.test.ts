/**
 * terminal-service.test.ts — a REGRA DE OURO do terminal web:
 *  - relay puro: input do usuário vai ao PTY e NUNCA aparece em auditoria;
 *  - auditoria apenas de ciclo de vida (sessão criada/encerrada/timeout);
 *  - runCommand: saída ao vivo, marcador de exit filtrado, fila serializada;
 *  - sessão única com replay de scrollback, resize validado, idle timeout.
 */
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CaptureDesyncError,
  TerminalService,
  TerminalUnavailableError,
} from "../src/services/terminal-service.js";
import type { RemotePty } from "../src/services/docker-socket.js";
import { SECURITY_CHECKS } from "@paas/security";

/** PTY falso: captura input, emite saída programada, registra resize/kill. */
class FakePty implements RemotePty {
  readonly inputs: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
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

  /** Emula saída do processo no PTY. */
  emit(data: string): void {
    this.stream.push(data);
  }

  /** Emula o fim do processo (stream fecha). */
  end(): void {
    this.stream.push(null);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.end();
  }
}

/** Aguarda a entrega assíncrona dos eventos do stream (next tick). */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface Harness {
  service: TerminalService;
  ptys: FakePty[];
  audits: Array<{ action: string; detail: string }>;
  next: () => FakePty;
}

function makeService(opts?: {
  idleTimeoutMs?: number;
  failOpen?: boolean;
}): Harness {
  const ptys: FakePty[] = [];
  const audits: Array<{ action: string; detail: string }> = [];
  const service = new TerminalService({
    openPty: () => {
      if (opts?.failOpen) return Promise.reject(new Error("docker.sock ausente"));
      const pty = new FakePty();
      ptys.push(pty);
      return Promise.resolve(pty);
    },
    ...(opts?.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    audit: (action, detail) => audits.push({ action, detail }),
  });
  const next = () => {
    const pty = ptys[ptys.length - 1];
    if (!pty) throw new Error("nenhum PTY criado ainda");
    return pty;
  };
  return { service, ptys, audits, next };
}

describe("TerminalService — REGRA DE OURO: input nunca é logado/auditado", () => {
  it("write() faz relay puro ao PTY e NADA do input aparece na auditoria", async () => {
    const { service, audits, next } = makeService();
    await service.connect();
    service.write("senha-secreta-super-confidencial\n");
    service.write("outro-segredo");

    const pty = next();
    expect(pty.inputs.join("")).toContain("senha-secreta-super-confidencial");
    // auditoria existe (ciclo de vida), mas NUNCA com conteúdo digitado
    expect(audits.length).toBeGreaterThan(0);
    const blob = JSON.stringify(audits);
    expect(blob).not.toContain("senha-secreta");
    expect(blob).not.toContain("outro-segredo");
    // e o input não vaza para o scrollback/output sem eco do PTY
    const { replay } = await service.connect();
    expect(replay).not.toContain("senha-secreta");
    await service.dispose();
  });

  it("auditoria registra apenas ciclo de vida (abrir/encerrar), sem payloads", async () => {
    const { service, audits } = makeService();
    await service.connect();
    service.write("root-password-123\n");
    await service.dispose();
    expect(audits.map((a) => a.action)).toEqual(["terminal.session"]);
    expect(JSON.stringify(audits)).not.toContain("root-password-123");
  });
});

describe("TerminalService — sessão", () => {
  it("sessão única: connect() reutiliza o PTY e devolve replay do scrollback", async () => {
    const { service, ptys, next } = makeService();
    await service.connect();
    next().emit("root@host:~$ ");
    await flush();
    const second = await service.connect();
    expect(ptys).toHaveLength(1);
    expect(second.replay).toContain("root@host:~$ ");
    expect(service.sessionActive).toBe(true);
    await service.dispose();
    expect(service.sessionActive).toBe(false);
  });

  it("broadcast replica a saída aos assinantes", async () => {
    const { service, next } = makeService();
    await service.connect();
    const seen: string[] = [];
    const off = service.onOutput((c) => seen.push(c));
    next().emit("linha-1\n");
    await flush();
    off();
    next().emit("linha-2\n");
    await flush();
    expect(seen.join("")).toBe("linha-1\n");
    await service.dispose();
  });

  it("falha ao abrir o PTY vira TerminalUnavailableError (fallback seguro)", async () => {
    const { service } = makeService({ failOpen: true });
    await expect(service.connect()).rejects.toBeInstanceOf(TerminalUnavailableError);
    await expect(service.runCommand("echo x", () => undefined)).rejects.toBeInstanceOf(
      TerminalUnavailableError,
    );
  });

  it("idle timeout encerra a sessão e audita (sem conteúdo)", async () => {
    const { service, audits, next } = makeService({ idleTimeoutMs: 40 });
    await service.connect();
    service.write("segredo-digitado");
    await new Promise((r) => setTimeout(r, 120));
    expect(service.sessionActive).toBe(false);
    expect(next().killed).toBe(true);
    const idle = audits.find((a) => a.action === "terminal.idle-timeout");
    expect(idle).toBeDefined();
    expect(JSON.stringify(audits)).not.toContain("segredo-digitado");
  });

  it("resize valida dimensões antes de repassar ao PTY", async () => {
    const { service, next } = makeService();
    await service.connect();
    service.resize(120, 40);
    service.resize(1, 1); // pequeno demais
    service.resize(10_000, 40); // grande demais
    service.resize(12.5, 40); // não inteiro
    expect(next().resizes).toEqual([{ cols: 120, rows: 40 }]);
    await service.dispose();
  });
});

describe("TerminalService — runCommand (fases dentro do terminal)", () => {
  it("transmite saída ao vivo, filtra o marcador e resolve o exit code", async () => {
    const { service, next } = makeService();
    const broadcasted: string[] = [];
    service.onOutput((c) => broadcasted.push(c));
    const jobLog: string[] = [];

    const promise = service.runCommand("bash /opt/fase.sh --dry-run", (c) => jobLog.push(c));
    await flush();
    const pty = next();
    // o comando aparece digitado no terminal (transparência)
    expect(pty.inputs.join("")).toContain("bash /opt/fase.sh --dry-run");

    const markerLine = /echo ":::PAAS_EXIT_([0-9a-f]+):\$\?"/.exec(pty.inputs.join(""));
    const nonce = markerLine?.[1];
    expect(nonce).toBeTruthy();
    // eco do shell + saída do script + marcador
    pty.emit(`bash /opt/fase.sh --dry-run; echo ":::PAAS_EXIT_${nonce}:$?"\r\n`);
    pty.emit(":::PAAS_STEP Atualizando pacotes\r\n");
    pty.emit("trabalhando...\r\n");
    pty.emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    const code = await promise;
    expect(code).toBe(0);
    const log = jobLog.join("");
    expect(log).toContain(":::PAAS_STEP Atualizando pacotes");
    expect(log).toContain("trabalhando...");
    expect(log).not.toContain(`:::PAAS_EXIT_${nonce}:0`); // marcador filtrado
    expect(broadcasted.join("")).toContain("trabalhando...");
    expect(broadcasted.join("")).not.toContain(`:::PAAS_EXIT_${nonce}:0`);
    await service.dispose();
  });

  it("resolve exit code não-zero (falha da fase)", async () => {
    const { service, next } = makeService();
    const promise = service.runCommand("false", () => undefined);
    await flush();
    const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(next().inputs.join(""))?.[1];
    next().emit(`:::PAAS_EXIT_${nonce}:3\r\n`);
    await expect(promise).resolves.toBe(3);
    await service.dispose();
  });

  it("prompt sem newline (ex.: senha) é exibido na hora — não fica preso no buffer", async () => {
    const { service, next } = makeService();
    const seen: string[] = [];
    const promise = service.runCommand("passwd deploy", (c) => seen.push(c));
    await flush();
    const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(next().inputs.join(""))?.[1];
    next().emit("New password:"); // sem \n — precisa aparecer imediatamente
    await flush();
    expect(seen.join("")).toContain("New password:");
    next().emit(`\r\n:::PAAS_EXIT_${nonce}:0\r\n`);
    await expect(promise).resolves.toBe(0);
    await service.dispose();
  });

  it("rejeita comandos com quebra de linha (uma linha apenas)", async () => {
    const { service } = makeService();
    await expect(service.runCommand("echo a\nrm -rf /", () => undefined)).rejects.toThrow(
      /uma linha/,
    );
  });

  it("serializa comandos: o segundo só começa após o primeiro terminar", async () => {
    const { service, next } = makeService();
    const order: string[] = [];
    const p1 = service.runCommand("primeiro", () => undefined).then((c) => order.push(`p1:${c}`));
    const p2 = service.runCommand("segundo", () => undefined).then((c) => order.push(`p2:${c}`));
    await new Promise((r) => setTimeout(r, 10));
    const pty = next();
    expect(pty.inputs.join("")).toContain("primeiro");
    expect(pty.inputs.join("")).not.toContain("segundo"); // ainda na fila
    const nonces = [...pty.inputs.join("").matchAll(/PAAS_EXIT_([0-9a-f]+):/g)].map((m) => m[1]);
    pty.emit(`:::PAAS_EXIT_${nonces[0]}:0\r\n`);
    await new Promise((r) => setTimeout(r, 10));
    expect(pty.inputs.join("")).toContain("segundo");
    const nonces2 = [...pty.inputs.join("").matchAll(/PAAS_EXIT_([0-9a-f]+):/g)].map((m) => m[1]);
    pty.emit(`:::PAAS_EXIT_${nonces2[nonces2.length - 1]}:2\r\n`);
    await Promise.all([p1, p2]);
    expect(order).toEqual(["p1:0", "p2:2"]);
    await service.dispose();
  });

  it("sessão DESTACÁVEL: marcador de exit é lido do stream do PTY mesmo com o subscriber (browser) desconectado no meio da execução", async () => {
    const { service, next } = makeService();
    const view: string[] = [];
    const off = service.onOutput((c) => view.push(c)); // o WS do browser
    const promise = service.runCommand("bash /opt/paas-hardening/05.sh --dry-run", () => undefined);
    await flush();
    const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(next().inputs.join(""))?.[1];
    next().emit(":::PAAS_STEP Atualizando pacotes\r\n");
    await flush();
    expect(view.join("")).toContain(":::PAAS_STEP");

    off(); // o browser CAIU no meio da fase (WS desconectado)
    next().emit(":::PAAS_OK pacotes atualizados\r\n");
    next().emit(`:::PAAS_EXIT_${nonce}:0\r\n`);

    // o exit code AINDA é capturado (parse server-side) — a fase NÃO falha
    await expect(promise).resolves.toBe(0);
    // e a saída posterior ao disconnect ficou no scrollback para o reattach
    const { replay } = await service.connect();
    expect(replay).toContain(":::PAAS_OK pacotes atualizados");
    await service.dispose();
  });

  it("sessão morta pelo alvo REMOVE o container (kill no PTY) — sem leak de paas-terminal-*", async () => {
    const { service, ptys, next } = makeService();
    await service.connect();
    const first = next();
    first.end(); // stream morreu (erro/fim) com o container ainda de pé
    await flush();
    expect(first.killed).toBe(true); // cleanup do alvo ao encerrar a sessão
    // a próxima conexão abre um PTY NOVO (o antigo foi removido, não vazou)
    await service.connect();
    expect(ptys).toHaveLength(2);
    await service.dispose();
  });

  it("sessão morta no meio do comando rejeita (sem fallback — nunca re-executa)", async () => {
    const { service, next } = makeService();
    const promise = service.runCommand("bash /opt/fase.sh", () => undefined);
    await flush();
    next().end(); // alvo caiu no meio da fase
    await expect(promise).rejects.toThrow(/terminal foi encerrado/);
  });

  it("timeout do comando rejeita APENAS o comando — a sessão NÃO é derrubada e a fila segue", async () => {
    vi.useFakeTimers();
    try {
      const { service, next } = makeService();
      // PTY que nunca responde ao 1º comando (travou) mas responde ao 2º
      const stuck = service.runCommand("sleep 9999", () => undefined, { timeoutMs: 1_000 });
      const stuckAssertion = expect(stuck).rejects.toThrow(/tempo limite/); // handler anexado já
      const queued = service.runCommand("echo depois-do-timeout", () => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      // Ctrl-C enviado ao PTY
      expect(next().inputs.join("")).toContain("\x03");
      await vi.advanceTimersByTimeAsync(5_000);
      await stuckAssertion;
      // a sessão sobrevive: nada de dispose/kill por causa de UM comando lento
      expect(service.sessionActive).toBe(true);
      expect(next().killed).toBe(false);
      // e o próximo comando da fila roda no MESMO shell (prompt voltou com o Ctrl-C)
      await vi.advanceTimersByTimeAsync(0);
      const nonces = [...next().inputs.join("").matchAll(/PAAS_EXIT_([0-9a-f]+):/g)].map((m) => m[1]);
      expect(nonces).toHaveLength(2);
      expect(next().inputs.join("")).toContain("echo depois-do-timeout");
      next().emit(`:::PAAS_EXIT_${nonces[1]}:0\r\n`);
      await expect(queued).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout seguido de marcador tardio do Ctrl-C resolve normal (sem rejeitar)", async () => {
    vi.useFakeTimers();
    try {
      const { service, next } = makeService();
      const promise = service.runCommand("sleep 9999", () => undefined, { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(next().inputs.join(""))?.[1];
      // o Ctrl-C funcionou: o shell imprime o marcador dentro do grace de 5s
      next().emit(`:::PAAS_EXIT_${nonce}:130\r\n`);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(promise).resolves.toBe(130); // SIGINT — comando interrompido, sessão íntegra
      expect(service.sessionActive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TerminalService — runCommandCaptured (checks do scanner no terminal)", () => {
  function nonceOf(ptyInputs: string[], kind: "BEGIN" | "EXIT"): string {
    const m = new RegExp(`:::PAAS_${kind}_([0-9a-f]+)`).exec(ptyInputs.join(""));
    if (!m?.[1]) throw new Error(`marcador ${kind} não encontrado no input do PTY`);
    return m[1];
  }

  it("captura só a saída real (sem eco do comando nem marcadores) + exit code", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("cat /etc/os-release");
    await flush();
    const pty = next();
    const nonce = nonceOf(pty.inputs, "BEGIN");
    // o comando digitado inclui os DOIS marcadores (visível/honesto no terminal)
    expect(pty.inputs.join("")).toContain(`echo ":::PAAS_BEGIN_${nonce}"; cat /etc/os-release; echo ":::PAAS_EXIT_${nonce}:$?"`);

    // o shell ecoa o comando digitado (uma linha) e depois vem a saída real
    pty.emit(`echo ":::PAAS_BEGIN_${nonce}"; cat /etc/os-release; echo ":::PAAS_EXIT_${nonce}:$?"\r\n`);
    pty.emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    pty.emit('PRETTY_NAME="Ubuntu 24.04 LTS"\r\n');
    pty.emit(`:::PAAS_EXIT_${nonce}:0\r\n`);

    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe('PRETTY_NAME="Ubuntu 24.04 LTS"\n');
    expect(result.output).not.toContain("PAAS_BEGIN");
    expect(result.output).not.toContain("os-release; echo");
  });

  it("a saída capturada TAMBÉM aparece ao vivo para os clientes do terminal", async () => {
    const { service, next } = makeService();
    const view: string[] = [];
    service.onOutput((c) => view.push(c));
    const promise = service.runCommandCaptured("hostname");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    next().emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    next().emit("minha-vps\r\n");
    next().emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    await promise;
    expect(view.join("")).toContain("minha-vps");
    expect(view.join("")).not.toContain("PAAS_BEGIN");
  });

  it("exit code não-zero é propagado com a saída parcial", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("grep algo /inexistente");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    next().emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    next().emit("grep: /inexistente: No such file or directory\r\n");
    next().emit(`:::PAAS_EXIT_${nonce}:2\r\n`);
    const result = await promise;
    expect(result.code).toBe(2);
    expect(result.output).toContain("No such file or directory");
  });

  it("rejeita comandos com quebra de linha (uma linha apenas)", async () => {
    const { service } = makeService();
    await expect(service.runCommandCaptured("echo a\necho b")).rejects.toThrow(/uma linha/);
  });

  it("marcador COLADO após saída sem newline final (caso real: tr '\\n' ' ') resolve e preserva a saída", async () => {
    const { service, next } = makeService();
    const broadcasted: string[] = [];
    service.onOutput((c) => broadcasted.push(c));
    const promise = service.runCommandCaptured("ss -tuln | tail -n +2 | awk '{print $5}' | sort -u | tr '\\n' ' '");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    next().emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    // a saída NÃO termina com \n — o echo do marcador imprime na MESMA linha
    next().emit(`0.0.0.0:22 0.0.0.0:9000 :::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    // saída preservada byte a byte (sem o marcador, sem newline sintético)
    expect(result.output).toBe("0.0.0.0:22 0.0.0.0:9000 ");
    expect(result.output).not.toContain("PAAS_EXIT");
    // e o usuário vê as portas ao vivo, sem o marcador
    expect(broadcasted.join("")).toContain("0.0.0.0:22 0.0.0.0:9000 ");
    expect(broadcasted.join("")).not.toContain(`PAAS_EXIT_${nonce}`);
    await service.dispose();
  });

  it("marcador colado após sequência ANSI também resolve", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("echo -e '\\033[32mOK\\033[0m'");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    next().emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    next().emit(`\x1b[32mOK\x1b[0m :::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("\x1b[32mOK\x1b[0m ");
    await service.dispose();
  });

  it("marcador colado no meio da linha E dividido entre chunks resolve sem vazar", async () => {
    const { service, next } = makeService();
    const broadcasted: string[] = [];
    service.onOutput((c) => broadcasted.push(c));
    const promise = service.runCommandCaptured("printf 'porta1 porta2 '");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    next().emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    // chunk quebra DENTRO do marcador, que já está colado na saída sem \n
    next().emit("porta1 porta2 :::PAAS_EX");
    next().emit(`IT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("porta1 porta2 ");
    expect(broadcasted.join("")).not.toContain("PAAS_EX");
    await service.dispose();
  });

  it("marcador BEGIN COLADO ao prompt (sem newline) liga a captura e o prompt segue visível", async () => {
    const { service, next } = makeService();
    const broadcasted: string[] = [];
    service.onOutput((c) => broadcasted.push(c));
    const promise = service.runCommandCaptured("hostname");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    // Caso real da VPS: o echo do input chega atrasado/intercalado e o echo
    // do BEGIN sai NA MESMA LINHA do prompt (que não termina com newline).
    // Com a âncora ^ isso NUNCA casava: captura vazia + marcador visível.
    next().emit(`root@vps:~# :::PAAS_BEGIN_${nonce}\r\n`);
    next().emit("minha-vps\r\n");
    next().emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("minha-vps\n");
    // o trecho antes do marcador (prompt) é conteúdo real: segue visível
    expect(broadcasted.join("")).toContain("root@vps:~# ");
    expect(broadcasted.join("")).not.toContain(`PAAS_BEGIN_${nonce}`);
    await service.dispose();
  });

  it("marcador BEGIN colado ao prompt E dividido entre chunks liga a captura", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("hostname");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    // chunk quebra DENTRO do BEGIN, já colado ao prompt sem newline
    next().emit("root@vps:~# :::PAAS_BE");
    next().emit(`GIN_${nonce}\r\n`);
    next().emit("minha-vps\r\n");
    next().emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("minha-vps\n");
    await service.dispose();
  });

  it("texto parecido com marcador na saída real NÃO é segurado nem liga captura duas vezes", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("cat /var/log/app.log");
    await flush();
    const nonce = nonceOf(next().inputs, "BEGIN");
    next().emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    // saída real contém um sufixo tipo-marcador no fim do chunk: com a
    // captura JÁ ligada, não pode ficar preso no buffer de marcador
    next().emit("linha de log :::PAAS_BE");
    next().emit("qualquer\r\n");
    next().emit(`:::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("linha de log :::PAAS_BEqualquer\n");
    await service.dispose();
  });

  it("EXIT sem BEGIN (captura dessincronizada) NÃO entrega vazio: retenta UMA vez e captura", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("hostname");
    await flush();
    const pty = next();
    const nonce1 = nonceOf(pty.inputs, "BEGIN");
    // o BEGIN da 1ª tentativa se perdeu no byte stream; o EXIT chega mesmo assim
    pty.emit(`:::PAAS_EXIT_${nonce1}:0\r\n`);
    await flush();
    await flush();
    // retentativa automática: o comando foi digitado de novo, com NOVO nonce
    const nonces = [...pty.inputs.join("").matchAll(/:::PAAS_BEGIN_([0-9a-f]+)/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(2);
    const nonce2 = nonces[1]!;
    expect(nonce2).not.toBe(nonce1);
    pty.emit(`:::PAAS_BEGIN_${nonce2}\r\n`);
    pty.emit("minha-vps\r\n");
    pty.emit(`:::PAAS_EXIT_${nonce2}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("minha-vps\n");
    await service.dispose();
  });

  it("dessincronia também na retentativa → CaptureDesyncError propaga (scanner marca unknown, nunca fail)", async () => {
    const { service, next } = makeService();
    const promise = service.runCommandCaptured("hostname");
    const assertion = expect(promise).rejects.toBeInstanceOf(CaptureDesyncError);
    await flush();
    const pty = next();
    const nonce1 = nonceOf(pty.inputs, "BEGIN");
    pty.emit(`:::PAAS_EXIT_${nonce1}:0\r\n`); // sem BEGIN — dessincronizado
    await flush();
    await flush();
    const nonces = [...pty.inputs.join("").matchAll(/:::PAAS_BEGIN_([0-9a-f]+)/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(2); // exatamente UMA retentativa
    pty.emit(`:::PAAS_EXIT_${nonces[1]}:0\r\n`); // de novo sem BEGIN
    await assertion;
    await flush();
    // NÃO há terceira tentativa
    const final = [...pty.inputs.join("").matchAll(/:::PAAS_BEGIN_([0-9a-f]+)/g)].map((m) => m[1]);
    expect(final).toHaveLength(2);
    await service.dispose();
  });

  it("end-to-end: comando real do check net.listening-inventory resolve sem timeout e alimenta o evaluate", async () => {
    const def = SECURITY_CHECKS.find((c) => c.id === "net.listening-inventory");
    if (!def) throw new Error("check net.listening-inventory não encontrado");
    const { service, next } = makeService();
    const promise = service.runCommandCaptured(def.command, { timeoutMs: 5_000 });
    await flush();
    const pty = next();
    // o comando digitado no terminal é exatamente o do catálogo
    expect(pty.inputs.join("")).toContain(def.command);
    const nonce = nonceOf(pty.inputs, "BEGIN");
    pty.emit(`:::PAAS_BEGIN_${nonce}\r\n`);
    // saída real do pipeline `ss ... | tr '\n' ' '`: sem newline final,
    // marcador colado — antes do fix isso estourava o timeout de 65s
    pty.emit(`0.0.0.0:22 0.0.0.0:9000 :::PAAS_EXIT_${nonce}:0\r\n`);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.output).toBe("0.0.0.0:22 0.0.0.0:9000 ");
    const evaluation = def.evaluate({ code: result.code, stdout: result.output, stderr: "" });
    expect(evaluation.status).toBe("pass");
    expect(evaluation.detail).toBe("0.0.0.0:22 0.0.0.0:9000");
    await service.dispose();
  });
});
