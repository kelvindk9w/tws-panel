/**
 * mail-network-migration.ts — põe cada projeto na rede de e-mail SÓ DELE e deixa a paas-mail só para o servidor de
 * e-mail, sem derrubar quem já usa o e-mail e sem redeploy.
 *
 * Duas migrações, na mesma rodada (na subida do painel e, até dar certo inteira, a cada manutenção do e-mail):
 *  - A4 (instalações antigas): o Stalwart (e o webmail) saem da paas-net, onde TODO projeto os alcança;
 *  - rede por projeto: antes, os serviços de todos os projetos com e-mail dividiam a paas-mail, e um container
 *    comprometido num projeto alcançava o php-fpm, o nginx e os workers dos outros por ela. Agora cada projeto tem a
 *    sua (`paas-mail-<slug>`, interna, com sub-rede da faixa do painel), com o Stalwart nela; o webmail tem a dele
 *    (`paas-mailweb`).
 *
 * A ordem importa:
 *  1. o Stalwart entra nas redes dele (paas-mail-admin, paas-mail e paas-mailweb) e em toda rede de e-mail de projeto
 *     que já existe, sem sair de nada; o painel entra na paas-mail-admin;
 *  2. para cada projeto com e-mail: a rede do projeto é criada (se faltar) e o Stalwart entra nela; os containers que
 *     já rodam entram nela com os mesmos apelidos e SÓ DEPOIS saem da paas-mail (o SMTP_HOST é o mesmo nome, que o
 *     Stalwart tem nas duas). Nada é parado nem recriado;
 *  3. o webmail entra na paas-mailweb e sai da paas-mail (e da paas-net);
 *  4. o Stalwart sai da paas-net;
 *  5. quem ainda sobrou na paas-mail (projeto com o e-mail desligado e não refeito, container solto) sai dela, menos
 *     o servidor de e-mail, o webmail e os containers dos projetos cujo passo 2 falhou agora (sem a rede nova, a
 *     paas-mail ainda é o caminho do SMTP deles).
 * Cada passo é idempotente: o que falhar é registrado e tentado de novo na próxima rodada.
 */
export interface MailNetworkMigrationDeps {
  mail: {
    /** Liga o Stalwart às redes dele e às de projeto; devolve os erros das de projeto (não param a migração). */
    joinMailNetworks(): Promise<string[] | void>;
    emailProjectIds(): Promise<string[]>;
    leaveProjectNetwork(): Promise<void>;
  };
  /** Liga os containers que já rodam do projeto à rede de e-mail dele (e os tira da paas-mail); devolve quantos. */
  joinProject(projectId: string, log: (message: string) => void): Promise<number>;
  /** Faz o webmail acompanhar (e mudar de rede, se for o caso). */
  syncWebmail(): Promise<void>;
  /** Tira da paas-mail quem não é o servidor de e-mail nem o webmail, menos os containers destes projetos. */
  sweepShared?(skipProjectIds: string[], log: (message: string) => void): Promise<number>;
  log: (message: string) => void;
}

export interface MailNetworkMigrationResult {
  /** Projetos que não foram para a rede deles nesta rodada (a próxima tenta de novo). */
  failed: string[];
  /** Algum passo que não é de projeto falhou (webmail, limpeza da paas-mail): a próxima rodada refaz a migração. */
  incomplete: boolean;
}

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function migrateMailNetworks(deps: MailNetworkMigrationDeps): Promise<MailNetworkMigrationResult> {
  let incomplete = false;
  for (const error of (await deps.mail.joinMailNetworks()) ?? []) {
    incomplete = true;
    deps.log(`E-mail: o servidor de e-mail não entrou numa rede de projeto agora (${error}); tento de novo na próxima rodada.`);
  }
  const failed: string[] = [];
  for (const id of await deps.mail.emailProjectIds()) {
    try {
      await deps.joinProject(id, deps.log);
    } catch (err) {
      failed.push(id);
      deps.log(`E-mail: não consegui passar o projeto ${id} para a rede de e-mail dele (${text(err)}); ele segue como está (na rede antiga) e a próxima rodada (ou o próximo deploy) tenta de novo.`);
    }
  }
  try {
    await deps.syncWebmail();
  } catch (err) {
    incomplete = true;
    deps.log(`E-mail: o webmail não mudou de rede agora (${text(err)}); tento de novo na próxima rodada.`);
  }
  await deps.mail.leaveProjectNetwork();
  if (deps.sweepShared) {
    try {
      await deps.sweepShared(failed, deps.log);
    } catch (err) {
      incomplete = true;
      deps.log(`E-mail: não consegui esvaziar a rede de e-mail antiga agora (${text(err)}); tento de novo na próxima rodada.`);
    }
  }
  return { failed, incomplete };
}
