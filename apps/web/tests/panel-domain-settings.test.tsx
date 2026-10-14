/**
 * panel-domain-settings.test.tsx — Configurações → Domínio do painel.
 *
 * A API é simulada com estado (cadastrar → verificar → certificado → abrir
 * pelo domínio novo → desativar o IP → reativar → remover). O endereço da
 * página vem de @/lib/page-location (o jsdom sempre roda em localhost).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CertificateItem, PanelDomainDnsCheck, PanelDomainStatus } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
const hostMock = vi.hoisted(() => ({ hostname: "203-0-113-10.sslip.io" }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
vi.mock("@/lib/page-location", () => ({
  pageLocation: () => ({ protocol: "https:", hostname: hostMock.hostname, port: "", pathname: "/settings/panel-domain", search: "" }),
}));

import { ApiRequestError } from "@/lib/api";
import { PanelDomainSettings } from "@/pages/settings/PanelDomainSettings";

const IP = "203-0-113-10.sslip.io";
const D = "painel.exemplo.com.br";

let state: PanelDomainStatus;
let dnsOk: boolean;
let certState: CertificateItem["state"];

function cert(): CertificateItem {
  return {
    host: D,
    owner: { kind: "panel", projectId: null, projectName: null },
    mode: "automatic",
    coveredBy: null,
    state: certState,
    issuer: certState === "valid" ? "Let's Encrypt" : null,
    validTo: certState === "valid" ? "2027-01-05T00:00:00Z" : null,
    renewsAround: null,
    lastError: null,
    manual: null,
    canRetry: certState !== "valid",
  };
}

function base(): PanelDomainStatus {
  return {
    mode: "https",
    ipAddress: IP,
    ipAccessDisabled: false,
    serverIp: "203.0.113.10",
    domain: null,
    domainActive: false,
    lastCheck: null,
    certificate: null,
    addresses: [IP],
    currentHost: IP,
    openedVia: "ip",
    disableIp: { allowed: false, blockers: ["Cadastre o domínio do painel primeiro."] },
    reactivateCommand: "cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh",
    configFile: "/data/panel-domain.json (volume Docker paas_data)",
  };
}

function refresh(): PanelDomainStatus {
  const opened = hostMock.hostname;
  const certificate = state.domainActive ? cert() : null;
  const valid = certificate?.state === "valid";
  const blockers: string[] = [];
  if (!state.ipAccessDisabled && state.domainActive) {
    if (!valid) blockers.push(`O certificado HTTPS de ${D} ainda não está válido.`);
    if (opened !== D) blockers.push(`Abra o painel pelo endereço novo (https://${D}), entre de novo e volte a esta tela: o botão só funciona lá.`);
  }
  state = {
    ...state,
    certificate,
    currentHost: opened,
    openedVia: opened === D ? "domain" : opened === IP ? "ip" : "other",
    addresses: state.domainActive ? (state.ipAccessDisabled ? [D] : [D, IP]) : [IP],
    disableIp: { allowed: state.domainActive && !state.ipAccessDisabled && blockers.length === 0, blockers },
  };
  return state;
}

beforeEach(() => {
  hostMock.hostname = IP;
  state = base();
  dnsOk = false;
  certState = "issuing";
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    if (path === "/api/settings/panel-domain" && method === "GET") return refresh();
    if (path === "/api/settings/panel-domain" && method === "PUT") {
      if (body.domain === "203.0.113.10") throw new ApiRequestError(400, "invalid_domain", "Informe um nome de domínio, não um IP.");
      state = { ...state, domain: body.domain!, domainActive: false, ipAccessDisabled: false, lastCheck: null };
      return refresh();
    }
    if (path === "/api/settings/panel-domain" && method === "DELETE") {
      state = { ...base() };
      return refresh();
    }
    if (path === "/api/settings/panel-domain/verify") {
      const check: PanelDomainDnsCheck = {
        domain: D,
        ok: dnsOk,
        problem: dnsOk ? "ok" : "missing",
        ipv4: dnsOk ? ["203.0.113.10"] : [],
        ipv6: [],
        expectedIp: "203.0.113.10",
        message: dnsOk ? `${D} aponta para esta VPS (203.0.113.10).` : `${D} ainda não aponta para lugar nenhum.`,
        checkedAt: "2026-10-07T12:00:00Z",
      };
      state = { ...state, lastCheck: check, domainActive: state.domainActive || dnsOk };
      return { check, status: refresh() };
    }
    if (path === "/api/settings/panel-domain/disable-ip") {
      expect(body.confirm).toBe(D);
      state = { ...state, ipAccessDisabled: true };
      return refresh();
    }
    if (path === "/api/settings/panel-domain/enable-ip") {
      state = { ...state, ipAccessDisabled: false };
      return refresh();
    }
    if (path === `/api/certificates/${encodeURIComponent(D)}/retry`) {
      if (certState === "valid") {
        throw new ApiRequestError(409, "already_valid", `O certificado de ${D} já está válido e o painel renova sozinho perto do fim.`);
      }
      return { host: D, message: "Pedimos ao proxy que tente emitir o certificado agora." };
    }
    if (path === `/api/certificates?host=${encodeURIComponent(D)}`) {
      return { checkedAt: "2026-10-07T12:00:00Z", proxyRunning: true, items: [cert()] };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

const statusCalls = () =>
  apiFetchMock.mock.calls.filter(([p, init]) => p === "/api/settings/panel-domain" && !(init as RequestInit | undefined)?.method).length;

function renderPage() {
  return render(<PanelDomainSettings />, { wrapper: MemoryRouter });
}

describe("Configurações → Domínio do painel", () => {
  it("sem domínio: mostra o endereço atual (com o IP no nome) e cadastra o domínio, mostrando o registro A", async () => {
    renderPage();
    expect(await screen.findByTestId("panel-addresses")).toHaveTextContent(IP);
    fireEvent.change(screen.getByLabelText(/Domínio do painel/), { target: { value: D } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar domínio/ }));
    const record = await screen.findByTestId("dns-record");
    expect(record).toHaveTextContent("A");
    expect(record).toHaveTextContent(D);
    expect(record).toHaveTextContent("203.0.113.10");
    expect(screen.getByText(/nuvem cinza/)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/settings/panel-domain", expect.objectContaining({ method: "PUT" }));
  });

  it("domínio recusado: mostra o motivo", async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Domínio do painel/), { target: { value: "203.0.113.10" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar domínio/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/não um IP/);
  });

  it("Verificar DNS: errado mostra o que fazer; certo ativa e passa a acompanhar o certificado", async () => {
    state = { ...base(), domain: D };
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Verificar DNS/ }));
    expect(await screen.findByTestId("dns-result")).toHaveTextContent(/ainda não aponta/);
    dnsOk = true;
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    expect(await screen.findByTestId(`cert-${D}`)).toHaveTextContent("Emitindo");
    expect(screen.getByRole("button", { name: /Tentar emitir agora/ })).toBeInTheDocument();
    expect(screen.getByTestId("panel-addresses")).toHaveTextContent(D);
    expect(screen.getByTestId("panel-addresses")).toHaveTextContent(IP);
    expect(screen.queryByRole("link", { name: /Abrir o painel pelo endereço novo/ })).not.toBeInTheDocument();
  });

  it("certificado válido, aberto pelo IP: link para o endereço novo, aviso de entrar de novo e o botão de desativar travado", async () => {
    state = { ...base(), domain: D, domainActive: true };
    certState = "valid";
    renderPage();
    const link = await screen.findByRole("link", { name: /Abrir o painel pelo endereço novo/ });
    expect(link).toHaveAttribute("href", `https://${D}/settings/panel-domain`);
    expect(screen.getByText(/entrar de novo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Desativar o acesso pelo IP/ })).toBeDisabled();
    expect(screen.getByTestId("disable-ip-blockers")).toHaveTextContent(`https://${D}`);
    expect(screen.getByTestId("reactivate-command")).toHaveTextContent("sudo ./scripts/reativar-acesso-ip.sh");
  });

  it("aberto pelo domínio novo: desativa com confirmação forte (digitar o domínio) e reativa", async () => {
    hostMock.hostname = D;
    state = { ...base(), domain: D, domainActive: true };
    certState = "valid";
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Desativar o acesso pelo IP/ }));
    const confirm = screen.getByTestId("disable-ip-confirm");
    expect(within(confirm).getByTestId("reactivate-command")).toBeInTheDocument();
    const go = within(confirm).getByRole("button", { name: /Desativar agora/ });
    expect(go).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(/Digite/), { target: { value: "painel.exemplo" } });
    expect(go).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(/Digite/), { target: { value: D } });
    fireEvent.click(go);
    expect(await screen.findByRole("button", { name: /Reativar o acesso pelo IP/ })).toBeInTheDocument();
    expect(screen.getByTestId("panel-addresses")).not.toHaveTextContent(IP);
    fireEvent.click(screen.getByRole("button", { name: /Reativar o acesso pelo IP/ }));
    await waitFor(() => expect(screen.getByTestId("panel-addresses")).toHaveTextContent(IP));
  });

  it("servidor libera mas o navegador não está no domínio novo: o botão continua travado", async () => {
    hostMock.hostname = "localhost";
    state = { ...base(), domain: D, domainActive: true };
    certState = "valid";
    // servidor (por engano de proxy) diz que pode
    apiFetchMock.mockImplementationOnce(async () => ({ ...refresh(), disableIp: { allowed: true, blockers: [] } }));
    renderPage();
    expect(await screen.findByRole("button", { name: /Desativar o acesso pelo IP/ })).toBeDisabled();
  });

  it("remover o domínio pede confirmação e avisa que o IP volta", async () => {
    state = { ...base(), domain: D, domainActive: true, ipAccessDisabled: true };
    hostMock.hostname = D;
    certState = "valid";
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Remover domínio/ }));
    expect(screen.getByTestId("remove-confirm")).toHaveTextContent(`https://${IP}`);
    fireEvent.click(screen.getByRole("button", { name: /Sim, remover/ }));
    expect(await screen.findByLabelText(/Domínio do painel/)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/settings/panel-domain", expect.objectContaining({ method: "DELETE" }));
  });

  it("trocar o domínio abre o formulário já preenchido; cancelar volta", async () => {
    state = { ...base(), domain: D };
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Trocar domínio/ }));
    expect(screen.getByLabelText(/Domínio do painel/)).toHaveValue(D);
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(screen.queryByLabelText(/Domínio do painel/)).not.toBeInTheDocument();
  });

  it("modo túnel: explica que não há endereço público e como mudar para HTTPS, sem formulário", async () => {
    state = { ...base(), mode: "tunnel", ipAddress: null, serverIp: null, addresses: [] };
    apiFetchMock.mockImplementationOnce(async () => state);
    renderPage();
    expect(await screen.findByTestId("tunnel-mode")).toHaveTextContent(/túnel SSH/);
    expect(screen.getByTestId("tunnel-mode")).toHaveTextContent("--acesso=https");
    expect(screen.queryByLabelText(/Domínio do painel/)).not.toBeInTheDocument();
  });

  // Validação real (07/10/2026): o certificado ficou válido e a tela seguiu em
  // "Emitindo" até recarregar a página.
  it("certificado emitindo: a tela consulta sozinha e, quando fica válido, atualiza tudo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state = { ...base(), domain: D, domainActive: true };
    renderPage();
    expect(await screen.findByTestId(`cert-${D}`)).toHaveTextContent("Emitindo");
    expect(screen.getByTestId("disable-ip-blockers")).toHaveTextContent(/certificado HTTPS/);
    const before = statusCalls();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(statusCalls()).toBeGreaterThan(before); // conferiu sozinha
    expect(screen.getByTestId(`cert-${D}`)).toHaveTextContent("Emitindo");

    certState = "valid";
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByTestId(`cert-${D}`)).toHaveTextContent("Válido");
    expect(screen.getByRole("link", { name: /Abrir o painel pelo endereço novo/ })).toBeInTheDocument();
    expect(screen.getByTestId("disable-ip-blockers")).not.toHaveTextContent(/certificado HTTPS/);

    // válido: para de consultar
    const after = statusCalls();
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000));
    expect(statusCalls()).toBe(after);
  });

  it("aba oculta: não consulta; ao voltar, confere na hora", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state = { ...base(), domain: D, domainActive: true };
    renderPage();
    await screen.findByTestId(`cert-${D}`);
    act(() => setVisibility("hidden"));
    const before = statusCalls();
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(statusCalls()).toBe(before);
    certState = "valid";
    await act(async () => setVisibility("visible"));
    await waitFor(() => expect(screen.getByTestId(`cert-${D}`)).toHaveTextContent("Válido"));
    expect(statusCalls()).toBe(before + 1);
  });

  it("DNS ainda não conferido: não fica consultando o certificado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state = { ...base(), domain: D };
    renderPage();
    await screen.findByRole("button", { name: /Verificar DNS/ });
    const before = statusCalls();
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(statusCalls()).toBe(before);
  });

  it("\"Tentar emitir agora\" com o certificado que já ficou válido: a tela se atualiza na hora", async () => {
    state = { ...base(), domain: D, domainActive: true };
    renderPage();
    expect(await screen.findByTestId(`cert-${D}`)).toHaveTextContent("Emitindo");
    certState = "valid"; // ficou válido enquanto a tela estava aberta
    fireEvent.click(screen.getByRole("button", { name: /Tentar emitir agora/ }));
    await waitFor(() => expect(screen.getByTestId(`cert-${D}`)).toHaveTextContent("Válido"));
    expect(screen.getByRole("link", { name: /Abrir o painel pelo endereço novo/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/já está válido/)).toBeInTheDocument();
  });

  it("\"Tentar emitir agora\" acompanha a emissão e, quando sai, atualiza a tela inteira", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state = { ...base(), domain: D, domainActive: true };
    renderPage();
    await screen.findByTestId(`cert-${D}`);
    apiFetchMock.mockImplementationOnce(async () => {
      certState = "valid"; // o pedido de emissão funciona; a próxima conferência já vê válido
      return { host: D, message: "Pedimos ao proxy." };
    });
    fireEvent.click(screen.getByRole("button", { name: /Tentar emitir agora/ }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(await screen.findByText(/Certificado emitido/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir o painel pelo endereço novo/ })).toBeInTheDocument();
    expect(screen.getByTestId("disable-ip-blockers")).not.toHaveTextContent(/certificado HTTPS/);
  });

  it("falha ao carregar: mensagem de erro", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("rede"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível/);
  });
});
