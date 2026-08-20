import { createContext, useContext } from "react";
import type { AdminUser } from "@paas/core";

export interface AuthContextValue {
  user: AdminUser;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Usuário autenticado — só existe dentro do RequireAuth. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro do RequireAuth");
  return ctx;
}
