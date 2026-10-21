/**
 * dashboard-reconciliation.test.tsx — o Dashboard mostra o aviso "o painel
 * antigo tinha X ativo" enquanto houver pendência, independente do roteiro
 * "Deixe o painel pronto", e nada quando não há.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/pages/DashboardPage";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function stub(items: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/restore-reconciliation")) return json({ items });
      if (u.includes("/api/projects")) return json({ projects: [] });
      return json({ containers: [] });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard + aviso de reconciliação", () => {
  it("com pendência: o aviso aparece no Dashboard", async () => {
    stub([{ id: "webmail", status: "pending", source: "panel", since: "2026-10-20T12:00:00.000Z" }]);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/O painel antigo tinha o webmail ativo/)).toBeInTheDocument();
  });

  it("sem pendência: nenhum aviso", async () => {
    stub([]);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Nenhum projeto ainda")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-reconciliation")).not.toBeInTheDocument();
  });
});
