/**
 * Serviços do compose na tela (assistente e Visão geral). Validação real
 * (cassino, 03/10/2026): a detecção mostrava só "serviço web / porta", e não
 * dava para entender por que a entrada era wallet:80 nem o que subia junto.
 * Agora: todos os serviços, a entrada HTTP em destaque com a explicação do
 * network_mode, o estado de cada container e a escolha da entrada.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { CASSINO_SERVICES } from "./fixtures/compose-services";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ComposeServicesCard, ComposeServicesList } from "@/components/project/ComposeServices";

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(cleanup);

function container(service: string, state: string, health: DockerContainerInfo["health"], status = "Up"): DockerContainerInfo {
  return {
    id: service,
    name: `paas-loja-${service}-1`,
    image: "x",
    state,
    status,
    managed: true,
    projectSlug: "loja",
    composeProject: "paas-loja",
    service,
    health,
    ports: [],
  };
}

describe("ComposeServicesList", () => {
  it("lista todos os serviços com imagem/build, portas, rede, dependências e healthcheck", () => {
    render(<ComposeServicesList services={CASSINO_SERVICES} entryService="wallet" entryPort={80} />);
    for (const name of ["db", "redis", "wallet", "web", "caddy"]) {
      expect(screen.getByTestId(`compose-service-${name}`)).toBeInTheDocument();
    }
    const db = screen.getByTestId("compose-service-db");
    expect(db).toHaveTextContent("postgres:18-alpine");
    expect(db).toHaveTextContent(/healthcheck no compose/i);

    const wallet = screen.getByTestId("compose-service-wallet");
    expect(wallet).toHaveTextContent(/construído do repositório/i);
    expect(wallet).toHaveTextContent("80:80");
    expect(wallet).toHaveTextContent(/conflita com o painel/i);
    expect(wallet).toHaveTextContent("127.0.0.1:8010:8010");
    expect(wallet).toHaveTextContent(/8009 \(EXPOSE do Dockerfile\)/);
    expect(wallet).toHaveTextContent(/depende de: db \(saudável\), redis \(saudável\)/i);
    expect(wallet).toHaveTextContent(/healthcheck no Dockerfile/i);
    expect(within(wallet).getByText(/entrada HTTP/i)).toBeInTheDocument();

    const web = screen.getByTestId("compose-service-web");
    expect(web).toHaveTextContent(/usa a rede do wallet/i);
    expect(web).toHaveTextContent("services/web/Dockerfile");

    expect(screen.getByTestId("compose-service-caddy")).toHaveTextContent(/sem healthcheck/i);
  });

  it("destaca a entrada e explica o network_mode (o caddy atende dentro do wallet)", () => {
    render(<ComposeServicesList services={CASSINO_SERVICES} entryService="wallet" entryPort={80} />);
    const entry = screen.getByTestId("compose-entry");
    expect(entry).toHaveTextContent("wallet:80");
    expect(entry).toHaveTextContent(/caddy.*atende dentro do wallet.*por isso a entrada é wallet:80/i);
  });

  it("80/443 que o painel retira aparecem como tal", () => {
    render(
      <ComposeServicesList
        services={[
          {
            ...CASSINO_SERVICES[2]!,
            name: "app",
            publishedPorts: [{ mapping: "80:3000", containerPort: 3000, hostPort: 80, panel: "removed" }],
          },
        ]}
        entryService={null}
        entryPort={null}
      />,
    );
    expect(screen.getByTestId("compose-service-app")).toHaveTextContent(/o painel retira/i);
    expect(screen.getByTestId("compose-entry")).toHaveTextContent(/nenhum serviço escolhido/i);
  });

  it("depois do deploy: estado de cada container", () => {
    render(
      <ComposeServicesList
        services={CASSINO_SERVICES}
        entryService="wallet"
        entryPort={80}
        containers={[
          container("db", "running", "healthy"),
          container("redis", "exited", null, "Exited (1)"),
          container("wallet", "running", "unhealthy"),
          container("web", "restarting", null),
          container("caddy", "running", null),
        ]}
      />,
    );
    expect(screen.getByTestId("compose-service-db")).toHaveTextContent(/saudável/);
    expect(screen.getByTestId("compose-service-redis")).toHaveTextContent(/parado/);
    expect(screen.getByTestId("compose-service-wallet")).toHaveTextContent(/não saudável/);
    expect(screen.getByTestId("compose-service-web")).toHaveTextContent(/reiniciando/);
    expect(screen.getByTestId("compose-service-caddy")).toHaveTextContent(/rodando/);
  });

  it("estados restantes: iniciando, não iniciou e sem container", () => {
    render(
      <ComposeServicesList
        services={CASSINO_SERVICES.slice(0, 3)}
        entryService="wallet"
        entryPort={80}
        containers={[container("db", "running", "starting"), container("redis", "created", null)]}
      />,
    );
    expect(screen.getByTestId("compose-service-db")).toHaveTextContent(/iniciando/);
    expect(screen.getByTestId("compose-service-redis")).toHaveTextContent(/não iniciou/);
    expect(screen.getByTestId("compose-service-wallet")).toHaveTextContent(/sem container/);
  });
});

describe("ComposeServicesCard (projeto)", () => {
  const project = {
    id: "p1",
    proxyService: null,
    proxyPort: null,
    detection: { type: "compose", proxyService: "wallet", proxyPort: 80, services: CASSINO_SERVICES },
  } as never;

  it("escolhe outro serviço e porta e salva no projeto", async () => {
    apiFetchMock.mockResolvedValue({});
    const onChanged = vi.fn();
    render(<ComposeServicesCard project={project} containers={[]} onChanged={onChanged} />);
    const select = screen.getByLabelText(/Serviço que recebe o HTTP/i) as HTMLSelectElement;
    // quem usa a rede de outro (web, caddy) não pode ser a entrada
    expect([...select.options].map((o) => o.value)).toEqual(["db", "redis", "wallet"]);
    fireEvent.change(select, { target: { value: "db" } });
    fireEvent.change(screen.getByLabelText(/Porta interna/i), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar entrada/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1", {
        method: "PATCH",
        body: JSON.stringify({ proxyService: "db", proxyPort: 8080 }),
      }),
    );
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/vale no próximo deploy/i)).toBeInTheDocument();
  });

  it("porta fora de 1–65535 não salva; porta conhecida preenche com um clique", () => {
    render(<ComposeServicesCard project={project} containers={[]} onChanged={() => undefined} />);
    const port = screen.getByLabelText(/Porta interna/i);
    fireEvent.change(port, { target: { value: "70000" } });
    expect(screen.getByText(/entre 1 e 65535/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Salvar entrada/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "8009" }));
    expect(port).toHaveValue("8009");
  });

  it("erro do servidor aparece no card", async () => {
    const { ApiRequestError } = await import("@/lib/api");
    apiFetchMock.mockImplementation(async () => {
      throw new ApiRequestError(400, "invalid_proxy_service", "O serviço \"x\" não existe no compose.");
    });
    render(<ComposeServicesCard project={project} containers={[]} onChanged={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Porta interna/i), { target: { value: "81" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar entrada/i }));
    expect(await screen.findByText(/não existe no compose/)).toBeInTheDocument();
  });

  it("detecção antiga, sem a lista: botão para ler o compose de novo", async () => {
    apiFetchMock.mockResolvedValue({ detection: {} });
    const onChanged = vi.fn();
    const old = { id: "p1", proxyService: null, proxyPort: null, detection: { type: "compose", proxyService: "web", proxyPort: 80 } } as never;
    render(<ComposeServicesCard project={old} containers={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Ler o compose de novo/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/detect", { method: "POST" }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("falha ao ler o compose de novo mostra o motivo", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new Error("Não foi possível baixar o código do repositório.");
    });
    const old = { id: "p1", proxyService: null, proxyPort: null, detection: { type: "compose", proxyService: "web", proxyPort: 80 } } as never;
    render(<ComposeServicesCard project={old} containers={[]} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Ler o compose de novo/i }));
    expect(await screen.findByText(/Não foi possível baixar/)).toBeInTheDocument();
  });
});
