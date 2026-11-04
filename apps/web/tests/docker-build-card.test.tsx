/**
 * docker-build-card.test.tsx — Saúde da VPS → Docker e BuildKit.
 *
 * Para um leigo: ver se o buildx existe no painel e na VPS, corrigir com um clique (senha + código do app)
 * quando o painel sabe o pacote certo, e ver os comandos manuais quando não sabe.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { ApiRequestError } from "@/lib/api";
import { DockerBuildCard } from "@/components/DockerBuildCard";

type Status = {
  panel: { buildx: boolean; version: string | null; detail: string | null };
  host: { available: boolean; reason: string | null; buildx: boolean | null; origin: string | null; fixable: boolean; manualCommands: string[] };
  ok: boolean;
};

const OK_STATUS: Status = {
  panel: { buildx: true, version: "docker/buildx v0.38.1", detail: null },
  host: { available: true, reason: null, buildx: true, origin: "docker-ce", fixable: false, manualCommands: [] },
  ok: true,
};
const MISSING: Status = {
  panel: { buildx: true, version: null, detail: null },
  host: {
    available: true,
    reason: null,
    buildx: false,
    origin: "docker-ce",
    fixable: true,
    manualCommands: ["sudo apt-get update", "sudo apt-get install -y docker-buildx-plugin", "docker buildx version"],
  },
  ok: false,
};

let status: Status;
let fixCalls: Array<Record<string, unknown>>;
let fixResult: "ok" | "erro";

beforeEach(() => {
  status = OK_STATUS;
  fixCalls = [];
  fixResult = "ok";
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/health/docker-build") return status;
    if (path === "/api/health/docker-build/fix") {
      fixCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (fixResult === "erro") throw new ApiRequestError(502, "host_failed", "A instalação do buildx falhou: sem rede");
      return { status: OK_STATUS, alertWarning: "O aviso por e-mail não saiu." };
    }
    throw new Error(`rota inesperada: ${path}`);
  });
});
afterEach(cleanup);

describe("DockerBuildCard", () => {
  it("tudo com buildx: mostra a versão do painel e nenhuma ação", async () => {
    render(<DockerBuildCard />);
    expect(await screen.findByText(/buildx disponível \(docker\/buildx v0\.38\.1\)/)).toBeTruthy();
    expect(screen.getByText(/Tudo certo/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Corrigir" })).toBeNull();
  });

  it("VPS sem buildx e origem conhecida: Corrigir pede senha e código, instala e atualiza o estado", async () => {
    status = MISSING;
    render(<DockerBuildCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Corrigir" }));
    const submit = screen.getByRole("button", { name: "Instalar o buildx" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Senha do painel/), { target: { value: "MinhaSenha123" } });
    fireEvent.change(screen.getByLabelText(/Código do app autenticador/), { target: { value: "123456" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByText("Pronto: o buildx foi instalado na VPS.")).toBeTruthy();
    expect(screen.getByText("O aviso por e-mail não saiu.")).toBeTruthy();
    expect(fixCalls).toEqual([{ currentPassword: "MinhaSenha123", code: "123456" }]);
    expect(screen.queryByTestId("docker-build-fix-form")).toBeNull();
  });

  it("erro da VPS aparece e o formulário continua aberto; Cancelar fecha", async () => {
    status = MISSING;
    fixResult = "erro";
    render(<DockerBuildCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Corrigir" }));
    fireEvent.change(screen.getByLabelText(/Senha do painel/), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/Código do app autenticador/), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Instalar o buildx" }));
    expect(await screen.findByText(/A instalação do buildx falhou: sem rede/)).toBeTruthy();
    expect(screen.getByTestId("docker-build-fix-form")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("docker-build-fix-form")).toBeNull();
  });

  it("origem não reconhecida: sem botão, com os comandos manuais", async () => {
    status = {
      ...MISSING,
      host: { ...MISSING.host, origin: "unknown", fixable: false, manualCommands: ["sudo apt-get install -y docker-buildx-plugin", "docker buildx version"] },
    };
    render(<DockerBuildCard />);
    const manual = await screen.findByTestId("docker-build-manual");
    expect(manual.textContent).toContain("docker-buildx-plugin");
    expect(screen.getByText(/Origem do Docker: não reconhecida/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Corrigir" })).toBeNull();
  });

  it.each([
    ["docker.io", /pacote docker\.io do Ubuntu/],
    ["snap", /Origem do Docker: snap/],
  ])("mostra a origem %s", async (origin, texto) => {
    status = { ...MISSING, host: { ...MISSING.host, origin, fixable: origin === "docker.io", manualCommands: ["x"] } };
    render(<DockerBuildCard />);
    expect(await screen.findByText(texto)).toBeTruthy();
  });

  it("buildx ausente no painel: explica que é preciso atualizar o painel e mostra a resposta do Docker", async () => {
    status = { ...OK_STATUS, panel: { buildx: false, version: null, detail: "docker: unknown command: docker buildx" }, ok: false };
    render(<DockerBuildCard />);
    expect(await screen.findByText(/Atualize o painel para a versão mais recente/)).toBeTruthy();
    expect(screen.getByText(/unknown command: docker buildx/)).toBeTruthy();
  });

  it("painel com buildx mas sem versão informada", async () => {
    status = { ...OK_STATUS, panel: { buildx: true, version: null, detail: null } };
    render(<DockerBuildCard />);
    expect(await screen.findAllByText("buildx disponível")).toHaveLength(2);
  });

  it("VPS não verificada (fora da VPS real): mostra o motivo, sem ação", async () => {
    status = {
      ...OK_STATUS,
      host: { available: false, reason: "Esta checagem só existe no painel instalado na VPS.", buildx: null, origin: null, fixable: false, manualCommands: [] },
    };
    render(<DockerBuildCard />);
    expect(await screen.findByText(/Não verificado: Esta checagem só existe/)).toBeTruthy();
  });

  it("falha ao ler o estado: mostra o erro e dá para verificar de novo", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(500, "internal_error", "Falhou"));
    render(<DockerBuildCard />);
    expect(await screen.findByText("Falhou")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Verificar de novo/ }));
    await waitFor(() => expect(screen.getByText(/Tudo certo/)).toBeTruthy());
  });
});
