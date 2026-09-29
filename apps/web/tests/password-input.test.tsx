/**
 * password-input.test.tsx — campo de senha reutilizável com o "olho" para
 * mostrar/ocultar (pedido do dono do produto na validação real: ao criar o
 * admin não dava para conferir o que foi digitado).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordInput } from "@/components/ui/password-input";

afterEach(cleanup);

describe("PasswordInput", () => {
  it("começa oculto e o olho mostra e volta a ocultar, sem perder o valor", () => {
    render(<PasswordInput aria-label="Senha" defaultValue="segredo-123" />);
    const campo = screen.getByLabelText("Senha") as HTMLInputElement;
    expect(campo).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Mostrar senha" }));
    expect(campo).toHaveAttribute("type", "text");
    expect(campo.value).toBe("segredo-123");
    expect(screen.getByRole("button", { name: "Ocultar senha" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Ocultar senha" }));
    expect(campo).toHaveAttribute("type", "password");
  });

  it("o botão do olho não envia o formulário", () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput aria-label="Senha" />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mostrar senha" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("repassa props e ref ao input (id, autoComplete, onChange, disabled)", () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<PasswordInput id="admin-pass" ref={ref} autoComplete="new-password" onChange={onChange} disabled />);
    const campo = document.getElementById("admin-pass") as HTMLInputElement;
    expect(ref.current).toBe(campo);
    expect(campo).toHaveAttribute("autocomplete", "new-password");
    expect(campo).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mostrar senha" })).toBeDisabled();
  });

  it("rótulo do olho personalizável (ex.: token)", () => {
    render(<PasswordInput aria-label="Token" revealLabel="token" />);
    expect(screen.getByRole("button", { name: "Mostrar token" })).toBeInTheDocument();
  });
});
