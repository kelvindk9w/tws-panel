/**
 * Regressão do banner "Sessão sem setup token": o Dashboard só renderiza dentro
 * do RequireAuth (usuário autenticado via cookie de sessão), então o aviso —
 * que olhava apenas o setup token no sessionStorage, limpo pelo login/setup —
 * aparecia indevidamente para usuário logado. O banner foi removido: com ou sem
 * setup token na sessão, ele nunca deve renderizar. O cenário de setup
 * incompleto sem token segue coberto pelo guard (RequireAuth redireciona para
 * /setup) e pelo aviso próprio da SetupPage.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/pages/DashboardPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockDashboardFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/projects")) return jsonResponse({ projects: [] });
      return jsonResponse({ containers: [] });
    }),
  );
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("DashboardPage — banner de setup token", () => {
  it("usuário autenticado sem setup token → banner NÃO renderiza", async () => {
    mockDashboardFetch();
    renderDashboard();

    // dashboard carrega normalmente…
    expect(await screen.findByText("Nenhum projeto ainda")).toBeInTheDocument();
    // …e o banner amarelo nunca aparece
    expect(screen.queryByText(/Sessão sem setup token/i)).not.toBeInTheDocument();
  });

  it("com setup token na sessão → banner também não renderiza (comportamento preservado)", async () => {
    sessionStorage.setItem("paas.setup-token", "token-qualquer");
    mockDashboardFetch();
    renderDashboard();

    expect(await screen.findByText("Nenhum projeto ainda")).toBeInTheDocument();
    expect(screen.queryByText(/Sessão sem setup token/i)).not.toBeInTheDocument();
  });
});
