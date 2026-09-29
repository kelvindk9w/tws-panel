/**
 * security-page.test.tsx — regressão dos ~2 min de "Carregando…" no card
 * Hardening Index: o GET /api/security/scan sem fresh agora devolve na hora o
 * último relatório (nunca dispara scan novo — ver apps/server/tests/
 * security-scan.test.ts) e sinaliza `refreshing` quando um scan fresco está
 * em andamento. O card mostra o índice cacheado + indicador discreto
 * "atualizando…" em vez de bloquear a tela.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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

function mockSecurityFetch(scan: unknown, history: unknown = { entries: [], firstIndex: null, latestIndex: null, applied: null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/security/scan")) return jsonResponse(scan);
      if (u.includes("/api/security/history")) {
        return jsonResponse(history);
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
    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );

    // índice do último relatório aparece imediatamente…
    expect(await screen.findByText("75")).toBeInTheDocument();
    // …com o indicador discreto de atualização em andamento
    expect(screen.getByText(/atualizando/)).toBeInTheDocument();
  });

  it("refreshing=false → índice sem o indicador de atualização", async () => {
    mockSecurityFetch({ report: REPORT, cached: true, refreshing: false });
    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("75")).toBeInTheDocument();
    expect(screen.queryByText(/atualizando/)).not.toBeInTheDocument();
  });
});

/**
 * Validação real: "Evolução: 42 → 86 ▲" comparava o índice interno (42) com o
 * Lynis (86). Seta e sentido só entre notas da mesma régua.
 */
describe("SecurityPage — evolução sem misturar réguas", () => {
  const scan = (id: string, at: string, idx: number, src: "lynis" | "internal") => ({
    id,
    at,
    kind: "scan",
    hardeningIndex: idx,
    hardeningIndexSource: src,
  });

  it("réguas diferentes: diz quais são e não desenha seta", async () => {
    mockSecurityFetch(
      { report: REPORT, cached: true, refreshing: false },
      {
        entries: [scan("a", "2026-09-28T10:00:00Z", 42, "internal"), scan("b", "2026-09-29T21:00:00Z", 80, "lynis")],
        firstIndex: 42,
        latestIndex: 80,
        applied: null,
      },
    );
    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );
    const evo = await screen.findByTestId("evolution");
    expect(evo).toHaveTextContent(/réguas diferentes/);
    expect(evo).not.toHaveTextContent("▲");
  });

  it("mesma régua: seta com o sentido", async () => {
    mockSecurityFetch(
      { report: REPORT, cached: true, refreshing: false },
      {
        entries: [scan("a", "2026-09-28T10:00:00Z", 58, "lynis"), scan("b", "2026-09-29T21:00:00Z", 86, "lynis")],
        firstIndex: 58,
        latestIndex: 86,
        applied: null,
      },
    );
    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("evolution")).toHaveTextContent("Evolução: 58 → 86 ▲");
  });
});
