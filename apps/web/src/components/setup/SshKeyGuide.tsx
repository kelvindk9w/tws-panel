import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { ChevronDown, ChevronRight, KeyRound } from "lucide-react";

function CommandRow({ cmd }: { cmd: string }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-2 rounded bg-black/60 px-2 py-1.5">
      <code className="break-all font-mono text-xs text-emerald-100/90">{cmd}</code>
      <CopyButton text={cmd} />
    </div>
  );
}

/**
 * Tutorial guiado de chave SSH (Fase 01 do wizard de segurança).
 *
 * Decisão de UX do produto: NADA de upload de arquivo nem geração pelo
 * painel — o usuário só COLA a chave pública, e este guia ensina, passo a
 * passo e por sistema operacional, como gerar a chave no PRÓPRIO computador
 * e copiar o conteúdo do arquivo .pub.
 *
 * Recolhível e FECHADO por padrão: quem já tem a chave (o caminho recomendado
 * pelo README) vai direto aos campos, sem rolar por um tutorial que não
 * precisa. Quem nunca usou chave SSH abre o resumo e vê o passo a passo.
 */
export function SshKeyGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-secondary/20 p-4 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-left font-medium"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <KeyRound className="h-4 w-4 shrink-0 text-amber-400" />
        Nunca usou chave SSH? Veja como gerar em 2 minutos.
      </button>

      {open && (
      <>
      <div className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
        <p>
          <strong className="text-foreground">O que é:</strong> um par de chaves criptográficas. A{" "}
          <strong className="text-foreground">chave privada</strong> fica guardada no SEU computador
          (nunca saia dela nem compartilhe) e a <strong className="text-foreground">chave pública</strong>{" "}
          é instalada no servidor — é ela que você cola aqui.
        </p>
        <p>
          <strong className="text-foreground">Para que serve:</strong> é assim que você vai entrar na
          VPS por SSH <strong className="text-foreground">depois que o acesso root for desativado</strong>{" "}
          pelo hardening. Sem ela instalada, o painel NÃO trava o root (proteção anti-lockout).
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* ------------------------------------------------ Windows */}
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            🪟 Windows (PowerShell)
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs text-muted-foreground">
            <li>
              Abra o <strong className="text-foreground">PowerShell</strong> e gere o par de chaves
              (aperte Enter para aceitar o local padrão; a senha da chave é opcional, mas recomendada):
              <CommandRow cmd="ssh-keygen -t ed25519" />
            </li>
            <li>
              Exiba a chave pública para copiar (ela fica em{" "}
              <code className="font-mono text-foreground">C:\Users\SEU_USUARIO\.ssh\id_ed25519.pub</code>):
              <CommandRow cmd="Get-Content ~\.ssh\id_ed25519.pub" />
            </li>
            <li>Copie a linha inteira exibida (começa com ssh-ed25519) e cole no campo abaixo.</li>
          </ol>
        </div>

        {/* ---------------------------------------------- Linux/macOS */}
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            🐧 Linux / 🍎 macOS (Terminal)
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs text-muted-foreground">
            <li>
              Abra o <strong className="text-foreground">Terminal</strong> e gere o par de chaves
              (aperte Enter para aceitar o local padrão; a senha da chave é opcional, mas recomendada):
              <CommandRow cmd="ssh-keygen -t ed25519" />
            </li>
            <li>
              Exiba a chave pública para copiar (ela fica em{" "}
              <code className="font-mono text-foreground">~/.ssh/id_ed25519.pub</code>):
              <CommandRow cmd="cat ~/.ssh/id_ed25519.pub" />
            </li>
            <li>
              Copie a linha inteira exibida (começa com ssh-ed25519) e cole no campo abaixo. No Mac,
              dá para copiar direto com{" "}
              <code className="font-mono text-foreground">pbcopy &lt; ~/.ssh/id_ed25519.pub</code>.
            </li>
          </ol>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        💡 <strong className="text-foreground">Já tem uma chave?</strong> Se o comando de exibição
        acima mostrar uma linha começando com ssh-ed25519 ou ssh-rsa, não precisa gerar outra — use
        a que você já tem.
      </p>
      </>
      )}
    </div>
  );
}
