import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input, type InputProps } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PasswordInputProps extends Omit<InputProps, "type"> {
  /** O que o olho revela, para o rótulo acessível ("senha", "token"…). */
  revealLabel?: string;
  /** Classes do contêiner (ex.: "min-w-0 flex-1" numa linha flexível). */
  containerClassName?: string;
  /** Controle de fora (ex.: "Mostrar valores" de uma lista); sem ele, o olho decide sozinho. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}

/**
 * Campo de senha com o "olho" para mostrar/ocultar o que foi digitado.
 * Use-o em TODO campo de segredo digitado pelo operador (senha do admin,
 * login, troca de senha, token do repositório, senha do sudo): conferir o que
 * se digitou evita criar conta com senha errada. Começa sempre oculto; o botão
 * é type="button" para nunca enviar o formulário.
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    { className, containerClassName, revealLabel = "senha", disabled, visible: visibleProp, onVisibleChange, ...props },
    ref,
  ) => {
    const [visibleState, setVisibleState] = React.useState(false);
    const visible = visibleProp ?? visibleState;
    const setVisible = (v: boolean) => {
      if (visibleProp === undefined) setVisibleState(v);
      onVisibleChange?.(v);
    };
    const label = `${visible ? "Ocultar" : "Mostrar"} ${revealLabel}`;
    return (
      <div className={cn("relative w-full", containerClassName)}>
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          disabled={disabled}
          className={cn("pr-9", className)}
          {...props}
        />
        <button
          type="button"
          aria-label={label}
          aria-pressed={visible}
          title={label}
          disabled={disabled}
          onClick={() => setVisible(!visible)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
