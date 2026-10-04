/**
 * Modal "Portas" — publicar porta por container e editar em lote (pedido do
 * dono, 04/10/2026: "sobre a troca de porta, não consigo trocar de cada
 * container ou em lote?"). As duas gravam a lista completa numa chamada só
 * (PUT /api/projects/:id/ports/batch).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPortEntry, ProjectPortsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { PortsModal } from "@/components/project/PortsModal";

const API_8010: ProjectPortEntry = {
  original: "127.0.0.1:8010:8010",
  containerPort: 8010,
  protocol: "tcp",
  composeHost: "127.0.0.1:8010",
  published: true,
  hostIp: "127.0.0.1",
  hostPort: 8010,
  override: null,
  panel: null,
  applied: true,
  changeable: true,
  added: false,
  composeHostPort: 8010,
  composeHostIp: "127.0.0.1",
};

const DB_5432: ProjectPortEntry = {
  ...API_8010,
  original: "5432:5432",
  containerPort: 5432,
  composeHost: "5432",
  hostIp: null,
  hostPort: 5432,
  composeHostPort: 5432,
  composeHostIp: null,
};

const ADDED_REDIS: ProjectPortEntry = {
  ...API_8010,
  original: "+127.0.0.1:16379:6379",
  containerPort: 6379,
  composeHost: "",
  hostPort: 16379,
  applied: false,
  added: true,
  composeHostPort: null,
  composeHostIp: null,
  override: { original: "+127.0.0.1:16379:6379", hostPort: 16379, hostIp: "127.0.0.1", added: { containerPort: 6379, protocol: "tcp" } },
};

function response(redisPorts: ProjectPortEntry[] = []): ProjectPortsResponse {
  const svc = (name: string, internalPorts: number[], ports: ProjectPortEntry[], extra = {}) => ({
    name,
    container: `paas-loja-${name}-1`,
    state: "running",
    health: null,
    internalPorts,
    networkModeService: null,
    publishBlocked: null,
    livePorts: [],
    ports,
    ...extra,
  });
  return {
    docker: true,
    reserved: [80, 443, 2019, 9000],
    rows: [
      { owner: "project", projectId: "p1", projectName: "Loja", container: "paas-loja-api-1", service: "api", image: "app:1", state: "running", hostIp: "127.0.0.1", hostPort: 8010, containerPort: 8010, protocol: "tcp", source: "live", conflict: false, conflictWith: null },
      { owner: "panel", projectId: null, projectName: null, container: "tws-panel", service: null, image: "tws-panel:latest", state: "running", hostIp: "127.0.0.1", hostPort: 9000, containerPort: 9000, protocol: "tcp", source: "live", conflict: false, conflictWith: null },
      { owner: "project", projectId: "p2", projectName: "Blog", container: null, service: "web", image: null, state: null, hostIp: null, hostPort: 8020, containerPort: 8020, protocol: "tcp", source: "configured", conflict: false, conflictWith: null },
    ],
    project: {
      projectId: "p1",
      projectName: "Loja",
      type: "compose",
      canChange: true,
      entry: { service: "api", port: 8010 },
      pendingDeploy: false,
      services: [
        svc("api", [8010], [API_8010]),
        svc("db", [5432], [DB_5432]),
        svc("redis", [6379], redisPorts),
        svc("web", [3200], [], { networkModeService: "api", publishBlocked: "Usa a rede do api — publique a porta no api." }),
      ],
    },
  };
}

const onClose = vi.fn();
const onDeploy = vi.fn();

function open(data: ProjectPortsResponse = response()) {
  apiFetchMock.mockResolvedValueOnce(data);
  render(<PortsModal projectId="p1" onClose={onClose} onDeploy={onDeploy} />);
}

function lastBatchBody() {
  const call = apiFetchMock.mock.calls.findLast((c) => c[0] === "/api/projects/p1/ports/batch");
  expect(call?.[1]?.method).toBe("PUT");
  return JSON.parse(call![1].body as string);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  onClose.mockReset();
  onDeploy.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe("Publicar uma porta (por container)", () => {
  it("cada serviço tem o botão; quem usa a rede de outro explica por que não", async () => {
    open();
    const redis = await screen.findByTestId("port-service-redis");
    expect(within(redis).getByRole("button", { name: /publicar uma porta/i })).toBeInTheDocument();
    expect(within(screen.getByTestId("port-service-api")).getByRole("button", { name: /adicionar outra/i })).toBeInTheDocument();
    const web = screen.getByTestId("port-service-web");
    expect(within(web).queryByRole("button", { name: /publicar|adicionar/i })).not.toBeInTheDocument();
    expect(web).toHaveTextContent("Usa a rede do api — publique a porta no api.");
  });

  it("escolhe a interna pelo atalho, sugere a do servidor, avisa do banco aberto e grava a lista completa", async () => {
    open();
    const redis = await screen.findByTestId("port-service-redis");
    fireEvent.click(within(redis).getByRole("button", { name: /publicar uma porta/i }));
    const form = screen.getByTestId("publish-form");
    expect(form).toHaveTextContent(/túnel SSH/i);
    fireEvent.click(within(form).getByRole("button", { name: "6379" }));
    expect(within(form).getByLabelText(/porta interna/i)).toHaveValue("6379");
    expect(within(form).getByLabelText(/porta do servidor/i)).toHaveValue("6379");

    fireEvent.click(within(form).getByLabelText(/em todos os endereços/i));
    expect(within(form).getByTestId("port-exposed-warning")).toHaveTextContent(/internet/i);
    expect(within(form).getByTestId("publish-db-warning")).toHaveTextContent(/Redis aberto para a internet/i);
    fireEvent.click(within(form).getByLabelText(/só no servidor/i));
    expect(within(form).queryByTestId("publish-db-warning")).not.toBeInTheDocument();
    expect(form).toHaveTextContent(/ssh -L 6379:127\.0\.0\.1:6379/);

    apiFetchMock.mockResolvedValueOnce(response([{ ...ADDED_REDIS, hostPort: 6379, original: "+127.0.0.1:6379:6379" }]));
    fireEvent.click(within(form).getByRole("button", { name: /^publicar$/i }));
    await waitFor(() =>
      expect(lastBatchBody()).toEqual({
        ports: [{ service: "redis", containerPort: 6379, protocol: "tcp", hostPort: 6379, hostIp: "127.0.0.1" }],
      }),
    );
    expect(await screen.findByTestId("ports-saved")).toHaveTextContent(/próximo deploy/i);
    expect(screen.getByTestId("port-service-redis")).toHaveTextContent(/adicionada no painel/i);
    fireEvent.click(within(screen.getByTestId("ports-saved")).getByRole("button", { name: /fazer deploy agora/i }));
    expect(onDeploy).toHaveBeenCalledOnce();
  });

  it("confere enquanto digita: porta em uso, interna inválida; a sugestão pula a ocupada", async () => {
    open();
    fireEvent.click(within(await screen.findByTestId("port-service-api")).getByRole("button", { name: /adicionar outra/i }));
    const form = screen.getByTestId("publish-form");
    fireEvent.change(within(form).getByLabelText(/porta interna/i), { target: { value: "8010" } });
    // 8010 já é do próprio api: a sugestão vai para 18010
    expect(within(form).getByLabelText(/porta do servidor/i)).toHaveValue("18010");
    fireEvent.change(within(form).getByLabelText(/porta do servidor/i), { target: { value: "8020" } });
    expect(within(form).getByTestId("publish-error")).toHaveTextContent("Blog · web");
    expect(within(form).getByRole("button", { name: /^publicar$/i })).toBeDisabled();
    // digitou a do servidor: mudar a interna não mexe mais nela
    fireEvent.change(within(form).getByLabelText(/porta interna/i), { target: { value: "0" } });
    expect(within(form).getByLabelText(/porta do servidor/i)).toHaveValue("8020");
    expect(within(form).getByTestId("publish-error")).toHaveTextContent(/porta interna/i);
    fireEvent.click(within(form).getByRole("button", { name: /cancelar/i }));
    expect(screen.queryByTestId("publish-form")).not.toBeInTheDocument();
  });

  it("adicionada: aparece marcada; Trocar abre o mesmo formulário preenchido e Remover tira da lista", async () => {
    open(response([ADDED_REDIS]));
    const redis = await screen.findByTestId("port-service-redis");
    expect(redis).toHaveTextContent("127.0.0.1:16379 → 6379");
    expect(redis).toHaveTextContent(/adicionada no painel/i);
    expect(redis).not.toHaveTextContent(/trocada no painel/i);
    expect(within(redis).getByRole("button", { name: /adicionar outra/i })).toBeInTheDocument();
    fireEvent.click(within(redis).getByRole("button", { name: /trocar/i }));
    const form = screen.getByTestId("publish-form");
    expect(within(form).getByLabelText(/porta do servidor/i)).toHaveValue("16379");
    fireEvent.change(within(form).getByLabelText(/porta do servidor/i), { target: { value: "26379" } });
    apiFetchMock.mockResolvedValueOnce(response([{ ...ADDED_REDIS, hostPort: 26379 }]));
    fireEvent.click(within(form).getByRole("button", { name: /^salvar$/i }));
    await waitFor(() =>
      expect(lastBatchBody().ports).toEqual([{ service: "redis", containerPort: 6379, protocol: "tcp", hostPort: 26379, hostIp: "127.0.0.1" }]),
    );

    fireEvent.click(within(await screen.findByTestId("port-service-redis")).getByRole("button", { name: /trocar/i }));
    apiFetchMock.mockResolvedValueOnce(response());
    fireEvent.click(within(screen.getByTestId("publish-form")).getByRole("button", { name: /remover publicação/i }));
    await waitFor(() => expect(lastBatchBody()).toEqual({ ports: [] }));
  });

  it("erro do servidor fica no formulário", async () => {
    open();
    fireEvent.click(within(await screen.findByTestId("port-service-redis")).getByRole("button", { name: /publicar uma porta/i }));
    const form = screen.getByTestId("publish-form");
    fireEvent.click(within(form).getByRole("button", { name: "6379" }));
    apiFetchMock.mockRejectedValueOnce(
      new ApiRequestError(400, "invalid_ports", "1 porta com problema.", { errors: [{ index: 0, message: "A porta 6379 do servidor já é usada por X." }] }),
    );
    fireEvent.click(within(form).getByRole("button", { name: /^publicar$/i }));
    expect(await within(form).findByTestId("publish-error")).toHaveTextContent("já é usada por X");
  });
});

describe("Editar em lote", () => {
  async function openBatch(data = response([ADDED_REDIS])) {
    open(data);
    fireEvent.click(await screen.findByRole("button", { name: /editar em lote/i }));
    return screen.getByTestId("ports-batch");
  }
  const rows = () => screen.getAllByTestId("batch-row");

  it("vira uma lista editável com todas as portas; muda várias e grava numa chamada só", async () => {
    const batch = await openBatch();
    expect(screen.queryByTestId("port-service-api")).not.toBeInTheDocument();
    expect(rows()).toHaveLength(3);
    expect(rows()[2]).toHaveTextContent(/adicionada no painel/i);

    fireEvent.change(within(rows()[0]!).getByLabelText(/porta do servidor/i), { target: { value: "18010" } });
    expect(rows()[0]).toHaveTextContent(/no compose: 127\.0\.0\.1:8010/);
    fireEvent.change(within(rows()[1]!).getByLabelText(/onde fica aberta/i), { target: { value: "127.0.0.1" } });
    fireEvent.click(within(rows()[2]!).getByRole("button", { name: /remover/i }));
    expect(rows()).toHaveLength(2);

    fireEvent.click(within(batch).getByRole("button", { name: /adicionar publicação/i }));
    const novo = rows()[2]!;
    fireEvent.change(within(novo).getByLabelText(/serviço/i), { target: { value: "redis" } });
    fireEvent.change(within(novo).getByLabelText(/porta interna/i), { target: { value: "6379" } });
    expect(within(novo).getByLabelText(/porta do servidor/i)).toHaveValue("6379");
    // quem usa a rede de outro não aparece na escolha do serviço
    expect(within(within(novo).getByLabelText(/serviço/i)).queryByRole("option", { name: "web" })).not.toBeInTheDocument();

    apiFetchMock.mockResolvedValueOnce(response([ADDED_REDIS]));
    fireEvent.click(screen.getByRole("button", { name: /salvar tudo/i }));
    await waitFor(() =>
      expect(lastBatchBody()).toEqual({
        ports: [
          { service: "api", original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" },
          { service: "db", original: "5432:5432", hostPort: 5432, hostIp: "127.0.0.1" },
          { service: "redis", containerPort: 6379, protocol: "tcp", hostPort: 6379, hostIp: "127.0.0.1" },
        ],
      }),
    );
    expect(apiFetchMock.mock.calls.filter((c) => c[0] === "/api/projects/p1/ports/batch")).toHaveLength(1);
    expect(await screen.findByTestId("ports-saved")).toBeInTheDocument();
    expect(screen.queryByTestId("ports-batch")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("ports-saved")).getByRole("button", { name: /fazer deploy agora/i }));
    expect(onDeploy).toHaveBeenCalledOnce();
  });

  it("mostra o erro na linha (conflito entre si e com outros) e não deixa salvar", async () => {
    await openBatch();
    fireEvent.change(within(rows()[0]!).getByLabelText(/porta do servidor/i), { target: { value: "16379" } });
    expect(within(rows()[0]!).getByTestId("batch-row-error")).toHaveTextContent("também está na linha de redis");
    expect(within(rows()[2]!).getByTestId("batch-row-error")).toHaveTextContent("também está na linha de api");
    expect(screen.getByRole("button", { name: /salvar tudo/i })).toBeDisabled();
    expect(screen.getByTestId("ports-batch")).toHaveTextContent(/corrija as linhas marcadas/i);
    fireEvent.change(within(rows()[0]!).getByLabelText(/porta do servidor/i), { target: { value: "8020" } });
    expect(within(rows()[0]!).getByTestId("batch-row-error")).toHaveTextContent("Blog · web");
    fireEvent.change(within(rows()[0]!).getByLabelText(/porta do servidor/i), { target: { value: "9000" } });
    expect(within(rows()[0]!).getByTestId("batch-row-error")).toHaveTextContent(/reservada ao painel/);
  });

  it("erro do servidor aparece na linha certa", async () => {
    await openBatch();
    fireEvent.change(within(rows()[1]!).getByLabelText(/porta do servidor/i), { target: { value: "15432" } });
    apiFetchMock.mockRejectedValueOnce(
      new ApiRequestError(400, "invalid_ports", "1 porta com problema. A primeira: ocupada.", {
        errors: [{ index: 1, message: "A porta 16379 do servidor já é usada por container novo." }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /salvar tudo/i }));
    expect(await within(rows()[2]!).findByTestId("batch-row-error")).toHaveTextContent("container novo");
    expect(screen.getByTestId("ports-batch-error")).toHaveTextContent("1 porta com problema");
    // mexer na linha limpa o erro do servidor
    fireEvent.change(within(rows()[2]!).getByLabelText(/porta do servidor/i), { target: { value: "26379" } });
    expect(within(rows()[2]!).queryByTestId("batch-row-error")).not.toBeInTheDocument();
  });

  it("atalhos: fechar todas para a internet e voltar tudo ao compose", async () => {
    const batch = await openBatch();
    expect(within(rows()[1]!).getByLabelText(/onde fica aberta/i)).toHaveValue("0.0.0.0");
    expect(rows()[1]).toHaveTextContent(/PostgreSQL aberto para a internet/i);
    fireEvent.click(within(batch).getByRole("button", { name: /fechar todas para a internet/i }));
    for (const r of rows()) expect(within(r).getByLabelText(/onde fica aberta/i)).toHaveValue("127.0.0.1");

    fireEvent.click(within(rows()[0]!).getByRole("button", { name: /^remover$/i }));
    expect(rows()[0]).toHaveTextContent(/publicação removida/i);
    expect(within(rows()[0]!).getByLabelText(/porta do servidor/i)).toBeDisabled();
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: /publicar de novo/i }));
    expect(within(rows()[0]!).getByLabelText(/porta do servidor/i)).not.toBeDisabled();

    fireEvent.click(within(batch).getByRole("button", { name: /voltar tudo ao compose/i }));
    expect(rows()).toHaveLength(2);
    expect(within(rows()[1]!).getByLabelText(/onde fica aberta/i)).toHaveValue("0.0.0.0");
    apiFetchMock.mockResolvedValueOnce(response());
    fireEvent.click(screen.getByRole("button", { name: /salvar tudo/i }));
    await waitFor(() => expect(lastBatchBody()).toEqual({ ports: [] }));
  });

  it("voltar uma linha ao compose e cancelar o lote", async () => {
    await openBatch();
    fireEvent.change(within(rows()[0]!).getByLabelText(/porta do servidor/i), { target: { value: "18010" } });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: /voltar ao compose/i }));
    expect(within(rows()[0]!).getByLabelText(/porta do servidor/i)).toHaveValue("8010");
    expect(within(rows()[0]!).queryByRole("button", { name: /voltar ao compose/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancelar$/i }));
    expect(screen.queryByTestId("ports-batch")).not.toBeInTheDocument();
    expect(screen.getByTestId("port-service-api")).toBeInTheDocument();
  });

  it("projeto que não troca portas não mostra os botões", async () => {
    const data = response();
    data.project.canChange = false;
    open(data);
    await screen.findByTestId("port-service-api");
    expect(screen.queryByRole("button", { name: /editar em lote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /publicar uma porta/i })).not.toBeInTheDocument();
  });
});
