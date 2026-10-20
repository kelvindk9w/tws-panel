/**
 * header-language-menu.test.tsx — o seletor de idioma sempre à vista no
 * cabeçalho do painel (topo, laterais e barra móvel) e o menu do topo
 * enxuto: itens do dia a dia visíveis e o resto atrás de "Mais".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavLayout } from "@paas/core";
import { catalog, localeShort, STORAGE_KEY } from "../src/i18n/core";

const apiFetch = vi.fn(async (_path: string): Promise<unknown> => ({ openCount: 0 }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => apiFetch(path),
  ApiRequestError: class extends Error {},
  clearSetupToken: vi.fn(),
}));

import { AuthContext } from "@/lib/auth";
import { Layout } from "@/components/Layout";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ openCount: 0 });
});

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

const top = () => screen.getByTestId("nav-top");

describe("seletor de idioma no cabeçalho", () => {
  it("topo: aparece fora do menu do usuário, com rótulo acessível, e troca o idioma", () => {
    renderLayout("top");
    // sem abrir nenhum menu
    const select = within(top()).getByRole("combobox", { name: "Idioma" });
    expect(select).toHaveValue("pt-BR");
    fireEvent.change(select, { target: { value: "en" } });
    expect(within(top()).getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(within(top()).getByRole("button", { name: "More" })).toBeInTheDocument();
  });

  it("mostra o código curto do idioma (PT/EN) e mantém o nome completo acessível nas opções", () => {
    renderLayout("top");
    const select = within(top()).getByRole("combobox", { name: "Idioma" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["PT", "EN"]);
    expect(within(select).getByRole("option", { name: "English" })).toBeInTheDocument();
  });

  it("idioma sem código curto no dicionário cai no próprio código em maiúsculas", () => {
    catalog["es"] = { common: { "language.name": "Español" } };
    try {
      expect(localeShort("es")).toBe("ES");
      expect(localeShort("pt-BR")).toBe("PT");
    } finally {
      delete catalog["es"];
    }
  });

  it.each(["left", "right"] as const)("lateral %s: o seletor fica na lateral e na barra móvel", (side) => {
    renderLayout(side);
    const lateral = screen.getByTestId("nav-sidebar");
    const select = within(lateral).getByRole("combobox", { name: "Idioma" });
    fireEvent.change(select, { target: { value: "en" } });
    expect(within(lateral).getByRole("combobox", { name: "Language" })).toHaveValue("en");
    // barra móvel (escondida por CSS em telas grandes) também tem o seu
    expect(within(top()).getByRole("combobox", { name: "Language" })).toHaveValue("en");
  });

  it("não fica dentro do menu do usuário (o painel dele não tem seletor de idioma)", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    await user.click(screen.getByRole("button", { name: /Conta:/ }));
    const painel = screen.getByRole("button", { name: "Sair" }).parentElement as HTMLElement;
    expect(within(painel).getByRole("button", { name: "Trocar senha" })).toBeInTheDocument();
    expect(within(painel).queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: "Idioma" })).toHaveLength(1);
  });
});

describe("menu do usuário e \"Mais\" não ficam abertos juntos", () => {
  const sair = () => screen.queryByRole("button", { name: "Sair" });

  it("abrir \"Mais\" pelo teclado fecha o menu do usuário, e o inverso", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const conta = screen.getByRole("button", { name: /Conta:/ });
    const more = within(top()).getByRole("button", { name: "Mais" });
    conta.focus();
    await user.keyboard("{Enter}");
    expect(sair()).toBeInTheDocument();
    more.focus();
    await user.keyboard("{Enter}");
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(sair()).not.toBeInTheDocument();
    conta.focus();
    await user.keyboard("{Enter}");
    expect(sair()).toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("Esc fecha o menu do usuário e devolve o foco ao botão", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const conta = screen.getByRole("button", { name: /Conta:/ });
    await user.click(conta);
    await user.tab();
    expect(screen.getByRole("button", { name: "Configurações" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(sair()).not.toBeInTheDocument();
    expect(conta).toHaveFocus();
  });

  it("clicar e navegar com Tab dentro do menu do usuário não o fecha", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    await user.click(screen.getByRole("button", { name: /Conta:/ }));
    await user.tab();
    await user.tab();
    expect(sair()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trocar senha" }).parentElement as HTMLElement);
    expect(sair()).toBeInTheDocument();
  });
});

describe("menu do topo com \"Mais\"", () => {
  const visible = ["Dashboard", "Novo Projeto", "E-mail", "Segurança", "Alertas"];
  const grouped = ["Envios", "Certificados", "Auditoria", "Configurações", "Setup"];

  function desktopNav() {
    return within(top()).getByRole("navigation", { name: "Principal" });
  }

  it("só os itens do dia a dia ficam à vista; o resto some até abrir \"Mais\"", () => {
    renderLayout("top");
    const nav = desktopNav();
    for (const name of visible) expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    for (const name of grouped) expect(within(nav).queryByRole("link", { name })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Mais" })).toHaveAttribute("aria-expanded", "false");
  });

  it("abre e fecha por clique, mantendo aria-expanded", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    for (const name of grouped) expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveAttribute("href", "/mail/envios");
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByRole("link", { name: "Envios" })).not.toBeInTheDocument();
  });

  it("abre pelo teclado (Enter e seta para baixo), navega com Tab e fecha com Esc devolvendo o foco", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(more).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveFocus();
  });

  it("seta para cima: com o painel aberto e o foco no botão vai ao ÚLTIMO item; fechado, abre focando o último", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    await user.click(more);
    expect(more).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(within(nav).getByRole("link", { name: "Setup" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(within(nav).getByRole("link", { name: "Configurações" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("link", { name: "Setup" })).toHaveFocus();
  });

  it("seta para baixo percorre e dá a volta; Home e End vão ao primeiro e ao último", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    await user.click(more);
    await user.keyboard("{ArrowDown}");
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(within(nav).getByRole("link", { name: "Setup" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveFocus();
    more.focus();
    await user.keyboard("{End}");
    expect(within(nav).getByRole("link", { name: "Setup" })).toHaveFocus();
    more.focus();
    await user.keyboard("{Home}");
    expect(within(nav).getByRole("link", { name: "Envios" })).toHaveFocus();
  });

  it("Home e End com o painel fechado não abrem nada", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const more = within(desktopNav()).getByRole("button", { name: "Mais" });
    more.focus();
    await user.keyboard("{End}{Home}");
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("clicar no item da rota que já está aberta fecha o painel", async () => {
    const user = userEvent.setup();
    renderLayout("top", "/certificates");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    await user.click(more);
    await user.click(within(nav).getByRole("link", { name: "Certificados" }));
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("clique fora fecha", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const more = within(desktopNav()).getByRole("button", { name: "Mais" });
    await user.click(more);
    await user.click(screen.getByText("conteúdo"));
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("o foco saindo do grupo (Tab além do último item) fecha", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    await user.click(more);
    within(nav).getByRole("link", { name: "Setup" }).focus();
    await user.tab();
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("escolher um item navega e fecha o grupo", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    await user.click(more);
    await user.click(within(nav).getByRole("link", { name: "Auditoria" }));
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("rota filha aberta destaca \"Mais\" e o item dentro dele", async () => {
    const user = userEvent.setup();
    renderLayout("top", "/certificates");
    const nav = desktopNav();
    const more = within(nav).getByRole("button", { name: "Mais" });
    expect(more.className).toContain("bg-secondary");
    expect(more).toHaveAttribute("data-active", "true");
    await user.click(more);
    expect(within(nav).getByRole("link", { name: "Certificados" }).className).toContain("bg-secondary");
    expect(within(nav).getByRole("link", { name: "Certificados" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Auditoria" }).className).not.toContain("bg-secondary");
  });

  it("em /mail/envios \"Mais\" fica ativo e E-mail não; em /settings/security (subrota) também", () => {
    renderLayout("top", "/mail/envios");
    let nav = desktopNav();
    expect(within(nav).getByRole("button", { name: "Mais" })).toHaveAttribute("data-active", "true");
    expect(within(nav).getByRole("link", { name: "E-mail" }).className).not.toContain("bg-secondary");
    cleanup();
    renderLayout("top", "/settings/security");
    nav = desktopNav();
    expect(within(nav).getByRole("button", { name: "Mais" })).toHaveAttribute("data-active", "true");
  });

  it("rota de item visível não ativa \"Mais\"", () => {
    renderLayout("top", "/alerts");
    const more = within(desktopNav()).getByRole("button", { name: "Mais" });
    expect(more).not.toHaveAttribute("data-active");
    expect(more.className).not.toContain("bg-secondary");
  });

  it("o badge de alertas abertos continua à vista (fora do grupo)", async () => {
    apiFetch.mockResolvedValue({ openCount: 120 });
    renderLayout("top");
    const alerts = within(desktopNav()).getByRole("link", { name: /Alertas/ });
    await waitFor(() => expect(alerts).toHaveTextContent("99+"));
  });

  it("em inglês, rótulos do grupo e dos itens", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    fireEvent.change(within(top()).getByRole("combobox"), { target: { value: "en" } });
    const nav = within(top()).getByRole("navigation", { name: "Main" });
    await user.click(within(nav).getByRole("button", { name: "More" }));
    expect(within(nav).getByRole("link", { name: "Audit log" })).toBeInTheDocument();
  });

  it("menu móvel lista todos os itens, sem agrupar", async () => {
    const user = userEvent.setup();
    renderLayout("top");
    await user.click(screen.getByRole("button", { name: /^Menu/ }));
    const mobile = screen.getByTestId("nav-mobile");
    for (const name of [...visible, ...grouped]) expect(within(mobile).getByRole("link", { name })).toBeInTheDocument();
    expect(within(mobile).queryByRole("button", { name: "Mais" })).not.toBeInTheDocument();
  });

  it("lateral lista todos os itens, sem agrupar, na ordem de sempre", () => {
    renderLayout("left");
    const lateral = screen.getByTestId("nav-sidebar");
    const links = within(lateral).getAllByRole("link").map((a) => a.textContent);
    expect(links.slice(1)).toEqual(["Dashboard", "Novo Projeto", "E-mail", "Envios", "Certificados", "Segurança", "Alertas", "Auditoria", "Configurações", "Setup"]);
    expect(within(lateral).queryByRole("button", { name: "Mais" })).not.toBeInTheDocument();
  });
});

describe("cabeçalho estreito: sem estouro lateral (estrutura)", () => {
  it("o texto 'Menu' fica só para leitor de tela abaixo de sm, mas segue sendo o nome do botão", () => {
    renderLayout("top");
    const button = within(top()).getByRole("button", { name: "Menu" });
    const label = within(button).getByText("Menu");
    expect(label.className).toContain("sr-only");
    expect(label.className).toContain("sm:not-sr-only");
  });

  it("espaços do cabeçalho: menores abaixo de sm e na faixa lg, normais em sm e xl", () => {
    renderLayout("top");
    const row = top().firstElementChild as HTMLElement;
    for (const c of ["gap-2", "sm:gap-4", "lg:gap-3", "xl:gap-6"]) expect(row.className).toContain(c);
    const group = within(top()).getByRole("combobox", { name: "Idioma" }).closest("div")!.parentElement as HTMLElement;
    for (const c of ["gap-1", "sm:gap-2", "lg:gap-1", "xl:gap-2"]) expect(group.className).toContain(c);
  });
});
