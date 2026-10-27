/**
 * AlertsService: findActive / resolveActive / create silencioso — o que o
 * vigia de certificados usa para não recriar alerta que a pessoa já viu e
 * para resolver sozinho o que passou.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertsService } from "../src/services/alerts-service.js";

let dir: string;
let service: AlertsService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-alerts-active-"));
  service = new AlertsService(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CERT = { severity: "warning" as const, source: "certificate" as const, title: "Certificado de a.exemplo.com.br não renovou", detail: "d" };

describe("findActive / resolveActive / create silencioso", () => {
  it("findActive acha o aberto e o reconhecido, não o resolvido nem o de outra origem ou título", async () => {
    expect(await service.findActive("certificate", CERT.title)).toBeNull();
    const { alert } = await service.create(CERT);
    expect((await service.findActive("certificate", CERT.title))?.id).toBe(alert.id);
    await service.setStatus(alert.id, "acknowledged");
    expect((await service.findActive("certificate", CERT.title))?.status).toBe("acknowledged");
    expect(await service.findActive("scan", CERT.title)).toBeNull();
    expect(await service.findActive("certificate", "outro título")).toBeNull();
    await service.setStatus(alert.id, "resolved");
    expect(await service.findActive("certificate", CERT.title)).toBeNull();
  });

  it("listActive devolve abertos e reconhecidos da origem (cópias), nunca resolvidos nem de outra origem", async () => {
    const a = await service.create(CERT);
    const b = await service.create({ ...CERT, title: "Certificado de b.exemplo.com.br não renovou" });
    const c = await service.create({ ...CERT, title: "Certificado de c.exemplo.com.br não renovou" });
    await service.create({ severity: "warning", source: "scan", title: "outra origem", detail: "d" });
    await service.setStatus(b.alert.id, "acknowledged");
    await service.setStatus(c.alert.id, "resolved");
    const list = await service.listActive("certificate");
    expect(list.map((x) => x.id).sort()).toEqual([a.alert.id, b.alert.id].sort());
    list[0]!.status = "resolved";
    expect((await service.listActive("certificate")).every((x) => x.status !== "resolved")).toBe(true);
  });

  it("findActive devolve uma cópia (mexer nela não altera o alerta)", async () => {
    await service.create(CERT);
    const copy = (await service.findActive("certificate", CERT.title))!;
    copy.status = "resolved";
    expect((await service.findActive("certificate", CERT.title))?.status).toBe("open");
  });

  it("resolveActive resolve aberto e reconhecido (com horário) e conta; sem nada vivo devolve 0", async () => {
    expect(await service.resolveActive("certificate", CERT.title)).toBe(0);
    const a = await service.create(CERT);
    const b = await service.create({ ...CERT, title: "outro" });
    await service.setStatus(b.alert.id, "acknowledged");
    expect(await service.resolveActive("certificate", CERT.title)).toBe(1);
    const listed = (await service.list()).alerts;
    const resolved = listed.find((x) => x.id === a.alert.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toEqual(expect.any(String));
    expect(resolved.acknowledgedAt).toEqual(expect.any(String));
    expect(listed.find((x) => x.id === b.alert.id)!.status).toBe("acknowledged");
    expect(await service.resolveActive("certificate", CERT.title)).toBe(0);
  });

  it("resolver um alerta já reconhecido mantém o horário do reconhecimento", async () => {
    const b = await service.create(CERT);
    await service.setStatus(b.alert.id, "acknowledged");
    const ack = (await service.list()).alerts[0]!.acknowledgedAt;
    expect(await service.resolveActive("certificate", CERT.title)).toBe(1);
    expect((await service.list()).alerts[0]!.acknowledgedAt).toBe(ack);
  });

  it("a resolução fica gravada no disco", async () => {
    await service.create(CERT);
    await service.resolveActive("certificate", CERT.title);
    const again = new AlertsService(dir);
    expect((await again.list()).alerts[0]!.status).toBe("resolved");
  });

  it("depois de resolvido, o mesmo problema abre alerta novo", async () => {
    const first = await service.create(CERT);
    await service.resolveActive("certificate", CERT.title);
    const again = await service.create(CERT);
    expect(again.created).toBe(true);
    expect(again.alert.id).not.toBe(first.alert.id);
  });

  it("create silencioso grava mas não avisa quem escuta", async () => {
    const heard: string[] = [];
    service.onCreated((a) => void heard.push(a.title));
    await service.create(CERT, { silent: true });
    await service.create({ ...CERT, title: "barulhento" });
    expect(heard).toEqual(["barulhento"]);
    expect((await service.list()).total).toBe(2);
  });
});
