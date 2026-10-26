/**
 * Assistente de novo projeto — tipo escolhido à mão (sobrepõe a detecção) e "aplicação de página única"
 * (fallback do nginx para o index.html), e a seção Variáveis com a marca "de build".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { NewProjectPage } from "@/pages/NewProjectPage";
import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { ProjectConfigCard } from "@/components/ProjectConfigCard";

const PROJECT = { id: "p1", domain: "loja.localhost", name: "loja" };
const base = { composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] };
const DOCKERFILE = { ...base, type: "dockerfile", proxyPort: 80 };
const STATIC_NODE = { ...base, type: "static-node", outputDir: "dist", chosenType: true, detectedType: "dockerfile", spaSuggested: true };
let patchBodies: Array<Record<string, unknown>> = [];
let detectBodies: unknown[] = [];
let detectReply: (body: { type?: string | null }) => unknown;

beforeEach(() => {
  patchBodies = [];
  detectBodies = [];
  detectReply = () => ({ detection: DOCKERFILE });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/projects" && method === "POST") return { project: PROJECT };
    if (path === "/api/projects/p1" && method === "PATCH") {
      patchBodies.push(JSON.parse(String(init?.body)));
      return { project: PROJECT };
    }
    if (path.startsWith("/api/domains/suggest")) return { auto: "loja.203-0-113-10.sslip.io", publicIp: "203.0.113.10" };
    if (path === "/api/projects/p1/detect") {
      const body = init?.body ? (JSON.parse(String(init.body)) as { type?: string | null }) : {};
      detectBodies.push(body);
      const reply = detectReply(body);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(cleanup);

async function abrirDeteccao() {
  render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewProjectPage />} />
        <Route path="*" element={<p>fim</p>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: "https://github.com/usuario/loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
  await screen.findByTestId("wizard-type");
}

async function concluir() {
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Criar projeto/ }));
  await screen.findByText("fim");
}

describe("tipo escolhido à mão no assistente", () => {
  it("começa em 'Detecção automática'; escolher um tipo pede a detecção com ele e mostra 'Tipo escolhido por você'", async () => {
    await abrirDeteccao();
    const select = screen.getByTestId("wizard-type") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Detecção automática",
      "site estático (HTML)",
      "estático (Node)",
      "compose adotado",
      "dockerfile",
      "Next.js (servidor)",
    ]);
    detectReply = () => ({ detection: STATIC_NODE });
    fireEvent.change(select, { target: { value: "static-node" } });
    await screen.findByText(/Tipo escolhido por você/);
    expect(detectBodies.at(-1)).toEqual({ type: "static-node" });
    expect((screen.getByTestId("wizard-type") as HTMLSelectElement).value).toBe("static-node");
  });

  it("voltar para 'Detecção automática' manda type: null", async () => {
    await abrirDeteccao();
    detectReply = () => ({ detection: STATIC_NODE });
    fireEvent.change(screen.getByTestId("wizard-type"), { target: { value: "static-node" } });
    await screen.findByText(/Tipo escolhido por você/);
    detectReply = () => ({ detection: DOCKERFILE });
    fireEvent.change(screen.getByTestId("wizard-type"), { target: { value: "" } });
    await screen.findByText(/Tipo detectado/);
    expect(detectBodies.at(-1)).toEqual({ type: null });
  });

  it("tipo que não combina com o código: mostra o motivo do servidor e mantém a detecção anterior", async () => {
    await abrirDeteccao();
    detectReply = () => new ApiRequestError(422, "invalid_type", "Não há Dockerfile na raiz do projeto.");
    fireEvent.change(screen.getByTestId("wizard-type"), { target: { value: "dockerfile" } });
    expect(await screen.findByTestId("new-project-error")).toHaveTextContent(/Dockerfile na raiz/);
    expect(screen.getByText(/Tipo detectado/)).toBeInTheDocument();
  });
});

describe("aplicação de página única no assistente", () => {
  it("static-node sugerido pela detecção: a caixa já vem ligada e o PATCH leva spa: true", async () => {
    detectReply = () => ({ detection: STATIC_NODE });
    await abrirDeteccao();
    const box = within(screen.getByTestId("wizard-spa")).getByRole("checkbox");
    expect(box).toBeChecked();
    expect(screen.getByTestId("wizard-spa")).toHaveTextContent(/a opção já veio ligada/);
    await concluir();
    expect(patchBodies.at(-1)).toMatchObject({ spa: true });
  });

  it("pode desligar; HTML puro nasce desligado e manda spa: false", async () => {
    detectReply = () => ({ detection: STATIC_NODE });
    await abrirDeteccao();
    fireEvent.click(within(screen.getByTestId("wizard-spa")).getByRole("checkbox"));
    await concluir();
    expect(patchBodies.at(-1)).toMatchObject({ spa: false });
    cleanup();
    detectReply = () => ({ detection: { ...base, type: "static" } });
    await abrirDeteccao();
    const box = within(screen.getByTestId("wizard-spa")).getByRole("checkbox");
    expect(box).not.toBeChecked();
    expect(screen.getByTestId("wizard-spa")).not.toHaveTextContent(/já veio ligada/);
    await concluir();
    expect(patchBodies.at(-1)).toMatchObject({ spa: false });
  });

  it("Dockerfile: sem a opção e sem spa no PATCH", async () => {
    await abrirDeteccao();
    expect(screen.queryByTestId("wizard-spa")).not.toBeInTheDocument();
    await concluir();
    expect(patchBodies.at(-1)).not.toHaveProperty("spa");
  });
});

describe("opção de página única na configuração do projeto", () => {
  const staticProject = (extra: Record<string, unknown> = {}) =>
    ({
      id: "p1", name: "loja", slug: "loja", ingestMode: "existing", source: "/x", branch: null, domain: "loja.localhost", websocket: false,
      detection: { type: "static-node" }, ...extra,
    }) as unknown as Project;

  it("static-node mostra a caixa; mudar manda só spa; Dockerfile não mostra", async () => {
    apiFetchMock.mockImplementation(async () => ({ project: PROJECT }));
    const onSaved = vi.fn();
    render(<ProjectConfigCard section="general" project={staticProject({ spa: false })} onSaved={onSaved} />);
    fireEvent.click(within(screen.getByTestId("config-spa")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Salvar$/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [path, init] = apiFetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/projects/p1");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ spa: true });
    cleanup();
    render(<ProjectConfigCard section="general" project={staticProject({ detection: { type: "dockerfile" } })} onSaved={onSaved} />);
    expect(screen.queryByTestId("config-spa")).not.toBeInTheDocument();
  });
});

describe("Variáveis — marca 'de build'", () => {
  const projectOf = (type: string) => ({ id: "p1", name: "loja", slug: "loja", detection: { type } }) as unknown as Project;
  let putBody: { vars: Array<Record<string, unknown>> } | null;

  function serve(vars: Array<Record<string, unknown>>) {
    putBody = null;
    apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return putBody;
      }
      return { vars };
    });
  }
  const renderEnv = (type: string) =>
    render(
      <MemoryRouter>
        <ProjectEnvCard project={projectOf(type)} />
      </MemoryRouter>,
    );

  it("prefixo público sem marca: sugere (sem marcar sozinho); segredo comum não tem sugestão", async () => {
    serve([
      { key: "VITE_API_URL", value: "https://api.example.com" },
      { key: "SEGREDO_DB", value: "x" },
    ]);
    renderEnv("static-node");
    const row = await screen.findByTestId("env-build-VITE_API_URL");
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByTestId("env-build-suggest-VITE_API_URL")).toHaveTextContent(/prefixo VITE_/);
    expect(screen.queryByTestId("env-build-suggest-SEGREDO_DB")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("env-build-SEGREDO_DB")).getByRole("checkbox")).not.toBeChecked();
  });

  it("marcar mostra o aviso de que é pública, e o PUT leva build: true só nas marcadas", async () => {
    serve([
      { key: "VITE_API_URL", value: "https://api.example.com" },
      { key: "SEGREDO_DB", value: "x" },
    ]);
    renderEnv("dockerfile");
    const row = await screen.findByTestId("env-build-VITE_API_URL");
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(row).toHaveTextContent(/Pública: entra no JavaScript do site/);
    expect(screen.queryByTestId("env-build-suggest-VITE_API_URL")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody!.vars).toEqual([
      { key: "VITE_API_URL", value: "https://api.example.com", build: true },
      { key: "SEGREDO_DB", value: "x" },
    ]);
  });

  it("variável já marcada vem marcada do servidor e continua marcada ao salvar", async () => {
    serve([{ key: "PUBLIC_X", value: "1", build: true }]);
    renderEnv("compose");
    const row = await screen.findByTestId("env-build-PUBLIC_X");
    expect(within(row).getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody!.vars).toEqual([{ key: "PUBLIC_X", value: "1", build: true }]);
  });

  it("HTML puro e Next com servidor não têm a marca (não há build do usuário / já é automático)", async () => {
    for (const type of ["static", "node-server"]) {
      serve([{ key: "VITE_A", value: "1" }]);
      renderEnv(type);
      await screen.findByTestId("env-row-VITE_A");
      expect(screen.queryByTestId("env-build-VITE_A")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("static-node explica que só as marcadas entram no build", async () => {
    serve([]);
    renderEnv("static-node");
    expect(await screen.findByTestId("env-static-note")).toHaveTextContent(/marcar como "de build"/);
  });
});
