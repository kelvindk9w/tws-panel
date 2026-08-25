/**
 * Card de configuração do projeto: edição de nome, repositório, branch e
 * domínio, slug imutável e o aviso de divergência entre o que está
 * configurado e o que está efetivamente publicado.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { ProjectConfigCard } from "../src/components/ProjectConfigCard";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiFetch: apiFetchMock };
});

function projeto(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Minha App",
    slug: "minha-app",
    ingestMode: "git",
    source: "https://github.com/usuario/app.git",
    branch: "main",
    domain: "app.exemplo.com",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  apiFetchMock.mockReset();
});

describe("ProjectConfigCard", () => {
  it("mostra os valores atuais do projeto nos campos", () => {
    render(<ProjectConfigCard project={projeto()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/nome/i)).toHaveValue("Minha App");
    expect(screen.getByLabelText(/reposit/i)).toHaveValue("https://github.com/usuario/app.git");
    expect(screen.getByLabelText(/branch/i)).toHaveValue("main");
    expect(screen.getByLabelText(/dom[ií]nio/i)).toHaveValue("app.exemplo.com");
  });

  it("exibe o slug como valor fixo, sem campo editável", () => {
    render(<ProjectConfigCard project={projeto()} onSaved={vi.fn()} />);
    expect(screen.getByText("minha-app")).toBeInTheDocument();
    expect(screen.queryByLabelText(/slug/i)).not.toBeInstanceOf(HTMLInputElement);
  });

  it("avisa quando a branch configurada difere da publicada", () => {
    render(
      <ProjectConfigCard
        project={projeto({ branch: "sandbox", deployedBranch: "main", deployedSource: "https://github.com/usuario/app.git" })}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/no ar/i);
    expect(screen.getByRole("status")).toHaveTextContent(/main/);
  });

  it("não avisa quando o publicado corresponde ao configurado", () => {
    render(
      <ProjectConfigCard
        project={projeto({ branch: "main", deployedBranch: "main", deployedSource: "https://github.com/usuario/app.git" })}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("avisa que nada foi publicado ainda em projeto novo", () => {
    render(<ProjectConfigCard project={projeto()} onSaved={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/nenhum deploy/i);
  });

  it("salva apenas os campos alterados", async () => {
    apiFetchMock.mockResolvedValue({ project: projeto({ branch: "sandbox" }) });
    const onSaved = vi.fn();
    render(<ProjectConfigCard project={projeto()} onSaved={onSaved} />);

    const branch = screen.getByLabelText(/branch/i);
    await userEvent.clear(branch);
    await userEvent.type(branch, "sandbox");
    await userEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/p1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ branch: "sandbox" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("salvar e publicar dispara o deploy logo após salvar", async () => {
    apiFetchMock.mockResolvedValue({ project: projeto({ branch: "sandbox" }) });
    render(<ProjectConfigCard project={projeto()} onSaved={vi.fn()} />);

    const branch = screen.getByLabelText(/branch/i);
    await userEvent.clear(branch);
    await userEvent.type(branch, "sandbox");
    await userEvent.click(screen.getByRole("button", { name: /salvar e publicar/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(apiFetchMock.mock.calls[0][0]).toBe("/api/projects/p1");
    expect(apiFetchMock.mock.calls[1][0]).toBe("/api/projects/p1/deploy");
  });

  it("não chama a API quando nada foi alterado", async () => {
    render(<ProjectConfigCard project={projeto()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^salvar$/i }));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("mostra a mensagem de erro da API quando o salvamento falha", async () => {
    apiFetchMock.mockRejectedValue(new Error("Nome de branch inválido."));
    render(<ProjectConfigCard project={projeto()} onSaved={vi.fn()} />);

    const branch = screen.getByLabelText(/branch/i);
    await userEvent.clear(branch);
    await userEvent.type(branch, "x");
    await userEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    expect(await screen.findByText(/branch inválido/i)).toBeInTheDocument();
  });
});
