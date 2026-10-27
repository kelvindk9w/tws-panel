/**
 * cloudflare-ui.test.tsx — Configurações → Integrações → Cloudflare e o botão "Criar na Cloudflare"
 * ao lado das listas de DNS: prévia antes de aplicar, nada diferente é trocado sem marcar, o token
 * nunca é mostrado de volta.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflarePlanResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { CloudflareDnsAction } from "@/components/CloudflareDnsAction";
import { CloudflareSettings } from "@/pages/settings/CloudflareSettings";

const SECRET = "cf_SEGREDO_do_token_9876";
let connected: boolean;
let plan: CloudflarePlanResponse;
let applied: unknown;
let applyResult: unknown;

const item = (over: Partial<CloudflarePlanResponse["items"][number]>): CloudflarePlanResponse["items"][number] => ({
  id: "a",
  type: "A",
  name: "mail.example.com",
  status: "create",
  proposed: "203.0.113.10",
  current: [],
  optional: false,
  ours: false,
  reason: null,
  fingerprint: "fp-a",
  selectable: true,
  defaultSelected: true,
  ...over,
});

beforeEach(() => {
  connected = true;
  applied = null;
  applyResult = null;
  plan = { noZoneCount: 0, items: [item({})] };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/integrations/cloudflare" && method === "GET") {
      return connected
        ? { connected: true, hint: "9876", updatedAt: "x", callsLastHour: 4, hourlyLimit: 600 }
        : { connected: false, hint: null, updatedAt: null, callsLastHour: 0, hourlyLimit: 600 };
    }
    if (path === "/api/integrations/cloudflare/zones") return { zones: ["example.com"] };
    if (path === "/api/integrations/cloudflare" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { token: string; currentPassword: string };
      if (body.token.length === 37) throw new ApiRequestError(400, "cloudflare_global_key", "Global key recusada");
      connected = true;
      return { connected: true, hint: "9876", updatedAt: "x", callsLastHour: 2, hourlyLimit: 600, zones: ["example.com", "example.org"] };
    }
    if (path === "/api/integrations/cloudflare/disconnect") {
      connected = false;
      return { connected: false, hint: null, updatedAt: null, callsLastHour: 0, hourlyLimit: 600 };
    }
    if (path === "/api/integrations/cloudflare/dns/plan") return plan;
    if (path === "/api/integrations/cloudflare/dns/apply") {
      applied = JSON.parse(String(init?.body));
      return applyResult ?? {
        created: 1,
        updated: 0,
        skipped: 0,
        failed: 1,
        results: [
          { id: "a", type: "A", name: "mail.example.com", outcome: "created", message: null },
          { id: "b", type: "TXT", name: "example.com", outcome: "failed", message: "Falhou lá" },
        ],
      };
    }
    throw new Error(`rota não prevista: ${method} ${path}`);
  });
});

afterEach(cleanup);

describe("Configurações → Cloudflare", () => {
  it("desconectada: mostra o guia de permissões e conecta com token + senha; o token não volta para a tela", async () => {
    connected = false;
    render(<CloudflareSettings />);
    const tokenInput = await screen.findByLabelText("API Token da Cloudflare");
    fireEvent.click(screen.getByRole("button", { name: /Como criar o token/ }));
    expect(screen.getByTestId("cloudflare-guide").textContent).toContain("Zone → DNS → Edit");
    expect(screen.getByTestId("cloudflare-guide").textContent).toContain("Zone → Zone → Read");
    expect(screen.getByTestId("cloudflare-guide").textContent).toContain("Global API Key");

    const connect = screen.getByRole("button", { name: "Conectar a Cloudflare" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(tokenInput, { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    fireEvent.change(screen.getByLabelText(/Código da verificação/), { target: { value: " 123456 " } });
    fireEvent.click(connect);

    await screen.findByTestId("cloudflare-connected");
    const put = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/integrations/cloudflare" && i?.method === "PUT")!;
    expect(JSON.parse(String(put[1].body))).toEqual({ token: SECRET, currentPassword: "MinhaSenha123", code: "123456" });
    expect(screen.getByTestId("cloudflare-connected").textContent).toContain("9876");
    expect(screen.getByTestId("cloudflare-zones").textContent).toBe("example.com, example.org");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("erro da API aparece na tela", async () => {
    connected = false;
    render(<CloudflareSettings />);
    fireEvent.change(await screen.findByLabelText("API Token da Cloudflare"), { target: { value: "0123456789abcdef0123456789abcdef01234" } });
    fireEvent.change(screen.getByLabelText("Sua senha atual"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar a Cloudflare" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Global key recusada");
  });

  it("conectada: mostra só os 4 últimos caracteres; trocar abre o formulário; remover pede a senha", async () => {
    render(<CloudflareSettings />);
    await screen.findByTestId("cloudflare-connected");
    expect(await screen.findByTestId("cloudflare-zones")).toBeTruthy();
    expect(screen.queryByLabelText("API Token da Cloudflare")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Trocar o token" }));
    expect(screen.getByLabelText("API Token da Cloudflare")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    fireEvent.click(screen.getByRole("button", { name: "Remover o token" }));
    const confirm = screen.getByRole("button", { name: "Confirmar e remover" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByTestId("cloudflare-connected")).toBeNull());
    expect(screen.getByLabelText("API Token da Cloudflare")).toBeTruthy();
  });

  it("falha ao consultar a integração avisa", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("fora"));
    render(<CloudflareSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("Não foi possível consultar a integração");
  });

  it("conectada sem nenhuma zona: avisa", async () => {
    apiFetchMock.mockImplementation(async (path: string) =>
      path.endsWith("/zones") ? { zones: [] } : { connected: true, hint: "9876", updatedAt: "x", callsLastHour: 0, hourlyLimit: 600 },
    );
    render(<CloudflareSettings />);
    expect(await screen.findByText(/não alcança nenhuma zona/)).toBeTruthy();
  });
});

describe("Criar na Cloudflare", () => {
  const scope = { kind: "mail", domain: "example.com" } as const;

  it("sem a Cloudflare conectada, só convida a conectar (a lista manual segue como sempre)", async () => {
    connected = false;
    render(
      <MemoryRouter>
        <CloudflareDnsAction scope={scope} />
      </MemoryRouter>,
    );
    const hint = await screen.findByTestId("cloudflare-hint");
    expect(hint.querySelector("a")!.getAttribute("href")).toBe("/settings/integrations");
    expect(screen.queryByRole("button", { name: "Criar na Cloudflare" })).toBeNull();
  });

  it("fora de um roteador o convite vira link comum; erro ao consultar o estado não mostra nada", async () => {
    connected = false;
    render(<CloudflareDnsAction scope={scope} />);
    expect((await screen.findByTestId("cloudflare-hint")).querySelector("a")!.getAttribute("href")).toBe("/settings/integrations");
    cleanup();
    apiFetchMock.mockRejectedValueOnce(new Error("fora"));
    const { container } = render(<CloudflareDnsAction scope={scope} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("prévia: marcados por padrão só os 'criar'; diferente e fusão não vêm marcados; conflito não tem caixa", async () => {
    plan = {
      noZoneCount: 1,
      items: [
        item({ id: "a" }),
        item({ id: "dmarc", type: "TXT", name: "_dmarc.example.com", status: "differs", current: ["v=DMARC1; p=reject"], proposed: "v=DMARC1; p=none", defaultSelected: false }),
        item({ id: "spf", type: "TXT", name: "example.com", status: "merge", current: ["v=spf1 mx ~all"], proposed: "v=spf1 mx ip4:203.0.113.10 ~all", defaultSelected: false }),
        item({ id: "mx", type: "MX", name: "example.com", status: "conflict", reason: "other_mx", current: ["1 aspmx.example.net"], selectable: false, defaultSelected: false }),
        item({ id: "tls", type: "TXT", name: "_smtp._tls.example.com", status: "ok", selectable: false, defaultSelected: false, optional: true, current: ["x"] }),
        item({ id: "z", name: "a.outro.org", status: "no_zone", selectable: false, defaultSelected: false }),
      ],
    };
    const onApplied = vi.fn();
    render(<CloudflareDnsAction scope={scope} onApplied={onApplied} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    const preview = await screen.findByTestId("cloudflare-preview");
    expect(preview.textContent).toContain("Prévia: nada foi alterado ainda");
    expect(preview.textContent).toContain("1 nome não está numa zona");
    expect((screen.getByLabelText("Marcar A mail.example.com") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Marcar TXT _dmarc.example.com") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Marcar TXT example.com") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("cloudflare-item-mx").querySelector("input")).toBeNull();
    expect(screen.getByTestId("cloudflare-item-mx").textContent).toContain("nunca troca isso sozinho");
    expect(screen.getByTestId("cloudflare-item-dmarc").textContent).toContain("Hoje: v=DMARC1; p=reject");
    expect(screen.getByTestId("cloudflare-item-dmarc").textContent).toContain("Proposto: v=DMARC1; p=none");
    expect(screen.getByTestId("cloudflare-item-spf").textContent).toContain("Dois SPF quebram o e-mail");
    expect(screen.getByTestId("cloudflare-item-tls").textContent).toContain("opcional");

    // marca o DMARC também e aplica: só os marcados vão ao servidor
    fireEvent.click(screen.getByLabelText("Marcar TXT _dmarc.example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar 2 marcados" }));
    const result = await screen.findByTestId("cloudflare-result");
    expect(applied).toEqual({
      scope,
      items: [
        { id: "a", status: "create", fingerprint: "fp-a" },
        { id: "dmarc", status: "differs", fingerprint: "fp-a" },
      ],
    });
    expect(result.textContent).toContain("1 criado(s), 0 atualizado(s), 0 ignorado(s), 1 com falha.");
    expect(result.textContent).toContain("Falhou lá");
    expect(onApplied).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Conferir de novo" }));
    expect(await screen.findByTestId("cloudflare-preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.getByRole("button", { name: "Criar na Cloudflare" })).toBeTruthy();
  });

  it("item que mudou desde a prévia aparece com a mensagem clara e nada foi escrito", async () => {
    applyResult = {
      created: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
      results: [{ id: "a", type: "A", name: "mail.example.com", outcome: "skipped", reason: "changed", message: null }],
    };
    render(<CloudflareDnsAction scope={scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    await screen.findByTestId("cloudflare-preview");
    fireEvent.click(screen.getByRole("button", { name: "Aplicar 1 marcado" }));
    expect((await screen.findByTestId("cloudflare-result")).textContent).toContain("mudou desde a prévia, confira de novo");
  });

  it("AAAA antigo sem IPv6 na VPS aparece como conflito com a explicação", async () => {
    plan = {
      noZoneCount: 0,
      items: [item({ id: "stale_aaaa:x", type: "AAAA", status: "conflict", reason: "stale_aaaa", selectable: false, defaultSelected: false, current: ["2001:db8::99"] })],
    };
    render(<CloudflareDnsAction scope={scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    expect((await screen.findByTestId("cloudflare-item-stale_aaaa:x")).textContent).toContain("não tem IPv6 configurado");
  });

  it("AAAA de outro endereço, com IPv6 na VPS, tem texto próprio", async () => {
    plan = {
      noZoneCount: 0,
      items: [item({ id: "stale_aaaa:x", type: "AAAA", status: "conflict", reason: "other_aaaa", selectable: false, defaultSelected: false, current: ["2001:db8::99"] })],
    };
    render(<CloudflareDnsAction scope={scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    const text = (await screen.findByTestId("cloudflare-item-stale_aaaa:x")).textContent ?? "";
    expect(text).toContain("não é o da VPS");
    expect(text).not.toContain("não tem IPv6");
  });

  it("desmarcar tudo desliga o botão de aplicar", async () => {
    render(<CloudflareDnsAction scope={scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    await screen.findByTestId("cloudflare-preview");
    fireEvent.click(screen.getByLabelText("Marcar A mail.example.com"));
    expect((screen.getByRole("button", { name: "Aplicar 0 marcado" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("domínio fora das zonas do token: mensagem clara, sem botão de aplicar", async () => {
    plan = { noZoneCount: 1, items: [item({ status: "no_zone", selectable: false, defaultSelected: false })] };
    render(<CloudflareDnsAction scope={scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    expect((await screen.findByTestId("cloudflare-preview")).textContent).toContain("não está numa zona que o token alcança");
    expect(screen.queryByRole("button", { name: /Aplicar/ })).toBeNull();
  });

  it("tudo certo: avisa que não há nada a criar", async () => {
    plan = { noZoneCount: 0, items: [item({ status: "ok", selectable: false, defaultSelected: false, current: ["203.0.113.10"] })] };
    render(<CloudflareDnsAction scope={scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar na Cloudflare" }));
    expect((await screen.findByTestId("cloudflare-preview")).textContent).toContain("Nada a criar");
  });

  it("erro na prévia e erro ao aplicar mostram o motivo da API", async () => {
    render(<CloudflareDnsAction scope={scope} />);
    const button = await screen.findByRole("button", { name: "Criar na Cloudflare" });
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(409, "cloudflare_token_rejected", "Token recusado pela Cloudflare"));
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Token recusado");
    fireEvent.click(screen.getByRole("button", { name: "Criar na Cloudflare" }));
    await screen.findByTestId("cloudflare-preview");
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(502, "cloudflare_error", "Cloudflare com erro"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar 1 marcado" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Cloudflare com erro");
    expect(screen.getByTestId("cloudflare-preview")).toBeTruthy();
  });

  it("autoOpen: logo depois de cadastrar o domínio a prévia abre sozinha; mudar o escopo descarta a prévia", async () => {
    const { rerender } = render(<CloudflareDnsAction scope={scope} autoOpen />);
    expect(await screen.findByTestId("cloudflare-preview")).toBeTruthy();
    rerender(<CloudflareDnsAction scope={{ kind: "mail", domain: "example.org" }} autoOpen />);
    await waitFor(() => expect(screen.queryByTestId("cloudflare-preview")).toBeNull());
    expect(screen.getByRole("button", { name: "Criar na Cloudflare" })).toBeTruthy();
  });
});
