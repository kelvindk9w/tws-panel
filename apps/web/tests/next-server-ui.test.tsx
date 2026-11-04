/**
 * next-server-ui.test.tsx — Next.js com servidor (type node-server) na tela:
 * rótulo do tipo, assistente de criação (porta e avisos de NEXT_PUBLIC_ e
 * memória), visão geral do projeto, nota nas Variáveis e idioma en.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectResult } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { NextServerNotes } from "@/components/project/NextServerNotes";
import { ProjectOverview } from "@/components/project/ProjectOverview";
import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { NewProjectPage } from "@/pages/NewProjectPage";
import { nextjsGuideUrl } from "@/lib/links";

const DETECTION: DetectResult = {
  type: "node-server",
  composeFile: null,
  outputDir: null,
  packageManager: "pnpm",
  buildCommand: "pnpm build",
  proxyService: null,
  proxyPort: 3000,
  nodeServer: { framework: "next", standalone: true, nodeMajor: 22, nodeSource: "engines", lockfile: true },
  warnings: [],
  details: ["Next.js com servidor"],
};
const project = (over: Record<string, unknown> = {}) =>
  ({
    id: "p1",
    name: "loja",
    slug: "loja",
    ingestMode: "git",
    source: "x",
    branch: "main",
    domain: "loja.example.com",
    websocket: false,
    detection: DETECTION,
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastDeployAt: null,
    lastDeployStatus: null,
    ...over,
  }) as never;

beforeEach(() => {
  setLocale("pt-BR", { persist: false });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/projects" && method === "POST") return { project: { id: "p1", domain: "loja.localhost", name: "loja" } };
    if (path === "/api/projects/p1/detect") return { detection: DETECTION };
    if (path.startsWith("/api/domains/suggest")) return { auto: "loja.localhost", publicIp: null };
    if (path.includes("/https")) return { domains: [] };
    if (path.includes("/email")) return { email: null };
    if (path.includes("/env")) return { vars: [], compose: null, provided: [], links: {} };
    return { containers: [] };
  });
});
afterEach(() => {
  cleanup();
  setLocale("pt-BR", { persist: false });
});

describe("NextServerNotes", () => {
  it("mostra Node, gerenciador, lockfile, standalone, a nota de NEXT_PUBLIC_ e a de memória", () => {
    render(<NextServerNotes detection={DETECTION} port={3000} />);
    expect(screen.getByTestId("next-node")).toHaveTextContent("Node 22 (vindo de engines.node do package.json)");
    expect(screen.getByTestId("next-manager")).toHaveTextContent("Gerenciador: pnpm");
    expect(screen.getByTestId("next-lockfile")).toHaveTextContent("Instalação congelada pelo lockfile");
    expect(screen.getByTestId("next-standalone")).toHaveTextContent("node server.js");
    expect(screen.getByTestId("next-port")).toHaveTextContent("3000");
    expect(screen.getByTestId("next-public-note")).toHaveTextContent(/NEXT_PUBLIC_.*qualquer visitante pode lê-las.*Nunca ponha segredo/s);
    expect(screen.getByTestId("next-public-note")).toHaveTextContent(/reiniciar não basta/);
    expect(screen.getByTestId("next-memory-note")).toHaveTextContent(/sem memória.*swap de 2 GB/s);
    expect(screen.getByRole("link", { name: /Guia de Next\.js/ })).toHaveAttribute("href", nextjsGuideUrl("pt-BR"));
  });

  it("sem lockfile e sem standalone: avisos próprios; sem porta, a linha some", () => {
    const sem: DetectResult = {
      ...DETECTION,
      nodeServer: { framework: "next", standalone: false, nodeMajor: 24, nodeSource: "default", lockfile: false },
    };
    render(<NextServerNotes detection={sem} port={null} />);
    expect(screen.getByTestId("next-node")).toHaveTextContent("Node 24 (vindo de padrão do painel (LTS))");
    expect(screen.getByTestId("next-lockfile")).toHaveTextContent("Sem lockfile");
    expect(screen.getByTestId("next-standalone")).toHaveTextContent(/next start.*standalone/s);
    expect(screen.queryByTestId("next-port")).not.toBeInTheDocument();
  });

  it.each([
    ["nvmrc", ".nvmrc"],
    ["node-version", ".node-version"],
  ] as const)("fonte %s", (source, label) => {
    const d: DetectResult = { ...DETECTION, packageManager: null, nodeServer: { ...DETECTION.nodeServer!, nodeSource: source } };
    render(<NextServerNotes detection={d} port={null} />);
    expect(screen.getByTestId("next-node")).toHaveTextContent(`(vindo de ${label})`);
    expect(screen.getByTestId("next-manager")).toHaveTextContent("Gerenciador: npm");
  });

  it("detecção antiga sem nodeServer: só as notas gerais", () => {
    const { nodeServer: _omit, ...velha } = DETECTION;
    render(<NextServerNotes detection={velha} port={3000} />);
    expect(screen.queryByTestId("next-node")).not.toBeInTheDocument();
    expect(screen.getByTestId("next-public-note")).toBeInTheDocument();
  });

  it("em inglês: textos e link do guia em inglês", () => {
    setLocale("en", { persist: false });
    render(<NextServerNotes detection={DETECTION} port={3000} />);
    expect(screen.getByTestId("next-node")).toHaveTextContent("Node 22 (from engines.node in package.json)");
    expect(screen.getByTestId("next-public-note")).toHaveTextContent(/any visitor can read them.*Never put a secret/s);
    expect(screen.getByTestId("next-memory-note")).toHaveTextContent(/ran out of memory.*2 GB swap/s);
    expect(screen.getByRole("link", { name: /Next\.js guide/ })).toHaveAttribute("href", nextjsGuideUrl("en"));
    expect(nextjsGuideUrl("en")).toMatch(/\/en\/guides\/nextjs\/$/);
    expect(nextjsGuideUrl("pt-BR")).toMatch(/\/pt-br\/guides\/nextjs\/$/);
  });
});

function preencherGit() {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
    target: { value: "https://github.com/usuario/loja" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
}

describe("Assistente de novo projeto — Next.js (servidor)", () => {
  it("rotula o tipo, mostra a porta 3000 editável e as notas de NEXT_PUBLIC_ e de memória", async () => {
    preencherGit();
    const bloco = await screen.findByTestId("wizard-next-server");
    expect(screen.getByText("Next.js (servidor)", { selector: "[data-slot='badge'], div, span" })).toBeInTheDocument();
    expect(within(bloco).getByLabelText("Porta do servidor")).toHaveValue("3000");
    expect(within(bloco).getByTestId("next-public-note")).toBeInTheDocument();
    expect(within(bloco).getByTestId("next-memory-note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continuar/ })).toBeEnabled();
  });

  it("porta inválida bloqueia o Continuar; vazia e válida liberam", async () => {
    preencherGit();
    const campo = await screen.findByLabelText("Porta do servidor");
    for (const ruim of ["abc", "0", "70000", "30 00"]) {
      fireEvent.change(campo, { target: { value: ruim } });
      expect(screen.getByRole("button", { name: /Continuar/ }), ruim).toBeDisabled();
    }
    for (const boa of ["8080", "", "65535"]) {
      fireEvent.change(campo, { target: { value: boa } });
      expect(screen.getByRole("button", { name: /Continuar/ }), boa).toBeEnabled();
    }
  });

  it("outros tipos não mostram o bloco do Next.js", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects" && (init?.method ?? "GET") === "POST") return { project: { id: "p1", domain: "loja.localhost", name: "loja" } };
      if (path === "/api/projects/p1/detect") return { detection: { ...DETECTION, type: "dockerfile", nodeServer: undefined } };
      return {};
    });
    preencherGit();
    await screen.findByText(/Tipo detectado/);
    expect(screen.queryByTestId("wizard-next-server")).not.toBeInTheDocument();
  });

  it("em inglês o rótulo do tipo é Next.js (server)", async () => {
    setLocale("en", { persist: false });
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("my-app"), { target: { value: "loja" } });
    fireEvent.click(screen.getByRole("button", { name: /Git repository/ }));
    fireEvent.change(screen.getByPlaceholderText("https://github.com/user/repo.git"), {
      target: { value: "https://github.com/usuario/loja" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create and detect/ }));
    await screen.findByTestId("wizard-next-server");
    expect(screen.getByText("Next.js (server)", { selector: "[data-slot='badge'], div, span" })).toBeInTheDocument();
    expect(screen.getByLabelText("Server port")).toHaveValue("3000");
  });
});

describe("Visão geral do projeto — Next.js (servidor)", () => {
  const overview = (p = project()) =>
    render(
      <MemoryRouter>
        <ProjectOverview project={p} status="running" containers={[]} jobs={[]} latestJob={null} onOpenJob={() => {}} />
      </MemoryRouter>,
    );

  it("mostra o tipo, a porta da detecção e as notas", async () => {
    overview();
    const card = await screen.findByTestId("overview-next-server");
    expect(within(card).getByTestId("next-port")).toHaveTextContent("3000");
    expect(within(card).getByTestId("next-public-note")).toBeInTheDocument();
    expect(screen.getByText("Next.js (servidor)", { selector: "[class*='text-base']" })).toBeInTheDocument();
  });

  it("a porta do campo do projeto vence a detectada", async () => {
    overview(project({ proxyPort: 8080 }));
    expect(await screen.findByTestId("next-port")).toHaveTextContent("8080");
  });

  it("outros tipos não têm o cartão", () => {
    overview(project({ detection: { ...DETECTION, type: "static", nodeServer: undefined } }));
    expect(screen.queryByTestId("overview-next-server")).not.toBeInTheDocument();
  });
});

describe("Variáveis — nota do Next.js", () => {
  it("projeto node-server mostra a nota de NEXT_PUBLIC_; outros tipos não", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <ProjectEnvCard project={project()} />
      </MemoryRouter>,
    );
    const nota = await screen.findByTestId("env-next-note");
    expect(nota).toHaveTextContent(/NEXT_PUBLIC_.*nunca ponha segredo nelas.*novo deploy/si);
    rerender(
      <MemoryRouter>
        <ProjectEnvCard project={project({ detection: { ...DETECTION, type: "dockerfile" } })} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByTestId("env-next-note")).not.toBeInTheDocument());
  });
});
