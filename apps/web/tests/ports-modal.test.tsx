/**
 * Modal "Portas" da página do projeto (pedido do dono, 03/10/2026): as portas
 * deste projeto (internas, publicadas, entrada HTTP) com "Trocar", e todas as
 * portas do servidor numa tabela ordenável, com busca e conflitos marcados.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPortsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { PortsModal } from "@/components/project/PortsModal";

function response(extra: Partial<ProjectPortsResponse["project"]> = {}, top: Partial<ProjectPortsResponse> = {}): ProjectPortsResponse {
  return {
    docker: true,
    reserved: [80, 443, 2019, 9000],
    rows: [
      { owner: "project", projectId: "p1", projectName: "Loja", container: "paas-loja-api-1", service: "api", image: "app:1", state: "running", hostIp: "127.0.0.1", hostPort: 8010, containerPort: 8010, protocol: "tcp", source: "live", conflict: false, conflictWith: null },
      { owner: "project", projectId: "p1", projectName: "Loja", container: "paas-loja-db-1", service: "db", image: "postgres:16", state: "running", hostIp: null, hostPort: 5432, containerPort: 5432, protocol: "tcp", source: "live", conflict: false, conflictWith: null },
      { owner: "panel", projectId: null, projectName: null, container: "tws-panel", service: null, image: "tws-panel:latest", state: "running", hostIp: "127.0.0.1", hostPort: 9000, containerPort: 9000, protocol: "tcp", source: "live", conflict: false, conflictWith: null },
      { owner: "external", projectId: null, projectName: null, container: "outro-app", service: null, image: "nginx:1", state: "running", hostIp: null, hostPort: 8020, containerPort: 80, protocol: "tcp", source: "live", conflict: true, conflictWith: "Blog · web" },
      { owner: "project", projectId: "p2", projectName: "Blog", container: null, service: "web", image: null, state: null, hostIp: null, hostPort: 8020, containerPort: 8020, protocol: "tcp", source: "configured", conflict: true, conflictWith: "container outro-app" },
    ],
    project: {
      projectId: "p1",
      projectName: "Loja",
      type: "compose",
      canChange: true,
      entry: { service: "api", port: 3000 },
      pendingDeploy: false,
      services: [
        {
          name: "api",
          container: "paas-loja-api-1",
          state: "running",
          health: "healthy",
          internalPorts: [80, 3000, 8010],
          networkModeService: null,
          livePorts: [{ hostIp: "127.0.0.1", hostPort: 8010, containerPort: 8010, protocol: "tcp" }],
          ports: [
            { original: "127.0.0.1:8010:8010", containerPort: 8010, protocol: "tcp", composeHost: "127.0.0.1:8010", published: true, hostIp: "127.0.0.1", hostPort: 8010, override: null, panel: null, applied: true, changeable: true },
            { original: "80:80", containerPort: 80, protocol: "tcp", composeHost: "80", published: false, hostIp: null, hostPort: null, override: null, panel: "removed", applied: true, changeable: false },
          ],
        },
        {
          name: "db",
          container: "paas-loja-db-1",
          state: "exited",
          health: null,
          internalPorts: [5432],
          networkModeService: null,
          livePorts: [],
          ports: [
            { original: "5432:5432", containerPort: 5432, protocol: "tcp", composeHost: "5432", published: true, hostIp: null, hostPort: 5432, override: null, panel: null, applied: null, changeable: true },
          ],
        },
      ],
      ...extra,
    },
    ...top,
  };
}

const onClose = vi.fn();
const onDeploy = vi.fn();

function open(data: ProjectPortsResponse = response()) {
  apiFetchMock.mockResolvedValueOnce(data);
  render(<PortsModal projectId="p1" onClose={onClose} onDeploy={onDeploy} />);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  onClose.mockReset();
  onDeploy.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe("aba Este projeto", () => {
  it("consulta uma vez e mostra serviços, portas internas, publicadas e a entrada HTTP", async () => {
    open();
    expect(await screen.findByTestId("port-service-api")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/ports");
    expect(screen.getByText(/Porta interna é onde o app escuta dentro do container; só muda no código do app/)).toBeInTheDocument();
    expect(screen.getByText(/Porta publicada é a porta do servidor que leva até ele; o painel pode trocar/)).toBeInTheDocument();
    expect(screen.getByTestId("ports-entry")).toHaveTextContent("api:3000");
    const api = screen.getByTestId("port-service-api");
    expect(api).toHaveTextContent("saudável");
    expect(api).toHaveTextContent(/internas: 80, 3000, 8010/i);
    expect(api).toHaveTextContent("127.0.0.1:8010 → 8010");
    expect(api).toHaveTextContent(/o painel retira/i);
    expect(within(api).getAllByRole("button", { name: /trocar/i })).toHaveLength(1);
    const db = screen.getByTestId("port-service-db");
    expect(db).toHaveTextContent("parado");
    expect(db).toHaveTextContent(/aberta a todos os endereços/i);
    // a aba Todos usa os mesmos dados: nenhuma consulta nova
    fireEvent.click(screen.getByRole("tab", { name: /todos os projetos/i }));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("troca a porta: confere antes, avisa sobre todos os endereços e salva", async () => {
    open();
    const api = await screen.findByTestId("port-service-api");
    fireEvent.click(within(api).getByRole("button", { name: /trocar/i }));
    const input = screen.getByLabelText(/nova porta do servidor/i);
    fireEvent.change(input, { target: { value: "5432" } });
    expect(screen.getByTestId("port-form-error")).toHaveTextContent(/Loja · db/);
    expect(screen.getByRole("button", { name: /salvar troca/i })).toBeDisabled();
    fireEvent.change(input, { target: { value: "18010" } });
    expect(screen.queryByTestId("port-form-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/em todos os endereços/i));
    expect(screen.getByTestId("port-exposed-warning")).toHaveTextContent(/internet/i);
    expect(screen.getByTestId("port-exposed-warning")).toHaveTextContent(/UFW/);

    const saved = response({ pendingDeploy: true });
    saved.project.services[0]!.ports[0] = {
      ...saved.project.services[0]!.ports[0]!,
      hostIp: null,
      hostPort: 18010,
      applied: false,
      override: { original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" },
    };
    apiFetchMock.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole("button", { name: /salvar troca/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/ports", {
        method: "PUT",
        body: JSON.stringify({ service: "api", original: "127.0.0.1:8010:8010", action: "change", hostPort: 18010, hostIp: "0.0.0.0" }),
      }),
    );
    expect(await screen.findByTestId("ports-pending")).toHaveTextContent(/próximo deploy/i);
    expect(screen.getByTestId("port-service-api")).toHaveTextContent("0.0.0.0:18010 → 8010");
    expect(screen.getByTestId("port-service-api")).toHaveTextContent(/trocada no painel/i);
    expect(screen.getByTestId("port-service-api")).toHaveTextContent(/vale no próximo deploy/i);
    fireEvent.click(screen.getByRole("button", { name: /fazer deploy agora/i }));
    expect(onDeploy).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("manter a mesma porta manda só o endereço", async () => {
    open();
    fireEvent.click(within(await screen.findByTestId("port-service-db")).getByRole("button", { name: /trocar/i }));
    apiFetchMock.mockResolvedValueOnce(response());
    fireEvent.click(screen.getByRole("button", { name: /salvar troca/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith("/api/projects/p1/ports", {
        method: "PUT",
        body: JSON.stringify({ service: "db", original: "5432:5432", action: "change", hostIp: "127.0.0.1" }),
      }),
    );
  });

  it("remover publicação e voltar ao compose", async () => {
    const withOverride = response();
    withOverride.project.services[1]!.ports[0] = {
      ...withOverride.project.services[1]!.ports[0]!,
      override: { original: "5432:5432", hostPort: 15432, hostIp: "127.0.0.1" },
    };
    open(withOverride);
    fireEvent.click(within(await screen.findByTestId("port-service-db")).getByRole("button", { name: /trocar/i }));
    apiFetchMock.mockResolvedValueOnce(withOverride);
    fireEvent.click(screen.getByRole("button", { name: /voltar ao compose/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith("/api/projects/p1/ports", {
        method: "PUT",
        body: JSON.stringify({ service: "db", original: "5432:5432", action: "reset" }),
      }),
    );
    fireEvent.click(within(screen.getByTestId("port-service-db")).getByRole("button", { name: /trocar/i }));
    apiFetchMock.mockResolvedValueOnce(response());
    fireEvent.click(screen.getByRole("button", { name: /remover publicação/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith("/api/projects/p1/ports", {
        method: "PUT",
        body: JSON.stringify({ service: "db", original: "5432:5432", action: "remove" }),
      }),
    );
  });

  it("erro do servidor fica no formulário", async () => {
    open();
    fireEvent.click(within(await screen.findByTestId("port-service-api")).getByRole("button", { name: /trocar/i }));
    fireEvent.change(screen.getByLabelText(/nova porta do servidor/i), { target: { value: "18010" } });
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(409, "port_in_use", "A porta 18010 do servidor já é usada por X."));
    fireEvent.click(screen.getByRole("button", { name: /salvar troca/i }));
    expect(await screen.findByTestId("port-form-error")).toHaveTextContent("já é usada por X");
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(screen.queryByLabelText(/nova porta do servidor/i)).not.toBeInTheDocument();
  });

  it("ordena por porta e por estado, e lembra a escolha", async () => {
    open();
    await screen.findByTestId("port-service-api");
    const order = () => screen.getAllByTestId(/^port-service-/).map((el) => el.getAttribute("data-testid"));
    expect(order()).toEqual(["port-service-api", "port-service-db"]);
    fireEvent.click(screen.getByRole("button", { name: /^porta/i }));
    expect(order()).toEqual(["port-service-db", "port-service-api"]);
    fireEvent.click(screen.getByRole("button", { name: /^porta/i }));
    expect(order()).toEqual(["port-service-api", "port-service-db"]);
    fireEvent.click(screen.getByRole("button", { name: /^estado/i }));
    expect(JSON.parse(localStorage.getItem("paas.ports.sort.project")!)).toEqual({ key: "state", dir: "asc" });
  });

  it("projeto sem compose: portas no ar, sem trocar", async () => {
    open(
      response({
        type: "dockerfile",
        canChange: false,
        entry: { service: null, port: 8080 },
        services: [
          { name: "paas-site", container: "paas-site", state: "running", health: null, internalPorts: [8080], networkModeService: null, ports: [], livePorts: [{ hostIp: "127.0.0.1", hostPort: 18080, containerPort: 8080, protocol: "tcp" }] },
        ],
      }),
    );
    const svc = await screen.findByTestId("port-service-paas-site");
    expect(svc).toHaveTextContent("127.0.0.1:18080 → 8080");
    expect(within(svc).queryByRole("button", { name: /trocar/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("ports-cannot-change")).toHaveTextContent(/só vale para projetos compose/i);
    expect(screen.getByTestId("ports-entry")).toHaveTextContent("porta 8080");
  });

  it("compose sem o código no servidor e Docker fora do ar: avisos", async () => {
    open(response({ canChange: false, services: [] }, { docker: false }));
    expect(await screen.findByTestId("ports-cannot-change")).toHaveTextContent(/primeiro deploy/i);
    expect(screen.getByTestId("ports-docker-down")).toBeInTheDocument();
  });

  it("falha ao carregar: mensagem e fechar", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("sem conexão"));
    render(<PortsModal projectId="p1" onClose={onClose} />);
    expect(await screen.findByText("sem conexão")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("aba Todos os projetos", () => {
  async function openAll() {
    open();
    await screen.findByTestId("port-service-api");
    fireEvent.click(screen.getByRole("tab", { name: /todos os projetos/i }));
    return screen.getByTestId("ports-table");
  }

  it("tabela com projeto, container, imagem, estado e porta; conflitos marcados", async () => {
    const table = await openAll();
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(table).toHaveTextContent("Painel");
    expect(table).toHaveTextContent("Externo");
    expect(table).toHaveTextContent("nginx:1");
    expect(screen.getByTestId("ports-conflicts")).toHaveTextContent(/2 portas em conflito/i);
    const conflicts = within(table).getAllByTestId("row-conflict");
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toHaveTextContent(/conflito com/i);
    expect(table).toHaveTextContent(/próximo deploy/i);
    // lista empilhada do celular com as mesmas linhas
    expect(within(screen.getByTestId("ports-list")).getAllByRole("listitem")).toHaveLength(5);
  });

  it("ordena clicando no cabeçalho e lembra; busca filtra", async () => {
    const table = await openAll();
    const firstContainer = () => within(table).getAllByRole("row")[1]!.textContent;
    fireEvent.click(within(table).getByRole("button", { name: /^porta/i }));
    expect(firstContainer()).toContain("5432");
    fireEvent.click(within(table).getByRole("button", { name: /^porta/i }));
    expect(firstContainer()).toContain("9000");
    expect(JSON.parse(localStorage.getItem("paas.ports.sort.all")!)).toEqual({ key: "port", dir: "desc" });
    fireEvent.click(within(table).getByRole("button", { name: /^container/i }));
    expect(firstContainer()).toContain("outro-app");
    fireEvent.click(within(table).getByRole("button", { name: /^estado/i }));
    fireEvent.click(within(table).getByRole("button", { name: /^projeto/i }));
    expect(firstContainer()).toContain("Blog");

    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: "nginx" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: "zzz" } });
    expect(screen.getByText(/nenhuma porta encontrada/i)).toBeInTheDocument();
  });

  it("ordenação salva é usada ao abrir", async () => {
    localStorage.setItem("paas.ports.sort.all", JSON.stringify({ key: "port", dir: "desc" }));
    const table = await openAll();
    expect(within(table).getAllByRole("row")[1]!.textContent).toContain("9000");
  });
});

describe("fechar", () => {
  it("pelo X e pela tecla Esc", async () => {
    open();
    await screen.findByTestId("port-service-api");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
