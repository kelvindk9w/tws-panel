/**
 * confirm-word-input.test.tsx — todo diálogo que pede para digitar uma palavra
 * (restauração, "Recomeçar do zero", desativar o acesso pelo IP) mostra a
 * palavra em fonte de código, diz que é literal, deixa copiar e usa a própria
 * palavra como exemplo no campo. A lógica de comparação de cada diálogo não muda.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/i18n";
import { ConfirmWordInput } from "@/components/ConfirmWordInput";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ word }: { word: string }) {
  const [v, setV] = useState("");
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <ConfirmWordInput
        id="cw"
        word={word}
        value={v}
        onChange={setV}
        labelKey="backups.restore.confirmLabel.word"
        hintKey="backups.restore.confirmHint.email"
      />
    </form>
  );
}

describe("ConfirmWordInput", () => {
  it.each([
    ["pt-BR", "e-mail", /Para confirmar, digite a palavra/, "Digite exatamente a palavra e-mail (não é o seu endereço de e-mail).", "Copiar e-mail"],
    ["en", "email", /To confirm, type the word/, "Type exactly the word email (it is not your email address).", "Copy email"],
  ] as const)("(%s) palavra em fonte de código, dica de que é literal, placeholder e copiar", async (loc, word, label, hint, copyName) => {
    setLocale(loc);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Harness word={word} />);
    const input = screen.getByLabelText(label);
    expect(input).toHaveAttribute("placeholder", word);
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(screen.getByText(word, { selector: "code" }).className).toContain("font-mono");
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription(hint);
    const copy = screen.getByRole("button", { name: copyName });
    // dentro de um formulário, copiar não envia o formulário
    expect(copy).toHaveAttribute("type", "button");
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(word));
    fireEvent.change(input, { target: { value: "x" } });
    expect(within(input.closest("form")!).getByLabelText(label)).toHaveValue("x");
  });
});
