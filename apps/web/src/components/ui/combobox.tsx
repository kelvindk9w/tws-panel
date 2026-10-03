import * as React from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Texto pequeno à direita (ex.: "do compose"). */
  hint?: string;
  /** Aparece na lista (com o motivo em `hint`), mas não pode ser escolhida. */
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  /** Permite usar o texto digitado como valor novo (ex.: um nome de variável que ainda não existe). */
  allowCreate?: boolean;
  /** Rótulo da opção de criar (padrão: `Usar "texto"`). */
  createLabel?: (query: string) => string;
  /** Ajusta o texto digitado antes de virar valor novo (ex.: tirar espaços). */
  normalizeCreate?: (query: string) => string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

type Item = { kind: "option"; option: ComboboxOption } | { kind: "create"; value: string };

const selectable = (item: Item | undefined): item is Item => !!item && !(item.kind === "option" && item.option.disabled);

/** Próximo índice escolhível a partir de `from`, andando `step` (com volta); -1 = nenhum. */
function nextSelectable(items: Item[], from: number, step: 1 | -1): number {
  for (let n = 1; n <= items.length; n++) {
    const i = (((from + step * n) % items.length) + items.length) % items.length;
    if (selectable(items[i])) return i;
  }
  return -1;
}

/**
 * Seleção com busca (estilo select2), seguindo o padrão "combobox com lista"
 * da WAI-ARIA: o campo de texto é o combobox; digitar filtra; setas movem a
 * opção ativa (aria-activedescendant), Enter escolhe, Esc fecha sem mudar.
 * Com `allowCreate`, o texto digitado vira uma opção a mais. Opção
 * desabilitada aparece (aria-disabled, com o motivo na dica) mas o clique e
 * as setas a pulam. No celular, a lista abre logo abaixo do campo, na
 * largura dele, e rola por dentro (cerca de 8 itens à vista).
 */
export function Combobox({
  options,
  value,
  onChange,
  allowCreate = false,
  createLabel = (q) => `Usar "${q}"`,
  normalizeCreate = (q) => q.trim(),
  placeholder,
  disabled,
  id,
  className,
  ...aria
}: ComboboxProps) {
  const autoId = React.useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(-1);

  const selected = options.find((o) => o.value === value);
  const selectedText = selected ? selected.label : value;

  const itemsFor = React.useCallback(
    (text: string): Item[] => {
      const q = text.trim().toLowerCase();
      const list: Item[] = options
        .filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
        .map((option) => ({ kind: "option", option }));
      const created = normalizeCreate(text);
      if (allowCreate && created && !options.some((o) => o.value === created || o.label === created)) {
        list.push({ kind: "create", value: created });
      }
      return list;
    },
    [options, allowCreate, normalizeCreate],
  );
  const items = React.useMemo(() => itemsFor(query), [itemsFor, query]);
  const listRef = React.useRef<HTMLUListElement>(null);

  // a opção ativa pelas setas fica à vista dentro da lista que rola
  React.useEffect(() => {
    if (open && active >= 0) listRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function show() {
    if (disabled) return;
    setQuery("");
    setActive(-1);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
    setActive(-1);
  }

  function choose(item: Item) {
    if (!selectable(item)) return;
    onChange(item.kind === "option" ? item.option.value : item.value);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        show();
        setActive(nextSelectable(itemsFor(""), -1, 1));
        return;
      }
      if (items.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => nextSelectable(items, a < 0 && step === -1 ? 0 : a, step));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!open) show();
      else if (items[active]) choose(items[active]!);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className={cn("relative w-full min-w-0", className)}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 && items[active] ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={open ? selectedText || placeholder : placeholder}
        value={open ? query : selectedText}
        onClick={() => !open && show()}
        onChange={(e) => {
          if (!open) setOpen(true);
          setQuery(e.target.value);
          setActive(nextSelectable(itemsFor(e.target.value), -1, 1));
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
        className="flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 pl-3 pr-9 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        {...aria}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Fechar a lista" : "Abrir a lista"}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) close();
          else {
            inputRef.current?.focus();
            show();
          }
        }}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          // o clique numa opção não tira o foco do campo (senão o blur fecharia antes)
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 z-50 mt-1 max-h-[17rem] overflow-y-auto rounded-md border bg-background p-1 shadow-lg"
        >
          {items.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">Nada encontrado.</li>}
          {items.map((item, i) => {
            const isActive = i === active;
            const isSelected = item.kind === "option" && item.option.value === value;
            const isDisabled = !selectable(item);
            return (
              <li
                key={item.kind === "option" ? `o:${item.option.value}` : `c:${item.value}`}
                id={optionId(i)}
                role="option"
                aria-selected={isActive}
                aria-disabled={isDisabled || undefined}
                onClick={() => choose(item)}
                onMouseEnter={() => !isDisabled && setActive(i)}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-sm [overflow-wrap:anywhere]",
                  isDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  isActive && "bg-accent text-accent-foreground",
                )}
              >
                {item.kind === "create" ? (
                  <>
                    <Plus className="h-4 w-4 shrink-0 text-sky-400" />
                    <span>{createLabel(item.value)}</span>
                  </>
                ) : (
                  <>
                    <Check className={cn("h-4 w-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1 font-mono">{item.option.label}</span>
                    {item.option.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.option.hint}</span>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
