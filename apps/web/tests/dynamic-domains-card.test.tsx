/**
 * dynamic-domains-card.test.tsx — domínios dinâmicos no projeto (lista, busca, filtro,
 * páginas, cadastro, remoção, sufixos) e os tetos em Configurações. API simulada com
 * estado. Nenhum domínio real: example.com e *.example.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicDomainItem, DynamicDomainsResponse, DynamicSuffix, Project } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { SITE_URL } from "@/lib/links";
import { ProjectDynamicDomainsCard } from "@/components/project/ProjectDynamicDomainsCard";
import { DynamicDomainsSettings } from "@/pages/settings/DynamicDomainsSettings";
import { SETTINGS_SECTIONS } from "@/pages/settings/SettingsLayout";

const PROJECT = { id: "aaaa1111aaaa1111", name: "Saas" } as Project;
const LIST = `/api/projects/${PROJECT.id}/dynamic-domains`;

let items: DynamicDomainItem[];
let suffixes: DynamicSuffix[];
let routing: { ready: boolean; reason: string | null };
let failures: Record<string, ApiRequestError>;
let calls: Array<{ key: string; body: unknown }>;
let limits: { maxNamesPerProject: number; maxIssuancesPerHour: number };

function item(host: string, over: Partial<DynamicDomainItem> = {}): DynamicDomainItem {
  return { host, addedAt: "2026-10-24T10:00:00.000Z", addedBy: "admin", via: "own", state: "waiting", message: null, validTo: null, ...over };
}

function view(query: URLSearchParams): DynamicDomainsResponse {
  const q = query.get("q") ?? "";
  const state = query.get("state");
  const page = Number(query.get("page") ?? 1);
  const pageSize = Number(query.get("pageSize") ?? 25);
  const filtered = items.filter((i) => i.host.includes(q) && (!state || i.state === state));
  const counters = { valid: 0, expiring: 0, expired: 0, issuing: 0, failed: 0, waiting: 0, total: items.length };
  for (const i of items) counters[i.state]++;
  return {
    suffixes,
    limits,
    usage: { names: items.length, issuancesLastHour: 3 },
    counters,
    routing,
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

beforeEach(() => {
  setLocale("pt-BR");
  items = [];
  suffixes = [];
  routing = { ready: true, reason: null };
  failures = {};
  calls = [];
  limits = { maxNamesPerProject: 500, maxIssuancesPerHour: 20 };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const [pathname, search = ""] = path.split("?");
    const key = `${method} ${pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (failures[key]) throw failures[key];
    if (key === `GET ${LIST}`) return view(new URLSearchParams(search));
    if (key === `POST ${LIST}`) {
      calls.push({ key, body });
      const added = item(String(body.host).toLowerCase());
      items = [added, ...items];
      return { item: added };
    }
    if (method === "DELETE" && pathname.startsWith(`${LIST}/`)) {
      calls.push({ key, body });
      const host = decodeURIComponent(pathname.slice(LIST.length + 1));
      items = items.filter((i) => i.host !== host);
      return { ok: true };
    }
    if (key === `PUT ${LIST}/suffixes`) {
      calls.push({ key, body });
      suffixes = body.suffixes;
      return { suffixes };
    }
    if (key === "GET /api/settings/dynamic-domains" || key === "PUT /api/settings/dynamic-domains") {
      if (body) {
        calls.push({ key, body });
        limits = body;
      }
      return {
        limits,
        defaults: { maxNamesPerProject: 500, maxIssuancesPerHour: 20 },
        range: { maxNamesPerProject: { min: 10, max: 5000 }, maxIssuancesPerHour: { min: 1, max: 100 } },
      };
    }
    throw new Error(`rota inesperada: ${key}`);
  });
});
afterEach(() => {
  cleanup();
  setLocale("pt-BR");
});

describe("Domínios dinâmicos no projeto", () => {
  it("vazio: explica, mostra o uso e o guia do site; sem nomes não há dica de DNS", async () => {
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    expect(await screen.findByText("Nenhum domínio cadastrado ainda.")).toBeInTheDocument();
    expect(screen.getByTestId("dynamic-usage")).toHaveTextContent("0 de 500 nomes · 3 de 20 emissões novas na última hora");
    expect(screen.getByRole("link", { name: /Guia: domínios dos seus clientes/ })).toHaveAttribute("href", `${SITE_URL}/pt-br/guides/saas-domains/`);
    expect(screen.queryByTestId("dynamic-waiting-hint")).toBeNull();
    expect(screen.queryByTestId("dynamic-routing-off")).toBeNull();
  });

  it("cadastrar: envia o nome, limpa o campo e mostra o estado 'Aguardando DNS / emissão' com a dica da nuvem cinza", async () => {
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    await screen.findByText("Nenhum domínio cadastrado ainda.");
    const button = screen.getByRole("button", { name: /Cadastrar/ });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Domínio do cliente"), { target: { value: " App.Escola.example " } });
    fireEvent.click(button);
    const row = await screen.findByTestId("dynamic-app.escola.example");
    expect(calls[0]).toEqual({ key: `POST ${LIST}`, body: { host: "App.Escola.example" } });
    expect(row).toHaveTextContent("Aguardando DNS / emissão");
    expect(row).toHaveTextContent("nome avulso");
    expect(row).toHaveTextContent("cadastrado pelo painel");
    expect(await screen.findByTestId("dynamic-waiting-hint")).toHaveTextContent(/nuvem laranja/);
    expect(screen.getByLabelText("Domínio do cliente")).toHaveValue("");
  });

  it("nome recusado pelo servidor: mostra a mensagem e mantém o que foi digitado", async () => {
    failures[`POST ${LIST}`] = new ApiRequestError(400, "invalid_dynamic_host", "O nome não pode ser um IP.");
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    await screen.findByText("Nenhum domínio cadastrado ainda.");
    fireEvent.change(screen.getByLabelText("Domínio do cliente"), { target: { value: "203.0.113.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar/ }));
    expect(await screen.findByText("O nome não pode ser um IP.")).toBeInTheDocument();
    expect(screen.getByLabelText("Domínio do cliente")).toHaveValue("203.0.113.5");
  });

  it("remover pede confirmação; cancelar não remove; confirmar remove", async () => {
    items = [item("a.cliente.example"), item("b.cliente.example")];
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    const row = await screen.findByTestId("dynamic-a.cliente.example");
    fireEvent.click(within(row).getByRole("button", { name: "Remover a.cliente.example" }));
    fireEvent.click(within(row).getByRole("button", { name: "Cancelar" }));
    expect(calls).toEqual([]);
    fireEvent.click(within(row).getByRole("button", { name: "Remover a.cliente.example" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirmar remoção" }));
    await waitFor(() => expect(screen.queryByTestId("dynamic-a.cliente.example")).toBeNull());
    expect(calls[0]!.key).toBe(`DELETE ${LIST}/a.cliente.example`);
    expect(screen.getByTestId("dynamic-b.cliente.example")).toBeInTheDocument();
  });

  it("falha ao remover: mostra o erro e mantém o nome", async () => {
    items = [item("a.cliente.example")];
    failures[`DELETE ${LIST}/a.cliente.example`] = new ApiRequestError(500, "storage_write_failed", "Não foi possível salvar.");
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    const row = await screen.findByTestId("dynamic-a.cliente.example");
    fireEvent.click(within(row).getByRole("button", { name: "Remover a.cliente.example" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirmar remoção" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Não foi possível salvar.");
  });

  it("mostra quem cadastrou, a validade e a causa da falha", async () => {
    items = [
      item("v.cliente.example", { state: "valid", addedBy: "token:app-do-saas", validTo: "2027-01-10T00:00:00.000Z", via: "suffix" }),
      item("f.cliente.example", { state: "failed", addedBy: "acesso", message: "O DNS não aponta para esta VPS." }),
    ];
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    const ok = await screen.findByTestId("dynamic-v.cliente.example");
    expect(ok).toHaveTextContent("Válido");
    expect(ok).toHaveTextContent("pelo sufixo");
    expect(ok).toHaveTextContent("cadastrado pelo token app-do-saas");
    expect(ok).toHaveTextContent(/válido até/);
    const bad = screen.getByTestId("dynamic-f.cliente.example");
    expect(bad).toHaveTextContent("cadastrado pelo primeiro acesso");
    expect(bad).toHaveTextContent("O DNS não aponta para esta VPS.");
  });

  it("centenas de nomes: páginas, tamanho da página, busca e filtro por situação", async () => {
    items = Array.from({ length: 60 }, (_, i) => item(`c${String(i).padStart(2, "0")}.cliente.example`, i % 3 === 0 ? { state: "valid" } : {}));
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    await screen.findByTestId("dynamic-c00.cliente.example");
    expect(screen.getAllByTestId(/^dynamic-c/)).toHaveLength(25);
    expect(screen.getByTestId("dynamic-page-summary")).toHaveTextContent("Página 1 de 3 · 60 nomes");
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    await screen.findByTestId("dynamic-c25.cliente.example");
    expect(screen.getByTestId("dynamic-page-summary")).toHaveTextContent("Página 2 de 3");
    fireEvent.change(screen.getByLabelText("Por página"), { target: { value: "50" } });
    await waitFor(() => expect(screen.getByTestId("dynamic-page-summary")).toHaveTextContent("Página 1 de 2"));

    fireEvent.change(screen.getByLabelText("Buscar nome"), { target: { value: "c07" } });
    await waitFor(() => expect(screen.getAllByTestId(/^dynamic-c/)).toHaveLength(1));
    expect(screen.queryByTestId("dynamic-page-summary")).toBeNull();
    fireEvent.change(screen.getByLabelText("Buscar nome"), { target: { value: "zzz" } });
    expect(await screen.findByText("Nenhum nome com esse filtro.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Buscar nome"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Situação"), { target: { value: "valid" } });
    await waitFor(() => expect(screen.getAllByTestId(/^dynamic-c/)).toHaveLength(20));
    expect(within(screen.getByLabelText("Situação")).getByRole("option", { name: "Válido (20)" })).toBeInTheDocument();
  });

  it("o proxy não alcança o painel: avisa o motivo; sem motivo, usa o texto padrão", async () => {
    routing = { ready: false, reason: "O painel não está rodando em container." };
    const { unmount } = render(<ProjectDynamicDomainsCard project={PROJECT} />);
    expect(await screen.findByTestId("dynamic-routing-off")).toHaveTextContent("ainda não são servidos: O painel não está rodando em container.");
    unmount();
    routing = { ready: false, reason: null };
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    expect(await screen.findByTestId("dynamic-routing-off")).toHaveTextContent("o proxy não consegue consultar o painel.");
  });

  it("falha ao carregar: mostra o erro", async () => {
    failures[`GET ${LIST}`] = new ApiRequestError(500, "internal_error", "Erro interno.");
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Erro interno.");
  });

  it("em inglês: textos e o guia em /en/", async () => {
    setLocale("en");
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    expect(await screen.findByText("No domain registered yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Guide: your customers' domains/ })).toHaveAttribute("href", `${SITE_URL}/en/guides/saas-domains/`);
  });
});

describe("Sufixos dos domínios dinâmicos", () => {
  it("sem sufixo: avisa que só os nomes cadastrados valem; adicionar normaliza (*., maiúsculas) e salva", async () => {
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    const box = await screen.findByTestId("dynamic-suffixes");
    expect(box).toHaveTextContent("Nenhum sufixo: só os nomes cadastrados valem.");
    expect(within(box).getByRole("button", { name: "Salvar sufixos" })).toBeDisabled();
    fireEvent.change(within(box).getByLabelText("Sufixo"), { target: { value: "*.Saas.Example" } });
    fireEvent.click(within(box).getByRole("button", { name: /Adicionar sufixo/ }));
    expect(within(box).getByText("*.saas.example")).toBeInTheDocument();
    // repetir não duplica
    fireEvent.change(within(box).getByLabelText("Sufixo"), { target: { value: "saas.example" } });
    fireEvent.click(within(box).getByRole("button", { name: /Adicionar sufixo/ }));
    expect(within(box).getAllByText("*.saas.example")).toHaveLength(1);
    fireEvent.click(within(box).getByRole("button", { name: "Salvar sufixos" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ key: `PUT ${LIST}/suffixes`, body: { suffixes: [{ suffix: "saas.example", openAll: false }] } }));
    expect(await within(box).findByText("Sufixos salvos.")).toBeInTheDocument();
  });

  it("'aceitar qualquer subdomínio' mostra o aviso do abuso; desligar tira o aviso; remover tira o sufixo", async () => {
    suffixes = [{ suffix: "saas.example", openAll: false }];
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    const box = await screen.findByTestId("dynamic-suffixes");
    expect(within(box).queryByRole("note")).toBeNull();
    fireEvent.click(within(box).getByLabelText("Aceitar qualquer subdomínio no primeiro acesso"));
    expect(within(box).getByRole("note")).toHaveTextContent(/gastar a sua cota de emissões/);
    fireEvent.click(within(box).getByLabelText("Aceitar qualquer subdomínio no primeiro acesso"));
    expect(within(box).queryByRole("note")).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Tirar o sufixo saas.example" }));
    expect(within(box).getByText("Nenhum sufixo: só os nomes cadastrados valem.")).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Salvar sufixos" }));
    await waitFor(() => expect(calls.at(-1)!.body).toEqual({ suffixes: [] }));
  });

  it("sufixo recusado pelo servidor: mostra o erro e mantém o rascunho", async () => {
    failures[`PUT ${LIST}/suffixes`] = new ApiRequestError(409, "domain_in_use", "O sufixo já é de outro projeto.");
    render(<ProjectDynamicDomainsCard project={PROJECT} />);
    const box = await screen.findByTestId("dynamic-suffixes");
    fireEvent.change(within(box).getByLabelText("Sufixo"), { target: { value: "saas.example" } });
    fireEvent.click(within(box).getByRole("button", { name: /Adicionar sufixo/ }));
    fireEvent.click(within(box).getByRole("button", { name: "Salvar sufixos" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("O sufixo já é de outro projeto.");
    expect(within(box).getByText("*.saas.example")).toBeInTheDocument();
  });
});

describe("Configurações → Domínios dinâmicos", () => {
  it("aparece no menu de Configurações", () => {
    expect(SETTINGS_SECTIONS.some((s) => s.to === "/settings/dynamic-domains" && s.label === "Domínios dinâmicos")).toBe(true);
  });

  it("mostra os tetos atuais com a faixa e o padrão; salvar só liga com mudança; voltar ao padrão restaura", async () => {
    render(<DynamicDomainsSettings />);
    const names = (await screen.findByLabelText("Nomes por projeto")) as HTMLInputElement;
    const issuances = screen.getByLabelText("Emissões novas por hora") as HTMLInputElement;
    expect(names.value).toBe("500");
    expect(issuances.value).toBe("20");
    expect(screen.getByText(/De 10 a 5000\. Padrão: 500/)).toBeInTheDocument();
    expect(screen.getByText(/De 1 a 100\. Padrão: 20/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Salvar tetos" });
    expect(save).toBeDisabled();
    fireEvent.change(names, { target: { value: "x1200" } }); // só dígitos
    expect(names.value).toBe("1200");
    fireEvent.change(issuances, { target: { value: "" } });
    expect(save).toBeDisabled();
    fireEvent.change(issuances, { target: { value: "7" } });
    fireEvent.click(save);
    expect(await screen.findByText("Tetos salvos.")).toBeInTheDocument();
    expect(calls.at(-1)!.body).toEqual({ maxNamesPerProject: 1200, maxIssuancesPerHour: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao padrão" }));
    await waitFor(() => expect(calls.at(-1)!.body).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20 }));
    await waitFor(() => expect(names.value).toBe("500"));
  });

  it("valor recusado: mostra o erro; falha ao carregar também", async () => {
    const { unmount } = render(<DynamicDomainsSettings />);
    const names = (await screen.findByLabelText("Nomes por projeto")) as HTMLInputElement;
    failures["PUT /api/settings/dynamic-domains"] = new ApiRequestError(400, "invalid_dynamic_limit", "Valor fora da faixa: nomes por projeto de 10 a 5000.");
    fireEvent.change(names, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tetos" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Valor fora da faixa");
    unmount();
    failures = { "GET /api/settings/dynamic-domains": new ApiRequestError(500, "internal_error", "Erro interno.") };
    render(<DynamicDomainsSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Erro interno.");
  });

  it("em inglês: o guia aponta para /en/", async () => {
    setLocale("en");
    render(<DynamicDomainsSettings />);
    expect(await screen.findByLabelText("Names per project")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Guide: your customers' domains/ })).toHaveAttribute("href", `${SITE_URL}/en/guides/saas-domains/`);
  });
});
