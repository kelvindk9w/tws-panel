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
 *
 * PRONTIDÃO DO SHELL (por que existe abrirTerminalPronto)
 * ------------------------------------------------------
 * `docker exec` com Tty devolve o stream ANTES de o shell existir: o exec roda
 * `sh -c "... exec bash -l"`, e o bash ainda precisa nascer, ler /etc/profile,
 * /etc/bash.bashrc e ~/.bashrc e só então entrar no readline. Escrevendo o
 * comando na hora, a linha é entregue a um terminal em modo CANÔNICO, sem
 * shell nenhum lendo — o eco que volta primeiro é o do PRÓPRIO KERNEL (N_TTY),
 * antes de qualquer `\x1b[?2004h` do readline, e a linha é ecoada DUAS vezes
 * (kernel + readline). Medido neste repositório, dump do stream cru:
 *
 *   [0] echo ":::PAAS_BEGIN_…"; printf …          <- eco do kernel, sem ESC
 *   [1] \x1b[?2004h\x1b]0;root@…\x07root@…:/#     <- bash chegou ao readline
 *   [2] echo ":::PAAS_BEGIN_…"; printf '%s' '10.0\r0.0.1:80 …   <- eco do readline
 *
 * Consequências, ambas ruins para um teste:
 *  - o relógio do COMANDO (timeoutMs) passa a cobrir também a subida do exec e
 *    do bash de login com page cache frio — o teste mede tempo de Docker, não
 *    de comando, e quando estoura reporta "comando excedeu o tempo limite",
 *    que aponta para o lugar errado;
 *  - o PTY do exec nasce 0x0 (`stty -a` responde `rows 0; columns 0`, ninguém
 *    faz resize aqui), então o readline cai no termcap do xterm (80 colunas) e
 *    QUEBRA a linha ecoada com `\r` no meio — capturado ao vivo:
 *    `:::PAAS_EXIT_deadbeef:\r:$?`. ONDE esse `\r` cai depende de quem ecoou
 *    (kernel ou readline) e de quanto do prompt já estava na tela, ou seja:
 *    enquanto o shell está subindo, o byte stream que estes testes afirmam
 *    não é determinístico.
 *
 * O que NÃO é a causa (verificado, para não voltar a ser hipótese): a entrada
 * escrita antes do shell não se perde. Com o container limitado a 0,05 CPU,
 * com um `sleep 6` no /etc/profile, e escrevendo a linha PARTIDA EM DOIS
 * pedaços com atraso varrido de 0 a 400 ms (84 tentativas), o bash executou
 * todas — o readline não descarta o que já estava na fila do terminal.
 *
 * Por isso cada teste abre o terminal com abrirTerminalPronto(): espera o
 * prompt do readline no fluxo (prova de que o bash configurou o terminal) e
 * roda um comando trivial de aquecimento, cada etapa com relógio próprio e
 * mensagem própria. As asserções reais rodam num shell COMPROVADAMENTE pronto
 * — que é, aliás, o cenário de produção descrito acima ("shell de longa
 * vida"), com o BEGIN colado ao `\x1b[?2004l\r` do readline.
 *
 * SEM retentativa automática do Vitest neste arquivo, de propósito: ela
 * esconderia também o CaptureDesyncError, que é exatamente o defeito que
 * estes testes existem para pegar.
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

/**
 * Teto da SUBIDA do shell (exec + bash de login), separado do teto de
 * execução de comando. Medido: com a imagem em cache, o prompt do readline
 * aparece em ~30 ms nesta máquina; com o container estrangulado a 0,05 CPU,
 * ~500 ms; com um `sleep 6` plantado no /etc/profile, ~6 s. O arquivo inteiro
 * levou 2,9 s numa execução saudável do CI. 45 s é folga de uma ordem de
 * grandeza sobre o pior caso já medido — e, quando estoura, a mensagem diz
 * que o TERMINAL não ficou pronto, em vez de acusar o comando.
 */
const PRONTIDAO_TIMEOUT_MS = 45_000;
/** Teto do comando trivial de aquecimento (round-trip completo já pronto). */
const AQUECIMENTO_TIMEOUT_MS = 30_000;
/**
 * Teto de execução dos comandos MEDIDOS. Já não cobre subida de Docker nem de
 * bash — isso agora é do PRONTIDAO_TIMEOUT_MS. Medido: um runCommandCaptured
 * num shell pronto leva p50 38 ms / máx 152 ms com o processo preso em dois
 * núcleos saturados (25 repetições). 30 s são ~200x o pior caso medido; era
 * 60 s só porque o número precisava esconder a subida do container.
 */
const COMANDO_TIMEOUT_MS = 30_000;

/**
 * Espera o shell do PTY estar REALMENTE pronto para ler stdin.
 *
 * `\x1b[?2004h` (bracketed paste ligado) é emitido pelo readline dentro de
 * rl_prep_terminal, imediatamente ANTES do primeiro prompt: vê-lo prova que o
 * bash terminou os arquivos de login e já configurou o terminal. O prompt
 * terminado em "# "/"$ " é a rede de segurança para um shell sem readline
 * (o ramo `sh -l` de imagem mínima do docker-socket.ts).
 */
async function esperarShellPronto(view: string[]): Promise<void> {
  const limite = Date.now() + PRONTIDAO_TIMEOUT_MS;
  for (;;) {
    const texto = view.join("");
    if (texto.includes("\x1b[?2004h") || /[#$] $/.test(texto)) return;
    if (Date.now() >= limite) {
      throw new Error(
        `o shell do PTY não ficou pronto em ${PRONTIDAO_TIMEOUT_MS}ms — nenhum prompt no fluxo ` +
          `(últimos bytes: ${JSON.stringify(texto.slice(-200))})`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Abre o terminal e só devolve quando ele está pronto: prompt do readline no
 * fluxo + um comando trivial que fez o round-trip inteiro (BEGIN, saída e
 * EXIT). Devolve também `view` — TUDO o que o usuário veria desde o primeiro
 * byte, aquecimento incluso, para as asserções de vazamento de marcador.
 */
async function abrirTerminalPronto(): Promise<{ service: TerminalService; view: string[] }> {
  const service = new TerminalService({ openPty: createDockerPtyFactory(config) });
  const view: string[] = [];
  service.onOutput((c) => view.push(c));
  try {
    await service.connect();
    await esperarShellPronto(view);
    // O sucesso DESTE comando é a prova de prontidão: se a captura
    // dessincronizar aqui, o CaptureDesyncError sobe — nada é mascarado.
    const aquecimento = await service.runCommandCaptured("printf 'pronto'", {
      timeoutMs: AQUECIMENTO_TIMEOUT_MS,
    });
    expect(aquecimento).toEqual({ code: 0, output: "pronto" });
  } catch (err) {
    await service.dispose();
    throw err;
  }
  return { service, view };
}

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
    // `view` = o que o usuário vê no xterm, desde o primeiro byte da sessão.
    const { service, view } = await abrirTerminalPronto();
    try {
      // Comando no estilo dos checks do scanner (pipeline longo > 80 cols de
      // linha digitada, saída SEM newline final — como `ss ... | tr '\n' ' '`).
      const payload =
        "10.0.0.1:22 10.0.0.1:80 10.0.0.1:443 10.0.0.1:9000 10.0.0.1:9001 ";
      const cmd = `printf '%s' '${payload}'`; // saída sem newline final
      // TETO de execução num shell já pronto, não sono fixo: a promise resolve
      // assim que o marcador EXIT chega no stream (runCommandNow). A subida do
      // container e do bash ficou fora daqui (abrirTerminalPronto), então este
      // número volta a medir só o comando — e dessincronia de captura continua
      // falhando na hora, via CaptureDesyncError.
      const result = await service.runCommandCaptured(cmd, { timeoutMs: COMANDO_TIMEOUT_MS });
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
  }, 120_000);

  it("scanner em sequência: vários runCommandCaptured seguidos capturam corretamente", async () => {
    const { service } = await abrirTerminalPronto();
    try {
      // 1) saída sem newline final (cola o EXIT — fix d274efd)…
      // timeoutMs pelo mesmo motivo do teste acima: teto de execução num shell
      // já pronto, não um sono fixo — cada chamada resolve assim que o
      // marcador EXIT chega.
      const first = await service.runCommandCaptured("printf 'a b '", { timeoutMs: COMANDO_TIMEOUT_MS });
      expect(first).toEqual({ code: 0, output: "a b " });
      // 2) …e o check seguinte continua capturando (BEGIN limpo ou colado)
      const second = await service.runCommandCaptured("hostname", { timeoutMs: COMANDO_TIMEOUT_MS });
      expect(second.code).toBe(0);
      expect(second.output.trim()).not.toBe("");
      // 3) comando real do catálogo: net.listening-inventory (ss pode não
      // existir na imagem mínima — o que importa é resolver com a saída do
      // pipeline, mesmo vazia, sem dessincronizar)
      const inventory = await service.runCommandCaptured(
        "ss -tuln 2>/dev/null | tail -n +2 | awk '{print $5}' | sort -u | tr '\\n' ' '",
        { timeoutMs: COMANDO_TIMEOUT_MS },
      );
      expect(inventory.code).toBe(0);
    } finally {
      await service.dispose();
    }
  }, 180_000);
});
