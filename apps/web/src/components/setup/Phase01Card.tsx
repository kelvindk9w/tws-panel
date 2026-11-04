import { useEffect, useState } from "react";
import type { SecurityScanReport } from "@paas/core";
import { isValidSshPublicKey, isValidSshUsername } from "@paas/core";
import { SshKeyGuide } from "@/components/setup/SshKeyGuide";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { pageLocation } from "@/lib/page-location";
import { isInsecureTransport } from "@/lib/terminal-info";
import { Trans, useI18n } from "@/i18n";
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
  const { t } = useI18n();
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
  const who = userOk ? user : t("hardening.phase01.whoDefault");
  const b = <strong />;
  const code = <code className="font-mono" />;
  const bm = <strong className="font-mono" />;

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-amber-400" /> {t("hardening.phase01.title")}
        </CardTitle>
        <CardDescription>
          {t("hardening.phase01.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="ssh-user">
            {t("hardening.phase01.userLabel")}
          </label>
          <Input
            id="ssh-user"
            value={sshUser}
            onChange={(e) => onSshUserChange(e.target.value)}
            className="h-8 w-64 font-mono"
          />
          {user !== "" && !userOk && (
            <p className="text-xs text-red-400">{t("hardening.phase01.userInvalid")}</p>
          )}
          {/* De onde veio o nome: sem isso, parece um chute do painel. */}
          {configuredSshUser !== null && user === configuredSshUser && (
            <p className="text-xs text-muted-foreground">
              <Trans k="hardening.phase01.userFromConfig" components={{ b }} />
            </p>
          )}
          {configuredSshUser === null && soleDetectedUser !== null && user === soleDetectedUser && (
            <p className="text-xs text-muted-foreground">
              <Trans k="hardening.phase01.userDetected" components={{ b }} />
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
                  <Trans
                    k="hardening.phase01.userNotDetected"
                    params={{ user: configuredSshUser }}
                    components={{ b, bm, code }}
                  />
                </span>
              </p>
            )}
          {/* Dois ou mais: o painel NÃO escolhe pelo operador. */}
          {configuredSshUser === null && detectedSudoUsers.length > 1 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                <Trans
                  k="hardening.phase01.userMany"
                  params={{ n: detectedSudoUsers.length }}
                  components={{ b }}
                />
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
            <p className="text-xs text-muted-foreground">{t("hardening.phase01.userHint")}</p>
          )}
        </div>

        {/* O que vai acontecer — pelas mesmas regras do script. */}
        <div data-testid="phase01-status" className="flex flex-col gap-1 rounded-md border border-border bg-secondary/20 p-3 text-sm">
          {outcome === null ? (
            <p className="text-muted-foreground">
              {t("hardening.phase01.unchecked", { who })}
            </p>
          ) : (
            <>
              <p>
                {outcome.hasPassword ? "✅" : "❌"}{" "}
                {t(outcome.hasPassword ? "hardening.phase01.hasPassword" : "hardening.phase01.noPassword", { user })}
              </p>
              <p>
                {outcome.keys > 0 ? "✅" : "❌"}{" "}
                {outcome.keys > 0
                  ? `${t("hardening.phase01.keys", { count: outcome.keys })}${keyOk ? t("hardening.phase01.keysPasted") : ""}`
                  : t("hardening.phase01.noKeys")}
              </p>
              {outcome.willLock ? (
                <p className="font-semibold text-emerald-400">
                  {t("hardening.phase01.resultLocked")}
                </p>
              ) : !outcome.hasPassword ? (
                <p className="font-semibold text-amber-400">
                  <Trans k="hardening.phase01.resultNoPassword" params={{ user }} components={{ code }} />
                </p>
              ) : (
                <p className="font-semibold text-amber-400">
                  {t("hardening.phase01.resultNoKey")}
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
            {t(missingKey ? "hardening.phase01.keyToggleMissing" : "hardening.phase01.keyToggleOptional")}
          </button>
          {keyOpen && (
            <div className="flex flex-col gap-2 pl-6">
              <p className="text-xs text-muted-foreground">
                <Trans k="hardening.phase01.keyHelp" components={{ code }} />
              </p>
              <p className="text-xs text-muted-foreground">
                <Trans k="hardening.phase01.keyPublic" components={{ b, code }} />
              </p>
              <label className="text-xs text-muted-foreground" htmlFor="ssh-pubkey">
                {t("hardening.phase01.keyLabel")}
              </label>
              <textarea
                id="ssh-pubkey"
                value={sshPublicKey}
                onChange={(e) => onSshPublicKeyChange(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={t("hardening.phase01.keyPlaceholder")}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {!keyEmpty && !keyOk && (
                <p className="text-xs text-red-400">
                  {t("hardening.phase01.keyInvalid")}
                </p>
              )}
              {keyOk && <p className="text-xs text-emerald-400">{t("hardening.phase01.keyValid")}</p>}
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
            {t("hardening.phase01.detailsToggle")}
          </button>
          {detailsOpen && (
            <div className="flex flex-col gap-2 pl-6 text-xs text-muted-foreground">
              <p>
                <Trans k="hardening.phase01.details.apply" components={{ b }} />
              </p>
              <p>
                <Trans k="hardening.phase01.details.lostKey" params={{ who }} components={{ b, bm }} />
              </p>
              <p>
                <Trans k="hardening.phase01.details.dontConfuse" params={{ who }} components={{ b }} />
              </p>
              {insecure && (
                <p>
                  <Trans k="hardening.phase01.details.insecure" components={{ b }} />
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
