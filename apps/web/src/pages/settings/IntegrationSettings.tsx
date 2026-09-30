import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { TokenGuide } from "@/components/TokenGuide";
import { CheckCircle2, Github, Loader2 } from "lucide-react";

interface GithubStatus {
  connected: boolean;
  login: string | null;
  hint: string | null;
  updatedAt: string | null;
}

/**
 * Configurações → Integrações. Conta do GitHub: conectada uma vez (token
 * somente leitura), o Novo Projeto lista os repositórios para escolher, e os
 * privados clonam sem pedir token de novo.
 */
export function IntegrationSettings() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<GithubStatus>("/api/integrations/github")
      .then(setStatus)
      .catch(() => setError("Não foi possível consultar a integração com o GitHub."));
  }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GithubStatus>("/api/integrations/github", {
        method: "PUT",
        body: JSON.stringify({ token: token.trim() }),
      });
      setToken("");
      setStatus(res);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível conectar.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/integrations/github", { method: "DELETE" });
      setStatus({ connected: false, login: null, hint: null, updatedAt: null });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível desconectar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Github className="h-4 w-4" /> GitHub
        </CardTitle>
        <CardDescription>
          Conecte a sua conta para escolher os repositórios numa lista ao criar um projeto — públicos e privados. O
          painel só lê o código: nunca escreve, commita nem faz push.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex max-w-lg flex-col gap-3 text-sm">
        {status === null && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {status?.connected && (
          <div className="flex flex-col gap-3">
            <p data-testid="github-connected" className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Conectado como <strong>{status.login}</strong>
              <span className="text-xs text-muted-foreground">(token terminado em {status.hint})</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Quando o token vencer, a lista para de carregar: desconecte e conecte de novo com um token novo.
            </p>
            <Button variant="outline" className="self-start" onClick={() => void disconnect()} disabled={busy}>
              Desconectar
            </Button>
          </div>
        )}

        {status && !status.connected && (
          <form onSubmit={(e) => void connect(e)} className="flex flex-col gap-3">
            <label htmlFor="gh-token" className="font-medium">
              Token do GitHub (somente leitura)
            </label>
            <PasswordInput
              id="gh-token"
              revealLabel="token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
            />
            <TokenGuide scope="account" />
            <span className="text-xs text-muted-foreground">
              Guardado cifrado no servidor. Um token com permissão de escrita é recusado.
            </span>
            <Button type="submit" className="self-start" disabled={busy || token.trim() === ""}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Conectar
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
