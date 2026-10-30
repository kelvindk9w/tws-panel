/**
 * modal-domain-scroll.test.tsx — o diálogo de conectar domínio cabe na tela (miolo rolável,
 * ações sempre à vista) e a rolagem da página volta ao fechar (Escape, clique fora, Cancelar, sucesso).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { Modal } from "@/components/ui/modal";
import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";
import { setLocale } from "../src/i18n";

const PROJECT = {
  id: "p1", name: "site", slug: "site", domain: "example.com", aliases: [],
  lastDeployStatus: "success", detection: { type: "dockerfile" }, updatedAt: "2026-10-22T00:00:00.000Z",
} as unknown as Project;

beforeEach(() => {
  setLocale("pt-BR", { persist: false });
  document.body.style.overflow = "";
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/projects/p1/domains/pairs") return { pairs: [] };
    if (path === "/api/projects/p1/domains" && init?.method === "POST") return { project: PROJECT };
    if (path.startsWith("/api/domains/suggest")) return { auto: "x.localhost", panelPublic: false };
    return {};
  });
});
afterEach(cleanup);

describe("Modal", () => {
  it("limita a altura à tela, rola só o miolo e mantém cabeçalho e ações fora da rolagem", () => {
    render(<Modal title="Título" footer={<button>Salvar</button>} onClose={vi.fn()}><p>miolo</p></Modal>);
    expect(screen.getByTestId("modal-panel").className).toContain("max-h-[calc(100dvh-1rem)]");
    const body = screen.getByTestId("modal-body");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.contains(screen.getByText("miolo"))).toBe(true);
    expect(body.contains(screen.getByText("Salvar"))).toBe(false);
    expect(body.contains(screen.getByText("Título"))).toBe(false);
  });

  it("trava a rolagem da página e a devolve ao desmontar", () => {
    document.body.style.overflow = "scroll";
    const { unmount } = render(<Modal title="t" onClose={vi.fn()}>x</Modal>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("com dois abertos, só devolve a rolagem quando o último fecha", () => {
    const a = render(<Modal title="a" onClose={vi.fn()}>x</Modal>);
    const b = render(<Modal title="b" onClose={vi.fn()}>x</Modal>);
    a.unmount();
    expect(document.body.style.overflow).toBe("hidden");
    b.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("fecha com Escape e com clique fora, não com clique dentro", () => {
    const onClose = vi.fn();
    render(<Modal title="t" onClose={onClose}>x</Modal>);
    fireEvent.mouseDown(screen.getByTestId("modal-panel"));
    fireEvent.mouseUp(screen.getByTestId("modal-panel"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("modal-overlay"));
    fireEvent.mouseUp(screen.getByTestId("modal-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Conectar novo domínio", () => {
  async function open(onChanged = vi.fn()) {
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Conectar novo domínio/ }));
    return screen.findByTestId("modal-panel");
  }

  it("abre num diálogo rolável com Cancelar e Conectar no rodapé fixo", async () => {
    await open();
    expect(document.body.style.overflow).toBe("hidden");
    const body = screen.getByTestId("modal-body");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.contains(screen.getByRole("button", { name: "Conectar" }))).toBe(false);
  });

  it("Escape fecha e devolve a rolagem", async () => {
    await open();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("modal-panel")).toBeNull());
    expect(document.body.style.overflow).toBe("");
  });

  it("clique fora fecha e devolve a rolagem", async () => {
    await open();
    fireEvent.mouseDown(screen.getByTestId("modal-overlay"));
    fireEvent.mouseUp(screen.getByTestId("modal-overlay"));
    await waitFor(() => expect(screen.queryByTestId("modal-panel")).toBeNull());
    expect(document.body.style.overflow).toBe("");
  });

  it("conectar com sucesso salva, fecha, devolve a rolagem, avisa e pede a lista de novo", async () => {
    const onChanged = vi.fn();
    await open(onChanged);
    fireEvent.change(document.getElementById("pd-new")!, { target: { value: "app.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    await waitFor(() => expect(screen.queryByTestId("modal-panel")).toBeNull());
    expect(document.body.style.overflow).toBe("");
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("app.example.com");
    const post = apiFetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(post![1].body).domain).toBe("app.example.com");
  });

  it("erro ao conectar mantém o diálogo aberto com a mensagem", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/domains/pairs") return { pairs: [] };
      if (init?.method === "POST") throw new Error("boom");
      return {};
    });
    await open();
    fireEvent.change(document.getElementById("pd-new")!, { target: { value: "app.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("modal-panel")).toBeTruthy();
  });

  it("a lista mostra o principal e todos os adicionais salvos", () => {
    const p = { ...PROJECT, aliases: ["www.example.com", "app.example.com"] } as Project;
    render(<ProjectDomainsCard project={p} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    expect(screen.getAllByText("app.example.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("www.example.com").length).toBeGreaterThan(0);
  });
});
