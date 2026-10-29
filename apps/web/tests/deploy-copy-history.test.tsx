/**
 * Botão "Copiar histórico" do detalhe do deploy: copia o log completo (buscado
 * no servidor na hora), sem cores, com cabeçalho de diagnóstico.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_LOG_MAX_CHARS, type DeployJob } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
const copyMock = vi.hoisted(() => vi.fn());
const copyNowMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyTextLater: copyMock, copyText: copyNowMock }));

import { DeployDetailModal } from "@/components/project/DeployDetailModal";
import { ApiRequestError } from "@/lib/api";
import { buildDeployHistoryText, safeGitSource, stripLogControl } from "@/components/project/deploy-format";

function job(over: Partial<DeployJob> = {}): DeployJob {
  return {
    id: "f00dcafe1234",
    projectId: "p1",
    status: "success",
    createdAt: "2026-10-29T10:00:00.000Z",
    startedAt: "2026-10-29T10:00:00.000Z",
    finishedAt: "2026-10-29T10:01:12.000Z",
    steps: [{ name: "Build", status: "done" }],
    log: "linha 1\nlinha 2\n",
    error: null,
    ...over,
  };
}

let shown: DeployJob;
let full: DeployJob;
let copied: Promise<string> | null;

function modernClipboard(on: boolean) {
  vi.stubGlobal("ClipboardItem", on ? class {} : undefined);
  Object.defineProperty(navigator, "clipboard", { value: on ? { write: vi.fn() } : undefined, configurable: true });
}

beforeEach(() => {
  modernClipboard(true);
  copyNowMock.mockReset();
  copyNowMock.mockResolvedValue(true);
  copied = null;
  copyMock.mockReset();
  copyMock.mockImplementation(async (p: Promise<string>) => {
    copied = p;
    return p.then(() => true, () => false);
  });
  apiFetchMock.mockReset();
  // 1ª chamada: o que a tela mostra; as seguintes (clique): o log completo
  let calls = 0;
  apiFetchMock.mockImplementation(async () => ({ job: calls++ === 0 ? shown : full }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function abrir() {
  render(<DeployDetailModal projectId="p1" jobId="f00dcafe1234" projectName="loja" ingestMode="git" source="https://example.com/loja.git" branch="main" onClose={() => {}} />);
}

describe("Copiar histórico", () => {
  it("copia o log completo do servidor (maior que o exibido), com cabeçalho e aviso de linhas", async () => {
    shown = job({ log: "so a parte\n" });
    full = job({ log: "a\nb\nc\nd\n" });
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
    expect(await screen.findByRole("status")).toHaveTextContent("Histórico copiado: 4 linhas.");
    const text = await copied!;
    expect(text).toContain("Projeto: loja");
    expect(text).toContain("Id: f00dcafe1234");
    expect(text).toContain("Status: sucesso");
    expect(text).toContain("Origem: https://example.com/loja.git");
    expect(text).toContain("Branch: main");
    expect(text).toContain("\na\nb\nc\nd\n");
    expect(text).not.toContain("so a parte");
  });

  it("falha: cabeçalho com status e mensagem de erro final", () => {
    const { text } = buildDeployHistoryText(job({ status: "failed", error: "Build falhou (exit 1)" }));
    expect(text).toContain("Status: falhou");
    expect(text).toContain("Erro: Build falhou (exit 1)");
  });

  it("em andamento: avisa que o log pode estar incompleto", () => {
    const { text } = buildDeployHistoryText(job({ status: "running", finishedAt: null }), {}, Date.parse("2026-10-29T10:00:30Z"));
    expect(text).toContain("Status: em andamento");
    expect(text).toContain("Fim: em andamento (até agora 30s)");
    expect(text).toContain("ainda estava em andamento");
  });

  it("remove cores ANSI e caracteres de controle; barra de progresso fica com o último trecho", () => {
    expect(stripLogControl("\u001b[31mvermelho\u001b[0m ok\u0007\r\n10%\r50%\rpronto\n\u001b]0;titulo\u0007fim")).toBe("vermelho ok\npronto\nfim");
    const { text, lines } = buildDeployHistoryText(job({ log: "\u001b[32mverde\u001b[0m\n" }));
    expect(text).toContain("\nverde\n");
    expect(text).not.toContain("\u001b");
    expect(lines).toBe(1);
  });

  it("log cortado pelo limite: diz que o início foi cortado", () => {
    const { text } = buildDeployHistoryText(job({ log: "x".repeat(DEPLOY_LOG_MAX_CHARS) }));
    expect(text).toContain("o início do log foi cortado pelo limite");
  });

    it("log vazio e reinício", () => {
    const { text, lines } = buildDeployHistoryText(job({ kind: "recreate", log: "", steps: [] }));
    expect(text).toContain("Histórico do reinício");
    expect(text).toContain("(o log está vazio)");
    expect(lines).toBe(0);
  });

  it("o log é copiado como a tela mostra (sem ocultar nem revelar nada)", () => {
    const { text } = buildDeployHistoryText(job({ log: "DB_PASSWORD=***\nTOKEN=••••\n" }));
    expect(text).toContain("DB_PASSWORD=***");
    expect(text).toContain("TOKEN=••••");
  });

  it("origem git nunca leva usuário, senha ou token", () => {
    for (const src of ["https://u:ghp_SECRET@github.com/a/b.git", "https://ghp_SECRET@github.com/a/b.git?token=x#y", "ssh://git:SEGREDO@example.com/a/b.git"]) {
      const { text } = buildDeployHistoryText(job(), { ingestMode: "git", source: src });
      expect(text).toContain("Origem: ");
      expect(text).not.toMatch(/SECRET|SEGREDO|token=/);
    }
    expect(safeGitSource("git@example.com:a/b.git")).toBe("example.com:a/b.git");
    expect(safeGitSource("user:tok@example.com:a/b.git")).toBe("example.com:a/b.git");
    expect(safeGitSource("https://example.com/a/b.git")).toBe("https://example.com/a/b.git");
    expect(safeGitSource("lixo sem formato")).toBeNull();
    expect(buildDeployHistoryText(job(), { ingestMode: "git", source: "lixo sem formato" }).text).not.toContain("Origem");
  });

  it("upload e pasta existente mostram só o tipo, nunca o caminho da VPS", () => {
    const up = buildDeployHistoryText(job(), { ingestMode: "upload", source: "/srv/paas/uploads/loja" }).text;
    expect(up).toContain("Origem: upload de arquivos");
    expect(up).not.toContain("/srv");
    expect(buildDeployHistoryText(job(), { ingestMode: "existing", source: "/home/app" }).text).toContain("Origem: pasta já existente na VPS");
  });

  it("\\r no fim da linha não apaga o texto", () => {
    expect(stripLogControl("texto\r")).toBe("texto");
    expect(stripLogControl("Step 1/5\r")).toBe("Step 1/5");
    expect(stripLogControl("a\r\r\n")).toBe("a\n");
    expect(stripLogControl("0%\r50%\r100%\n")).toBe("100%\n");
  });

  it("datas do cabeçalho levam o fuso", () => {
    const { text } = buildDeployHistoryText(job());
    expect(text).toMatch(/Início: .*\d{2}:\d{2}:\d{2} \S+/);
    expect(text).toMatch(/Fim: .*\d{2}:\d{2}:\d{2} \S+ \(duração/);
  });

  it("na fila é diferente de em andamento", () => {
    const { text } = buildDeployHistoryText(job({ status: "queued", startedAt: null, finishedAt: null }));
    expect(text).toContain("Status: na fila");
  });

  it("limite com separador de milhar e nota de log antigo no idioma da tela", () => {
    const lim = buildDeployHistoryText(job({ log: "x".repeat(DEPLOY_LOG_MAX_CHARS) })).text;
    expect(lim).toContain("400.000");
    const old = buildDeployHistoryText(job({ log: "[… log antigo reduzido: só o final foi guardado …]\nfinal\n" }));
    expect(old.text).toContain("deploys antigos guardam só o final");
    expect(old.lines).toBe(1);
  });

  it("sem API moderna de clipboard: copia na hora o log da tela, sem buscar, e avisa", async () => {
    modernClipboard(false);
    shown = job({ log: "da tela\n" });
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    apiFetchMock.mockClear();
    fireEvent.click(botao);
    expect(await screen.findByRole("status")).toHaveTextContent("Histórico copiado: 1 linha.");
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(copyMock).not.toHaveBeenCalled();
    expect(copyNowMock.mock.calls[0]![0]).toContain("pode não ser o mais recente");
    expect(copyNowMock.mock.calls[0]![0]).toContain("da tela");
  });

  it("sem API moderna e cópia recusada: mensagem de recusa", async () => {
    modernClipboard(false);
    copyNowMock.mockResolvedValue(false);
    shown = job();
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
    expect(await screen.findByRole("alert")).toHaveTextContent("O navegador recusou a cópia");
  });

  it("deploy que saiu do histórico (404): mensagem própria", async () => {
    shown = job();
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    apiFetchMock.mockRejectedValue(new ApiRequestError(404, "job_not_found", "x"));
    fireEvent.click(botao);
    expect(await screen.findByRole("alert")).toHaveTextContent("Este deploy não foi encontrado");
  });

  it("erro na cópia: mostra mensagem clara e volta a habilitar o botão", async () => {
    shown = job();
    full = job();
    copyMock.mockResolvedValue(false);
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
    expect(await screen.findByRole("alert")).toHaveTextContent("O navegador recusou a cópia");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copiar histórico" })).not.toBeDisabled());
  });

  it("erro ao buscar o log: mensagem de erro; durante a cópia o botão diz Copiando…", async () => {
    shown = job();
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    let rejeitar!: (e: Error) => void;
    apiFetchMock.mockImplementation(() => new Promise((_, rej) => (rejeitar = rej)));
    copyMock.mockImplementation(async (p: Promise<string>) => {
      return p.then(() => true, () => false);
    });
    fireEvent.click(botao);
    expect(await screen.findByRole("button", { name: "Copiando…" })).toBeDisabled();
    rejeitar(new Error("rede"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível buscar o log");
  });
});
