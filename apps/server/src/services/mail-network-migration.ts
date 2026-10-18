/**
 * mail-network-migration.ts — tira o servidor de e-mail da paas-net dos
 * projetos hospedados (achado A4), sem derrubar quem já usa o e-mail.
 *
 * Instalações antigas têm o Stalwart (e o webmail) na paas-net, onde TODO
 * projeto os alcança — inclusive a administração do e-mail. A ordem importa:
 *  1. o Stalwart entra nas redes novas (paas-mail-admin e paas-mail) sem sair
 *     da paas-net, e o painel entra na paas-mail-admin;
 *  2. os containers que já rodam dos projetos com e-mail entram na paas-mail
 *     (senão perderiam o SMTP até o próximo deploy);
 *  3. o webmail muda de rede (paas-panel + paas-mail);
 *  4. só então o Stalwart sai da paas-net.
 * Cada passo é idempotente: o que falhar é tentado de novo na próxima rodada.
 */
export interface MailNetworkMigrationDeps {
  mail: {
    joinMailNetworks(): Promise<void>;
    emailProjectIds(): Promise<string[]>;
    leaveProjectNetwork(): Promise<void>;
  };
  /** Liga os containers que já rodam do projeto à rede de e-mail; devolve quantos. */
  joinProject(projectId: string): Promise<number>;
  /** Faz o webmail acompanhar (e mudar de rede, se for o caso). */
  syncWebmail(): Promise<void>;
  log: (message: string) => void;
}

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function migrateMailNetworks(deps: MailNetworkMigrationDeps): Promise<void> {
  await deps.mail.joinMailNetworks();
  for (const id of await deps.mail.emailProjectIds()) {
    try {
      await deps.joinProject(id);
    } catch (err) {
      deps.log(`E-mail: não consegui ligar o projeto ${id} à rede de e-mail (${text(err)}); o próximo deploy liga.`);
    }
  }
  try {
    await deps.syncWebmail();
  } catch (err) {
    deps.log(`E-mail: o webmail não mudou de rede agora (${text(err)}); tento de novo na próxima rodada.`);
  }
  await deps.mail.leaveProjectNetwork();
}
