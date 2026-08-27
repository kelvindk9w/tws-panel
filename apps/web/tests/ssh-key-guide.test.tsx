/**
 * ssh-key-guide.test.tsx — SshKeyGuide (Fase 01 do wizard de segurança):
 *  - começa recolhido, mostrando só o resumo clicável;
 *  - clicar no resumo expande o tutorial completo (o que é, para que serve,
 *    comandos por sistema operacional);
 *  - clicar de novo recolhe.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SshKeyGuide } from "@/components/setup/SshKeyGuide";

afterEach(() => {
  cleanup();
});

describe("SshKeyGuide — recolhível, fechado por padrão", () => {
  it("mostra só o resumo clicável; o conteúdo do tutorial não está na tela", () => {
    render(<SshKeyGuide />);
    expect(
      screen.getByText(/Nunca usou chave SSH\? Veja como gerar em 2 minutos/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/O que é:/)).not.toBeInTheDocument();
    expect(screen.queryByText("ssh-keygen -t ed25519")).not.toBeInTheDocument();
  });

  it("clicar no resumo expande o tutorial completo", () => {
    render(<SshKeyGuide />);
    fireEvent.click(screen.getByRole("button", { name: /Veja como gerar em 2 minutos/ }));
    expect(screen.getByText(/O que é:/)).toBeInTheDocument();
    expect(screen.getAllByText("ssh-keygen -t ed25519")).toHaveLength(2); // Windows + Linux/Mac
  });

  it("clicar de novo recolhe o tutorial", () => {
    render(<SshKeyGuide />);
    const toggle = screen.getByRole("button", { name: /Veja como gerar em 2 minutos/ });
    fireEvent.click(toggle);
    expect(screen.getByText(/O que é:/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText(/O que é:/)).not.toBeInTheDocument();
  });
});
