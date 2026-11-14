/**
 * docker-duble.ts — o Docker dos testes do servidor: anota cada comando e responde como uma máquina sem Docker.
 *
 * tests/setup-no-docker.ts troca o `node:child_process` de TODOS os arquivos de teste do servidor pela versão daqui:
 * execFile/spawn/execFileSync/spawnSync com o programa `docker` (ou `docker-compose`) não criam processo nenhum —
 * vão ao dublê. Vale para o painel inteiro (buildApp, DeployService e o motor/Caddy do @paas/deploy, o @paas/mailer,
 * o DockerCli do backup, a lista de containers, os proxies confiáveis): pedir a paas-net, listar containers, remover o
 * `-next`/`-previous` ou a imagem de um projeto nunca sai do processo de teste. Qualquer outro programa (git, sh…)
 * roda de verdade.
 *
 * Exceções: quando o `docker` que o PATH acharia é um docker falso que o PRÓPRIO TESTE criou na pasta temporária
 * (o padrão dos testes de scripts e do restore-reconciliation-docker), o comando vai para ele, como antes; e quando
 * o PATH não tem docker nenhum, o processo falha sozinho (ENOENT), como o teste espera.
 *
 * Resposta padrão: código 1 e o erro de daemon fora do ar — o mesmo que esses testes recebiam numa máquina sem
 * Docker (o que provam continua igual). Teste que quer outra resposta troca `dockerDuble.responder`; o setup volta ao
 * padrão antes de cada teste. `dockerDuble.chamadas` guarda os argumentos de cada comando, na ordem.
 */
import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";

export const DAEMON_FORA = "Cannot connect to the Docker daemon (dublê de teste: sem Docker real)";

/**
 * Socket do Docker dos testes do servidor (o DOCKER_SOCKET_PATH que o setup define): numa pasta temporária que não
 * existe. A API do Docker pelo socket (reaper de helpers do terminal, logs e inspect, OOM das métricas, limpeza,
 * banco, terminal) falha sozinha com ENOENT, como numa máquina sem Docker, e nunca alcança o /var/run/docker.sock.
 */
export const SOCKET_DUBLE = path.join(tmpdir(), "paas-test-sem-docker", "nao-existe", "docker.sock");

export type RespostaDocker = { code: number; stdout?: string; stderr?: string };

const padrao = (): RespostaDocker => ({ code: 1, stdout: "", stderr: DAEMON_FORA });

export const dockerDuble = {
  /** Ligado por usarDockerReal(): neste arquivo, com PAAS_TEST_REAL_DOCKER=1, o docker é o de verdade. */
  real: false,
  /** Argumentos de cada comando docker pedido (sem o "docker"), na ordem. */
  chamadas: [] as string[][],
  /** DOCKER_HOST com que cada comando seria rodado (mesma ordem de `chamadas`). */
  hosts: [] as Array<string | undefined>,
  responder: padrao as (args: string[]) => RespostaDocker,
  reset(): void {
    this.chamadas.length = 0;
    this.hosts.length = 0;
    this.responder = padrao;
  },
};

/**
 * Para os testes de integração (*.docker-real.test.ts): com PAAS_TEST_REAL_DOCKER=1, os comandos deste arquivo vão ao
 * Docker de verdade. Sem a variável nada muda (o arquivo é pulado e a barreira continua de pé).
 */
export function usarDockerReal(): void {
  dockerDuble.real = process.env.PAAS_TEST_REAL_DOCKER === "1";
}

function executavel(arquivo: string): boolean {
  try {
    accessSync(arquivo, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dentro(arquivo: string, pasta: string): boolean {
  const rel = path.relative(pasta, arquivo);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * true = o comando vai ao dublê: o docker que o PATH acharia é o da barreira ou um de verdade (/usr/bin/docker). Ficam
 * de fora o docker falso de um teste (executável na pasta temporária que não é o da barreira) e o PATH sem docker
 * nenhum (o processo falha sozinho com ENOENT, como o teste espera).
 */
export function vaiAoDuble(file: string, env: NodeJS.ProcessEnv | undefined): boolean {
  const nome = path.basename(file);
  if (nome !== "docker" && nome !== "docker-compose") return false;
  if (dockerDuble.real) return false;
  const barreira = process.env.PAAS_TEST_DOCKER_FALSO_DIR;
  let achado: string | null = null;
  if (file.includes("/")) achado = file;
  else {
    const PATH = (env ?? process.env).PATH ?? "";
    for (const dir of PATH.split(path.delimiter)) {
      if (!dir) continue;
      const candidato = path.join(dir, nome);
      if (executavel(candidato)) {
        achado = candidato;
        break;
      }
    }
  }
  if (!achado) return false;
  const doTeste = dentro(achado, tmpdir()) && !(barreira && dentro(achado, barreira));
  return !doTeste;
}

type Opcoes = { env?: NodeJS.ProcessEnv; encoding?: BufferEncoding | "buffer" | null } | undefined;

function responder(args: readonly string[], opcoes: Opcoes): Required<RespostaDocker> {
  dockerDuble.chamadas.push([...args]);
  dockerDuble.hosts.push((opcoes?.env ?? process.env).DOCKER_HOST);
  const r = dockerDuble.responder([...args]);
  return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Separa (args, opções, callback) das assinaturas variáveis do child_process. */
function argumentos(resto: unknown[]): { args: string[]; opcoes: Opcoes; cb?: (...a: unknown[]) => void } {
  const lista = [...resto];
  const cb = typeof lista[lista.length - 1] === "function" ? (lista.pop() as (...a: unknown[]) => void) : undefined;
  const args = Array.isArray(lista[0]) ? (lista.shift() as string[]) : [];
  const opcoes = (lista[0] && typeof lista[0] === "object" ? lista[0] : undefined) as Opcoes;
  return { args, opcoes, ...(cb ? { cb } : {}) };
}

function saida(texto: string, opcoes: Opcoes, padraoTexto: boolean): string | Buffer {
  const enc = opcoes?.encoding;
  if (enc === "buffer" || (!enc && !padraoTexto)) return Buffer.from(texto);
  return texto;
}

function erroDoComando(args: readonly string[], r: Required<RespostaDocker>, opcoes: Opcoes, padraoTexto: boolean) {
  return Object.assign(new Error(`Command failed: docker ${args.join(" ")}\n${r.stderr}`), {
    code: r.code,
    status: r.code,
    killed: false,
    signal: null,
    cmd: `docker ${args.join(" ")}`,
    stdout: saida(r.stdout, opcoes, padraoTexto),
    stderr: saida(r.stderr, opcoes, padraoTexto),
  });
}

function filhoFalso(r: Required<RespostaDocker>): ChildProcess.ChildProcess {
  const filho = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  filho.stdout = stdout;
  filho.stderr = stderr;
  filho.stdin = new Writable({ write: (_c, _e, feito) => feito() });
  filho.stdio = [filho.stdin, stdout, stderr];
  filho.pid = undefined;
  filho.killed = false;
  filho.exitCode = null;
  filho.signalCode = null;
  filho.kill = () => {
    filho.killed = true;
    return true;
  };
  filho.ref = () => undefined;
  filho.unref = () => undefined;
  setImmediate(() => {
    filho.emit("spawn");
    stdout.end(r.stdout);
    stderr.end(r.stderr);
    filho.exitCode = r.code;
    filho.emit("exit", r.code, null);
    // 'close' depois do fim das duas saídas, como no processo de verdade
    let abertas = 2;
    const fechou = () => {
      abertas -= 1;
      if (abertas === 0) filho.emit("close", r.code, null);
    };
    stdout.on("end", fechou).resume();
    stderr.on("end", fechou).resume();
  });
  return filho as unknown as ChildProcess.ChildProcess;
}

/** O módulo `node:child_process` de verdade, com o docker indo ao dublê. */
export function childProcessComDuble(real: typeof ChildProcess): typeof ChildProcess {
  const execFile = function (this: unknown, file: string, ...resto: unknown[]) {
    const { args, opcoes, cb } = argumentos(resto);
    if (!vaiAoDuble(file, opcoes?.env)) return (real.execFile as (...a: unknown[]) => unknown).call(this, file, ...resto);
    const r = responder(args, opcoes);
    const filho = filhoFalso(r);
    if (cb) {
      setImmediate(() => {
        if (r.code === 0) cb(null, saida(r.stdout, opcoes, true), saida(r.stderr, opcoes, true));
        else cb(erroDoComando(args, r, opcoes, true), saida(r.stdout, opcoes, true), saida(r.stderr, opcoes, true));
      });
    }
    return filho;
  } as unknown as typeof ChildProcess.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, ...resto: unknown[]) => {
    const { args, opcoes } = argumentos(resto);
    const realPromisificado = promisify(real.execFile) as unknown as (...a: unknown[]) => Promise<unknown>;
    if (!vaiAoDuble(file, opcoes?.env)) return realPromisificado(file, ...resto);
    const r = responder(args, opcoes);
    return new Promise((resolve, reject) =>
      setImmediate(() =>
        r.code === 0
          ? resolve({ stdout: saida(r.stdout, opcoes, true), stderr: saida(r.stderr, opcoes, true) })
          : reject(erroDoComando(args, r, opcoes, true)),
      ),
    );
  };

  const spawn = function (this: unknown, file: string, ...resto: unknown[]) {
    const { args, opcoes } = argumentos(resto);
    if (!vaiAoDuble(file, opcoes?.env)) return (real.spawn as (...a: unknown[]) => unknown).call(this, file, ...resto);
    return filhoFalso(responder(args, opcoes));
  } as unknown as typeof ChildProcess.spawn;

  const execFileSync = function (this: unknown, file: string, ...resto: unknown[]) {
    const { args, opcoes } = argumentos(resto);
    if (!vaiAoDuble(file, opcoes?.env)) return (real.execFileSync as (...a: unknown[]) => unknown).call(this, file, ...resto);
    const r = responder(args, opcoes);
    if (r.code !== 0) throw erroDoComando(args, r, opcoes, false);
    return saida(r.stdout, opcoes, false);
  } as unknown as typeof ChildProcess.execFileSync;

  const spawnSync = function (this: unknown, file: string, ...resto: unknown[]) {
    const { args, opcoes } = argumentos(resto);
    if (!vaiAoDuble(file, opcoes?.env)) return (real.spawnSync as (...a: unknown[]) => unknown).call(this, file, ...resto);
    const r = responder(args, opcoes);
    const stdout = saida(r.stdout, opcoes, false);
    const stderr = saida(r.stderr, opcoes, false);
    return { pid: 0, status: r.code, signal: null, stdout, stderr, output: [null, stdout, stderr] };
  } as unknown as typeof ChildProcess.spawnSync;

  return { ...real, default: { ...real, execFile, spawn, execFileSync, spawnSync }, execFile, spawn, execFileSync, spawnSync } as typeof ChildProcess;
}
