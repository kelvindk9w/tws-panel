/**
 * project-logs-service.test.ts — a regra da aba Logs: quais containers são do
 * projeto, validação estrita do serviço, linhas/período/limites, mescla por
 * horário, estado de cada serviço, máscara e falhas parciais. Docker em dublê.
 */
import { describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { DockerUnavailableError } from "../src/services/docker-service.js";
import type { ContainerRuntime, DockerLogsResult } from "../src/services/docker-logs.js";
import { LOG_MASK } from "../src/services/log-mask.js";
import { MAX_LOG_SERVICES, MAX_RESPONSE_CHARS, ProjectLogsService } from "../src/services/project-logs.js";

const NOW = Date.parse("2026-10-24T12:00:00Z");

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function container(over: Partial<DockerContainerInfo> & { id: string; service: string }): DockerContainerInfo {
  return {
    name: `paas-fazenda-${over.service}-1`,
    image: "img",
    state: "running",
    status: "Up 3 hours",
    managed: true,
    projectSlug: "fazenda",
    composeProject: "paas-fazenda",
    health: null,
    ports: [],
    ...over,
  };
}

const RUNTIME: ContainerRuntime = {
  state: "running",
  health: "healthy",
  restartCount: 0,
  startedAt: "2026-10-24T09:00:00Z",
  finishedAt: null,
  exitCode: 0,
  tty: false,
};

interface Fx {
  containers: DockerContainerInfo[];
  runtime: Record<string, ContainerRuntime | null>;
  logs: Record<string, DockerLogsResult>;
}

function build(fx: Partial<Fx> = {}) {
  const state: Fx = {
    containers: fx.containers ?? [container({ id: "aaaaaaaaaaaa", service: "api" }), container({ id: "bbbbbbbbbbbb", service: "web" })],
    runtime: fx.runtime ?? {},
    logs: fx.logs ?? {},
  };
  const deps = {
    listContainers: vi.fn(async () => state.containers),
    inspect: vi.fn(async (id: string) => (id in state.runtime ? state.runtime[id]! : RUNTIME)),
    logs: vi.fn(async (id: string, _o: { tail: number; sinceSeconds: number | null }): Promise<DockerLogsResult> => state.logs[id] ?? { ok: true, body: Buffer.alloc(0) }),
    now: () => NOW,
  };
  return { svc: new ProjectLogsService(deps), deps, state };
}

const project = { slug: "fazenda" };

describe("ProjectLogsService: containers do projeto", () => {
  it("só entram containers gerenciados com o slug do projeto", async () => {
    const { svc } = build({
      containers: [
        container({ id: "aaaaaaaaaaaa", service: "api" }),
        container({ id: "cccccccccccc", service: "api", projectSlug: "outro", composeProject: "paas-outro" }),
        container({ id: "dddddddddddd", service: "ext", managed: false, projectSlug: null, composeProject: "stack" }),
      ],
    });
    const r = await svc.read(project, {}, []);
    expect(r.services.map((s) => s.container)).toEqual(["paas-fazenda-api-1"]);
  });

  it("projeto sem container: serviços e linhas vazios (a tela diz 'ainda não subiu')", async () => {
    const { svc } = build({ containers: [] });
    const r = await svc.read(project, {}, []);
    expect(r).toMatchObject({ services: [], lines: [], truncated: false, service: null });
  });

  it("Docker indisponível: o erro sobe (a rota vira 503)", async () => {
    const { svc, deps } = build();
    deps.listContainers.mockRejectedValue(new DockerUnavailableError("sem docker"));
    await expect(svc.read(project, {}, [])).rejects.toBeInstanceOf(DockerUnavailableError);
  });

  it("container fora do compose usa o nome como serviço", async () => {
    const { svc } = build({ containers: [{ ...container({ id: "aaaaaaaaaaaa", service: "x", name: "paas-fazenda" }), service: null, composeProject: null }] });
    expect((await svc.read(project, {}, [])).services[0]!.service).toBe("paas-fazenda");
  });

  it("acima do limite de serviços, os que sobram ficam de fora e avisa", async () => {
    const many = Array.from({ length: MAX_LOG_SERVICES + 3 }, (_v, i) =>
      container({ id: i.toString(16).padStart(12, "0"), service: `s${String(i).padStart(2, "0")}` }),
    );
    const { svc } = build({ containers: many });
    const r = await svc.read(project, {}, []);
    expect(r.services).toHaveLength(MAX_LOG_SERVICES);
    expect(r.truncated).toBe(true);
  });
});

describe("ProjectLogsService: validação estrita do serviço", () => {
  it("serviço que não é do projeto dá 404 service_not_found e nada é consultado", async () => {
    const { svc, deps } = build();
    await expect(svc.read(project, { service: "banco" }, [])).rejects.toMatchObject({ statusCode: 404, code: "service_not_found" });
    expect(deps.logs).not.toHaveBeenCalled();
  });

  it("nome com cara de caminho, id ou opção do Docker dá 400 antes de qualquer consulta", async () => {
    const { svc, deps } = build();
    for (const bad of ["../x", "api/../web", "--all", "-f", "api web", "a;b", "$(id)", "x".repeat(64), "", "é", "api\n"]) {
      await expect(svc.read(project, { service: bad }, [])).rejects.toMatchObject({ statusCode: 400, code: "invalid_service" });
    }
    expect(deps.listContainers).not.toHaveBeenCalled();
  });

  it("container de outro projeto não é alcançado nem pelo nome do container nem pelo id", async () => {
    const { svc, deps } = build({
      containers: [container({ id: "aaaaaaaaaaaa", service: "api" }), container({ id: "cccccccccccc", service: "api", name: "paas-outro-api-1", projectSlug: "outro" })],
    });
    await expect(svc.read(project, { service: "paas-outro-api-1" }, [])).rejects.toMatchObject({ code: "service_not_found" });
    await expect(svc.read(project, { service: "cccccccccccc" }, [])).rejects.toMatchObject({ code: "service_not_found" });
    await svc.read(project, { service: "api" }, []);
    expect(deps.logs.mock.calls.map((c) => c[0])).toEqual(["aaaaaaaaaaaa"]);
  });

  it("serviço escolhido: só o log dele, mas o estado de todos continua vindo", async () => {
    const { svc, deps } = build();
    const r = await svc.read(project, { service: "web" }, []);
    expect(r.service).toBe("web");
    expect(r.services.map((s) => s.service)).toEqual(["api", "web"]);
    expect(deps.logs.mock.calls.map((c) => c[0])).toEqual(["bbbbbbbbbbbb"]);
  });

  it("serviço com réplicas: o nome pega todos os containers dele", async () => {
    const { svc, deps } = build({
      containers: [
        container({ id: "aaaaaaaaaaaa", service: "api", name: "paas-fazenda-api-1" }),
        container({ id: "eeeeeeeeeeee", service: "api", name: "paas-fazenda-api-2" }),
        container({ id: "bbbbbbbbbbbb", service: "web" }),
      ],
    });
    await svc.read(project, { service: "api" }, []);
    expect(deps.logs.mock.calls.map((c) => c[0]).sort()).toEqual(["aaaaaaaaaaaa", "eeeeeeeeeeee"]);
  });
});

describe("ProjectLogsService: linhas e período", () => {
  it("padrão de 200 linhas, sem período", async () => {
    const { svc, deps } = build();
    const r = await svc.read(project, {}, []);
    expect(r.tail).toBe(200);
    expect(r.since).toBeNull();
    expect(deps.logs.mock.calls[0]![1]).toEqual({ tail: 200, sinceSeconds: null });
  });

  it("linhas: aceita 1 e 2000; fora disso dá 400", async () => {
    const { svc, deps } = build();
    await svc.read(project, { tail: 1 }, []);
    await svc.read(project, { tail: 2000 }, []);
    expect(deps.logs.mock.calls.map((c) => c[1].tail)).toEqual([1, 1, 2000, 2000]);
    for (const bad of [0, -5, 2001, 1.5, Number.NaN, Infinity]) {
      await expect(svc.read(project, { tail: bad }, [])).rejects.toMatchObject({ statusCode: 400, code: "invalid_log_query" });
    }
  });

  it("período: 15m, 1h e 24h viram segundos a partir de agora (relógio injetado); outro valor dá 400", async () => {
    const { svc, deps } = build({ containers: [container({ id: "aaaaaaaaaaaa", service: "api" })] });
    const nowS = Math.floor(NOW / 1000);
    await svc.read(project, { since: "15m" }, []);
    await svc.read(project, { since: "1h" }, []);
    await svc.read(project, { since: "24h" }, []);
    expect(deps.logs.mock.calls.map((c) => nowS - c[1].sinceSeconds!)).toEqual([900, 3600, 86_400]);
    await expect(svc.read(project, { since: "7d" as never }, [])).rejects.toMatchObject({ code: "invalid_log_query" });
  });

  it("marca o stdout/stderr, separa o horário e mantém a ordem", async () => {
    const body = Buffer.concat([
      frame(1, "2026-10-24T11:00:00.100Z servidor no ar\n"),
      frame(2, "2026-10-24T11:00:01.000Z erro: conexão recusada\n"),
    ]);
    const { svc } = build({ containers: [container({ id: "aaaaaaaaaaaa", service: "api" })], logs: { aaaaaaaaaaaa: { ok: true, body } } });
    const r = await svc.read(project, {}, []);
    expect(r.lines).toEqual([
      { time: "2026-10-24T11:00:00.100Z", service: "api", container: "paas-fazenda-api-1", stream: "stdout", text: "servidor no ar" },
      { time: "2026-10-24T11:00:01.000Z", service: "api", container: "paas-fazenda-api-1", stream: "stderr", text: "erro: conexão recusada" },
    ]);
    expect(r.generatedAt).toBe("2026-10-24T12:00:00.000Z");
  });

  it("todos os serviços: mescla por horário (frações de tamanhos diferentes) e fica com as últimas N", async () => {
    const api = Buffer.concat([frame(1, "2026-10-24T11:00:00.5Z a1\n"), frame(1, "2026-10-24T11:00:03Z a2\n")]);
    const web = Buffer.concat([frame(1, "2026-10-24T11:00:01.123456789Z w1\n"), frame(1, "2026-10-24T11:00:02Z w2\n")]);
    const { svc } = build({ logs: { aaaaaaaaaaaa: { ok: true, body: api }, bbbbbbbbbbbb: { ok: true, body: web } } });
    expect((await svc.read(project, {}, [])).lines.map((l) => l.text)).toEqual(["a1", "w1", "w2", "a2"]);
    expect((await svc.read(project, { tail: 2 }, [])).lines.map((l) => l.text)).toEqual(["w2", "a2"]);
  });

  it("linha sem horário herda a posição da anterior do mesmo container", async () => {
    const api = Buffer.concat([frame(1, "2026-10-24T11:00:05Z a1\n"), frame(1, "continuação sem horário\n")]);
    const web = frame(1, "2026-10-24T11:00:06Z w1\n");
    const { svc } = build({ logs: { aaaaaaaaaaaa: { ok: true, body: api }, bbbbbbbbbbbb: { ok: true, body: web } } });
    const r = await svc.read(project, {}, []);
    expect(r.lines.map((l) => l.text)).toEqual(["a1", "continuação sem horário", "w1"]);
    expect(r.lines[1]!.time).toBeNull();
  });

  it("container com TTY lê o fluxo cru, tudo em stdout", async () => {
    const { svc } = build({
      containers: [container({ id: "aaaaaaaaaaaa", service: "api" })],
      runtime: { aaaaaaaaaaaa: { ...RUNTIME, tty: true } },
      logs: { aaaaaaaaaaaa: { ok: true, body: Buffer.from("2026-10-24T11:00:00Z cru\r\n") } },
    });
    expect((await svc.read(project, {}, [])).lines).toMatchObject([{ stream: "stdout", text: "cru" }]);
  });
});

describe("ProjectLogsService: segredos e limpeza", () => {
  it("mascara os valores recebidos e os padrões, e limpa cores", async () => {
    const body = Buffer.concat([
      frame(1, "2026-10-24T11:00:00Z \u001b[32mconectando\u001b[0m com Sup3rS3gredo e postgres://u:abc12345@db/x\n"),
    ]);
    const { svc } = build({ containers: [container({ id: "aaaaaaaaaaaa", service: "api" })], logs: { aaaaaaaaaaaa: { ok: true, body } } });
    const r = await svc.read(project, {}, ["Sup3rS3gredo"]);
    expect(r.lines[0]!.text).toBe(`conectando com ${LOG_MASK} e postgres://u:${LOG_MASK}@db/x`);
  });

  it("o horário que veio colado ao segredo não impede a máscara (máscara só no texto)", async () => {
    const body = frame(1, "2026-10-24T11:00:00Z token=abcdef123456\n");
    const { svc } = build({ containers: [container({ id: "aaaaaaaaaaaa", service: "api" })], logs: { aaaaaaaaaaaa: { ok: true, body } } });
    expect((await svc.read(project, {}, [])).lines[0]!.text).toBe(`token=${LOG_MASK}`);
  });

  it("resposta acima do limite de caracteres: fica com as mais recentes e avisa", async () => {
    const big = "x".repeat(1900);
    const lines = Array.from({ length: Math.ceil(MAX_RESPONSE_CHARS / 1900) + 20 }, (_v, i) => `2026-10-24T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z ${big}${i}\n`);
    const { svc } = build({
      containers: [container({ id: "aaaaaaaaaaaa", service: "api" })],
      logs: { aaaaaaaaaaaa: { ok: true, body: frame(1, lines.join("")) } },
    });
    const r = await svc.read(project, { tail: 2000 }, []);
    expect(r.truncated).toBe(true);
    expect(r.lines.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(r.lines.at(-1)!.text.endsWith(String(lines.length - 1))).toBe(true);
  });
});

describe("ProjectLogsService: estado dos serviços", () => {
  it("traz estado, saúde, reinícios, início, parada e código de saída", async () => {
    const { svc } = build({
      containers: [container({ id: "aaaaaaaaaaaa", service: "api" })],
      runtime: {
        aaaaaaaaaaaa: { state: "exited", health: null, restartCount: 4, startedAt: "2026-10-24T08:00:00Z", finishedAt: "2026-10-24T09:00:00Z", exitCode: 1, tty: false },
      },
    });
    expect((await svc.read(project, {}, [])).services[0]).toEqual({
      service: "api",
      container: "paas-fazenda-api-1",
      state: "exited",
      status: "Up 3 hours",
      health: null,
      restartCount: 4,
      startedAt: "2026-10-24T08:00:00Z",
      finishedAt: "2026-10-24T09:00:00Z",
      exitCode: 1,
      logsError: null,
    });
  });

  it("inspect falhou: usa o estado do 'docker ps', não lê o log e marca unavailable", async () => {
    const { svc, deps } = build({
      containers: [container({ id: "aaaaaaaaaaaa", service: "api", state: "running", health: "unhealthy" })],
      runtime: { aaaaaaaaaaaa: null },
    });
    const r = await svc.read(project, {}, []);
    expect(r.services[0]).toMatchObject({ state: "running", health: "unhealthy", restartCount: null, logsError: "unavailable" });
    expect(deps.logs).not.toHaveBeenCalled();
  });

  it("falha de um serviço não derruba os outros", async () => {
    const { svc } = build({
      logs: { aaaaaaaaaaaa: { ok: false, reason: "too_large" }, bbbbbbbbbbbb: { ok: true, body: frame(1, "2026-10-24T11:00:00Z ok\n") } },
    });
    const r = await svc.read(project, {}, []);
    expect(r.services.map((s) => s.logsError)).toEqual(["too_large", null]);
    expect(r.lines.map((l) => l.text)).toEqual(["ok"]);
  });

  it("log que falha por indisponível marca unavailable", async () => {
    const { svc } = build({ logs: { aaaaaaaaaaaa: { ok: false, reason: "unavailable" } } });
    expect((await svc.read(project, {}, [])).services[0]!.logsError).toBe("unavailable");
  });
});
