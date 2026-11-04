import type { AdminUser } from "@paas/core";
import type { StoredUser } from "./user-store.js";

/** O que a API mostra da conta — nunca hash de senha nem segredos do 2FA. */
export function publicUser(user: StoredUser): AdminUser {
  return {
    username: user.username,
    createdAt: user.createdAt,
    displayName: user.displayName ?? null,
    email: user.email ?? null,
  };
}
