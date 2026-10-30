/**
 * domain-subdomain-label.test.tsx — conectar subdomínio digitando só o rótulo (api -> api.example.com)
 * e a robustez da trava de rolagem (sequências ruins que deixavam a página sem rolar).
 */
import { StrictMode, useState } from "react";
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
  id: "p1", name: "site", slug: "site", domain: "example.com", aliases: ["api.example.com"],
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

async function openForm() {
  render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /Conectar novo domínio/ }));
  await screen.findByTestId("modal-panel");
}

describe("subdomínio só com o rótulo", () => {
  it("com o domínio pai escolhido, mostra a prévia e envia rótulo + pai", async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText("Domínio pai"), { target: { value: "example.com" } });
    fireEvent.change(document.getElementById("pd-new")!, { target: { value: "App.V2" } });
    expect(screen.getByTestId("domain-preview").textContent).toBe("Será conectado como app.v2.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    await waitFor(() => expect(screen.queryByTestId("modal-panel")).toBeNull());
    const post = apiFetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(post![1].body)).toMatchObject({ domain: "App.V2", parent: "example.com" });
    expect(screen.getByRole("status").textContent).toContain("app.v2.example.com");
  });

  it("nome completo que já termina no pai não é duplicado", async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText("Domínio pai"), { target: { value: "example.com" } });
    fireEvent.change(document.getElementById("pd-new")!, { target: { value: "https://Blog.example.com/" } });
    expect(screen.getByTestId("domain-preview").textContent).toContain("blog.example.com");
    expect(screen.getByTestId("domain-preview").textContent).not.toContain("example.com.example.com");
  });

  it("rótulo inválido avisa e bloqueia Conectar; nome que já existe também", async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText("Domínio pai"), { target: { value: "example.com" } });
    const input = document.getElementById("pd-new")!;
    fireEvent.change(input, { target: { value: "-ruim" } });
    expect(screen.getByTestId("domain-preview").textContent).toContain("letras, números e hífen");
    expect((screen.getByRole("button", { name: "Conectar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "api" } });
    expect(screen.getByTestId("domain-preview").textContent).toContain("já está neste projeto");
    expect((screen.getByRole("button", { name: "Conectar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sem escolher o pai, o nome completo continua valendo como antes", async () => {
    await openForm();
    fireEvent.change(document.getElementById("pd-new")!, { target: { value: "example.net" } });
    expect(screen.queryByTestId("domain-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    await waitFor(() => expect(screen.queryByTestId("modal-panel")).toBeNull());
    const post = apiFetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(post![1].body)).toEqual({ domain: "example.net" });
  });
});

describe("trava de rolagem robusta", () => {
  it("StrictMode (efeitos duplicados) não deixa a trava presa nem solta cedo demais", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <StrictMode>
        <Modal title="t" onClose={vi.fn()}>x</Modal>
      </StrictMode>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("dois diálogos fechando fora de ordem (o primeiro aberto fecha primeiro) não prendem a página", () => {
    document.body.style.overflow = "scroll";
    const a = render(<Modal title="a" onClose={vi.fn()}>x</Modal>);
    const b = render(<Modal title="b" onClose={vi.fn()}>x</Modal>);
    a.unmount();
    expect(document.body.style.overflow).toBe("hidden");
    b.unmount();
    expect(document.body.style.overflow).toBe("scroll");
    // e de novo, para provar que o valor guardado não ficou velho
    const c = render(<Modal title="c" onClose={vi.fn()}>x</Modal>);
    c.unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("desmontar a tela inteira com o diálogo aberto (navegação) devolve a rolagem", () => {
    function Page() {
      const [open, setOpen] = useState(true);
      return open ? <Modal title="t" onClose={() => setOpen(false)}>x</Modal> : null;
    }
    const { unmount } = render(<Page />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("fechar durante uma conexão em andamento (resposta tardia) não reprende a página", async () => {
    let finish: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/domains/pairs") return Promise.resolve({ pairs: [] });
      if (init?.method === "POST") return new Promise((r) => (finish = r));
      return Promise.resolve({});
    });
    await openForm();
    fireEvent.change(document.getElementById("pd-new")!, { target: { value: "example.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
    finish({ project: PROJECT });
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
  });
});
