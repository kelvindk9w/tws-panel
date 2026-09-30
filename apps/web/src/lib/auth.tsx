import { createContext, useContext } from "react";
import type { AdminUser, UserPreferences } from "@paas/core";

export interface AuthContextValue {
  user: AdminUser;
  /** Preferências de interface da conta (Configurações), vindas de /api/auth/me. */
  preferences: UserPreferences;
  /** Troca na hora, em todo o painel (quem salva no servidor é a página de Configurações). */
  setPreferences: (preferences: UserPreferences) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Usuário autenticado — só existe dentro do RequireAuth. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro do RequireAuth");
  return ctx;
}
