/**
 * apps-domain-settings.test.tsx — Configurações → Domínio de aplicações.
 *
 * A API é simulada com estado: digitar a base → ver o registro curinga a
 * criar → "Verificar DNS e salvar" (só salva com o DNS certo) → reconferir →
 * trocar → remover. Nenhum IP real: 203.0.113.x e example.com.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppsDomainDnsCheck, AppsDomainStatus } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { SITE_URL } from "@/lib/links";
import { AppsDomainSettings } from "@/pages/settings/AppsDomainSettings";

const BASE = "apps.example.com";
const PATH = "/api/settings/apps-domain";

let state: AppsDomainStatus;
let dnsOk: boolean;
let nextProblem: AppsDomainDnsCheck["problem"];

function empty(): AppsDomainStatus {
  return {
    mode: "https",
    base: null,
    verified: false,
    needsRecheck: false,
    serverIp: "203.0.113.10",
    serverIpv6: null,
    records: [],
    lastCheck: null,
    projectsUsingBase: 0,
    example: null,
  };
}

function saved(base: string): AppsDomainStatus {
  return {
    ...empty(),
    base,
    verified: true,
    records: [{ type: "A", name: `*.${base}`, value: "203.0.113.10" }],
    example: `meu-projeto-k3x9q.${base}`,
  };
}

function check(base: string, ok: boolean, problem: AppsDomainDnsCheck["problem"], message: string): AppsDomainDnsCheck {
  return { base, probe: `paas-check-abc123.${base}`, ok, problem, ipv4: ok ? ["203.0.113.10"] : [], ipv6: [], expectedIp: "203.0.113.10", message, checkedAt: "2026-10-21T12:00:00Z" };
}

beforeEach(() => {
  state = empty();
  dnsOk = true;
  nextProblem = "missing";
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    if (path === PATH && method === "GET") return state;
    if (path === `${PATH}/verify`) {
      if (body.domain!.includes(";")) throw new ApiRequestError(400, "invalid_domain", "O domínio de aplicações é inválido. Use só letras, números, hífen e ponto (ex.: apps.example.com).");
      const base = body.domain!;
      if (dnsOk) {
        state = saved(base);
        return { check: check(base, true, "ok", `*.${base} aponta para esta VPS (203.0.113.10).`), saved: true, status: state };
      }
      const msg = nextProblem === "cloudflare" ? `*.${base} está com o proxy da Cloudflare ligado (nuvem laranja).` : `paas-check-abc123.${base} não aponta para lugar nenhum.`;
      if (state.base === base) state = { ...state, verified: false, needsRecheck: true };
      return { check: check(base, false, nextProblem, msg), saved: false, status: state };
    }
    if (path === PATH && method === "DELETE") {
      state = empty();
      return state;
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(cleanup);

function renderPage() {
  return render(<AppsDomainSettings />, { wrapper: MemoryRouter });
}

const input = () => screen.getByLabelText(/Domínio de aplicações$/) as HTMLInputElement;

describe("Configurações → Domínio de aplicações", () => {
  it("sem base: explica o ganho, mostra o campo e NÃO mostra registro antes de digitar", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: /Domínio de aplicações/ })).toBeInTheDocument();
    expect(screen.getByText(/sem o IP da VPS/)).toBeInTheDocument();
    expect(screen.queryByTestId("apps-dns-record")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verificar DNS e salvar/ })).toBeDisabled();
  });

  it("digitar a base mostra o registro curinga a criar (normalizado), com o IP da VPS e a nuvem cinza", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: "  https://Apps.Example.com/ " } });
    const record = screen.getByTestId("apps-dns-record");
    expect(record).toHaveTextContent("A");
    expect(record).toHaveTextContent(`*.${BASE}`);
    expect(record).toHaveTextContent("203.0.113.10");
    expect(record).not.toHaveTextContent("AAAA");
    expect(screen.getByText(/nuvem cinza/)).toBeInTheDocument();
    expect(screen.getByText(/só a parte antes dele/)).toBeInTheDocument();
  });

  it("curinga digitado pela pessoa vira só a base na pré-visualização", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: "*.apps.example.com" } });
    expect(screen.getByTestId("apps-dns-record")).toHaveTextContent(`*.${BASE}`);
    expect(screen.getByTestId("apps-dns-record")).not.toHaveTextContent(`*.*.`);
  });

  it("com IPv6 público informado, o registro AAAA também é mostrado", async () => {
    state = { ...empty(), serverIpv6: "2001:db8::1" };
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: BASE } });
    const record = screen.getByTestId("apps-dns-record");
    expect(record).toHaveTextContent("AAAA");
    expect(record).toHaveTextContent("2001:db8::1");
  });

  it("DNS certo: salva, mostra 'Verificado', o exemplo do endereço e o resultado como status", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: BASE } });
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS e salvar/ }));
    const result = await screen.findByTestId("apps-dns-result");
    expect(result).toHaveAttribute("role", "status");
    expect(result).toHaveTextContent(/aponta para esta VPS/);
    expect(await screen.findByTestId("apps-current")).toHaveTextContent(BASE);
    expect(screen.getByText("Verificado")).toBeInTheDocument();
    expect(screen.getByTestId("apps-example")).toHaveTextContent(`meu-projeto-k3x9q.${BASE}`);
    expect(apiFetchMock).toHaveBeenCalledWith(`${PATH}/verify`, expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: BASE }) }));
  });

  it("DNS errado: NÃO salva, mostra o motivo em âmbar (com ícone e texto, não só cor) e permite tentar de novo", async () => {
    dnsOk = false;
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: BASE } });
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS e salvar/ }));
    const result = await screen.findByTestId("apps-dns-result");
    expect(result).toHaveAttribute("role", "status");
    expect(result).toHaveTextContent(/não aponta para lugar nenhum/);
    expect(within(result).getByText(/Não foi salvo/)).toBeInTheDocument();
    expect(screen.queryByTestId("apps-current")).not.toBeInTheDocument();
    dnsOk = true;
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS e salvar/ }));
    expect(await screen.findByTestId("apps-current")).toBeInTheDocument();
  });

  it("proxy da Cloudflare: a mensagem do servidor aparece", async () => {
    dnsOk = false;
    nextProblem = "cloudflare";
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: BASE } });
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS e salvar/ }));
    expect(await screen.findByTestId("apps-dns-result")).toHaveTextContent(/Cloudflare/);
  });

  it("base recusada pelo servidor (hostil): mostra o motivo como alerta e não salva", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    fireEvent.change(input(), { target: { value: "apps.example.com;rm" } });
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS e salvar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/domínio de aplicações é inválido/);
    expect(screen.queryByTestId("apps-current")).not.toBeInTheDocument();
  });

  it("falha de rede ao verificar: mensagem padrão em alerta", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    apiFetchMock.mockImplementationOnce(async () => {
      throw new Error("rede");
    });
    fireEvent.change(input(), { target: { value: BASE } });
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS e salvar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível verificar o DNS/);
  });

  it("base salva e verificada: mostra o registro, reconfere e remove com confirmação (avisa dos projetos)", async () => {
    state = { ...saved(BASE), projectsUsingBase: 2 };
    renderPage();
    expect(await screen.findByTestId("apps-current")).toHaveTextContent(BASE);
    expect(screen.getByTestId("apps-dns-record")).toHaveTextContent(`*.${BASE}`);
    fireEvent.click(screen.getByRole("button", { name: /Remover/ }));
    const confirm = screen.getByTestId("apps-remove-confirm");
    expect(confirm).toHaveTextContent(/2 projetos/);
    expect(confirm).toHaveTextContent(/continuam funcionando/);
    fireEvent.click(within(confirm).getByRole("button", { name: /Sim, remover/ }));
    await waitFor(() => expect(screen.queryByTestId("apps-current")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(PATH, expect.objectContaining({ method: "DELETE" }));
  });

  it("cancelar a remoção não chama a API", async () => {
    state = saved(BASE);
    renderPage();
    await screen.findByTestId("apps-current");
    fireEvent.click(screen.getByRole("button", { name: /Remover/ }));
    fireEvent.click(within(screen.getByTestId("apps-remove-confirm")).getByRole("button", { name: /Cancelar/ }));
    expect(screen.queryByTestId("apps-remove-confirm")).not.toBeInTheDocument();
    expect(apiFetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("a conferir (VPS com outro IP): aviso âmbar com o IP novo; reconferir volta ao normal", async () => {
    state = { ...saved(BASE), verified: false, needsRecheck: true, serverIp: "198.51.100.20", records: [{ type: "A", name: `*.${BASE}`, value: "198.51.100.20" }] };
    renderPage();
    const warn = await screen.findByTestId("apps-recheck");
    expect(warn).toHaveAttribute("role", "status");
    expect(warn).toHaveTextContent(/198\.51\.100\.20/);
    expect(screen.getByText("A conferir")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS de novo/ }));
    await waitFor(() => expect(screen.queryByTestId("apps-recheck")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(`${PATH}/verify`, expect.objectContaining({ body: JSON.stringify({ domain: BASE }) }));
  });

  it("trocar a base: o campo vem preenchido com a atual e o aviso diz que os projetos antigos não mudam", async () => {
    state = saved(BASE);
    renderPage();
    await screen.findByTestId("apps-current");
    fireEvent.click(screen.getByRole("button", { name: /Trocar/ }));
    expect(input().value).toBe(BASE);
    expect(screen.getByText(/projetos que já usam/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(screen.getByTestId("apps-current")).toBeInTheDocument();
  });

  it("modo túnel: explica que não há o que configurar e não mostra o formulário", async () => {
    state = { ...empty(), mode: "tunnel", serverIp: null };
    renderPage();
    expect(await screen.findByTestId("apps-tunnel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verificar DNS e salvar/ })).not.toBeInTheDocument();
  });

  it("erro ao carregar: alerta", async () => {
    apiFetchMock.mockImplementationOnce(async () => {
      throw new Error("falhou");
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível consultar/);
  });

  it("mostra o limite do Let's Encrypt e o link do guia (endereço do site por links.ts, no idioma da interface)", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /Domínio de aplicações/ });
    expect(screen.getByText(/50 certificados por semana/)).toBeInTheDocument();
    const guide = screen.getByRole("link", { name: /guia/i });
    expect(guide).toHaveAttribute("href", `${SITE_URL}/pt-br/getting-started/complete-guide/#dominio-de-aplicacoes`);
    expect(guide).toHaveAttribute("target", "_blank");
    expect(guide.getAttribute("rel")).toContain("noopener");
  });

  it("em inglês: rótulos do glossário e link do guia em /en/", async () => {
    setLocale("en", { persist: false });
    state = { ...saved(BASE), projectsUsingBase: 1 };
    renderPage();
    expect(await screen.findByRole("heading", { name: /Apps domain/ })).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /guide/i })).toHaveAttribute("href", `${SITE_URL}/en/getting-started/complete-guide/#dominio-de-aplicacoes`);
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(screen.getByTestId("apps-remove-confirm")).toHaveTextContent(/1 project/);
  });
});
