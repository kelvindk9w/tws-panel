import { useEffect, useState } from "react";
import type { SecurityPhaseId } from "@paas/core";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { VPS_ADDRESS_PLACEHOLDER } from "@/lib/terminal-info";
import { AlertTriangle, ChevronDown, ChevronRight, Clock } from "lucide-react";

/** O que cada fase mudou no acesso — uma frase, no idioma de quem não é da área. */
function whatChanged(phase: SecurityPhaseId, user: string | null): string {
  const who = user ?? "o seu usuário";
  switch (phase) {
    case "01":
      return `A senha do root foi desativada. Confira que você ainda entra com ${who}.`;
    case "02":
      return `O SSH agora aceita entrar só por chave e só ${who}. Confira que você ainda entra.`;
    default:
      return "O firewall foi ligado. Confira que você ainda entra.";
  }
}

function secondsUntil(deadline: string): number {
  return Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
}

/** Segundos que faltam para o prazo, atualizados a cada segundo. */
function useSecondsUntil(deadline: string): number {
  const [remaining, setRemaining] = useState(() => secondsUntil(deadline));
  useEffect(() => {
    const t = setInterval(() => setRemaining(secondsUntil(deadline)), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return remaining;
}

function Remaining({ remaining }: { remaining: number }) {
  return (
    <span className={`font-mono font-bold ${remaining < 60 ? "text-red-400" : "text-amber-300"}`}>
      {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
    </span>
  );
}

/**
 * "Teste seu acesso agora" das fases que mexem em como se entra na VPS
 * (01 senha do root, 02 SSH, 03 firewall).
 *
 * Feedback da validação real: "abra outra janela" confundia (do navegador? do
 * terminal?), faltava copiar o comando e dizer por que testar a CADA fase, e
 * "Interromper" só parava a tela — a mudança seguia até a janela acabar. Agora:
 * curto na tela (onde, o comando, o que é dar certo, dois botões com
 * consequência clara) e o resto em "Mais detalhes".
 */
export function AccessTestAlert({
  phase,
  phaseTitle,
  user,
  host,
  deadline,
  busy,
  onConfirm,
  onUndo,
}: {
  phase: SecurityPhaseId;
  phaseTitle: string;
  /** Usuário não-root do teste; null = desconhecido (não se inventa comando). */
  user: string | null;
  /** Endereço da VPS para o ssh (ou VPS_ADDRESS_PLACEHOLDER). */
  host: string;
  /** Quando a reversão automática acontece (ISO). */
  deadline: string;
  /** Confirmando ou desfazendo: trava os botões. */
  busy: boolean;
  onConfirm: () => void;
  onUndo: () => void;
}) {
  const [details, setDetails] = useState(false);
  const remaining = useSecondsUntil(deadline);
  // Prazo acabou: quem decide agora é o servidor (a reversão agendada roda lá).
  // Os botões travam — confirmar a esta altura só daria erro.
  const expired = remaining === 0;
  const command = user ? `ssh ${user}@${host}` : null;

  return (
    <div
      role="alert"
      data-testid="access-test-alert"
      className="flex flex-col gap-4 rounded-xl border-4 border-amber-500 bg-amber-500/15 p-6 text-amber-50 shadow-[0_0_60px_rgba(245,158,11,0.3)]"
    >
      <p className="flex items-center gap-2 text-xl font-bold text-amber-300">
        <AlertTriangle className="h-6 w-6 shrink-0" /> Teste seu acesso agora — Fase {phase} ({phaseTitle})
      </p>
      <p className="text-base">{whatChanged(phase, user)}</p>

      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          Abra o <strong>terminal do seu computador</strong> (não o navegador), sem fechar esta página.
        </li>
        <li className="flex flex-col gap-1">
          <span>Rode:</span>
          {command ? (
            <span className="flex items-center gap-2">
              <code
                data-testid="access-test-command"
                className="flex-1 rounded bg-black/60 px-3 py-2 font-mono text-sm text-emerald-300"
              >
                {command}
              </code>
              <CopyButton text={command} />
            </span>
          ) : (
            <span className="text-amber-200/90">ssh SEU_USUARIO@{host} (troque pelo usuário que você criou)</span>
          )}
          {host === VPS_ADDRESS_PLACEHOLDER && (
            <span className="text-amber-200/90">
              Troque {VPS_ADDRESS_PLACEHOLDER} pelo IP da sua VPS — o mesmo que você usa para entrar por SSH.
            </span>
          )}
        </li>
        <li>
          Apareceu <code className="font-mono">{user ?? "seu-usuario"}@…$</code>? Deu certo: digite{" "}
          <code className="font-mono">exit</code> e clique em <strong>Entrei — confirmar</strong>.
        </li>
      </ol>

      <p className="text-sm text-amber-100/90">
        Por que testar agora: se der errado, desfazemos só esta fase — não todo o trabalho feito até aqui.
      </p>

      {expired ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
          <Clock className="h-4 w-4 shrink-0" /> O prazo acabou sem confirmação: o servidor está desfazendo esta
          fase. Em instantes a tela mostra o resultado.
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 shrink-0" /> Sem resposta, esta fase se desfaz sozinha em{" "}
          <Remaining remaining={remaining} />.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={onConfirm} disabled={busy || expired} className="bg-amber-500 text-black hover:bg-amber-400">
          ✅ Entrei — confirmar
        </Button>
        <Button size="lg" variant="outline" onClick={onUndo} disabled={busy || expired}>
          Não consegui entrar — desfazer agora
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={details}
          onClick={() => setDetails((v) => !v)}
          className="flex items-center gap-2 text-left text-sm font-medium text-amber-200"
        >
          {details ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Mais detalhes
        </button>
        {details && (
          <div className="flex flex-col gap-2 pl-6 text-sm text-amber-100/85">
            <p>
              <strong>Por que um teste em cada fase:</strong> as fases 01, 02 e 03 mexem em como você entra na
              VPS — a senha do root, o SSH e o firewall. Testando uma de cada vez, se algo der errado só aquela
              fase é desfeita e você sabe exatamente qual foi.
            </p>
            <p>
              <strong>Onde fica o terminal:</strong> no Windows, o PowerShell (menu Iniciar → digite
              &quot;PowerShell&quot;); no Mac, o Terminal (Spotlight → &quot;Terminal&quot;); no Linux, o
              Terminal. É o mesmo que você usou para entrar na VPS no começo.
            </p>
            <p>
              <strong>Pediu uma senha?</strong> Se for &quot;Enter passphrase for key&quot;, é a senha da
              chave SSH que você criou no seu computador — não a senha do servidor.
            </p>
            <p>
              <strong>Sua chave tem outro nome?</strong> Acrescente <code className="font-mono">-i ~/.ssh/NOME</code>{" "}
              ao comando.
            </p>
            <p>
              <strong>Não consegui entrar:</strong> clique em &quot;desfazer agora&quot;. Esta fase volta ao que
              era, as seguintes não rodam, e você pode tentar de novo depois de resolver.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
