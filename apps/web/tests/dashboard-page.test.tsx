/**
 * Regressão do banner "Sessão sem setup token": o Dashboard só renderiza dentro
 * do RequireAuth (usuário autenticado via cookie de sessão), então o aviso —
 * que olhava apenas o setup token no sessionStorage, limpo pelo login/setup —
 * aparecia indevidamente para usuário logado. O banner foi removido: com ou sem
 * setup token na sessão, ele nunca deve renderizar. O cenário de setup
 * incompleto sem token segue coberto pelo guard (RequireAuth redireciona para
 * /setup) e pelo aviso próprio da SetupPage.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
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
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

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

describe("DashboardPage — polling com pausa em aba oculta", () => {
  // Regressão: o polling era de 5s ininterruptos (mesmo em background) e cada
  // ciclo batia no dockerd. Agora: 15s com a aba visível, pausado com ela oculta.
  // shouldAdvanceTime: fake timers ativos ANTES do mount (o intervalo é criado
  // no useEffect), sem travar o findByText/waitFor (relógio avança em tempo real).
  it("com a aba visível, atualiza no intervalo de 15s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockDashboardFetch();
      renderDashboard();
      expect(await screen.findByText("Nenhum projeto ainda")).toBeInTheDocument();

      const fetchMock = vi.mocked(fetch);
      // shouldAdvanceTime faz o relógio fake andar alguns ms em tempo real,
      // então a asserção é por janela cheia: 1 ciclo a cada 15s (5s dariam +6).
      const initial = fetchMock.mock.calls.length; // 2: /api/projects + /api/docker/containers
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(fetchMock.mock.calls.length).toBe(initial + 2);
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(fetchMock.mock.calls.length).toBe(initial + 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("com a aba oculta o polling pausa; ao voltar, atualiza na hora e retoma", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockDashboardFetch();
      renderDashboard();
      expect(await screen.findByText("Nenhum projeto ainda")).toBeInTheDocument();

      const fetchMock = vi.mocked(fetch);
      act(() => setVisibility("hidden"));
      const before = fetchMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(fetchMock.mock.calls.length).toBe(before); // NENHUM poll com a aba oculta

      act(() => setVisibility("visible")); // refresh imediato ao voltar
      expect(fetchMock.mock.calls.length).toBe(before + 2);
      await act(async () => vi.advanceTimersByTimeAsync(15_000)); // intervalo retomado
      expect(fetchMock.mock.calls.length).toBe(before + 4);
    } finally {
      vi.useRealTimers();
    }
  });
});
