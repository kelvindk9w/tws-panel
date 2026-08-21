/**
 * security-page.test.tsx — regressão dos ~2 min de "Carregando…" no card
 * Hardening Index: o GET /api/security/scan sem fresh agora devolve na hora o
 * último relatório (nunca dispara scan novo — ver apps/server/tests/
 * security-scan.test.ts) e sinaliza `refreshing` quando um scan fresco está
 * em andamento. O card mostra o índice cacheado + indicador discreto
 * "atualizando…" em vez de bloquear a tela.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityPage } from "../src/pages/SecurityPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const REPORT = {
  id: "scan-1",
  scannedAt: "2026-08-21T10:00:00.000Z",
  durationMs: 115_000,
  target: "host",
  hardeningIndex: 75,
  hardeningIndexSource: "lynis",
  lynisAvailable: true,
  checks: [],
  summary: { total: 10, pass: 8, fail: 2, unknown: 0, critical: 0, warning: 2 },
  profile: "host",
  skippedChecks: [],
  profileNote: null,
};

function mockSecurityFetch(scan: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/security/scan")) return jsonResponse(scan);
      if (u.includes("/api/security/history")) {
        return jsonResponse({ entries: [], firstIndex: null, latestIndex: null, applied: null });
      }
      if (u.includes("/api/security/baseline")) return jsonResponse({ baseline: null });
      if (u.includes("/api/security/monitor/last")) {
        return jsonResponse({
          config: { intervalMs: 21_600_000 },
          schedulerRunning: false,
          lastRunAt: null,
          lastResult: null,
          baseline: null,
        });
      }
      return jsonResponse({}, 404);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SecurityPage — Hardening Index com refresh em andamento", () => {
  it("refreshing=true → mostra o índice cacheado + indicador \"atualizando…\" (sem bloquear)", async () => {
    mockSecurityFetch({ report: REPORT, cached: true, refreshing: true });
    render(<SecurityPage />);

    // índice do último relatório aparece imediatamente…
    expect(await screen.findByText("75")).toBeInTheDocument();
    // …com o indicador discreto de atualização em andamento
    expect(screen.getByText(/atualizando/)).toBeInTheDocument();
  });

  it("refreshing=false → índice sem o indicador de atualização", async () => {
    mockSecurityFetch({ report: REPORT, cached: true, refreshing: false });
    render(<SecurityPage />);

    expect(await screen.findByText("75")).toBeInTheDocument();
    expect(screen.queryByText(/atualizando/)).not.toBeInTheDocument();
  });
});
