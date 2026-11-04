/**
 * project-domains-pair.test.tsx — Domínios do projeto: o par (com/sem www) de cada domínio, em que
 * pé está (redirecionando, aguardando o DNS, desligado, em uso por outro projeto), ligar/desligar,
 * e a conexão de um domínio novo com a escolha do par e a verificação por nome.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectDomainPair } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";
import { setLocale } from "../src/i18n";

const PROJECT = {
  id: "p1",
  name: "site",
  slug: "site",
  domain: "example.com",
  aliases: ["loja.example.org"],
  lastDeployStatus: "success",
  detection: { type: "dockerfile" },
  updatedAt: "2026-10-22T00:00:00.000Z",
} as unknown as Project;

let pairs: ProjectDomainPair[];
let pairsFails = false;

function row(over: Partial<ProjectDomainPair> = {}): ProjectDomainPair {
  return { domain: "example.com", pair: "www.example.com", role: "www", enabled: true, state: "missing", active: false, ...over };
}

beforeEach(() => {
  pairs = [row()];
  pairsFails = false;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/projects/p1/domains/pairs") {
      if (pairsFails) throw new Error("falhou");
      return { pairs };
    }
    if (path.startsWith("/api/domains/check")) {
      return {
        domain: "example.net", devLocal: false, ok: true, state: "pointed", resolvedIps: ["203.0.113.10"], machineIps: [], message: "ok",
        pair: { domain: "www.example.net", role: "www", ok: false, state: "elsewhere", resolvedIps: ["198.51.100.7"], message: "" },
      };
    }
    if (path.startsWith("/api/domains/suggest")) return { auto: "x.localhost", panelPublic: false };
    if (path === "/api/projects/p1/domains" && init?.method === "POST") return { project: PROJECT };
    if (path.endsWith("/pair") && init?.method === "PUT") return { project: PROJECT };
    return {};
  });
});
afterEach(cleanup);

describe("ProjectDomainsCard — par com/sem www", () => {
  it("mostra o par do domínio que tem par e nenhum para o que não tem", async () => {
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const linha = await screen.findByTestId("pair-example.com");
    expect(linha).toHaveTextContent("www.example.com");
    expect(linha).toHaveTextContent("→ redireciona para example.com");
    expect(screen.queryByTestId("pair-loja.example.org")).not.toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains/pairs");
  });

  it("cada situação, com texto (não só cor)", async () => {
    const casos: Array<[Partial<ProjectDomainPair>, RegExp]> = [
      [{ state: "pointed", active: true }, /redirecionando/],
      [{ state: "pointed", active: false }, /o DNS já aponta, o redirecionamento começa em instantes/],
      [{ state: "missing" }, /aguardando o DNS/],
      [{ state: "elsewhere" }, /aponta para outro lugar/],
      [{ state: "cloudflare" }, /Cloudflare em modo proxy \(nuvem laranja\)/],
      [{ state: "unavailable" }, /o DNS não respondeu agora/],
      [{ enabled: false }, /desligado/],
      [{ occupiedBy: "other_project" }, /já é de outro projeto: sem redirecionamento/],
      [{ occupiedBy: "panel" }, /é do painel/],
      [{ occupiedBy: "mail" }, /é do servidor de e-mail: sem redirecionamento/],
      [{ occupiedBy: "same_project" }, /já conectado a este projeto/],
    ];
    for (const [over, texto] of casos) {
      pairs = [row(over)];
      const { unmount } = render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
      expect(await screen.findByTestId("pair-example.com")).toHaveTextContent(texto);
      unmount();
    }
  });

  it("par em uso por outro projeto não tem botão de ligar/desligar", async () => {
    pairs = [row({ occupiedBy: "other_project" })];
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const linha = await screen.findByTestId("pair-example.com");
    expect(within(linha).queryByRole("button")).not.toBeInTheDocument();
  });

  it("desligar e ligar mandam PUT com o booleano e recarregam", async () => {
    const onChanged = vi.fn();
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    const linha = await screen.findByTestId("pair-example.com");
    fireEvent.click(within(linha).getByRole("button", { name: "Desligar o redirecionamento de www.example.com" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/domains/example.com/pair",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) }),
    );
  });

  it("par desligado oferece 'Ligar'", async () => {
    pairs = [row({ enabled: false })];
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const linha = await screen.findByTestId("pair-example.com");
    fireEvent.click(within(linha).getByRole("button", { name: "Ligar o redirecionamento de www.example.com" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/domains/example.com/pair",
        expect.objectContaining({ body: JSON.stringify({ enabled: true }) }),
      ),
    );
  });

  it("erro ao mudar o par: mostra o aviso e não recarrega", async () => {
    const onChanged = vi.fn();
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/domains/pairs") return { pairs };
      if (init?.method === "PUT") throw new Error("falhou");
      return {};
    });
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    const linha = await screen.findByTestId("pair-example.com");
    fireEvent.click(within(linha).getByRole("button", { name: "Desligar o redirecionamento de www.example.com" }));
    expect(await within(linha).findByRole("alert")).toHaveTextContent(/Não foi possível alterar o domínio/);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a situação dos pares não carrega: o cartão segue sem as linhas do par", async () => {
    pairsFails = true;
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    expect(await screen.findByTestId("domain-example.com")).toBeInTheDocument();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains/pairs"));
    expect(screen.queryByTestId("pair-example.com")).not.toBeInTheDocument();
  });

  it("resposta sem a lista de pares é tratada como vazia", async () => {
    apiFetchMock.mockImplementation(async () => ({}));
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    expect(await screen.findByTestId("domain-example.com")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-example.com")).not.toBeInTheDocument();
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    pairs = [row({ state: "pointed", active: true })];
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const linha = await screen.findByTestId("pair-example.com");
    expect(linha).toHaveTextContent("→ redirects to example.com");
    expect(linha).toHaveTextContent("redirecting");
    expect(within(linha).getByRole("button", { name: "Turn off the redirect from www.example.com" })).toBeInTheDocument();
  });
});

describe("ProjectDomainsCard — conectar um domínio novo", () => {
  async function abrir(domain: string) {
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Conectar novo domínio/ }));
    fireEvent.change(screen.getByLabelText(/Novo domínio/), { target: { value: domain } });
  }

  it("a orientação traz os dois nomes e o Verificar DNS mostra o resultado de cada um (par que falha é aviso)", async () => {
    await abrir("example.net");
    expect(screen.getByTestId("dns-row-canonical")).toHaveTextContent("example.net");
    expect(screen.getByTestId("dns-row-pair")).toHaveTextContent("www.example.net");
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    await waitFor(() => expect(screen.getByTestId("dns-state-pair")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/domains/check?domain=example.net&project=p1");
    expect(screen.getByTestId("dns-state-canonical")).toHaveAttribute("data-state", "pointed");
    expect(screen.getByTestId("dns-state-pair")).toHaveAttribute("data-state", "elsewhere");
    expect(screen.getByTestId("dns-state-pair")).toHaveTextContent(/198\.51\.100\.7/);
    // o aviso do par não impede conectar o principal
    expect(screen.getByRole("button", { name: /^Conectar$/ })).toBeEnabled();
  });

  it("Unicode digitado: o guia mostra punycode com legenda e Verificar/Conectar mandam o nome em punycode", async () => {
    await abrir("Exämple.net");
    expect(screen.getByTestId("dns-guide-punycode")).toHaveTextContent("xn--exmple-cua.net");
    expect(screen.getByTestId("dns-row-canonical")).toHaveTextContent("xn--exmple-cua.net");
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/domains/check?domain=xn--exmple-cua.net&project=p1"));
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/domains",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: "xn--exmple-cua.net" }) }),
      ),
    );
  });

  it("texto que não é um nome (com Unicode) vai como digitado, para o servidor responder 400", async () => {
    await abrir("exä:80@mple.net");
    expect(screen.queryByTestId("dns-guide-punycode")).not.toBeInTheDocument();
  });

  it("conectar com o par ligado manda só o domínio; desligado manda pair:false", async () => {
    await abrir("Example.NET");
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains", expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: "example.net" }) })),
    );
    cleanup();
    await abrir("example.net");
    fireEvent.click(screen.getByRole("checkbox", { name: /Também deixar www\.example\.net funcionando/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/domains",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: "example.net", pair: false }) }),
      ),
    );
  });

  it("subdomínio comum: sem caixa do par", async () => {
    await abrir("app.example.net");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dns-row-pair")).not.toBeInTheDocument();
  });

  it("resposta antiga do servidor (sem 'state'): a mensagem de sempre continua aparecendo", async () => {
    apiFetchMock.mockImplementation(async (path: string) =>
      path.startsWith("/api/domains/check") ? { ok: false, message: "O domínio não aponta para esta máquina." } : { pairs: [] },
    );
    await abrir("app.example.net");
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    expect(await screen.findByText(/não aponta para esta máquina/)).toBeInTheDocument();
  });
});
