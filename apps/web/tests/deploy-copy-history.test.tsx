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
vi.mock("@/lib/clipboard", () => ({ copyTextLater: copyMock }));

import { DeployDetailModal } from "@/components/project/DeployDetailModal";
import { buildDeployHistoryText, stripLogControl } from "@/components/project/deploy-format";

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

beforeEach(() => {
  copied = null;
  copyMock.mockReset();
  copyMock.mockImplementation(async (p: Promise<string>) => {
    copied = p;
    await p;
    return true;
  });
  apiFetchMock.mockReset();
  // 1ª chamada: o que a tela mostra; as seguintes (clique): o log completo
  let calls = 0;
  apiFetchMock.mockImplementation(async () => ({ job: calls++ === 0 ? shown : full }));
});
afterEach(cleanup);

function abrir() {
  render(<DeployDetailModal projectId="p1" jobId="f00dcafe1234" projectName="loja" source="https://example.com/loja.git" branch="main" onClose={() => {}} />);
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

  it("log reduzido de deploy antigo: mantém a nota do servidor", () => {
    const { text } = buildDeployHistoryText(job({ log: "[… log antigo reduzido: só o final foi guardado …]\nfinal\n" }));
    expect(text).toContain("[… log antigo reduzido: só o final foi guardado …]");
  });

  it("log vazio e reinício", () => {
    const { text, lines } = buildDeployHistoryText(job({ kind: "recreate", log: "", steps: [] }));
    expect(text).toContain("Histórico do reinício");
    expect(text).toContain("(o log está vazio)");
    expect(lines).toBe(0);
  });

  it("segredo mascarado pelo servidor continua mascarado (o texto é copiado como veio)", () => {
    const { text } = buildDeployHistoryText(job({ log: "DB_PASSWORD=***\nTOKEN=••••\n" }));
    expect(text).toContain("DB_PASSWORD=***");
    expect(text).toContain("TOKEN=••••");
  });

  it("erro na cópia: mostra mensagem clara e volta a habilitar o botão", async () => {
    shown = job();
    full = job();
    copyMock.mockResolvedValue(false);
    abrir();
    const botao = await screen.findByRole("button", { name: "Copiar histórico" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível copiar o histórico");
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
      await p;
      return true;
    });
    fireEvent.click(botao);
    expect(await screen.findByRole("button", { name: "Copiando…" })).toBeDisabled();
    rejeitar(new Error("rede"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível copiar");
  });
});
