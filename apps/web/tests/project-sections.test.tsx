/**
 * project-sections.test.tsx — seções Domínios e Variáveis do projeto.
 *
 * Domínios (validação real): para testar devlink.tws.tec.br era preciso
 * editar o domínio atual; agora o projeto tem vários domínios, com "Conectar
 * novo domínio" (registro de DNS exato + verificação), tornar principal e
 * remover. Variáveis: nome/valor, valores escondidos por padrão.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";
import { ProjectEnvCard } from "@/components/ProjectEnvCard";

const PROJECT = {
  id: "p1",
  name: "devLink",
  slug: "devlink",
  domain: "devlink.203-0-113-10.sslip.io",
  aliases: ["devlink.tws.tec.br"],
  lastDeployStatus: "success",
  detection: { type: "dockerfile" },
} as unknown as Project;

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("ProjectDomainsCard", () => {
  it("lista o principal e os adicionais, cada um com link", () => {
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const principal = screen.getByTestId("domain-devlink.203-0-113-10.sslip.io");
    expect(principal).toHaveTextContent(/principal/i);
    expect(within(principal).getByRole("link")).toHaveAttribute("href", "https://devlink.203-0-113-10.sslip.io");
    expect(screen.getByTestId("domain-devlink.tws.tec.br")).toBeInTheDocument();
  });

  it("conectar novo domínio: mostra o registro A com o IP da VPS e conecta", async () => {
    const onChanged = vi.fn();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/domains/check")) return { ok: true, message: "O domínio aponta para esta máquina." };
      if (path === "/api/projects/p1/domains") return { project: PROJECT };
      throw new Error(path);
    });
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Conectar novo domínio/ }));
    fireEvent.change(screen.getByLabelText(/Novo domínio/), { target: { value: "www.devlink.com.br" } });
    const guia = screen.getByTestId("dns-guide");
    expect(guia).toHaveTextContent("www.devlink.com.br");
    expect(guia).toHaveTextContent("203.0.113.10");
    // Cloudflare: nuvem cinza (validação real — dúvida do dono do produto)
    expect(within(guia).getByTestId("dns-guide-cloudflare")).toHaveTextContent(/nuvem .*cinza/i);
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    expect(await screen.findByText(/aponta para esta máquina/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains", expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: "www.devlink.com.br" }) }));
  });

  it("tornar principal e remover um adicional", async () => {
    const onChanged = vi.fn();
    apiFetchMock.mockResolvedValue({ project: PROJECT });
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    const extra = screen.getByTestId("domain-devlink.tws.tec.br");
    fireEvent.click(within(extra).getByRole("button", { name: /Tornar principal/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains/devlink.tws.tec.br/primary", expect.objectContaining({ method: "POST" })));
    fireEvent.click(within(extra).getByRole("button", { name: /Remover/ }));
    fireEvent.click(within(extra).getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains/devlink.tws.tec.br", expect.objectContaining({ method: "DELETE" })));
    // o principal não tem "Remover"
    expect(within(screen.getByTestId("domain-devlink.203-0-113-10.sslip.io")).queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
  });
});

describe("ProjectEnvCard", () => {
  it("carrega, esconde os valores, adiciona e salva a lista", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/env" && (!init || !init.method)) return { vars: [{ key: "NODE_ENV", value: "production" }] };
      if (path === "/api/projects/p1/env" && init?.method === "PUT") return JSON.parse(String(init.body));
      throw new Error(path);
    });
    render(<ProjectEnvCard project={PROJECT} />);
    const valor = (await screen.findByDisplayValue("production")) as HTMLInputElement;
    expect(valor.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    const nomes = screen.getAllByPlaceholderText("NOME_DA_VARIAVEL");
    fireEvent.change(nomes[1]!, { target: { value: "DATABASE_URL" } });
    fireEvent.change(screen.getAllByPlaceholderText("valor")[1]!, { target: { value: "postgres://x" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/env",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ vars: [{ key: "NODE_ENV", value: "production" }, { key: "DATABASE_URL", value: "postgres://x" }] }),
        }),
      ),
    );
    expect(await screen.findByText(/próximo deploy/i)).toBeInTheDocument();
  });

  it("site estático: avisa que não há servidor para ler as variáveis", async () => {
    apiFetchMock.mockResolvedValue({ vars: [] });
    render(<ProjectEnvCard project={{ ...PROJECT, detection: { type: "static" } } as unknown as Project} />);
    expect(await screen.findByTestId("env-static-note")).toBeInTheDocument();
  });
});
