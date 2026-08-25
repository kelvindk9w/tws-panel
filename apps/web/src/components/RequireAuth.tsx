import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import type { AdminUser, AuthMeResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { AuthContext } from "@/lib/auth";

type GuardState =
  | { status: "loading" }
  | { status: "ok"; user: AdminUser }
  | { status: "redirect"; to: "/login" | "/setup" };

/**
 * Guard de rotas do painel: consulta /api/auth/me (cookie de sessão) e
 * redireciona — 401 unauthorized → /login (lembrando o destino original);
 * 401 setup_incomplete → /setup (wizard ainda não foi concluído).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [state, setState] = useState<GuardState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    apiFetch<AuthMeResponse>("/api/auth/me")
      .then((me) => {
        if (!cancelled) setState({ status: "ok", user: me.user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const to = err instanceof ApiRequestError && err.code === "setup_incomplete" ? "/setup" : "/login";
        setState({ status: "redirect", to });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Verificando sessão…
      </div>
    );
  }
  if (state.status === "redirect") {
    // Preserva a query string no redirect: o link do instalador chega como
    // "/?token=..." e o Navigate do React Router derrubaria o ?token= — sem
    // ele o wizard abriria com o campo de token vazio (defesa em profundidade;
    // a captura principal acontece no carregamento do módulo em lib/api.ts).
    return <Navigate to={{ pathname: state.to, search: location.search }} replace state={{ from: location.pathname }} />;
  }
  return <AuthContext.Provider value={{ user: state.user }}>{children}</AuthContext.Provider>;
}
