/**
 * provisional-domains-card.test.tsx — Domínios de um projeto que ficou com o endereço
 * provisório (nome-xxxxx.localhost): o provisório vira texto com aviso, e o card oferece
 * o caminho real para sair dele (botão com o endereço automático, ou explicação sem base).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { resetPanelPublicCache } from "@/components/project/ProvisionalAddressNotice";
import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";

const PROV = "loja-p4r7m.localhost";
const AUTO = "loja-k3x9q.apps.example.com";
const project = (domain: string, aliases: string[] = []) =>
  ({ id: "p1", name: "loja", domain, aliases, detection: null, proxyService: null, proxyPort: null, lastDeployStatus: null }) as never;

let suggestion: Record<string, unknown>;
const WITH_BASE = { auto: AUTO, publicIp: "203.0.113.10", kind: "apps", appsBase: "apps.example.com", testAddress: null, provisional: "x-aaaaa.localhost", panelPublic: true };
const NO_BASE = { auto: "loja.203-0-113-10.sslip.io", publicIp: "203.0.113.10", panelPublic: true };

function mount(p = project(PROV)) {
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ProjectDomainsCard project={p} publicIp="203.0.113.10" onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
}

function calls(method: string) {
  return apiFetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === method).map(([p]) => p as string);
}

beforeEach(() => {
  setLocale("pt-BR");
  resetPanelPublicCache();
  suggestion = WITH_BASE;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/domains/suggest")) return suggestion;
    if (path.startsWith("/api/certificates")) return { checkedAt: "x", proxyRunning: true, items: [] };
    if (init?.method) return { project: project(AUTO) };
    return {};
  });
});
afterEach(cleanup);

describe("Domínios com endereço provisório", () => {
  it("o provisório vira texto com o aviso (sem link) e o botão traz a sugestão", async () => {
    mount();
    const linha = screen.getByTestId(`domain-${PROV}`);
    await within(linha).findByTestId("provisional-notice");
    expect(within(linha).queryByRole("link", { name: new RegExp(PROV) })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: `Usar o endereço automático (${AUTO})` })).toBeInTheDocument();
  });

  it("clicar adiciona o endereço sob a base, torna principal e remove o provisório, nessa ordem", async () => {
    const onChanged = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Usar o endereço automático/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls("POST")).toEqual(["/api/projects/p1/domains", `/api/projects/p1/domains/${AUTO}/primary`]);
    expect(calls("DELETE")).toEqual([`/api/projects/p1/domains/${PROV}`]);
    const add = apiFetchMock.mock.calls.find(([p]) => p === "/api/projects/p1/domains")!;
    expect(JSON.parse(String((add[1] as RequestInit).body))).toEqual({ domain: AUTO });
  });

  it("a base mudou desde que a tela abriu: nada é gravado, avisa e mostra o novo endereço", async () => {
    mount();
    await screen.findByRole("button", { name: /Usar o endereço automático/ });
    suggestion = { ...WITH_BASE, auto: "loja-zz9yy.example.com", appsBase: "example.com" };
    fireEvent.click(screen.getByRole("button", { name: /Usar o endereço automático/ }));
    await screen.findByTestId("provisional-base-changed");
    expect(calls("POST")).toHaveLength(0);
    expect(await screen.findByRole("button", { name: "Usar o endereço automático (loja-zz9yy.example.com)" })).toBeInTheDocument();
  });

  it("falha no meio: a nova tentativa continua de onde parou, sem repetir o que já foi feito", async () => {
    mount();
    const base = apiFetchMock.getMockImplementation()!;
    let falhar = true;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/primary") && falhar) {
        falhar = false;
        throw new Error("rede");
      }
      return base(path, init);
    });
    fireEvent.click(await screen.findByRole("button", { name: /Usar o endereço automático/ }));
    await screen.findByTestId("provisional-switch-error");
    fireEvent.click(screen.getByRole("button", { name: /Usar o endereço automático/ }));
    await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
    expect(calls("POST").filter((p) => p === "/api/projects/p1/domains")).toHaveLength(1);
  });

  it("sem domínio de aplicações: explica o caminho real, com link para Configurações, e não oferece o botão", async () => {
    suggestion = NO_BASE;
    mount();
    const caixa = await screen.findByTestId("provisional-no-base");
    expect(within(caixa).getByRole("link", { name: /Configurar o domínio de aplicações/ })).toHaveAttribute("href", "/settings/apps-domain");
    expect(caixa).toHaveTextContent(/Conectar novo domínio/);
    expect(screen.queryByRole("button", { name: /Usar o endereço automático/ })).not.toBeInTheDocument();
  });

  it("projeto com endereço definitivo: sem botão nem caixa", async () => {
    mount(project(AUTO));
    await waitFor(() => expect(screen.getByTestId(`domain-${AUTO}`)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Usar o endereço automático/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("provisional-no-base")).not.toBeInTheDocument();
  });
});
