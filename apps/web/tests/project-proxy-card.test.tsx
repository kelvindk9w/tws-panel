/**
 * Cartão "Rede e proxy" da seção Variáveis: IP do Caddy, sub-rede, cabeçalhos do visitante e o nome do app na rede,
 * cada um com botão de copiar; variáveis PAAS_PROXY_* explicadas; valores indisponíveis e site estático.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectProxyInfo } from "@paas/core";
import { MemoryRouter } from "react-router";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { ProjectProxyCard } from "@/components/project/ProjectProxyCard";
import { setLocale } from "../src/i18n";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "dockerfile" } } as unknown as Project;

const PROXY: ProjectProxyInfo = {
  network: "paas-net",
  ip: "172.20.0.2",
  subnet: "172.20.0.0/16",
  headers: [
    { name: "X-Forwarded-For", description: "IP do visitante" },
    { name: "X-Forwarded-Proto", description: "http ou https" },
  ],
  upstream: "loja:3000",
  variables: ["PAAS_PROXY_IP", "PAAS_PROXY_SUBNET"],
  overridden: [],
  delivered: true,
};

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  apiFetchMock.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  setLocale("pt-BR", { persist: false });
});
afterEach(() => cleanup());

describe("ProjectProxyCard", () => {
  it("mostra cada valor com botão de copiar", async () => {
    render(<ProjectProxyCard proxy={PROXY} />);
    expect(screen.getByText("Rede e proxy")).toBeInTheDocument();
    const subnet = screen.getByTestId("proxy-subnet");
    expect(within(subnet).getByText("172.20.0.0/16")).toBeInTheDocument();
    expect(within(subnet).getByText(/proxies confiáveis/)).toBeInTheDocument();
    fireEvent.click(within(subnet).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("172.20.0.0/16"));
    fireEvent.click(within(screen.getByTestId("proxy-ip")).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("172.20.0.2"));
    fireEvent.click(within(screen.getByTestId("proxy-upstream")).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("loja:3000"));
    const headers = screen.getByTestId("proxy-headers");
    expect(within(headers).getByText("X-Forwarded-For")).toBeInTheDocument();
    fireEvent.click(within(headers).getAllByRole("button")[1]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("X-Forwarded-Proto"));
    expect(screen.getByTestId("proxy-variables")).toHaveTextContent("PAAS_PROXY_IP, PAAS_PROXY_SUBNET");
  });

  it("valor indisponível: avisa em vez de mostrar vazio, sem botão de copiar", () => {
    render(<ProjectProxyCard proxy={{ ...PROXY, ip: null, subnet: null, overridden: ["PAAS_PROXY_IP"] }} />);
    const ip = screen.getByTestId("proxy-ip");
    expect(within(ip).getByText(/indisponível agora/)).toBeInTheDocument();
    expect(within(ip).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("proxy-variables")).toHaveTextContent("Sobrescrita por você nas Variáveis: PAAS_PROXY_IP");
  });

  it("site estático: explica que não recebe variáveis de execução", () => {
    render(<ProjectProxyCard proxy={{ ...PROXY, delivered: false }} />);
    expect(screen.getByTestId("proxy-variables")).toHaveTextContent("Site estático não recebe variáveis de execução.");
  });

  it("em inglês", () => {
    setLocale("en", { persist: false });
    render(<ProjectProxyCard proxy={PROXY} />);
    expect(screen.getByText("Network and proxy")).toBeInTheDocument();
  });
});

describe("ProjectEnvCard com o cartão", () => {
  function serve(proxy: ProjectProxyInfo | undefined) {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/email")) return { email: null };
      return { vars: [], compose: null, provided: [], providedValues: {}, links: {}, example: null, ...(proxy ? { proxy } : {}) };
    });
  }

  it("aparece na seção Variáveis quando o servidor informa", async () => {
    serve(PROXY);
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("env-proxy-card")).toBeInTheDocument();
  });

  it("sem a informação, a seção continua sem o cartão", async () => {
    serve(undefined);
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    await screen.findByTestId("env-footer");
    expect(screen.queryByTestId("env-proxy-card")).toBeNull();
  });
});
