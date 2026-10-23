/**
 * new-project-pair.test.tsx — passo 3 do assistente com domínio próprio: a orientação cobre o
 * nome digitado e o par com/sem www, a verificação mostra um resultado por nome (o par que
 * falha é aviso) e desligar o par é enviado ao concluir.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { NewProjectPage } from "@/pages/NewProjectPage";

const SSLIP = "loja.203-0-113-10.sslip.io";
let checkResponse: Record<string, unknown>;

beforeEach(() => {
  checkResponse = {
    domain: "example.com", devLocal: false, ok: true, state: "pointed", resolvedIps: ["203.0.113.10"], machineIps: [], message: "ok",
    pair: { domain: "www.example.com", role: "www", ok: false, state: "missing", resolvedIps: [], message: "" },
  };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/projects" && method === "POST") return { project: { id: "p1", domain: JSON.parse(String(init!.body)).domain, name: "loja" } };
    if (path === "/api/projects/p1" && method === "PATCH") return { project: { id: "p1", domain: SSLIP, name: "loja" } };
    if (path.startsWith("/api/domains/suggest")) return { auto: SSLIP, publicIp: "203.0.113.10", panelPublic: false };
    if (path.startsWith("/api/domains/check")) return checkResponse;
    if (path === "/api/projects/p1/detect") {
      return { detection: { type: "dockerfile", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: 80, warnings: [], details: [] } };
    }
    if (path.startsWith("/api/integrations/github")) throw new Error("sem github");
    if (path.startsWith("/api/projects/p1/env")) return { vars: [], compose: null };
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(cleanup);

async function ateOPasso3ComDominioProprio(domain: string) {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: "https://github.com/usuario/loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
  await screen.findByText(/Tipo detectado/);
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  await screen.findByTestId("auto-domain");
  fireEvent.click(screen.getByRole("radio", { name: /Meu domínio ou subdomínio/ }));
  fireEvent.change(screen.getByLabelText(/Seu domínio/), { target: { value: domain } });
}

function patches(): Array<Record<string, unknown>> {
  return apiFetchMock.mock.calls
    .filter(([p, i]) => p === "/api/projects/p1" && (i as RequestInit | undefined)?.method === "PATCH")
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
}

describe("passo 3 — domínio próprio com par", () => {
  it("digitou o apex: mostra @ e www; Verificar DNS mostra um resultado por nome", async () => {
    await ateOPasso3ComDominioProprio("example.com");
    const guia = screen.getByTestId("dns-guide");
    expect(within(guia).getByTestId("dns-row-canonical")).toHaveTextContent("example.com");
    expect(within(guia).getByTestId("dns-row-pair")).toHaveTextContent("www.example.com");
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    await waitFor(() => expect(screen.getByTestId("dns-state-pair")).toBeInTheDocument());
    expect(screen.getByTestId("dns-state-canonical")).toHaveAttribute("data-state", "pointed");
    expect(screen.getByTestId("dns-state-pair")).toHaveAttribute("data-state", "missing");
    expect(screen.getByTestId("dns-state-pair")).toHaveTextContent(/É só um aviso/);
  });

  it("Unicode digitado: o guia mostra punycode, Verificar DNS e o PATCH levam o nome em punycode", async () => {
    await ateOPasso3ComDominioProprio("example.公司.cn");
    expect(screen.getByTestId("dns-guide-punycode")).toHaveTextContent("example.xn--55qx5d.cn");
    expect(within(screen.getByTestId("dns-guide")).getByTestId("dns-row-pair")).toHaveTextContent("www.example.xn--55qx5d.cn");
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/domains/check?domain=example.xn--55qx5d.cn"));
    fireEvent.click(screen.getByRole("button", { name: /^Criar projeto$/ }));
    await waitFor(() => expect(patches().some((p) => p.domain === "example.xn--55qx5d.cn")).toBe(true));
  });

  it("digitou o www: o par é o apex", async () => {
    await ateOPasso3ComDominioProprio("www.example.com");
    expect(screen.getByTestId("dns-row-pair")).toHaveTextContent("@");
    expect(screen.getByTestId("dns-row-pair")).toHaveTextContent("example.com");
  });

  it("par ligado (padrão): o PATCH ao concluir não leva 'pair'", async () => {
    await ateOPasso3ComDominioProprio("example.com");
    fireEvent.click(screen.getByRole("button", { name: /^Criar projeto$/ }));
    await waitFor(() => expect(patches().some((p) => p.domain === "example.com")).toBe(true));
    expect(patches().find((p) => p.domain === "example.com")).not.toHaveProperty("pair");
  });

  it("par desligado na caixa: o PATCH leva pair:false", async () => {
    await ateOPasso3ComDominioProprio("example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: /Também deixar www\.example\.com funcionando/ }));
    expect(screen.queryByTestId("dns-row-pair")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Criar projeto$/ }));
    await waitFor(() => expect(patches().some((p) => p.domain === "example.com")).toBe(true));
    expect(patches().find((p) => p.domain === "example.com")).toMatchObject({ pair: false });
  });

  it("subdomínio comum: sem caixa e sem 'pair' no PATCH", async () => {
    await ateOPasso3ComDominioProprio("app.example.com");
    expect(screen.queryByRole("checkbox", { name: /Também deixar/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Criar projeto$/ }));
    await waitFor(() => expect(patches().some((p) => p.domain === "app.example.com")).toBe(true));
    expect(patches().find((p) => p.domain === "app.example.com")).not.toHaveProperty("pair");
  });
});
