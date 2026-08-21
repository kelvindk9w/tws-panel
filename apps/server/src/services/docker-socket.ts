/**
 * docker-socket.ts — cliente mínimo da Docker Engine API via unix socket,
 * usado pelo TERMINAL WEB para abrir um PTY real no alvo (host ou container).
 *
 * Por que NÃO node-pty:
 *  - node-pty compila nativo (node-gyp) — inflaria a imagem hardened (slim,
 *    read-only, não-root) com python3/make/g++ só de build;
 *  - pior: node-pty daria um shell DENTRO do container do painel — o alvo dos
 *    comandos é o HOST (ou o container descartável de dev), nunca o painel.
 *
 * A abordagem (mesma do host bridge — docs/host-bridge.md): o PTY é fornecido
 * pelo próprio daemon Docker, que JÁ está acessível via /var/run/docker.sock:
 *  - alvo "host": container helper DESCARTÁVEL (--rm, privileged, pid=host)
 *    com Tty:true rodando `nsenter -t 1 ... -- bash -l` — um shell interativo
 *    real na VPS, idêntico ao SSH;
 *  - alvo "container" (dev): `docker exec` com Tty:true no container alvo.
 *
 * Em ambos os casos o I/O é um stream CRU hijacked (Tty:true = sem multiplex
 * de stdout/stderr) e o resize é o endpoint /resize da API — comportamento
 * de PTY completo sem nenhuma dependência nativa.
 *
 * SEGURANÇA: este módulo só transporte bytes. Nunca inspeciona, loga ou
 * persiste o conteúdo do fluxo (input do usuário incluso).
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { ServerConfig } from "../config.js";

/** Handle de um PTY remoto: stream cru + resize + encerramento. */
export interface RemotePty {
  /** Stream bidirecional cru do PTY (relay puro, byte a byte). */
  readonly stream: Duplex;
  /** Redimensiona o PTY (cols/rows do xterm do navegador). Best-effort. */
  resize(cols: number, rows: number): void;
  /** Encerra a sessão (remove o helper / fecha o exec). */
  kill(): Promise<void>;
}

export class DockerSocketError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DockerSocketError";
  }
}

// ---------------------------------------------------------------------------
// HTTP sobre o unix socket do daemon
// ---------------------------------------------------------------------------

function request(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {}),
        },
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new DockerSocketError("timeout na Docker API")));
    req.on("error", (err) =>
      reject(
        err instanceof DockerSocketError
          ? err
          : new DockerSocketError(
              `docker.sock inacessível (${socketPath}): ${err.message}. O painel precisa do socket do Docker montado.`,
            ),
      ),
    );
    req.end(payload);
  });
}

/**
 * POST com hijack (HTTP 101 Upgrade: tcp). O socket retornado passa a ser o
 * stream cru do attach/exec — é o "fio" do PTY.
 */
function hijack(socketPath: string, path: string, body: unknown): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath,
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
      timeout: 30_000,
    });
    req.on("upgrade", (_res, socket, head) => {
      socket.setNoDelay(true);
      if (head && head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        reject(
          new DockerSocketError(
            `hijack recusado (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`,
            res.statusCode,
          ),
        ),
      );
    });
    req.on("timeout", () => req.destroy(new DockerSocketError("timeout no hijack do PTY")));
    req.on("error", reject);
    req.end(payload);
  });
}

function errorMessage(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: string };
    return parsed.message ?? body.toString("utf8").slice(0, 200);
  } catch {
    return body.toString("utf8").slice(0, 200);
  }
}

/** Garante a imagem presente no daemon (pull se ausente). */
async function ensureImage(socketPath: string, image: string): Promise<void> {
  const inspect = await request(socketPath, "GET", `/images/${encodeURIComponent(image)}/json`);
  if (inspect.status === 200) return;
  // tag = trecho após o último ":", somente se depois da última "/" (evita
  // confundir porta de registry, ex.: localhost:5000/img, com tag).
  const colon = image.lastIndexOf(":");
  const hasTag = colon > image.lastIndexOf("/");
  const name = hasTag ? image.slice(0, colon) : image;
  const tag = hasTag ? image.slice(colon + 1) : "latest";
  const pull = await request(
    socketPath,
    "POST",
    `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
    {},
  );
  if (pull.status < 200 || pull.status >= 300) {
    throw new DockerSocketError(`falha ao baixar a imagem ${image}: ${errorMessage(pull.body)}`, pull.status);
  }
  // O corpo do pull é um stream de progresso JSON; falhas aparecem como errorDetail.
  const text = pull.body.toString("utf8");
  if (/"errorDetail"/.test(text)) {
    throw new DockerSocketError(`falha ao baixar a imagem ${image}: ${text.slice(-200)}`);
  }
}

// ---------------------------------------------------------------------------
// PTY no HOST via helper descartável nsenter (mesmo padrão do host bridge)
// ---------------------------------------------------------------------------

async function openHostPty(socketPath: string, image: string): Promise<RemotePty> {
  await ensureImage(socketPath, image);
  const name = `paas-terminal-${randomBytes(4).toString("hex")}`;
  const create = await request(socketPath, "POST", `/containers/create?name=${name}`, {
    Image: image,
    // Shell de login interativo NOS NAMESPACES DO HOST (bash é o do host).
    Cmd: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-l"],
    Env: ["TERM=xterm-256color"],
    Tty: true,
    OpenStdin: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: { Privileged: true, PidMode: "host", AutoRemove: true },
  });
  if (create.status !== 201) {
    throw new DockerSocketError(`falha ao criar o helper do terminal: ${errorMessage(create.body)}`, create.status);
  }
  const id = (JSON.parse(create.body.toString("utf8")) as { Id: string }).Id;

  const start = await request(socketPath, "POST", `/containers/${id}/start`);
  if (start.status !== 204 && start.status !== 304) {
    throw new DockerSocketError(`falha ao iniciar o helper do terminal: ${errorMessage(start.body)}`, start.status);
  }
  const stream = await hijack(
    socketPath,
    `/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
    {},
  );
  return {
    stream,
    resize(cols, rows) {
      void request(socketPath, "POST", `/containers/${id}/resize?h=${rows}&w=${cols}`).catch(() => undefined);
    },
    async kill() {
      stream.destroy();
      await request(socketPath, "DELETE", `/containers/${id}?force=true`).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// PTY no container alvo de dev (docker exec com TTY)
// ---------------------------------------------------------------------------

async function openContainerExecPty(socketPath: string, target: string): Promise<RemotePty> {
  const create = await request(socketPath, "POST", `/containers/${target}/exec`, {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color"],
    // bash se houver (ubuntu), senão sh (alpine) — sempre shell de login.
    // (não dá para usar `exec bash || exec sh`: falha de exec mata o sh).
    Cmd: ["sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi"],
  });
  if (create.status !== 201) {
    throw new DockerSocketError(
      `falha ao criar exec no container ${target} (ele existe? rode uma fase ou crie o alvo de dev): ${errorMessage(create.body)}`,
      create.status,
    );
  }
  const id = (JSON.parse(create.body.toString("utf8")) as { Id: string }).Id;
  const stream = await hijack(socketPath, `/exec/${id}/start`, { Detach: false, Tty: true });
  return {
    stream,
    resize(cols, rows) {
      void request(socketPath, "POST", `/exec/${id}/resize?h=${rows}&w=${cols}`).catch(() => undefined);
    },
    async kill() {
      // Fechar o stream fecha o master do PTY: o bash do exec recebe SIGHUP e morre.
      stream.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Fábrica de PTY a partir da config do servidor
// ---------------------------------------------------------------------------

export type PtyFactory = () => Promise<RemotePty>;

/**
 * Monta a fábrica de PTY conforme o alvo de segurança configurado:
 *  - PAAS_TARGET=host → shell interativo no HOST (helper nsenter descartável);
 *  - alvo container (dev) → bash interativo no container alvo.
 */
export function createDockerPtyFactory(config: ServerConfig): PtyFactory {
  const socketPath = config.dockerSocketPath;
  if (config.securityTarget === "host") {
    const image = config.hostHelperImage;
    return () => openHostPty(socketPath, image);
  }
  const target = config.securityTargetContainer;
  return () => openContainerExecPty(socketPath, target);
}
