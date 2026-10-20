import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Trans, useI18n } from "@/i18n";
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
  const { t } = useI18n();
  const b = <strong className="text-foreground" />;
  const code = <code className="font-mono text-foreground" />;
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
        {t("hardening.sshGuide.toggle")}
      </button>

      {open && (
      <>
      <div className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
        <p>
          <Trans k="hardening.sshGuide.whatIs" components={{ b }} />
        </p>
        <p>
          <Trans k="hardening.sshGuide.purpose" components={{ b }} />
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* ------------------------------------------------ Windows */}
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("hardening.sshGuide.windows.title")}
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs text-muted-foreground">
            <li>
              <Trans k="hardening.sshGuide.windows.step1" components={{ b }} />
              <CommandRow cmd="ssh-keygen -t ed25519" />
            </li>
            <li>
              <Trans
                k="hardening.sshGuide.windows.step2"
                params={{ path: "C:\\Users\\SEU_USUARIO\\.ssh\\id_ed25519.pub" }}
                components={{ code }}
              />
              <CommandRow cmd="Get-Content ~\\.ssh\\id_ed25519.pub" />
            </li>
            <li>{t("hardening.sshGuide.windows.step3")}</li>
          </ol>
        </div>

        {/* ---------------------------------------------- Linux/macOS */}
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("hardening.sshGuide.unix.title")}
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs text-muted-foreground">
            <li>
              <Trans k="hardening.sshGuide.unix.step1" components={{ b }} />
              <CommandRow cmd="ssh-keygen -t ed25519" />
            </li>
            <li>
              <Trans k="hardening.sshGuide.unix.step2" params={{ path: "~/.ssh/id_ed25519.pub" }} components={{ code }} />
              <CommandRow cmd="cat ~/.ssh/id_ed25519.pub" />
            </li>
            <li>
              <Trans
                k="hardening.sshGuide.unix.step3"
                params={{ command: "pbcopy < ~/.ssh/id_ed25519.pub" }}
                components={{ code }}
              />
            </li>
          </ol>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        <Trans k="hardening.sshGuide.alreadyHave" components={{ b }} />
      </p>
      </>
      )}
    </div>
  );
}
