/**
 * copy-agent-instructions.test.tsx — "Copiar instruções para o agente": o texto
 * (idioma, links montados por lib/links.ts, regras alinhadas ao código dos
 * guardrails), a cópia com confirmação acessível, o caminho sem API de
 * clipboard (página sem HTTPS) e os dois lugares onde o botão aparece.
 */
import fs from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale, t } from "../src/i18n";
import { buildAgentInstructions } from "../src/lib/agent-instructions";
import { agentPromptGuideUrl, composeRulesGuideUrl, docsUrl, prepareProjectGuideUrl, SITE_URL } from "../src/lib/links";
import { COPIED_FEEDBACK_MS, CopyAgentInstructions } from "@/components/CopyAgentInstructions";
import { HelpMenu } from "@/components/HelpMenu";
import { NewProjectPage } from "@/pages/NewProjectPage";

const DEPLOY_SRC = path.resolve(__dirname, "../../../packages/deploy/src");

function clip(value: Record<string, unknown> | undefined) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  clip({ writeText });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (p: string) => {
    if (p === "/api/version") return { version: "0.1.0" };
    if (p.startsWith("/api/domains/suggest")) return { auto: null, publicIp: null };
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clip(undefined);
  setLocale("pt-BR", { persist: false });
});

describe("links da documentação", () => {
  it("partem do endereço da documentação (docsUrl), no idioma da interface", () => {
    for (const locale of ["pt-BR", "en"]) {
      expect(prepareProjectGuideUrl(locale)).toBe(`${docsUrl(locale)}guides/prepare-project/`);
      expect(composeRulesGuideUrl(locale)).toBe(`${docsUrl(locale)}guides/compose-rules/`);
      expect(agentPromptGuideUrl(locale)).toBe(`${docsUrl(locale)}guides/agent-prompt/`);
    }
    expect(prepareProjectGuideUrl("pt-BR")).toBe(`${SITE_URL}/pt-br/guides/prepare-project/`);
    expect(agentPromptGuideUrl("en")).toBe(`${SITE_URL}/en/guides/agent-prompt/`);
  });
});

describe("texto das instruções", () => {
  it("pt-BR: explica o painel, traz as regras, o que entregar e os links em /pt-br/", () => {
    const text = buildAgentInstructions(t, "pt-BR");
    expect(text).toMatch(/^Vou publicar este projeto no meu TWS Panel\./);
    for (const part of ["O que é o TWS Panel", "Como o painel decide o que fazer", "Regras que o painel exige", "O que entregar"]) {
      expect(text).toContain(part);
    }
    expect(text).toContain(`Como preparar um projeto: ${prepareProjectGuideUrl("pt-BR")}`);
    expect(text).toContain(`Regras do compose (o que barra o deploy e como corrigir): ${composeRulesGuideUrl("pt-BR")}`);
    expect(text).toContain(`Instruções para agentes de IA: ${agentPromptGuideUrl("pt-BR")}`);
    expect(text).toContain(`Documentação completa: ${docsUrl("pt-BR")}`);
    expect(text).not.toContain("/en/");
    // a sintaxe do compose não é confundida com variável da tradução
    expect(text).toContain("${VAR:?mensagem}");
    expect(text).not.toMatch(/\{(prepareUrl|composeRulesUrl|agentPromptUrl|docsUrl)\}/);
  });

  it("en: todo em inglês, com os links em /en/", () => {
    const text = buildAgentInstructions(t, "en");
    // `t` segue o idioma ativo; o texto em inglês sai com o idioma da interface em inglês
    setLocale("en", { persist: false });
    const en = buildAgentInstructions(t, "en");
    expect(en).toMatch(/^I am going to publish this project on my TWS Panel\./);
    for (const part of ["What TWS Panel is", "Rules the panel requires", "What to deliver"]) expect(en).toContain(part);
    expect(en).toContain(`How to prepare a project: ${prepareProjectGuideUrl("en")}`);
    expect(en).toContain(`Instructions for AI agents: ${agentPromptGuideUrl("en")}`);
    expect(en).toContain("${VAR:?message}");
    expect(en).not.toMatch(/[ãõçáéíóú]/i);
    expect(en).not.toContain("/pt-br/");
    expect(text).not.toBe(en);
  });

  it("não leva nada da instalação: nem host fora do site da documentação, nem IP", () => {
    for (const locale of ["pt-BR", "en"]) {
      setLocale(locale, { persist: false });
      const text = buildAgentInstructions(t, locale);
      const hosts = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => new URL(m[0]).origin);
      expect(new Set(hosts)).toEqual(new Set([new URL(SITE_URL).origin]));
      // 0.0.0.0 é a instrução "escute em todas as interfaces", não endereço de ninguém
      const ips = [...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]);
      expect(ips.filter((ip) => ip !== "0.0.0.0")).toEqual([]);
    }
  });

  it("os arquivos compose citados existem na lista do painel, na mesma ordem de prioridade", () => {
    const source = fs.readFileSync(path.join(DEPLOY_SRC, "compose-files.ts"), "utf8");
    const candidates = [...source.matchAll(/"((?:docker-)?compose(?:\.[a-z]+)?\.ya?ml)"/g)].map((m) => m[1]!);
    expect(candidates.length).toBeGreaterThan(4);
    for (const locale of ["pt-BR", "en"]) {
      setLocale(locale, { persist: false });
      const detect = t("agent.text.detect");
      const cited = [...detect.matchAll(/\b((?:docker-)?compose(?:\.[a-z]+)?\.ya?ml)\b/g)].map((m) => m[1]!);
      expect(cited.length).toBeGreaterThan(4);
      const positions = cited.map((name) => candidates.indexOf(name));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  it("portas de banco e valores fracos citados são os que os guardrails conhecem", () => {
    const ports = fs.readFileSync(path.join(DEPLOY_SRC, "compose-ports.ts"), "utf8");
    const rules = fs.readFileSync(path.join(DEPLOY_SRC, "rules.ts"), "utf8");
    const weak = /const WEAK_VALUES = new Set\(\[([\s\S]*?)\]\)/.exec(rules)![1]!;
    const rulesText = t("agent.text.rules");
    for (const port of ["5432", "3306", "6379", "27017"]) {
      expect(rulesText).toContain(port);
      expect(ports).toMatch(new RegExp(`\\[${port}, "`));
    }
    for (const value of ["password", "admin", "root", "123456", "changeme"]) {
      expect(rulesText).toContain(value);
      expect(weak).toContain(`"${value}"`);
    }
  });
});

describe("botão (tela de novo projeto)", () => {
  it("copia o texto em pt-BR e confirma no botão e numa região de status", async () => {
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await screen.findByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(buildAgentInstructions(t, "pt-BR"));
    expect(screen.getByRole("status")).toHaveTextContent("Instruções copiadas. Cole na conversa com o seu agente de IA.");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("volta ao rótulo normal depois de alguns segundos", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    await screen.findByRole("button", { name: "Instruções copiadas" });
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS + 10);
    });
    expect(screen.getByRole("button", { name: "Copiar instruções para o agente" })).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("copiar de novo com a confirmação na tela recomeça a contagem", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    await screen.findByRole("button", { name: "Instruções copiadas" });
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS - 500);
    });
    fireEvent.click(screen.getByRole("button", { name: "Instruções copiadas" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // o primeiro prazo já passou, mas a segunda cópia ainda está sendo confirmada
    expect(screen.getByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
    });
    expect(screen.getByRole("button", { name: "Copiar instruções para o agente" })).toBeInTheDocument();
  });

  it("sair da tela com a confirmação na tela cancela o temporizador", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    await screen.findByRole("button", { name: "Instruções copiadas" });
    clear.mockClear();
    unmount();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("em inglês: rótulo, confirmação e texto copiado em inglês", async () => {
    setLocale("en", { persist: false });
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for your AI agent" }));
    expect(await screen.findByRole("button", { name: "Instructions copied" })).toBeInTheDocument();
    const copied = String(writeText.mock.calls[0]![0]);
    expect(copied).toMatch(/^I am going to publish this project on my TWS Panel\./);
    expect(copied).toContain(prepareProjectGuideUrl("en"));
    expect(screen.getByRole("status")).toHaveTextContent("Instructions copied. Paste them into the conversation with your AI agent.");
  });

  it("sem API de clipboard (página sem HTTPS): usa o método antigo e confirma do mesmo jeito", async () => {
    clip(undefined);
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await screen.findByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    expect(exec).toHaveBeenCalledWith("copy");
    // a caixa invisível do método antigo não fica na página
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("API de clipboard recusada: cai no método antigo", async () => {
    writeText.mockRejectedValue(new Error("NotAllowedError"));
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await screen.findByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("nada copia: mostra o texto selecionado para copiar à mão, com aviso", async () => {
    clip(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/O navegador não deixou copiar sozinho/);
    const area = screen.getByRole("textbox", { name: "Instruções para o agente de IA" }) as HTMLTextAreaElement;
    expect(area).toHaveAttribute("readonly");
    expect(area.value).toBe(buildAgentInstructions(t, "pt-BR"));
    await waitFor(() => expect(area).toHaveFocus());
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(area.value.length);
    // o botão não finge que copiou
    expect(screen.getByRole("button", { name: "Copiar instruções para o agente" })).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("depois do caminho manual, uma nova tentativa que dá certo esconde a caixa", async () => {
    clip(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CopyAgentInstructions />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    await screen.findByRole("alert");
    clip({ writeText });
    fireEvent.click(screen.getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await screen.findByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("aparece na tela de novo projeto, com a explicação", async () => {
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    const block = screen.getByTestId("new-project-agent");
    expect(block).toHaveTextContent(/Vai preparar o projeto com um agente de IA/);
    fireEvent.click(within(block).getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await within(block).findByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe("item do menu de Ajuda", () => {
  it("fica no painel de ajuda, copia e confirma sem fechar o painel", async () => {
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Ajuda e feedback" }));
    const dialog = screen.getByRole("dialog", { name: "Ajuda e feedback" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar instruções para o agente" }));
    expect(await within(dialog).findByRole("button", { name: "Instruções copiadas" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(buildAgentInstructions(t, "pt-BR"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("em inglês, o item e o texto seguem o idioma", async () => {
    setLocale("en", { persist: false });
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Help and feedback" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy instructions for your AI agent" }));
    await screen.findByRole("button", { name: "Instructions copied" });
    expect(String(writeText.mock.calls[0]![0])).toContain(agentPromptGuideUrl("en"));
  });

  it("sem cópia automática, a caixa aparece dentro do painel e o foco nela não o fecha", async () => {
    clip(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Ajuda e feedback" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar instruções para o agente" }));
    const area = await within(dialog).findByRole("textbox", { name: "Instruções para o agente de IA" });
    await waitFor(() => expect(area).toHaveFocus());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
