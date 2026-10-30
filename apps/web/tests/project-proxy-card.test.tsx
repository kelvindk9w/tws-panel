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
  headers: ["X-Forwarded-For", "X-Forwarded-Proto"],
  compose: true,
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
    expect(within(subnet).getByText(/vizinho comprometido/)).toBeInTheDocument();
    expect(within(screen.getByTestId("proxy-ip")).getByText(/recomendado/)).toBeInTheDocument();
    fireEvent.click(within(subnet).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("172.20.0.0/16"));
    fireEvent.click(within(screen.getByTestId("proxy-ip")).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("172.20.0.2"));
    fireEvent.click(within(screen.getByTestId("proxy-upstream")).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("loja:3000"));
    const headers = screen.getByTestId("proxy-headers");
    expect(within(headers).getByText("X-Forwarded-For")).toBeInTheDocument();
    expect(within(headers).getByText("IP do visitante")).toBeInTheDocument();
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

  it("a frase sobre compose só aparece em projeto compose", () => {
    const { unmount } = render(<ProjectProxyCard proxy={PROXY} />);
    expect(screen.getByTestId("proxy-variables")).toHaveTextContent("Em projeto compose");
    unmount();
    render(<ProjectProxyCard proxy={{ ...PROXY, compose: false }} />);
    expect(screen.getByTestId("proxy-variables")).not.toHaveTextContent("Em projeto compose");
  });

  it("site estático: explica que não recebe variáveis de execução", () => {
    render(<ProjectProxyCard proxy={{ ...PROXY, delivered: false }} />);
    expect(screen.getByTestId("proxy-variables")).toHaveTextContent("Site estático não recebe variáveis de execução.");
  });

  it("em inglês", () => {
    setLocale("en", { persist: false });
    render(<ProjectProxyCard proxy={PROXY} />);
    expect(screen.getByText("Network and proxy")).toBeInTheDocument();
    // as descrições dos cabeçalhos vêm do idioma da tela, não do servidor
    expect(screen.getByText("visitor's IP")).toBeInTheDocument();
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

describe("PAAS_PROXY_* citadas pelo compose", () => {
  it("aparecem como fornecidas pelo painel (com valor), entram no filtro e não ficam como faltando", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/email")) return { email: null };
      return {
        vars: [],
        compose: { variables: [{ name: "PAAS_PROXY_IP", required: true, defaultValue: null }] },
        provided: ["PAAS_PROXY_IP"],
        providedValues: { PAAS_PROXY_IP: "172.20.0.2" },
        links: {},
        example: null,
        proxy: PROXY,
      };
    });
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    const line = await screen.findByTestId("env-panel-PAAS_PROXY_IP");
    expect(line).toHaveTextContent("vem da rede do painel");
    expect(line).not.toHaveTextContent("E-mail do projeto");
    expect(screen.queryByTestId("env-missing-banner")).toBeNull();
  });
});
