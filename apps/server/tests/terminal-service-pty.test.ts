/**
 * terminal-service-pty.test.ts — repro do bug P0 (captura vazia do scanner)
 * com PTY REAL, não fake: container Docker local + `docker exec` com Tty:true
 * via docker.sock — exatamente o caminho do docker-socket.ts em produção.
 *
 * PADRÃO DE BYTES REPRODUZIDO (bash -l + readline, TERM=xterm-256color):
 * ao aceitar a linha digitada, o readline emite `\x1b[?2004l\r` (bracketed
 * paste off + CR) IMEDIATAMENTE antes da saída do comando — sem \n entre
 * eles. Quando os dois writes coalescem numa leitura do socket (intermitente
 * por comando — depende do timing do daemon, piora com o shell de longa
 * vida), a "linha" do byte stream fica:
 *
 *   \x1b[?2004l\r:::PAAS_BEGIN_<nonce>\r
 *
 * Com a âncora ^ o BEGIN NUNCA casava nessa linha: `capturing` não ligava,
 * o EXIT casava (fix d274efd) e a captura ia VAZIA ao avaliador — todos os
 * checks viravam "ausente"/unknown, e a linha do BEGIN ainda vazava VISÍVEL
 * para o scrollback do usuário (o fumo observado na VPS).
 *
 * Estes testes FALHAM sem o fix do BEGIN tolerante e PASSAM com ele.
 * Pulados quando não há Docker disponível (o CI tem Docker).
 */
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TerminalService } from "../src/services/terminal-service.js";
import { createDockerPtyFactory } from "../src/services/docker-socket.js";
import type { ServerConfig } from "../src/config.js";

const execFileAsync = promisify(execFile);
const CONTAINER = "paas-terminal-pty-repro";
const IMAGE = "ubuntu:24.04"; // bash 5.2 + readline: mesmo stack do alvo real

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();

const config = {
  dockerSocketPath: process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock",
  securityTarget: "container",
  securityTargetContainer: CONTAINER,
} as unknown as ServerConfig;

describe.skipIf(!HAS_DOCKER)("TerminalService — repro P0 com PTY REAL (docker exec Tty)", () => {
  beforeAll(async () => {
    // Warm-up determinístico: garante a imagem em cache ANTES do `docker run`.
    // Sem isso, num ambiente sem cache (runner do CI), o pull implícito do
    // `run` despeja "Unable to find image... / Pull complete" no stderr e
    // quebra a assertion de stream limpo abaixo. A saída do pull é descartada.
    await execFileAsync("docker", ["image", "inspect", IMAGE], {
      timeout: 15_000,
    }).catch(() =>
      execFileAsync("docker", ["pull", "--quiet", IMAGE], { timeout: 180_000 }),
    );
    await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    const run = await execFileAsync(
      "docker",
      ["run", "-d", "--name", CONTAINER, IMAGE, "sleep", "infinity"],
      { timeout: 60_000 }, // imagem já em cache: run deve ser rápido e silencioso
    );
    expect(run.stderr).toBe("");
  }, 200_000);

  afterAll(async () => {
    await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
  }, 30_000);

  it("captura NÃO sai vazia quando o BEGIN vem colado à sequência do readline (linha digitada longa)", async () => {
    const service = new TerminalService({ openPty: createDockerPtyFactory(config) });
    const view: string[] = [];
    service.onOutput((c) => view.push(c)); // o que o usuário vê no xterm
    try {
      // Comando no estilo dos checks do scanner (pipeline longo > 80 cols de
      // linha digitada, saída SEM newline final — como `ss ... | tr '\n' ' '`).
      const payload =
        "10.0.0.1:22 10.0.0.1:80 10.0.0.1:443 10.0.0.1:9000 10.0.0.1:9001 ";
      const cmd = `printf '%s' '${payload}'`; // saída sem newline final
      const result = await service.runCommandCaptured(cmd, { timeoutMs: 20_000 });
      // ANTES do fix: { code: 0, output: "" } — a captura dessincronizava e
      // o scanner avaliava lixo. DEPOIS: a saída real, byte a byte.
      expect(result.code).toBe(0);
      expect(result.output).toBe(payload);
      // e o marcador BEGIN NUNCA aparece como linha de saída no terminal do
      // usuário (o fumo da VPS: `:::PAAS_BEGIN_<nonce>\r` visível = regex não casou)
      expect(view.join("")).not.toMatch(/:::PAAS_BEGIN_[0-9a-f]{8}\r/);
    } finally {
      await service.dispose();
    }
  }, 90_000);

  it("scanner em sequência: vários runCommandCaptured seguidos capturam corretamente", async () => {
    const service = new TerminalService({ openPty: createDockerPtyFactory(config) });
    try {
      // 1) saída sem newline final (cola o EXIT — fix d274efd)…
      const first = await service.runCommandCaptured("printf 'a b '", { timeoutMs: 20_000 });
      expect(first).toEqual({ code: 0, output: "a b " });
      // 2) …e o check seguinte continua capturando (BEGIN limpo ou colado)
      const second = await service.runCommandCaptured("hostname", { timeoutMs: 20_000 });
      expect(second.code).toBe(0);
      expect(second.output.trim()).not.toBe("");
      // 3) comando real do catálogo: net.listening-inventory (ss pode não
      // existir na imagem mínima — o que importa é resolver com a saída do
      // pipeline, mesmo vazia, sem dessincronizar)
      const inventory = await service.runCommandCaptured(
        "ss -tuln 2>/dev/null | tail -n +2 | awk '{print $5}' | sort -u | tr '\\n' ' '",
        { timeoutMs: 20_000 },
      );
      expect(inventory.code).toBe(0);
    } finally {
      await service.dispose();
    }
  }, 90_000);
});
