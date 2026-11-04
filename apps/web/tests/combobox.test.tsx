/**
 * Combobox: seleção com busca (estilo select2). Usado para escolher qual
 * variável do projeto recebe um valor do e-mail (02/10/2026), mas genérico.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const OPTIONS: ComboboxOption[] = [
  { value: "", label: "mesmo nome (padrão)" },
  { value: "SMTP_SENHA", label: "SMTP_SENHA", hint: "do compose" },
  { value: "EMAIL_DE", label: "EMAIL_DE", hint: "nas Variáveis" },
  { value: "EMAIL_HOST", label: "EMAIL_HOST" },
];

function Harness(props: { allowCreate?: boolean; onChange?: (v: string) => void; initial?: string }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <Combobox
      aria-label="Variável que recebe SMTP_PASS"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v);
        props.onChange?.(v);
      }}
      {...(props.allowCreate ? { allowCreate: true, createLabel: (q: string) => `Usar o nome novo ${q}` } : {})}
    />
  );
}

afterEach(() => cleanup());

describe("Combobox", () => {
  it("fechado mostra o rótulo da opção escolhida; acessível (combobox, expanded, controls)", () => {
    render(<Harness initial="EMAIL_DE" />);
    const input = screen.getByRole("combobox", { name: "Variável que recebe SMTP_PASS" });
    expect(input).toHaveValue("EMAIL_DE");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("valor que não está nas opções aparece como está", () => {
    render(<Harness initial="OUTRA" />);
    expect(screen.getByRole("combobox")).toHaveValue("OUTRA");
  });

  it("digitar filtra a lista (sem diferenciar maiúsculas) e clicar escolhe", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.clear(input);
    await user.type(input, "email");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["EMAIL_DEnas Variáveis", "EMAIL_HOST"]);
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    await user.click(screen.getByRole("option", { name: /EMAIL_HOST/ }));
    expect(onChange).toHaveBeenCalledWith("EMAIL_HOST");
    expect(input).toHaveValue("EMAIL_HOST");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("teclado: setas movem a opção ativa (aria-activedescendant), Enter escolhe", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox");
    input.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const first = screen.getAllByRole("option")[0]!;
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1]!.id);
    // passa do fim e volta ao começo
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[3]!.id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("EMAIL_HOST");
  });

  it("Esc fecha sem mudar e devolve o texto da escolha atual", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} initial="EMAIL_DE" />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "smtp");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("EMAIL_DE");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sem resultado: avisa; Enter não escolhe nada", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "zzz");
    expect(screen.getByText("Nada encontrado.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("com allowCreate: oferece usar o texto digitado como valor novo", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} allowCreate />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "MINHA_SENHA");
    const create = screen.getByRole("option", { name: "Usar o nome novo MINHA_SENHA" });
    expect(create).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("MINHA_SENHA");
  });

  it("com allowCreate: texto igual a uma opção não duplica; texto só de espaços não cria", async () => {
    const user = userEvent.setup();
    render(<Harness allowCreate />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "EMAIL_DE");
    expect(screen.queryByRole("option", { name: /Usar o nome novo/ })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "   ");
    expect(screen.queryByRole("option", { name: /Usar o nome novo/ })).not.toBeInTheDocument();
  });

  it("botão da seta abre e fecha a lista; sair do campo fecha", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <button type="button">fora</button>
      </>,
    );
    const toggle = screen.getByRole("button", { name: "Abrir a lista" });
    await user.click(toggle);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fechar a lista" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "fora" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter com a lista fechada abre; Tab escolhe nada e fecha", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    screen.getByRole("combobox").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("desabilitado não abre", async () => {
    const user = userEvent.setup();
    render(<Combobox aria-label="x" options={OPTIONS} value="" onChange={() => undefined} disabled />);
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  /**
   * Validação real (03/10/2026): o dono procurou MAIL_FROM_NAME e não achou —
   * os nomes que o painel já entrega sumiam da lista. Agora aparecem
   * desabilitados, com o motivo, e não podem ser escolhidos.
   */
  describe("opção desabilitada", () => {
    const WITH_DISABLED: ComboboxOption[] = [
      { value: "", label: "mesmo nome (padrão)" },
      { value: "MAIL_FROM_NAME", label: "MAIL_FROM_NAME", hint: "o painel já entrega com este nome", disabled: true },
      { value: "SMTP_SENHA", label: "SMTP_SENHA", hint: "do .env.example" },
      { value: "SMTP_HOST", label: "SMTP_HOST", hint: "o painel já entrega com este nome", disabled: true },
      { value: "SMTP_USUARIO", label: "SMTP_USUARIO", hint: "do .env.example" },
    ];

    function Disabled({ onChange }: { onChange: (v: string) => void }) {
      return (
        <Combobox aria-label="x" options={WITH_DISABLED} value="" onChange={onChange} allowCreate createLabel={(q) => `Usar o nome novo ${q}`} />
      );
    }

    it("aparece com aria-disabled e o motivo; clicar não escolhe nem fecha", async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<Disabled onChange={onChange} />);
      await user.click(screen.getByRole("combobox"));
      await user.type(screen.getByRole("combobox"), "mail_from");
      const opt = screen.getByRole("option", { name: /MAIL_FROM_NAME/ });
      expect(opt).toHaveAttribute("aria-disabled", "true");
      expect(opt).toHaveTextContent("o painel já entrega com este nome");
      // não oferece "usar o nome novo" para um nome que está na lista
      expect(screen.queryByRole("option", { name: /Usar o nome novo/ })).toBeInTheDocument();
      await user.click(opt);
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      await user.clear(screen.getByRole("combobox"));
      await user.type(screen.getByRole("combobox"), "MAIL_FROM_NAME");
      expect(screen.queryByRole("option", { name: /Usar o nome novo/ })).not.toBeInTheDocument();
    });

    it("teclado pula as desabilitadas; Enter nunca escolhe uma delas", async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<Disabled onChange={onChange} />);
      const input = screen.getByRole("combobox");
      await user.click(input);
      await user.type(input, "smtp");
      // primeira ativa é a primeira habilitada (SMTP_SENHA), não SMTP_HOST
      const ids = () => screen.getAllByRole("option").map((o) => o.id);
      const label = (id: string | null) => document.getElementById(id ?? "")?.textContent ?? "";
      expect(label(input.getAttribute("aria-activedescendant"))).toMatch(/^SMTP_SENHA/);
      await user.keyboard("{ArrowDown}");
      expect(label(input.getAttribute("aria-activedescendant"))).toMatch(/^SMTP_USUARIO/);
      await user.keyboard("{ArrowDown}");
      expect(label(input.getAttribute("aria-activedescendant"))).toBe("Usar o nome novo smtp");
      await user.keyboard("{ArrowDown}");
      // dá a volta
      expect(label(input.getAttribute("aria-activedescendant"))).toMatch(/^SMTP_SENHA/);
      await user.keyboard("{ArrowUp}{ArrowUp}");
      // para cima também pula SMTP_HOST
      expect(label(input.getAttribute("aria-activedescendant"))).toMatch(/^SMTP_USUARIO/);
      expect(ids()).toHaveLength(4);
      await user.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledWith("SMTP_USUARIO");
    });

    it("só desabilitadas na busca: nenhuma fica ativa e Enter não faz nada", async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<Combobox aria-label="x" options={WITH_DISABLED} value="" onChange={onChange} />);
      const input = screen.getByRole("combobox");
      await user.click(input);
      await user.type(input, "host");
      expect(screen.getByRole("option", { name: /SMTP_HOST/ })).toHaveAttribute("aria-disabled", "true");
      expect(input).not.toHaveAttribute("aria-activedescendant");
      await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
      expect(input).not.toHaveAttribute("aria-activedescendant");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("lista longa rola por dentro (no máximo ~8 itens à vista)", async () => {
      const user = userEvent.setup();
      render(<Disabled onChange={vi.fn()} />);
      await user.click(screen.getByRole("combobox"));
      expect(screen.getByRole("listbox").className).toMatch(/max-h-\[17rem\]/);
      expect(screen.getByRole("listbox").className).toMatch(/overflow-y-auto/);
    });
  });
});
