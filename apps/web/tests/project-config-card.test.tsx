/**
 * Card de configuração do projeto: edição de nome, repositório, branch e
 * domínio, slug imutável e o aviso de divergência entre o que está
 * configurado e o que está efetivamente publicado.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectCredentialInfo } from "@paas/core";
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

/** Estado público da credencial: por padrão, projeto sem credencial cadastrada. */
function credencial(overrides: Partial<ProjectCredentialInfo> = {}): ProjectCredentialInfo {
  return { configured: false, hint: null, username: null, updatedAt: null, ...overrides };
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

/**
 * Credencial de LEITURA do repositório privado.
 *
 * Regra de produto que estes testes protegem: o painel só lê repositórios, e a
 * tela precisa dizer isso ao operador no momento do cadastro. O valor do token
 * nunca volta do servidor e nunca é reexibido pela interface.
 */
describe("ProjectConfigCard — credencial de leitura", () => {
  it("mostra o estado 'não configurada' e o formulário de cadastro", () => {
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);
    expect(screen.getByText(/nenhuma credencial cadastrada/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/token de leitura/i)).toBeInTheDocument();
  });

  it("avisa, na tela de cadastro, que o painel só lê o repositório", () => {
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);
    const aviso = screen.getByTestId("credencial-somente-leitura");
    expect(aviso).toHaveTextContent(/somente leitura/i);
    expect(aviso).toHaveTextContent(/nunca escreve/i);
    expect(aviso).toHaveTextContent(/Contents: Read/);
  });

  it("pede o token em campo de senha, sem preenchimento automático", () => {
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);
    const campo = screen.getByLabelText(/token de leitura/i);
    expect(campo).toHaveAttribute("type", "password");
    expect(campo).toHaveAttribute("autocomplete", "off");
  });

  it("salva a credencial na rota e com o corpo corretos", async () => {
    apiFetchMock.mockResolvedValue({
      credential: { configured: true, hint: "cdef", username: "x-access-token", updatedAt: null },
    });
    const onSaved = vi.fn();
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText(/token de leitura/i), "ghp_abcdef");
    await userEvent.click(screen.getByRole("button", { name: /salvar credencial/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/p1/credential");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ token: "ghp_abcdef" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("envia o usuário informado junto do token", async () => {
    apiFetchMock.mockResolvedValue({
      credential: { configured: true, hint: "cdef", username: "kelvin", updatedAt: null },
    });
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/token de leitura/i), "ghp_abcdef");
    await userEvent.type(screen.getByLabelText(/usu[áa]rio/i), "kelvin");
    await userEvent.click(screen.getByRole("button", { name: /salvar credencial/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).toEqual({
      token: "ghp_abcdef",
      username: "kelvin",
    });
  });

  it("não chama a API com o token vazio", async () => {
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /salvar credencial/i }));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("limpa o campo do token depois de salvar, para não deixá-lo na tela", async () => {
    apiFetchMock.mockResolvedValue({
      credential: { configured: true, hint: "cdef", username: "x-access-token", updatedAt: null },
    });
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/token de leitura/i), "ghp_abcdef");
    await userEvent.click(screen.getByRole("button", { name: /salvar credencial/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByDisplayValue("ghp_abcdef")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain("ghp_abcdef");
  });

  it("com credencial cadastrada mostra só a dica, nunca o valor", () => {
    render(
      <ProjectConfigCard
        project={projeto()}
        credential={credencial({
          configured: true,
          hint: "cdef",
          username: "x-access-token",
          updatedAt: "2026-09-01T12:00:00.000Z",
        })}
        onSaved={vi.fn()}
      />,
    );
    const resumo = screen.getByTestId("credencial-resumo");
    expect(resumo).toHaveTextContent(/cdef/);
    expect(resumo).toHaveTextContent(/x-access-token/);
    // nenhum campo de token aberto enquanto o operador não pedir para substituir
    expect(screen.queryByLabelText(/token de leitura/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ghp_");
  });

  it("permite substituir a credencial existente, reexibindo o aviso de leitura", async () => {
    render(
      <ProjectConfigCard
        project={projeto()}
        credential={credencial({ configured: true, hint: "cdef", username: "x-access-token", updatedAt: null })}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /substituir/i }));
    expect(screen.getByLabelText(/token de leitura/i)).toBeInTheDocument();
    expect(screen.getByTestId("credencial-somente-leitura")).toBeInTheDocument();
  });

  it("remover pede confirmação antes de chamar a API", async () => {
    apiFetchMock.mockResolvedValue({ ok: true });
    render(
      <ProjectConfigCard
        project={projeto()}
        credential={credencial({ configured: true, hint: "cdef", username: "x-access-token", updatedAt: null })}
        onSaved={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^remover credencial$/i }));
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/vai falhar at[ée] que uma nova seja cadastrada/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /confirmar remo/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/p1/credential");
    expect(init.method).toBe("DELETE");
  });

  it("cancelar a remoção não chama a API", async () => {
    render(
      <ProjectConfigCard
        project={projeto()}
        credential={credencial({ configured: true, hint: "cdef", username: "x-access-token", updatedAt: null })}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^remover credencial$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^cancelar$/i }));
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /confirmar remo/i })).not.toBeInTheDocument();
  });

  it("mostra o erro da API ao falhar o cadastro da credencial", async () => {
    apiFetchMock.mockRejectedValue(new Error("Token inválido para este repositório."));
    render(<ProjectConfigCard project={projeto()} credential={credencial()} onSaved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/token de leitura/i), "ghp_abcdef");
    await userEvent.click(screen.getByRole("button", { name: /salvar credencial/i }));

    expect(await screen.findByText(/token inv[áa]lido/i)).toBeInTheDocument();
  });

  it("não oferece credencial para projetos que não vêm de git", () => {
    render(
      <ProjectConfigCard
        project={projeto({ ingestMode: "existing" })}
        credential={credencial()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/token de leitura/i)).not.toBeInTheDocument();
  });
});
