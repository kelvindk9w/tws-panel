/**
 * project-temporary-address.test.tsx — endereço temporário para testar enquanto o DNS do
 * domínio oficial propaga. O card Domínios do projeto:
 *  - oferece "Adicionar endereço temporário para testar" (usa /api/domains/suggest) quando
 *    nenhum domínio do projeto resolve para a VPS (mesma verificação de /api/domains/check);
 *  - não oferece em painel local, sem endereço público, ou quando algum domínio já resolve;
 *  - lembra de remover o temporário (sslip.io) depois que o oficial funcionar, sem remover sozinho.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { resetPanelPublicCache } from "@/components/project/ProvisionalAddressNotice";
import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";

const SSLIP = "loja.203-0-113-10.sslip.io";
const APPS = "loja-k3x9q.apps.example.com";
const OFFICIAL = "loja.example.com";

const project = (domain: string, aliases: string[] = []) =>
  ({ id: "p1", name: "loja", domain, aliases, detection: null, proxyService: null, proxyPort: null, lastDeployStatus: null }) as never;

let suggestion: Record<string, unknown>;
let resolves: Record<string, boolean>;
const NO_BASE = { auto: SSLIP, publicIp: "203.0.113.10", panelPublic: true };
const WITH_BASE = { auto: APPS, publicIp: "203.0.113.10", kind: "apps", appsBase: "apps.example.com", testAddress: SSLIP, provisional: "x-aaaaa.localhost", panelPublic: true };

function mount(p: never, onChanged = vi.fn()) {
  render(
    <MemoryRouter>
      <ProjectDomainsCard project={p} publicIp="203.0.113.10" onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
}

function posts() {
  return apiFetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST").map(([p, i]) => ({ path: p as string, body: JSON.parse(String((i as RequestInit).body ?? "null")) }));
}

beforeEach(() => {
  setLocale("pt-BR");
  resetPanelPublicCache();
  suggestion = NO_BASE;
  resolves = {};
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/domains/suggest")) return suggestion;
    if (path.startsWith("/api/domains/check")) {
      const domain = decodeURIComponent(path.split("domain=")[1]!);
      if (resolves[domain] === undefined && domain.startsWith("erro")) throw new Error("sem rede");
      return { domain, ok: resolves[domain] ?? false, devLocal: false, resolvedIps: [], machineIps: [], message: "x" };
    }
    if (path.startsWith("/api/certificates")) return { checkedAt: "x", proxyRunning: true, items: [] };
    if (init?.method) return { project: project(OFFICIAL, [APPS]) };
    return {};
  });
});
afterEach(cleanup);

describe("endereço temporário para testar", () => {
  it("domínio oficial que ainda não aponta para a VPS e nenhum outro endereço: oferece o botão com o aviso de sslip.io", async () => {
    mount(project(OFFICIAL));
    const box = await screen.findByTestId("temp-address");
    expect(within(box).getByRole("button", { name: "Adicionar endereço temporário para testar" })).toBeInTheDocument();
    expect(box).toHaveTextContent("ainda não aponta para esta VPS");
    expect(box).toHaveTextContent("contém o IP da VPS");
    expect(box).toHaveTextContent("limite de emissão de certificados");
    expect(apiFetchMock.mock.calls.some(([p]) => String(p) === `/api/domains/check?domain=${OFFICIAL}`)).toBe(true);
  });

  it("clicar adiciona o endereço sugerido como domínio adicional (o oficial continua principal) e recarrega", async () => {
    const onChanged = mount(project(OFFICIAL));
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar endereço temporário para testar" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(posts()).toEqual([{ path: "/api/projects/p1/domains", body: { domain: SSLIP } }]);
  });

  it("com domínio de aplicações verificado, o temporário é o <projeto>-<sufixo>.<base> e não fala do limite do sslip.io", async () => {
    suggestion = WITH_BASE;
    mount(project(OFFICIAL));
    const box = await screen.findByTestId("temp-address");
    expect(box).not.toHaveTextContent("sslip.io");
    expect(box).toHaveTextContent(`Endereço que será adicionado: ${APPS}`);
    expect(box).toHaveTextContent("o painel não o marca como temporário");
    expect(within(box).queryByRole("button", { name: "Adicionar endereço temporário para testar" })).not.toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Adicionar endereço para testar" }));
    await waitFor(() => expect(posts()).toEqual([{ path: "/api/projects/p1/domains", body: { domain: APPS } }]));
  });

  it("a caixa mostra qual endereço será acrescentado", async () => {
    mount(project(OFFICIAL));
    expect(await screen.findByTestId("temp-address")).toHaveTextContent(`Endereço que será adicionado: ${SSLIP}`);
  });

  it("painel não público mesmo com sslip.io sugerido: não oferece", async () => {
    suggestion = { ...NO_BASE, panelPublic: false };
    mount(project(OFFICIAL));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/check"))).toBe(true));
    await screen.findByTestId(`domain-${OFFICIAL}`);
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/suggest"))).toBe(true));
    expect(screen.queryByTestId("temp-address")).not.toBeInTheDocument();
  });

  it("enquanto adiciona, o botão fica desabilitado (sem clique duplo)", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    let release: () => void = () => undefined;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") await new Promise<void>((r) => (release = r));
      return base(path, init);
    });
    mount(project(OFFICIAL));
    const btn = await screen.findByRole("button", { name: "Adicionar endereço temporário para testar" });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.click(btn);
    release();
    await waitFor(() => expect(btn).toBeEnabled());
    expect(posts()).toHaveLength(1);
  });

  it("o domínio existe no DNS mas aponta para outro lugar (ex.: proxy da Cloudflare): não fala de propagação", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/domains/check")) return { domain: OFFICIAL, ok: false, devLocal: false, resolvedIps: ["104.16.0.1"], machineIps: [], message: "x" };
      return base(path, init);
    });
    mount(project(OFFICIAL));
    const box = await screen.findByTestId("temp-address");
    expect(box).toHaveTextContent("existe no DNS, mas não aponta para esta VPS");
    expect(box).not.toHaveTextContent("até algumas horas");
  });

  it("já existe um endereço que resolve para a VPS: não oferece", async () => {
    resolves[SSLIP] = true;
    mount(project(OFFICIAL, [SSLIP]));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/check?domain=loja.203"))).toBe(true));
    await screen.findByTestId(`domain-${SSLIP}`);
    expect(screen.queryByTestId("temp-address")).not.toBeInTheDocument();
  });

  it("o domínio oficial já aponta para a VPS: não oferece", async () => {
    resolves[OFFICIAL] = true;
    mount(project(OFFICIAL));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/check"))).toBe(true));
    expect(screen.queryByTestId("temp-address")).not.toBeInTheDocument();
  });

  it("painel local (panelPublic false) ou endereço .localhost: não oferece", async () => {
    suggestion = { auto: "loja.localhost", publicIp: null, panelPublic: false };
    mount(project(OFFICIAL));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/suggest"))).toBe(true));
    await screen.findByTestId(`domain-${OFFICIAL}`);
    expect(screen.queryByTestId("temp-address")).not.toBeInTheDocument();
  });

  it("painel público mas a sugestão é .localhost (sem IP público conhecido): não oferece", async () => {
    suggestion = { auto: "loja.localhost", publicIp: null, panelPublic: true };
    mount(project(OFFICIAL));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/check"))).toBe(true));
    expect(screen.queryByTestId("temp-address")).not.toBeInTheDocument();
  });

  it("não consegue verificar o DNS: não oferece (não adivinha)", async () => {
    mount(project("erro.example.com"));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/check"))).toBe(true));
    expect(screen.queryByTestId("temp-address")).not.toBeInTheDocument();
  });

  it("projeto com vários domínios oficiais, nenhum apontando: oferece uma vez", async () => {
    mount(project(OFFICIAL, ["www.loja.example.com"]));
    expect(await screen.findAllByRole("button", { name: "Adicionar endereço temporário para testar" })).toHaveLength(1);
  });

  it("falha ao adicionar (ex.: endereço em uso): mostra o erro e mantém o botão", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new ApiRequestError(409, "domain_in_use", "em uso");
      return base(path, init);
    });
    mount(project(OFFICIAL));
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar endereço temporário para testar" }));
    expect(await screen.findByTestId("temp-address-error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar endereço temporário para testar" })).toBeEnabled();
  });

  it("em inglês", async () => {
    setLocale("en");
    mount(project(OFFICIAL));
    const box = await screen.findByTestId("temp-address");
    expect(within(box).getByRole("button", { name: "Add a temporary address to test" })).toBeInTheDocument();
  });
});

describe("lembrete de remover o endereço temporário", () => {
  it("oficial funcionando e o sslip.io ainda conectado: lembra, sem remover nada", async () => {
    resolves[OFFICIAL] = true;
    resolves[SSLIP] = true;
    mount(project(OFFICIAL, [SSLIP]));
    const note = await screen.findByTestId("temp-address-reminder");
    expect(note).toHaveTextContent(`${OFFICIAL} já aponta para a VPS`);
    expect(note).toHaveTextContent(SSLIP);
    expect(note).toHaveTextContent("o painel não remove nada sozinho");
    expect(apiFetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "DELETE")).toHaveLength(0);
  });

  it("o temporário é o principal: manda tornar o oficial principal antes de remover (o principal não tem Remover)", async () => {
    resolves[OFFICIAL] = true;
    resolves[SSLIP] = true;
    mount(project(SSLIP, [OFFICIAL]));
    const note = await screen.findByTestId("temp-address-reminder");
    expect(note).toHaveTextContent("ainda é o principal");
    expect(note).toHaveTextContent("clique em Tornar principal");
    expect(within(screen.getByTestId(`domain-${SSLIP}`)).queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId(`domain-${OFFICIAL}`)).getByRole("button", { name: "Tornar principal" })).toBeInTheDocument();
  });

  it("temporário não principal: o lembrete manda usar Remover na linha dele, que existe", async () => {
    resolves[OFFICIAL] = true;
    resolves[SSLIP] = true;
    mount(project(OFFICIAL, [SSLIP]));
    const note = await screen.findByTestId("temp-address-reminder");
    expect(note).not.toHaveTextContent("ainda é o principal");
    expect(within(screen.getByTestId(`domain-${SSLIP}`)).getByRole("button", { name: /Remover/ })).toBeInTheDocument();
  });

  it("oficial ainda não aponta: sem lembrete", async () => {
    resolves[SSLIP] = true;
    mount(project(OFFICIAL, [SSLIP]));
    await screen.findByTestId(`domain-${SSLIP}`);
    await waitFor(() => expect(apiFetchMock.mock.calls.filter(([p]) => String(p).startsWith("/api/domains/check")).length).toBe(2));
    expect(screen.queryByTestId("temp-address-reminder")).not.toBeInTheDocument();
  });

  it("sem endereço sslip.io no projeto: sem lembrete", async () => {
    resolves[OFFICIAL] = true;
    mount(project(OFFICIAL, [APPS]));
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith("/api/domains/check"))).toBe(true));
    expect(screen.queryByTestId("temp-address-reminder")).not.toBeInTheDocument();
  });
});
