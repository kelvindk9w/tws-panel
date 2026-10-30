/**
 * terminal-page.test.tsx — o terminal numa tela própria (/terminal) e no menu: a rota mostra o convite
 * "Terminal desligado" quando o servidor diz desligado, o item "Terminal" do menu leva para lá e a
 * página não chama endpoint de segurança nem de saúde.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {},
  clearSetupToken: vi.fn(),
}));

import { AuthContext } from "@/lib/auth";
import { Layout } from "@/components/Layout";
import { TerminalPage } from "@/pages/TerminalPage";

const OFF = {
  required: true,
  enabled: false,
  expiresAt: null,
  idleExpiresAt: null,
  remainingMs: 0,
  idleRemainingMs: 0,
  windowMs: 30 * 60_000,
  idleMs: 15 * 60_000,
  twoFactorEnabled: true,
  emailCodeEnabled: false,
  lastEnd: null,
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/terminal/access") return OFF;
    if (path === "/api/auth/email-code") return { enabled: false, canEnable: false, address: null, mailReady: true, twoFactorEnabled: true };
    if (path.startsWith("/api/alerts")) return { openCount: 0 };
    if (path === "/api/terminal/info") return { configuredUser: null };
    throw new Error(`rota inesperada: ${path}`);
  });
});

afterEach(cleanup);

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{ user: { username: "admin", createdAt: "x" }, setUser: () => undefined, preferences: { navLayout: "left" }, setPreferences: () => undefined }}
      >
        <Layout>
          <Routes>
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/" element={<p>início</p>} />
          </Routes>
        </Layout>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function menuTerminalLink() {
  const nav = screen.getByTestId("nav-sidebar");
  return Array.from(nav.querySelectorAll("a")).find((a) => a.textContent === "Terminal")!;
}

describe("página /terminal", () => {
  it("terminal desligado: título, explicação, convite e botão Habilitar terminal", async () => {
    renderApp("/terminal");
    expect(await screen.findByText("Terminal desligado")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByText(/terminal do servidor dentro do painel/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Habilitar terminal" })).toBeInTheDocument();
  });

  it("não chama endpoints de segurança nem de saúde", async () => {
    renderApp("/terminal");
    await screen.findByText("Terminal desligado");
    const paths = apiFetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => /security|hardening|health|setup/.test(p))).toEqual([]);
  });
});

describe("menu", () => {
  it("o item Terminal existe e leva para /terminal", async () => {
    renderApp("/");
    const link = menuTerminalLink();
    expect(link.getAttribute("href")).toBe("/terminal");
    fireEvent.click(link);
    expect(await screen.findByText("Terminal desligado")).toBeInTheDocument();
  });
});
