/**
 * restore-reconciliation-notice.test.tsx — aviso âmbar "O painel antigo tinha X
 * ativo. Ativar agora?" (Dashboard e tela dos backups). Não é erro: âmbar,
 * ícone + texto (não só cor), role="status", botão que leva à ação certa e
 * "Dispensar". Nada aparece quando está tudo certo.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationItem } from "@paas/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init) };
});

import { ReconciliationNotice } from "@/components/restore/ReconciliationNotice";

const item = (id: ReconciliationItem["id"], status: ReconciliationItem["status"] = "pending"): ReconciliationItem => ({
  id,
  status,
  source: "panel",
  since: "2026-10-20T12:00:00.000Z",
});

let items: ReconciliationItem[];

beforeEach(() => {
  items = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/restore-reconciliation" && !init?.method) return { items };
    if (path.endsWith("/dismiss")) {
      const id = path.split("/")[3];
      items = items.filter((i) => i.id !== id);
      return { items };
    }
    if (path === "/api/mail/server/repair-auth") {
      items = items.filter((i) => i.id !== "mail-auth");
      return { ok: true, result: "repaired" };
    }
    throw new Error(`rota inesperada ${path}`);
  });
});
afterEach(cleanup);

const show = () => render(<ReconciliationNotice />, { wrapper: MemoryRouter });

describe("ReconciliationNotice", () => {
  it("tudo certo: nada na tela (já está validado, não pergunta nada)", async () => {
    show();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("restore-reconciliation")).not.toBeInTheDocument();
  });

  it("falha ao carregar: nada na tela (nunca inventa um aviso)", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new Error("rede");
    });
    show();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("restore-reconciliation")).not.toBeInTheDocument();
  });

  it("webmail pendente: pergunta, é âmbar (não erro), tem ícone e papel de status, e o botão leva a E-mail", async () => {
    items = [item("webmail")];
    show();
    const box = await screen.findByTestId("restore-reconciliation");
    expect(box).toHaveAttribute("role", "status");
    expect(box.className).toMatch(/amber/);
    expect(box.className).not.toMatch(/red/);
    expect(box.querySelector("svg")).not.toBeNull();
    expect(within(box).getByText(/O painel antigo tinha o webmail ativo\. Ativar agora\?/)).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: "Ativar agora" })).toHaveAttribute("href", "/mail");
    expect(within(box).getByRole("button", { name: "Dispensar" })).toBeInTheDocument();
    // cada pendência é uma nota própria
    expect(within(box).getAllByRole("note")).toHaveLength(1);
  });

  it("servidor de e-mail e domínio do painel levam à tela certa", async () => {
    items = [item("mail-server"), item("panel-domain")];
    show();
    expect(await screen.findByRole("link", { name: "Iniciar agora" })).toHaveAttribute("href", "/mail");
    expect(screen.getByRole("link", { name: "Conferir o DNS" })).toHaveAttribute("href", "/settings/panel-domain");
    expect(screen.getAllByRole("note")).toHaveLength(2);
  });

  it("'não foi possível conferir': mostra o aviso de que não conferiu, em vez de afirmar que está parado", async () => {
    items = [item("webmail", "unknown")];
    show();
    const box = await screen.findByTestId("restore-reconciliation");
    expect(box).toHaveTextContent(/Não foi possível conferir/);
  });

  it("Dispensar: tira o aviso e chama o servidor", async () => {
    items = [item("webmail")];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Dispensar" }));
    await waitFor(() => expect(screen.queryByTestId("restore-reconciliation")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/restore-reconciliation/webmail/dismiss", expect.objectContaining({ method: "POST" }));
  });

  it("Dispensar que falha: o aviso fica e mostra o erro", async () => {
    items = [item("webmail")];
    show();
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("falhou");
      return { items };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Dispensar" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("restore-reconciliation")).toBeInTheDocument();
  });

  it("não autenticou no servidor de e-mail: a ação pede confirmação e executa o reparo", async () => {
    items = [item("mail-auth")];
    show();
    const box = await screen.findByTestId("restore-reconciliation");
    expect(box).toHaveTextContent(/não consegue entrar no servidor de e-mail/);
    fireEvent.click(within(box).getByRole("button", { name: "Reparar agora" }));
    // nada executa antes da confirmação
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/mail/server/repair-auth", expect.anything());
    fireEvent.click(within(box).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/mail/server/repair-auth", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.queryByTestId("restore-reconciliation")).not.toBeInTheDocument());
  });

  it("reparo que falha: o aviso fica com a mensagem de erro", async () => {
    items = [item("mail-auth")];
    show();
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("falhou");
      return { items };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reparar agora" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  });

  it("a pendência some sozinha quando o serviço passa a rodar (nova conferência)", async () => {
    items = [item("webmail")];
    show();
    await screen.findByTestId("restore-reconciliation");
    items = [];
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.queryByTestId("restore-reconciliation")).not.toBeInTheDocument());
  });

  it("variant 'result' (tela do resultado da restauração) usa o mesmo aviso", async () => {
    items = [item("webmail")];
    render(<ReconciliationNotice variant="result" />, { wrapper: MemoryRouter });
    expect(await screen.findByTestId("restore-reconciliation")).toBeInTheDocument();
  });
});
