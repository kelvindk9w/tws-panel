import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  PASSWORD_MIN_LENGTH,
  validatePasswordStrength,
  validateUsername,
  type CreateAdminResponse,
  type SecurityScanReport,
} from "@paas/core";
import { apiFetch, ApiRequestError, clearSetupToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowRight, CheckCircle2, Circle, Loader2, PartyPopper, UserRound } from "lucide-react";

/** Checklist ao vivo das regras de senha (mesma validação do backend). */
function PasswordRules({ password }: { password: string }) {
  const { checks } = validatePasswordStrength(password);
  const rules = [
    { ok: checks.minLength, label: `Mínimo de ${PASSWORD_MIN_LENGTH} caracteres` },
    { ok: checks.hasUpper, label: "Ao menos uma letra maiúscula" },
    { ok: checks.hasLower, label: "Ao menos uma letra minúscula" },
    { ok: checks.hasNumber, label: "Ao menos um número" },
  ];
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {rules.map((rule) => (
        <li
          key={rule.label}
          className={`flex items-center gap-1.5 ${rule.ok ? "text-emerald-400" : "text-muted-foreground"}`}
        >
          {rule.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          {rule.label}
        </li>
      ))}
    </ul>
  );
}

function ScoreGauge({ value, source }: { value: number | null; source: string }) {
  if (value === null) return null;
  const color = value >= 75 ? "text-emerald-400" : value >= 50 ? "text-amber-400" : "text-red-400";
  const ring =
    value >= 75 ? "border-emerald-500/50" : value >= 50 ? "border-amber-500/50" : "border-red-500/50";
  return (
    <div className={`flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 ${ring}`}>
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {source === "lynis" ? "Lynis Index" : "Índice interno"}
      </span>
    </div>
  );
}

export function AdminStep() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // score de segurança do Passo 2 (cache do servidor) para a tela de sucesso
  const [score, setScore] = useState<{ value: number; source: string } | null>(null);
  useEffect(() => {
    apiFetch<{ report: SecurityScanReport }>("/api/security/scan")
      .then((res) =>
        setScore({ value: res.report.hardeningIndex ?? 0, source: res.report.hardeningIndexSource }),
      )
      .catch(() => undefined); // score é opcional — a tela funciona sem ele
  }, []);

  const strength = validatePasswordStrength(password);
  const usernameOk = validateUsername(username.trim());
  const confirmOk = confirm.length > 0 && confirm === password;
  const canSubmit = usernameOk && strength.valid && confirmOk && !loading;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch<CreateAdminResponse>("/api/setup/admin", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      // setup concluído: o token foi invalidado no servidor — descarta o local
      clearSetupToken();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível criar a conta. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------ pós-setup
  if (done) {
    return (
      <div className="flex animate-fade-in flex-col gap-6">
        <Card>
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15">
              <PartyPopper className="h-6 w-6 text-emerald-400" />
            </div>
            <CardTitle>Setup concluído!</CardTitle>
            <CardDescription className="max-w-md">
              A conta de administrador foi criada e o modo de setup foi encerrado — o setup token
              não funciona mais. A partir de agora, o acesso ao painel exige login.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6">
            {score && (
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs uppercase text-muted-foreground">Score de segurança</span>
                <ScoreGauge value={score.value} source={score.source} />
              </div>
            )}
            <Button onClick={() => navigate("/login")}>
              Ir para o login <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ------------------------------------------------------------ formulário
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Conta de administrador</h2>
        <p className="text-sm text-muted-foreground">
          Último passo: crie o acesso ao painel. Ao concluir, o modo de setup é encerrado e todo
          acesso passa a exigir login.
        </p>
      </div>

      <Card>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <UserRound className="h-6 w-6" />
          </div>
          <CardTitle>Criar conta admin</CardTitle>
          <CardDescription className="max-w-md">
            Única conta do painel. A senha é armazenada com hash argon2id — nunca em texto claro.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="mx-auto flex max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-username" className="text-sm font-medium">
                Usuário
              </label>
              <Input
                id="admin-username"
                autoComplete="username"
                placeholder="Usuário administrador"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              {username.length > 0 && !usernameOk && (
                <p className="text-xs text-amber-400">
                  3 a 32 caracteres, começando com letra ou número (letras, números, &quot;_&quot;,
                  &quot;.&quot;, &quot;-&quot;).
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-password" className="text-sm font-medium">
                Senha
              </label>
              <Input
                id="admin-password"
                type="password"
                autoComplete="new-password"
                placeholder="Senha forte"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {password.length > 0 && <PasswordRules password={password} />}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-confirm" className="text-sm font-medium">
                Confirmar senha
              </label>
              <Input
                id="admin-confirm"
                type="password"
                autoComplete="new-password"
                placeholder="Repita a senha"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {confirm.length > 0 && !confirmOk && (
                <p className="text-xs text-amber-400">As senhas não coincidem.</p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={!canSubmit}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Criando conta…" : "Concluir setup"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
