/**
 * barreira-docker.ts — a suíte de testes não toca o Docker real da máquina de quem roda.
 *
 * Entra no `setupFiles` de TODOS os pacotes com vitest (o teste barreira-docker-real.test.ts do servidor confere
 * isso). Quem roda a suíte pode ter containers, redes e imagens de projetos reais: um teste que criasse a paas-net,
 * apagasse um `paas-<slug>-next` ou removesse uma imagem mexeria em dados de verdade.
 *
 * Por padrão, antes de qualquer teste:
 *  - um `docker` (e um `docker-compose`) falso vai para a frente do PATH: registra a chamada e sai com erro,
 *    dizendo "teste tentou usar o Docker real: <argumentos>". O registro vai para PAAS_TEST_DOCKER_LOG (se não
 *    vier definido, um arquivo na pasta do falso);
 *  - DOCKER_HOST aponta para um socket que não existe (o original fica guardado para a regra abaixo);
 *  - conexão de socket unix com o daemon (o /var/run/docker.sock, o /run/docker.sock, o do DOCKER_HOST original
 *    e qualquer "docker*.sock" fora da pasta temporária) falha com a mesma mensagem, e também vai para o registro.
 *    Socket de dublê criado pelo teste na pasta temporária (ex.: tmp/docker.sock) continua funcionando.
 *
 * Só com PAAS_TEST_REAL_DOCKER=1 nada disso é instalado: é o pedido explícito para rodar os testes de integração
 * com Docker (arquivos *.docker-real.test.ts, que sem a variável são pulados). Ver docs/processo/testes-e-docker.md.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach } from "vitest";

export const VARIAVEL_DOCKER_REAL = "PAAS_TEST_REAL_DOCKER";
export const MENSAGEM_BARREIRA = "teste tentou usar o Docker real";
/** Para onde aponta o DOCKER_HOST com a barreira ligada: um socket que não existe. */
export const DOCKER_HOST_FALSO = "unix:///nonexistent/paas-test/docker.sock";

const MARCA = Symbol.for("paas.barreiraDocker");

export function dockerRealPermitido(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VARIAVEL_DOCKER_REAL] === "1";
}

function semBarra(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Caminho de socket unix de um DOCKER_HOST (unix:///x ou caminho cru); null se não for unix. */
function socketDoDockerHost(valor: string | undefined): string | null {
  if (!valor) return null;
  if (valor.startsWith("unix://")) return valor.slice("unix://".length) || null;
  if (valor.startsWith("/")) return valor;
  return null;
}

/**
 * Regra do socket bloqueado. Fica exportada para o teste da barreira: o socket do Docker conhecido é bloqueado
 * sempre (até se estiver na pasta temporária, caso de um DOCKER_HOST rootless); um "docker*.sock" qualquer só fora
 * da pasta temporária.
 */
export function socketDoDockerReal(alvo: string, conhecidos: readonly string[], pastaTemporaria: string): boolean {
  const candidatos = [semBarra(alvo), semBarra(real(alvo))];
  if (candidatos.some((c) => conhecidos.includes(c))) return true;
  if (!/docker[^/]*\.sock$/i.test(path.basename(alvo))) return false;
  const tmp = [semBarra(pastaTemporaria), semBarra(real(pastaTemporaria))];
  return !candidatos.some((c) => tmp.some((t) => c === t || c.startsWith(`${t}/`)));
}

function caminhoDoConnect(args: unknown[]): string | null {
  const primeiro = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof primeiro === "string" && !/^\d+$/.test(primeiro)) return primeiro;
  if (primeiro && typeof primeiro === "object" && typeof (primeiro as { path?: unknown }).path === "string") {
    return (primeiro as { path: string }).path;
  }
  return null;
}

function registrar(linha: string): void {
  const log = process.env.PAAS_TEST_DOCKER_LOG;
  if (!log) return;
  const teste = process.env.PAAS_TEST_ATUAL;
  try {
    appendFileSync(log, `${linha}${teste ? `\t# ${teste}` : ""}\n`);
  } catch {
    // registro é ajuda para quem investiga; a falha da chamada é o que protege
  }
}

const SCRIPT_FALSO = `#!/bin/sh
# docker falso da suíte de testes (scripts/testes/barreira-docker.ts): registra e falha.
if [ -n "\${PAAS_TEST_DOCKER_LOG:-}" ]; then
  if [ -n "\${PAAS_TEST_ATUAL:-}" ]; then printf '%s\\t# %s\\n' "$(basename "$0") $*" "$PAAS_TEST_ATUAL"; else printf '%s\\n' "$(basename "$0") $*"; fi >> "$PAAS_TEST_DOCKER_LOG" 2>/dev/null
fi
echo "${MENSAGEM_BARREIRA}: $(basename "$0") $*" >&2
echo "A suíte não fala com o Docker da máquina; integração só com ${VARIAVEL_DOCKER_REAL}=1 (docs/processo/testes-e-docker.md)." >&2
exit 1
`;

function instalarDockerFalso(): string {
  const pasta = path.join(tmpdir(), `paas-docker-falso-${process.pid}`);
  mkdirSync(pasta, { recursive: true });
  for (const nome of ["docker", "docker-compose"]) {
    const arquivo = path.join(pasta, nome);
    if (!existsSync(arquivo)) writeFileSync(arquivo, SCRIPT_FALSO);
    chmodSync(arquivo, 0o755);
  }
  process.once("exit", () => {
    try {
      rmSync(pasta, { recursive: true, force: true });
    } catch {
      // pasta temporária: o sistema limpa depois
    }
  });
  return pasta;
}

function instalarBarreira(): void {
  const proto = net.Socket.prototype as unknown as Record<symbol, unknown> & { connect: (...a: unknown[]) => unknown };
  if (proto[MARCA]) return; // já instalada neste processo (setupFiles roda a cada arquivo de teste)

  const pasta = instalarDockerFalso();
  process.env.PAAS_TEST_DOCKER_FALSO_DIR = pasta;
  process.env.PAAS_TEST_DOCKER_LOG ||= path.join(pasta, "chamadas.log");
  process.env.PATH = `${pasta}${path.delimiter}${process.env.PATH ?? ""}`;

  const conhecidos = new Set(["/var/run/docker.sock", "/run/docker.sock"].flatMap((s) => [s, semBarra(real(s))]));
  const doHost = socketDoDockerHost(process.env.DOCKER_HOST);
  if (doHost) for (const s of [doHost, real(doHost)]) conhecidos.add(semBarra(s));
  if (process.env.HOME) conhecidos.add(path.join(process.env.HOME, ".docker", "run", "docker.sock"));
  if (process.env.XDG_RUNTIME_DIR) conhecidos.add(path.join(process.env.XDG_RUNTIME_DIR, "docker.sock"));
  const lista = [...conhecidos];
  const pastaTemporaria = tmpdir();

  process.env.DOCKER_HOST = DOCKER_HOST_FALSO;
  delete process.env.DOCKER_CONTEXT;

  const original = proto.connect;
  proto.connect = function (this: net.Socket, ...args: unknown[]) {
    const alvo = caminhoDoConnect(args);
    if (alvo && socketDoDockerReal(alvo, lista, pastaTemporaria)) {
      registrar(`socket ${alvo}`);
      const erro = Object.assign(new Error(`${MENSAGEM_BARREIRA}: socket ${alvo} (só com ${VARIAVEL_DOCKER_REAL}=1)`), {
        code: "ECONNREFUSED",
      });
      // como uma conexão recusada: o erro chega pelo evento 'error', que é onde quem chama já espera
      process.nextTick(() => this.destroy(erro));
      return this;
    }
    return original.apply(this, args);
  };
  proto[MARCA] = true;
}

if (!dockerRealPermitido()) {
  instalarBarreira();
  // o registro diz qual teste chamou o Docker (arquivo > nome), para achar o culpado sem rodar arquivo por arquivo
  const nome = (t: { filepath?: string; name: string }) => path.basename(t.filepath ?? t.name);
  // o vitest exige desestruturação no 1º argumento; o arquivo vem no 2º
  beforeAll(({}, arquivo) => {
    process.env.PAAS_TEST_ATUAL = `${nome(arquivo as { filepath?: string; name: string })} > (preparação do arquivo)`;
  });
  beforeEach((ctx) => {
    process.env.PAAS_TEST_ATUAL = `${nome(ctx.task.file)} > ${ctx.task.name}`;
  });
}
