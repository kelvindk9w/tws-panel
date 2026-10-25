/**
 * notification-sources.test.ts — de onde vêm os avisos: alertas gravados,
 * deploy que falhou/voltou, certificados, disco e o painel iniciado.
 */
import { describe, expect, it, vi } from "vitest";
import type { Alert } from "@paas/core";
import {
  DiskWatcher,
  alertNotification,
  deployNotification,
  panelStartedNotification,
} from "../src/services/notification-sources.js";
import type { NotificationEvent } from "../src/services/notification-service.js";

function alert(partial: Partial<Alert>): Alert {
  return {
    id: "a1",
    severity: "critical",
    source: "scan",
    title: "Monitoramento: portas novas",
    detail: "tcp/2222 em 203.0.113.10",
    status: "open",
    createdAt: "2026-10-07T12:00:00Z",
    acknowledgedAt: null,
    resolvedAt: null,
    ...partial,
  };
}

describe("alertNotification", () => {
  it("cada origem vira o tipo certo; o detalhe do alerta NÃO vai na mensagem", () => {
    const scan = alertNotification(alert({}));
    expect(scan).toMatchObject({ kind: "security", key: "alert:scan:Monitoramento: portas novas", path: "/alerts" });
    expect(scan!.title).toBe("Monitoramento: portas novas");
    expect(JSON.stringify(scan)).not.toContain("2222");
    expect(scan!.body!.join(" ")).toMatch(/crítico/);
    expect(alertNotification(alert({ source: "guardrail", severity: "warning" }))!.kind).toBe("security");
    expect(alertNotification(alert({ source: "guardrail", severity: "warning" }))!.body!.join(" ")).toMatch(/atenção/);
    expect(alertNotification(alert({ source: "blacklist" }))!.kind).toBe("blacklist");
    expect(alertNotification(alert({ source: "certificate", severity: "info" }))).toMatchObject({ kind: "certificate", path: "/certificates" });
  });

  it("alerta de certificado leva o texto escrito pelo painel (nome, causa e o que fazer); os demais não", () => {
    const cert = alertNotification(
      alert({ source: "certificate", severity: "warning", title: "Certificado de a.exemplo.com.br não renovou e vence em breve", detail: "O DNS não aponta para esta VPS." }),
    );
    expect(cert.body).toEqual(["Gravidade: atenção.", "O DNS não aponta para esta VPS."]);
    expect(alertNotification(alert({ source: "scan" })).body).not.toContain("tcp/2222 em 203.0.113.10");
    expect(alertNotification(alert({ source: "blacklist", detail: "segredo" })).body!.join(" ")).not.toContain("segredo");
  });
});

describe("deployNotification", () => {
  const base = { projectId: "p1", projectName: "Loja", previousStatus: null };
  it("falhou: avisa; voltou a funcionar depois de falhar: avisa; sucesso normal: nada", () => {
    expect(deployNotification({ ...base, status: "failed" })).toMatchObject({
      kind: "deploy",
      key: "deploy-failed:p1",
      title: "Deploy de Loja falhou",
      path: "/projects/p1",
    });
    expect(deployNotification({ ...base, status: "success", previousStatus: "failed" })).toMatchObject({
      key: "deploy-ok:p1",
      title: "Loja voltou a publicar sem erro",
    });
    expect(deployNotification({ ...base, status: "success", previousStatus: "success" })).toBeNull();
    expect(deployNotification({ ...base, status: "success" })).toBeNull();
  });
});

describe("panelStartedNotification", () => {
  it("tipo 'panel', com a hora", () => {
    const e = panelStartedNotification(new Date("2026-10-07T12:34:00Z"));
    expect(e.kind).toBe("panel");
    expect(e.title).toMatch(/iniciado/);
    expect(e.body!.join(" ")).toMatch(/07\/10\/2026/);
  });
});

describe("DiskWatcher", () => {
  const GB = 1024 ** 3;
  function watcher(usedRatio: { v: number }, clock: { t: number }, opts: { fail?: boolean } = {}) {
    const events: NotificationEvent[] = [];
    const w = new DiskWatcher({
      path: "/data",
      statfs: async () => {
        if (opts.fail) throw new Error("sem acesso");
        const blocks = 100 * 1000;
        return { blocks, bsize: GB / 1000, bavail: Math.round(blocks * (1 - usedRatio.v)) };
      },
      notify: async (e) => void events.push(e),
      now: () => clock.t,
    });
    return { w, events };
  }

  it("avisa ao passar de 90%; de novo só depois de 24 h; volta abaixo de 85% e pode avisar outra vez", async () => {
    const used = { v: 0.5 };
    const clock = { t: 0 };
    const { w, events } = watcher(used, clock);
    await w.check();
    expect(events).toHaveLength(0);
    used.v = 0.87; // acima de 85% mas abaixo de 90%: ainda não avisa
    await w.check();
    expect(events).toHaveLength(0);
    used.v = 0.93;
    await w.check();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "disk", key: "disk" });
    expect(events[0]!.title).toMatch(/93%/);
    expect(events[0]!.body!.join(" ")).toMatch(/7 GB livres/);
    clock.t += 60 * 60 * 1000;
    await w.check();
    expect(events).toHaveLength(1);
    clock.t += 24 * 60 * 60 * 1000;
    await w.check();
    expect(events).toHaveLength(2);
    used.v = 0.88; // entre 85% e 90%: continua "cheio" (sem pisca-pisca)
    clock.t += 1000;
    await w.check();
    used.v = 0.8;
    await w.check();
    used.v = 0.95;
    await w.check();
    expect(events).toHaveLength(3);
  });

  it("relógio padrão (Date.now)", async () => {
    const events: NotificationEvent[] = [];
    const w = new DiskWatcher({
      path: "/data",
      statfs: async () => ({ blocks: 100, bsize: 1024, bavail: 1 }),
      notify: async (e) => void events.push(e),
    });
    await w.check();
    expect(events).toHaveLength(1);
  });

  it("disco ilegível ou com tamanho zero: não avisa nem lança", async () => {
    const { w, events } = watcher({ v: 0.99 }, { t: 0 }, { fail: true });
    await expect(w.check()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    const zero = new DiskWatcher({
      path: "/data",
      statfs: async () => ({ blocks: 0, bsize: 4096, bavail: 0 }),
      notify: vi.fn(),
      now: () => 0,
    });
    await zero.check();
  });
});
