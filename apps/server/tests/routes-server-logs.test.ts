/**
 * routes-server-logs.test.ts — GET /api/server-logs no painel REAL (Docker em dublê injetado no serviço):
 * só sessão (token de API sempre 403, mesmo com leitura em todo o painel), consulta estrita, mascara segredos do
 * e-mail, auditoria da leitura (sem o conteúdo, no máximo uma por minuto por pessoa e fonte), 503 sem Docker e
 * limite de pedidos por minuto.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { ServerLogsService } from "../src/services/server-logs.js";
import { DockerUnavailableError } from "../src/services/docker-service.js";
import { LOG_MASK } from "../src/services/log-mask.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
const MAIL_SECRET = "Caixa-Segredo-55443";
let dockerDown = false;
let dockerBroken = false;
let secretsFail = false;

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

beforeAll(async () => {
  panel = await startRealPanel();
  const containers: DockerContainerInfo[] = [
    { id: "aaaaaaaaaaaa", name: "tws-panel", image: "i", state: "running", status: "Up", managed: false, projectSlug: null, composeProject: null, ports: [] },
    { id: "bbbbbbbbbbbb", name: "paas-caddy", image: "i", state: "running", status: "Up", managed: false, projectSlug: null, composeProject: null, ports: [] },
    { id: "cccccccccccc", name: "paas-stalwart", image: "i", state: "running", status: "Up", managed: false, projectSlug: null, composeProject: null, ports: [] },
  ];
  (panel.app as unknown as { serverLogs: ServerLogsService }).serverLogs = new ServerLogsService({
    docker: {
      listContainers: async () => {
        if (dockerDown) throw new DockerUnavailableError("sem docker");
        if (dockerBroken) throw new Error("explodiu");
        return containers;
      },
      inspect: async () => ({ state: "running", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: 0, tty: false }),
      logs: async () => ({ ok: true, body: frame(`2026-10-30T11:00:00Z painel usou ${MAIL_SECRET}\n`) }),
      now: () => Date.parse("2026-10-30T12:00:00Z"),
    },
    journal: { read: async () => ({ ok: true, lines: [{ time: "2026-10-30T11:00:00.000Z", text: "vps sshd[1]: Failed password from 203.0.113.9" }] }) },
    secrets: async () => {
      if (secretsFail) throw new Error("cofre quebrado");
      return [MAIL_SECRET];
    },
  });
}, 120_000);

afterAll(async () => {
  await panel.close();
});

const get = (url: string, headers: Record<string, string>) => panel.app.inject({ method: "GET", url, headers });
const human = () => ({ cookie: panel.cookie });
const auditCount = async () => {
  await panel.app.auditService.flush();
  return (await panel.app.auditService.list(1, 200)).entries.filter((e) => e.action === "server-logs.read");
};

describe("GET /api/server-logs", () => {
  it("sessão: linhas mascaradas, sem cache", async () => {
    const res = await get("/api/server-logs?source=panel", human());
    expect(res.statusCode).toBe(200);
    expect(res.json().lines[0]).toMatchObject({ service: "panel", text: `painel usou ${LOG_MASK}` });
    expect(res.body).not.toContain(MAIL_SECRET);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("fonte do host (journal)", async () => {
    const res = await get("/api/server-logs?source=ssh&tail=20&since=1h", human());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: "ssh", tail: 20, since: "1h" });
    expect(res.json().lines[0].text).toContain("Failed password");
  });

  it("consulta inválida: 400 (fonte fora da lista, nome de container, tail, since, campo extra)", async () => {
    for (const q of ["source=fazenda", "source=tws-panel", "source=..%2Fx", "source=", "tail=0", "tail=2001", "tail=abc", "since=7d", "foo=1", "source=panel&source=mail"]) {
      const res = await get(`/api/server-logs?${q}`, human());
      expect(res.statusCode, q).toBe(400);
    }
  });

  it("sem sessão nem token: 401", async () => {
    expect((await get("/api/server-logs", {})).statusCode).toBe(401);
  });

  it("a leitura é auditada (quem, fonte, tamanho — nunca o conteúdo) e repetida no mesmo minuto não gera outra", async () => {
    const before = (await auditCount()).length;
    await get("/api/server-logs?source=mail", human());
    await get("/api/server-logs?source=mail&tail=50", human());
    const after = await auditCount();
    expect(after.length).toBe(before + 1);
    const entry = after[0]!;
    expect(entry.actor).toBe("admin");
    expect(entry.target).toBe("mail");
    expect(JSON.stringify(entry)).not.toContain(MAIL_SECRET);
    // outra fonte é outra entrada
    await get("/api/server-logs?source=proxy", human());
    expect((await auditCount()).length).toBe(before + 2);
  });

  it("auditoria que falha não derruba a leitura", async () => {
    const record = vi.spyOn(panel.app.auditService, "record").mockRejectedValueOnce(new Error("disco cheio"));
    // duas horas à frente: a janela de uma entrada por minuto já passou, então esta leitura tenta auditar de novo
    const later = Date.now() + 2 * 3_600_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const res = await get("/api/server-logs?source=ssh&tail=5", human());
      expect(res.statusCode).toBe(200);
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      record.mockRestore();
    }
  });

  it("erro inesperado do serviço: 500 genérico, sem detalhe", async () => {
    dockerBroken = true;
    try {
      const res = await get("/api/server-logs", human());
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("explodiu");
    } finally {
      dockerBroken = false;
    }
  });

  it("Docker indisponível: 503 docker_unavailable", async () => {
    dockerDown = true;
    try {
      const res = await get("/api/server-logs", human());
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("docker_unavailable");
    } finally {
      dockerDown = false;
    }
  });

  it("sem a lista de segredos: 503 log_masking_unavailable e nada vaza", async () => {
    secretsFail = true;
    try {
      const res = await get("/api/server-logs?source=panel", human());
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("log_masking_unavailable");
      expect(res.body).not.toContain("cofre quebrado");
    } finally {
      secretsFail = false;
    }
  });
});

describe("GET /api/server-logs com token de API", () => {
  it.each([
    ["leitura do painel inteiro", { name: "leitura", scope: "read", reach: "panel" }],
    ["administração do painel inteiro", { name: "admin", scope: "admin", reach: "panel" }],
  ])("token de %s: 403", async (_label, body) => {
    const t = await panel.createToken(body);
    expect(t.status).toBeLessThan(300);
    const res = await get("/api/server-logs?source=ssh", { authorization: `Bearer ${t.token}` });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("Failed password");
  });
});

describe("limite de pedidos", () => {
  it("passou de 30 por minuto: 429", async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await get("/api/server-logs?source=panel&tail=5", human());
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
