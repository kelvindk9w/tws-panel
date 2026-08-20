/**
 * Testes do AlertsService (alerts-service.ts): criação com dedup de alertas
 * abertos (bump), filtros/paginação e as transições de status (ack/resolve)
 * com seus timestamps — com arquivos reais em diretório temporário.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertsService } from "../src/services/alerts-service.js";

let dir: string;
let service: AlertsService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-alerts-"));
  service = new AlertsService(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const INPUT = {
  severity: "critical" as const,
  source: "scan" as const,
  title: "Porta 5432 exposta",
  detail: "PostgreSQL publicado no host.",
};

describe("create — dedup de alertas abertos", () => {
  it("cria alerta novo com status open e timestamps nulos", async () => {
    const { alert, created } = await service.create(INPUT);
    expect(created).toBe(true);
    expect(alert.status).toBe("open");
    expect(alert.acknowledgedAt).toBeNull();
    expect(alert.resolvedAt).toBeNull();
    expect(alert.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("alerta aberto idêntico (origem+título) é ATUALIZADO, não duplicado", async () => {
    const first = await service.create(INPUT);
    const second = await service.create({ ...INPUT, detail: "Detalhe novo." });
    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
    expect(second.alert.detail).toBe("Detalhe novo.");
    expect((await service.list()).total).toBe(1);
  });

  it("mesmo título em origem diferente → alerta novo", async () => {
    await service.create(INPUT);
    const other = await service.create({ ...INPUT, source: "blacklist" });
    expect(other.created).toBe(true);
    expect((await service.list()).total).toBe(2);
  });

  it("mesmo alerta já RESOLVIDO não é bumpado — abre um novo", async () => {
    const first = await service.create(INPUT);
    await service.setStatus(first.alert.id, "resolved");
    const second = await service.create(INPUT);
    expect(second.created).toBe(true);
    expect((await service.list()).total).toBe(2);
  });
});

describe("list — filtros e paginação", () => {
  beforeEach(async () => {
    await service.create(INPUT); // critical/scan
    await service.create({ severity: "warning", source: "guardrail", title: "Senha fraca", detail: "d" });
    await service.create({ severity: "info", source: "system", title: "Disco ok", detail: "d" });
  });

  it("filtra por status, severidade e origem; openCount só conta abertos", async () => {
    const critical = await service.list({ severity: "critical" });
    expect(critical.alerts.map((a) => a.title)).toEqual(["Porta 5432 exposta"]);

    const scan = await service.list({ source: "scan" });
    expect(scan.total).toBe(1);

    const all = await service.list();
    expect(all.openCount).toBe(3);

    const resolved = await service.list({ status: "resolved" });
    expect(resolved.total).toBe(0);
    expect(resolved.openCount).toBe(3); // openCount é global, não filtrado
  });

  it("mais recentes primeiro + clamps de paginação", async () => {
    const page = await service.list({ page: -5, perPage: 2 });
    expect(page.page).toBe(1);
    expect(page.alerts.map((a) => a.title)).toEqual(["Disco ok", "Senha fraca"]);

    const clamped = await service.list({ perPage: 999 });
    expect(clamped.perPage).toBe(200);
  });
});

describe("setStatus — transições", () => {
  it("ack em alerta aberto carimba acknowledgedAt", async () => {
    const { alert } = await service.create(INPUT);
    const acked = await service.setStatus(alert.id, "acknowledged");
    expect(acked?.status).toBe("acknowledged");
    expect(acked?.acknowledgedAt).not.toBeNull();
  });

  it("ack em alerta já reconhecido preserva o acknowledgedAt original", async () => {
    const { alert } = await service.create(INPUT);
    const first = await service.setStatus(alert.id, "acknowledged");
    const second = await service.setStatus(alert.id, "acknowledged");
    expect(second?.acknowledgedAt).toBe(first?.acknowledgedAt);
  });

  it("resolve direto do open preenche resolvedAt E acknowledgedAt", async () => {
    const { alert } = await service.create(INPUT);
    const resolved = await service.setStatus(alert.id, "resolved");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.acknowledgedAt).not.toBeNull();
  });

  it("resolve após ack preserva o acknowledgedAt do ack", async () => {
    const { alert } = await service.create(INPUT);
    const acked = await service.setStatus(alert.id, "acknowledged");
    const resolved = await service.setStatus(alert.id, "resolved");
    expect(resolved?.acknowledgedAt).toBe(acked?.acknowledgedAt);
  });

  it("id inexistente → null", async () => {
    expect(await service.setStatus("nope", "acknowledged")).toBeNull();
  });
});

describe("tolerância a falhas", () => {
  it("alerts.json corrompido → lista vazia sem lançar", async () => {
    await writeFile(path.join(dir, "alerts.json"), "{quebrado", "utf8");
    const fresh = new AlertsService(dir);
    expect((await fresh.list()).total).toBe(0);
  });

  it("alerts.json sem array de alertas → lista vazia", async () => {
    await writeFile(path.join(dir, "alerts.json"), JSON.stringify({ alerts: "oops" }), "utf8");
    const fresh = new AlertsService(dir);
    expect((await fresh.list()).total).toBe(0);
  });
});
