import { useEffect, useState } from "react";
import type { SecurityScanReport } from "@paas/core";
import { isValidSshPublicKey, isValidSshUsername } from "@paas/core";
import { SshKeyGuide } from "@/components/setup/SshKeyGuide";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { pageLocation } from "@/lib/page-location";
import { isInsecureTransport } from "@/lib/terminal-info";
import { AlertTriangle, ChevronDown, ChevronRight, KeyRound } from "lucide-react";

type UserAccess = NonNullable<SecurityScanReport["nonRootSudoUserAccess"]>[string];

/**
 * O que a Fase 01 vai fazer com a senha do root, pelas MESMAS regras do
 * 01-user.sh: só desativa com chave SSH (para entrar) E senha do usuário
 * (para o sudo). null = a varredura não leu o estado deste usuário.
 */
function phase01Outcome(access: UserAccess | undefined, pastedKeyOk: boolean) {
  if (!access) return null;
  const keys = access.keyCount + (pastedKeyOk ? 1 : 0);
  return { hasPassword: access.hasPassword, keys, willLock: access.hasPassword && keys > 0 };
}

/**
 * Card da Fase 01 (usuário não-root + chave SSH → desativar a senha do root).
 *
 * Feedback de campo: a versão anterior tinha oito parágrafos e o leigo não
 * descobria o principal — o que vai acontecer com a VPS DELE. Agora:
 *  - uma frase diz o que a fase faz;
 *  - um quadro mostra o estado lido pela varredura (o usuário tem senha? tem
 *    chave?) e o resultado ("será" / "não será desativada", e por quê);
 *  - a chave SSH fica numa seção recolhível, ABERTA quando falta chave;
 *  - explicações e emergência ficam em "Detalhes e emergência", recolhido.
 */
export function Phase01Card({
  sshUser,
  onSshUserChange,
  sshPublicKey,
  onSshPublicKeyChange,
  configuredSshUser,
  detectedSudoUsers,
  report,
}: {
  sshUser: string;
  /** Chamado quando o operador digita ou escolhe um nome. */
  onSshUserChange: (value: string) => void;
  sshPublicKey: string;
  onSshPublicKeyChange: (value: string) => void;
  /** Usuário escolhido na instalação (null = legado/root/ausente). */
  configuredSshUser: string | null;
  /** Não-root com sudo detectados pela varredura. */
  detectedSudoUsers: string[];
  report: SecurityScanReport | null;
}) {
  const user = sshUser.trim();
  const userOk = isValidSshUsername(user);
  const keyEmpty = sshPublicKey.trim() === "";
  const keyOk = isValidSshPublicKey(sshPublicKey);
  const soleDetectedUser = detectedSudoUsers.length === 1 ? detectedSudoUsers[0]! : null;
  const outcome = userOk ? phase01Outcome(report?.nonRootSudoUserAccess?.[user], keyOk) : null;
  const missingKey = outcome !== null && report?.nonRootSudoUserAccess?.[user]?.keyCount === 0;
  const [keyOpen, setKeyOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Sem chave no servidor, instalar a chave É o próximo passo: a seção abre
  // sozinha (uma vez; depois, quem manda é o operador).
  useEffect(() => {
    if (missingKey) setKeyOpen(true);
  }, [missingKey]);
  const insecure = isInsecureTransport(pageLocation());
  const who = userOk ? user : "seu usuário";

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-amber-400" /> Fase 01 — desativar a senha do root
        </CardTitle>
        <CardDescription>
          Depois desta fase, ninguém entra como root com senha. Você entra com a sua chave SSH e
          administra com o seu usuário e a senha dele.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="ssh-user">
            Usuário não-root criado na instalação
          </label>
          <Input
            id="ssh-user"
            value={sshUser}
            onChange={(e) => onSshUserChange(e.target.value)}
            className="h-8 w-64 font-mono"
          />
          {user !== "" && !userOk && (
            <p className="text-xs text-red-400">Nome inválido (minúsculas, sem espaços, nunca root).</p>
          )}
          {/* De onde veio o nome: sem isso, parece um chute do painel. */}
          {configuredSshUser !== null && user === configuredSshUser && (
            <p className="text-xs text-muted-foreground">
              ⚙️ Nome da <strong>configuração da instalação</strong>. Se não for esse, é só editar.
            </p>
          )}
          {configuredSshUser === null && soleDetectedUser !== null && user === soleDetectedUser && (
            <p className="text-xs text-muted-foreground">
              🔎 Nome <strong>detectado no servidor</strong>. Se não for esse, é só editar.
            </p>
          )}
          {/* Configurado mas fora do grupo sudo: avisa, sem trocar por outro
              nome. Relatório antigo (sem detecção) não permite afirmar nada. */}
          {configuredSshUser !== null &&
            user === configuredSshUser &&
            report?.nonRootSudoUsers !== undefined &&
            !report.nonRootSudoUsers.includes(configuredSshUser) && (
              <p data-testid="configured-user-not-detected" className="flex items-start gap-1 text-xs text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  A verificação <strong>não encontrou</strong>{" "}
                  <strong className="font-mono">{configuredSshUser}</strong> com sudo neste servidor.
                  Confira o nome e, se preciso, rode como root:{" "}
                  <code className="font-mono">usermod -aG sudo {configuredSshUser}</code>
                </span>
              </p>
            )}
          {/* Dois ou mais: o painel NÃO escolhe pelo operador. */}
          {configuredSshUser === null && detectedSudoUsers.length > 1 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                Encontramos <strong>{detectedSudoUsers.length} usuários</strong> com sudo no servidor.
                Qual deles você criou na instalação?
              </p>
              <div className="flex flex-wrap gap-2">
                {detectedSudoUsers.map((name) => (
                  <Button
                    key={name}
                    type="button"
                    size="sm"
                    variant={user === name ? "default" : "outline"}
                    className="h-7 font-mono text-xs"
                    onClick={() => onSshUserChange(name)}
                  >
                    {name}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {detectedSudoUsers.length === 0 && user === "" && (
            <p className="text-xs text-muted-foreground">O nome que você criou ao seguir o README (ex.: deploy).</p>
          )}
        </div>

        {/* O que vai acontecer — pelas mesmas regras do script. */}
        <div data-testid="phase01-status" className="flex flex-col gap-1 rounded-md border border-border bg-secondary/20 p-3 text-sm">
          {outcome === null ? (
            <p className="text-muted-foreground">
              Não deu para conferir {who} nesta verificação. A simulação mostra, antes de qualquer
              mudança, se a senha do root vai ser desativada.
            </p>
          ) : (
            <>
              <p>
                {outcome.hasPassword ? "✅" : "❌"}{" "}
                {outcome.hasPassword ? `${user} tem senha` : `${user} não tem senha`}
              </p>
              <p>
                {outcome.keys > 0 ? "✅" : "❌"}{" "}
                {outcome.keys > 0
                  ? `${outcome.keys} chave SSH instalada${outcome.keys > 1 ? "s" : ""}${keyOk ? " (contando a que você colou)" : ""}`
                  : "nenhuma chave SSH instalada"}
              </p>
              {outcome.willLock ? (
                <p className="font-semibold text-emerald-400">
                  Resultado: a senha do root será desativada.
                </p>
              ) : !outcome.hasPassword ? (
                <p className="font-semibold text-amber-400">
                  Resultado: a senha do root não será desativada — sem senha, {user} ficaria sem sudo.
                  Para corrigir, rode <code className="font-mono">sudo passwd {user}</code> no terminal
                  abaixo e clique em “Verificar de novo”.
                </p>
              ) : (
                <p className="font-semibold text-amber-400">
                  Resultado: a senha do root não será desativada e nada muda — você continua entrando com
                  a senha. Para ativar a proteção, instale sua chave abaixo.
                </p>
              )}
            </>
          )}
        </div>

        {/* Chave SSH: recolhida quando já há chave; aberta quando falta. */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="phase01-key-toggle"
            aria-expanded={keyOpen}
            onClick={() => setKeyOpen((v) => !v)}
            className="flex items-center gap-2 text-left text-sm font-medium"
          >
            {keyOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {missingKey ? "Instalar minha chave SSH" : "Adicionar uma chave SSH (opcional)"}
          </button>
          {keyOpen && (
            <div className="flex flex-col gap-2 pl-6">
              <p className="text-xs text-muted-foreground">
                Cole o conteúdo do arquivo <code className="font-mono">.pub</code> do seu computador — a
                fase instala a chave no servidor para você. Se sua chave já está no servidor, deixe em
                branco.
              </p>
              <p className="text-xs text-muted-foreground">
                <strong>A chave pública não é segredo</strong> — é feita para ser distribuída. Nunca cole
                a <strong>chave privada</strong> (o arquivo sem <code className="font-mono">.pub</code>).
              </p>
              <label className="text-xs text-muted-foreground" htmlFor="ssh-pubkey">
                Chave pública SSH (conteúdo do arquivo .pub) — opcional
              </label>
              <textarea
                id="ssh-pubkey"
                value={sshPublicKey}
                onChange={(e) => onSshPublicKeyChange(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="ssh-ed25519 AAAAC3NzaC… voce@sua-maquina"
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {!keyEmpty && !keyOk && (
                <p className="text-xs text-red-400">
                  Formato não reconhecido — cole o conteúdo completo do arquivo .pub (uma linha,
                  começando com ssh-ed25519 ou ssh-rsa).
                </p>
              )}
              {keyOk && <p className="text-xs text-emerald-400">Sua chave parece válida ✅</p>}
              <SshKeyGuide />
            </div>
          )}
        </div>

        {/* Explicações e emergência: recolhidas — quem quer, abre. */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex items-center gap-2 text-left text-sm font-medium"
          >
            {detailsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Detalhes e emergência
          </button>
          {detailsOpen && (
            <div className="flex flex-col gap-2 pl-6 text-xs text-muted-foreground">
              <p>
                Ao aplicar, abra uma <strong>nova janela SSH</strong> (sem fechar a atual) e teste o login
                antes de confirmar. Se você não confirmar em 5 minutos, a mudança é desfeita sozinha.
              </p>
              <p>
                Perdeu a chave? Entre pelo <strong>console da sua hospedagem</strong> (VNC, no painel do
                provedor) com <strong className="font-mono">{who}</strong> e a senha dele — a senha do root
                não funciona mais lá.
              </p>
              <p>
                <strong>Não confunda:</strong> a chave SSH é como você <strong>entra</strong> na VPS pelo
                SSH; a senha do sudo é o que <strong>autoriza</strong> comandos administrativos. Para
                desativar a senha do root sem te trancar para fora, a fase exige pelo menos uma chave
                instalada e a senha de {who}.
              </p>
              {insecure && (
                <p>
                  Esta página está sem criptografia (http fora do túnel SSH). Colar a chave pública não
                  vaza nada útil, mas alguém no caminho poderia <strong>alterar</strong> o que trafega —
                  prefira o túnel SSH.
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
