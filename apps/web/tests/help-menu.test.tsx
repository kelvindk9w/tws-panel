/**
 * help-menu.test.tsx — "Ajuda e feedback" no cabeçalho: links por idioma,
 * privacidade do link de bug, acessibilidade/teclado e convivência com os
 * outros menus do cabeçalho ("Mais" e menu do usuário).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavLayout } from "@paas/core";
import { setLocale } from "../src/i18n";
import { REPO_URL, SITE_URL } from "../src/lib/links";

let versionReply: () => Promise<unknown> = async () => ({ version: "0.1.0" });
const apiFetch = vi.fn(async (path: string): Promise<unknown> => {
  if (path === "/api/version") return versionReply();
  return { openCount: 0 };
});
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => apiFetch(path),
  ApiRequestError: class extends Error {},
  clearSetupToken: vi.fn(),
}));

import { AuthContext } from "@/lib/auth";
import { Layout } from "@/components/Layout";
import { HelpMenu } from "@/components/HelpMenu";

beforeEach(() => {
  versionReply = async () => ({ version: "0.1.0" });
});

afterEach(() => {
  cleanup();
  apiFetch.mockClear();
  setLocale("pt-BR");
});

function renderLayout(navLayout: NavLayout = "top") {
  return render(
    <MemoryRouter initialEntries={["/"]}>
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
const helpButton = (scope: HTMLElement = top(), name = "Ajuda e feedback") => within(scope).getByRole("button", { name });

describe("botão no cabeçalho", () => {
  it("topo: ícone com rótulo acessível, fechado por padrão e sem consultar a versão antes de abrir", () => {
    renderLayout("top");
    const button = helpButton();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(apiFetch).not.toHaveBeenCalledWith("/api/version");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("em inglês o rótulo é 'Help and feedback'", () => {
    setLocale("en");
    renderLayout("top");
    expect(helpButton(top(), "Help and feedback")).toBeInTheDocument();
  });

  it.each(["left", "right"] as const)("lateral %s: o botão existe na lateral e na barra móvel", (side) => {
    renderLayout(side);
    expect(helpButton(screen.getByTestId("nav-sidebar"))).toBeInTheDocument();
    expect(helpButton(top())).toBeInTheDocument();
  });
});

describe("painel de ajuda", () => {
  it("abre com os cinco links, em nova aba e com rel seguro (pt-BR)", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    const dialog = screen.getByRole("dialog", { name: "Ajuda e feedback" });
    expect(helpButton()).toHaveAttribute("aria-expanded", "true");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `${SITE_URL}/pt-br/`,
      `${SITE_URL}/pt-br/guides/help/`,
      `${REPO_URL}/discussions`,
      expect.stringMatching(new RegExp(`^${REPO_URL}/issues/new\\?`)),
      `${REPO_URL}/issues/new?template=feature_request.yml`,
    ]);
    for (const a of links) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a).toHaveAttribute("rel", "noopener noreferrer");
      // aviso de nova aba para leitor de tela, dentro do nome do link
      expect(a).toHaveAccessibleName(/\(abre em nova aba\)/);
    }
    expect(within(dialog).getByRole("link", { name: /Guia e documentação/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Página de ajuda e feedback/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Fazer uma pergunta ou dar uma ideia/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Relatar um problema/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Sugerir uma funcionalidade/ })).toBeInTheDocument();
  });

  it("em inglês, textos e endereços seguem o idioma (/en/)", async () => {
    setLocale("en");
    renderLayout("top");
    await userEvent.click(helpButton(top(), "Help and feedback"));
    const dialog = screen.getByRole("dialog", { name: "Help and feedback" });
    const hrefs = within(dialog).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs[0]).toBe(`${SITE_URL}/en/`);
    expect(hrefs[1]).toBe(`${SITE_URL}/en/guides/help/`);
    expect(within(dialog).getByRole("link", { name: /Ask a question or share an idea/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Report a problem/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Suggest a feature/ })).toBeInTheDocument();
    for (const a of within(dialog).getAllByRole("link")) expect(a).toHaveAccessibleName(/\(opens in a new tab\)/);
    expect(new URL(hrefs[3]!).searchParams.get("locale")).toBe("en");
  });

  it("trocar o idioma com o painel aberto atualiza os endereços", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    fireEvent.change(within(top()).getByRole("combobox", { name: "Idioma" }), { target: { value: "en" } });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("link")[0]).toHaveAttribute("href", `${SITE_URL}/en/`);
  });

  it("mostra a versão do painel e o aviso sobre logs", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    expect(await screen.findByText("TWS Panel v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("Não cole logs sem revisar: podem conter domínios, IPs e tokens.")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/api/version");
  });

  it("aviso sobre logs em inglês", async () => {
    setLocale("en");
    renderLayout("top");
    await userEvent.click(helpButton(top(), "Help and feedback"));
    expect(screen.getByText(/Don't paste logs without reviewing them/)).toBeInTheDocument();
  });

  it("a versão consultada entra no link do bug, junto com o idioma, e só", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    await screen.findByText("TWS Panel v0.1.0");
    const bug = screen.getByRole("link", { name: /Relatar um problema/ });
    const p = new URL(bug.getAttribute("href")!).searchParams;
    expect(p.get("template")).toBe("bug_report.yml");
    expect(p.get("version")).toBe("0.1.0");
    expect(p.get("locale")).toBe("pt-BR");
    expect([...p.keys()].sort()).toEqual(["locale", "template", "version"]);
  });

  it("versão hostil do servidor não vira parâmetro nem aparece no painel", async () => {
    versionReply = async () => ({ version: "0.1.0&title=segredo#x\nbody=senha" });
    renderLayout("top");
    await userEvent.click(helpButton());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/version"));
    const bug = screen.getByRole("link", { name: /Relatar um problema/ });
    await waitFor(() => expect(bug.getAttribute("href")).toContain("locale="));
    const url = new URL(bug.getAttribute("href")!);
    expect([...url.searchParams.keys()].sort()).toEqual(["locale", "template"]);
    expect(url.hash).toBe("");
    expect(screen.queryByText(/segredo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^TWS Panel v/)).not.toBeInTheDocument();
  });

  it("sem resposta da versão (erro ou formato estranho), o painel funciona sem ela", async () => {
    versionReply = async () => {
      throw new Error("fora do ar");
    };
    renderLayout("top");
    await userEvent.click(helpButton());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/version"));
    expect(screen.queryByText(/^TWS Panel v/)).not.toBeInTheDocument();
    expect(new URL(screen.getByRole("link", { name: /Relatar um problema/ }).getAttribute("href")!).searchParams.has("version")).toBe(false);

    cleanup();
    apiFetch.mockClear();
    versionReply = async () => ({ version: 42 });
    renderLayout("top");
    await userEvent.click(helpButton());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/version"));
    expect(screen.queryByText(/^TWS Panel v/)).not.toBeInTheDocument();
    expect(new URL(screen.getByRole("link", { name: /Relatar um problema/ }).getAttribute("href")!).searchParams.has("version")).toBe(false);
  });

  it("consulta a versão uma única vez, mesmo abrindo e fechando várias vezes", async () => {
    renderLayout("top");
    for (let i = 0; i < 3; i += 1) {
      await userEvent.click(helpButton());
      await userEvent.click(helpButton());
    }
    expect(apiFetch.mock.calls.filter(([p]) => p === "/api/version")).toHaveLength(1);
  });
});

describe("teclado, foco e clique fora", () => {
  it("Esc fecha e devolve o foco ao botão", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    const first = within(screen.getByRole("dialog")).getAllByRole("link")[0]!;
    first.focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(helpButton()).toHaveFocus();
    expect(helpButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("Tab percorre os links e, ao sair do painel, ele fecha", async () => {
    renderLayout("top");
    helpButton().focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const links = within(screen.getByRole("dialog")).getAllByRole("link");
    await userEvent.tab();
    expect(links[0]).toHaveFocus();
    for (let i = 1; i < links.length; i += 1) {
      await userEvent.tab();
      expect(links[i]).toHaveFocus();
    }
    await userEvent.tab(); // sai para o menu do usuário
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clique fora fecha", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("conteúdo"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clique dentro do painel (texto) não fecha", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    fireEvent.mouseDown(screen.getByText(/Não cole logs/));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Esc com o painel fechado não faz nada de estranho", async () => {
    renderLayout("top");
    helpButton().focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("convivência com os outros menus", () => {
  it("abrir a ajuda fecha o menu do usuário, e vice-versa", async () => {
    renderLayout("top");
    const userButton = within(top()).getByRole("button", { name: /Conta: admin/ });
    await userEvent.click(userButton);
    expect(screen.getByRole("button", { name: "Sair" })).toBeInTheDocument();
    await userEvent.click(helpButton());
    expect(screen.queryByRole("button", { name: "Sair" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(userButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sair" })).toBeInTheDocument();
  });

  it("abrir a ajuda fecha o 'Mais', e vice-versa", async () => {
    renderLayout("top");
    const more = within(top()).getByRole("button", { name: "Mais" });
    await userEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(helpButton());
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(more);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  it("pelo teclado: Tab da ajuda para o menu do usuário não deixa os dois abertos", async () => {
    renderLayout("top");
    helpButton().focus();
    await userEvent.keyboard("{Enter}");
    const userButton = within(top()).getByRole("button", { name: /Conta: admin/ });
    userButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sair" })).toBeInTheDocument();
  });

  it("lateral: abre para cima (rodapé) sem esconder o menu do usuário aberto", async () => {
    renderLayout("right");
    const side = screen.getByTestId("nav-sidebar");
    await userEvent.click(helpButton(side));
    const dialog = within(side).getByRole("dialog");
    expect(dialog.className).toMatch(/bottom-full/);
    await userEvent.click(within(side).getByRole("button", { name: /Conta: admin/ }));
    expect(within(side).queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("painel dentro da tela (estrutura)", () => {
  it("topo: abaixo de sm prende o painel à tela (fixed, 16px da direita, sob o cabeçalho) e limita a largura", async () => {
    renderLayout("top");
    await userEvent.click(helpButton());
    const cls = screen.getByRole("dialog").className;
    for (const c of ["max-sm:fixed", "max-sm:right-4", "max-sm:top-14", "max-sm:mt-0", "max-w-[calc(100vw-2rem)]", "w-72"]) expect(cls).toContain(c);
  });

  it("lateral: mantém a âncora no botão (sem fixed), só se abre na lateral em md+", async () => {
    renderLayout("left");
    const side = screen.getByTestId("nav-sidebar");
    await userEvent.click(helpButton(side));
    const cls = within(side).getByRole("dialog").className;
    expect(cls).not.toContain("fixed");
    expect(cls).toContain("left-0");
  });
});

describe("HelpMenu isolado", () => {
  it("renderiza sem o Layout", async () => {
    render(<HelpMenu />);
    await userEvent.click(screen.getByRole("button", { name: "Ajuda e feedback" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
