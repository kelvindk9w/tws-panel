/**
 * Testes do guard de rotas (RequireAuth): sessão válida renderiza o painel;
 * 401 unauthorized → /login; 401 setup_incomplete → /setup — preservando a
 * query string (?token=...) no redirect (link do instalador).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../src/components/RequireAuth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/security"]}>
      <Routes>
        <Route
          path="/security"
          element={
            <RequireAuth>
              <div>painel-protegido</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<div>tela-login</div>} />
        <Route path="/setup" element={<div>tela-setup</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("RequireAuth (guard de rotas)", () => {
  it("sessão válida (/me 200) → renderiza o conteúdo protegido", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ user: { username: "admin", createdAt: "x" }, session: { expiresAt: "y" } }),
      ),
    );
    renderGuard();
    expect(await screen.findByText("painel-protegido")).toBeInTheDocument();
  });

  it("401 unauthorized → redireciona para /login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized", message: "Sessão inválida ou expirada." }, 401)),
    );
    renderGuard();
    expect(await screen.findByText("tela-login")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("painel-protegido")).not.toBeInTheDocument());
  });

  it("401 setup_incomplete → redireciona para /setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "setup_incomplete", message: "Conclua o setup para criar a conta." }, 401),
      ),
    );
    renderGuard();
    expect(await screen.findByText("tela-setup")).toBeInTheDocument();
  });

  it("redirect para /setup PRESERVA a query string (?token= do link do instalador)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "setup_incomplete", message: "Conclua o setup para criar a conta." }, 401),
      ),
    );
    function SetupSearchProbe() {
      const location = useLocation();
      return <div>search:{location.search}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/security?token=token-do-instalador"]}>
        <Routes>
          <Route
            path="/security"
            element={
              <RequireAuth>
                <div>painel-protegido</div>
              </RequireAuth>
            }
          />
          <Route path="/setup" element={<SetupSearchProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    // o destino recebe a query intacta — o token não se perde no redirect
    expect(await screen.findByText("search:?token=token-do-instalador")).toBeInTheDocument();
  });
});
