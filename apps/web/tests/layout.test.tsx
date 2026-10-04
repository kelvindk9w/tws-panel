/**
 * layout.test.tsx — o menu de navegação no lugar escolhido em Configurações:
 * topo (padrão, o formato de sempre), lateral esquerda ou lateral direita.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavLayout } from "@paas/core";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ openCount: 0 })),
  ApiRequestError: class extends Error {},
  clearSetupToken: vi.fn(),
}));

import { AuthContext } from "@/lib/auth";
import { Layout } from "@/components/Layout";

afterEach(cleanup);

function renderLayout(navLayout: NavLayout, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{ user: { username: "admin", createdAt: "x" }, setUser: () => undefined, preferences: { navLayout }, setPreferences: () => undefined }}
      >
        <Layout>
          <p>conteúdo</p>
        </Layout>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("Layout — posição do menu", () => {
  it("topo: barra no alto, sem lateral", () => {
    renderLayout("top");
    expect(screen.getByTestId("nav-top")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-sidebar")).not.toBeInTheDocument();
  });

  it("lateral esquerda: a lateral vem ANTES do conteúdo", () => {
    renderLayout("left");
    const lateral = screen.getByTestId("nav-sidebar");
    expect(lateral.dataset.side).toBe("left");
    const conteudo = screen.getByText("conteúdo");
    expect(lateral.compareDocumentPosition(conteudo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lateral).toHaveTextContent("Configurações");
    expect(lateral).toHaveTextContent("admin"); // menu do usuário junto
  });

  it("lateral direita: a lateral vem DEPOIS do conteúdo", () => {
    renderLayout("right");
    const lateral = screen.getByTestId("nav-sidebar");
    expect(lateral.dataset.side).toBe("right");
    const conteudo = screen.getByText("conteúdo");
    expect(lateral.compareDocumentPosition(conteudo) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("telas pequenas: os itens ficam atrás de \"Menu\" (sem ocupar meia tela)", () => {
    renderLayout("top");
    expect(screen.queryByTestId("nav-mobile")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Menu/ }));
    expect(screen.getByTestId("nav-mobile")).toHaveTextContent("Configurações");
  });
});

describe("Layout — Envios no menu", () => {
  it("link Envios logo depois de E-mail", () => {
    renderLayout("top");
    const links = screen.getAllByRole("link").map((a) => a.textContent);
    const mail = links.indexOf("E-mail");
    expect(mail).toBeGreaterThanOrEqual(0);
    expect(links[mail + 1]).toBe("Envios");
    expect(screen.getByRole("link", { name: "Envios" })).toHaveAttribute("href", "/mail/envios");
  });

  it("em /mail/envios só Envios fica marcado; num domínio, só E-mail", () => {
    renderLayout("top", "/mail/envios");
    expect(screen.getByRole("link", { name: "Envios" }).className).toContain("bg-secondary");
    expect(screen.getByRole("link", { name: "E-mail" }).className).not.toContain("bg-secondary");
    cleanup();
    renderLayout("top", "/mail/envio.exemplo.com.br");
    expect(screen.getByRole("link", { name: "E-mail" }).className).toContain("bg-secondary");
    expect(screen.getByRole("link", { name: "Envios" }).className).not.toContain("bg-secondary");
  });
});
