# Relatório — adoção de domínios e caixas depois de restaurar o e-mail (21/10/2026)

## Problema (validado pelo dono)

O painel lista domínios e caixas do cadastro dele (`data/mail/mail.json`), não do Stalwart. A restauração do e-mail devolve dados e configuração ao Stalwart, mas o cadastro não sabia do que voltou. Numa VPS nova, o backup tinha 2 domínios e 4 caixas e o painel mostrava só `envio` e `postmaster@envio`.

## O que passou a acontecer

- No fim da restauração do e-mail, com o Stalwart autenticando (inclui o reparo do 401 que já existia), o painel lê os domínios e caixas do Stalwart e cadastra os que faltam. O registro da restauração ganha o passo e o aviso "Cadastrei N domínios e M caixas no painel". Sem nada a cadastrar: sem aviso e sem texto de erro.
- Botão **Sincronizar com o servidor de e-mail** na página E-mail (só com o servidor rodando), para quem já restaurou antes ou iniciou o servidor depois. Rota `POST /api/mail/sync` (sessão, CSRF do guard global, 10 req/min), resposta com contagens e nomes. Chamadas simultâneas viram uma só.
- Regras: nada é ativado; o que já estava cadastrado não muda; repetir não duplica; a senha da caixa nunca é lida, guardada, logada nem mostrada (o `secrets` é descartado no cliente); a caixa adotada fica sem senha conhecida e a tela avisa e oferece **Trocar senha**; o domínio entra com o DNS "não verificado"; abuse@ e dmarc@ continuam sendo endereços da postmaster@ (não viram caixas); `<slug>@` de um projeto cadastrado vira caixa dele; postmaster@ é caixa do sistema.
- Caixa sem senha conhecida não quebra nada: e-mail de teste e aviso do painel por e-mail explicam que falta a senha; o deploy não injeta `SMTP_PASS` vazio.
- Domínio cuja chave DKIM não dá para ler não entra (nem as caixas dele); aparece em "não consegui cadastrar".
- Falha do Stalwart: 401/403 usa `mail_auth_failed` (mesma mensagem e reparo); fora do ar vira `mail_unreachable` (502); outro erro `mail_sync_failed`. Na restauração a falha vira aviso e a restauração não falha. Nada é apagado.
- O serviço usado pela restauração é o mesmo objeto da tela, entregue pelo plugin de rotas do e-mail com `backupService.setMailAdopt`. A primeira versão chamava `app.mailService` no escopo raiz, onde ele não existe (o Fastify isola o plugin): a adoção automática nunca rodava em produção e só o botão Sincronizar funcionava. Os testes não viam porque usavam um adotador falso. Agora `tests/mail-adopt-wiring.test.ts` sobe o `buildApp()` real e prova que a adoção chega ao serviço que a tela lista (falhava antes da correção).

## Decisões a conferir

- Associação ao projeto é só pelo slug (o endereço padrão do e-mail do projeto); o vínculo de envio (`SMTP_*`) não é restaurado, a pessoa ativa o e-mail do projeto e escolhe a senha.
- Se o Stalwart diz que NÃO tem a assinatura DKIM `rsa-<domínio>` (404 ou sem chave), a adoção a cria; qualquer outra falha de leitura deixa o domínio de fora.
- Revisão (a1cacc0): domínio adotado com `dmarcAlias` coerente; alias de outra caixa e abuse@/dmarc@ próprios vão para os ignorados; dono pelo slug só no domínio do e-mail do projeto; falha do reparo do 401 sugere Sincronizar; ignorados cortados em 200 (com total) e aviso acima de 20 000; a tela avisa que domínio novo pode reiniciar o servidor de e-mail.

## Pendência anterior a este commit (não resolvida aqui)

A gravação do `mail.json` pela adoção (e por outras operações do `MailService`) escreve o arquivo inteiro a partir do que está em memória, sem reler. Se outra instância gravar entre a leitura e a escrita (por exemplo o reparo do 401 da restauração, que usa uma instância própria e pode gravar o TLS), a adoção pode desfazer essa gravação. O problema já existia no `MailService` e não foi mudado; fica registrado para tratar à parte (reler antes de gravar, ou um único dono do arquivo).
- A base foi a `dev` (traz o `mail-auth-error.ts`); a branch do worktree foi apontada para ela.

## Arquivos

Servidor: `services/mail-adopt.ts`, `mail-service.ts`, `mail-auth-error.ts`, `backup-service.ts`, `routes/mail.ts`, `app.ts`. Pacotes: `mailer/src/client.ts`, `core/src/mail.ts`. Web: `MailPage.tsx`, `MailboxesPanel.tsx`, locales pt-BR e en (mail, errors), GLOSSARY. Docs: `comoFuncionaSistema/email/sincronizar.json` e demais, `backups/restaurar.json`, `_i18n-servidor-fase2.tsv`, guia de restauração do site (pt-br e en).

## Testes

`mail-adopt.test.ts`, `mail-adopt-service.test.ts` (integração com Stalwart falso por fetch: 2 domínios e 4 caixas, reexecução, caixa já cadastrada com senha, simultâneas, 401, DKIM ilegível, sem vazar o hash), `routes-mail-sync.test.ts`, `client-principals.test.ts`, casos novos em `backup-service.test.ts`, `mail-page.test.tsx`, `mail-panels.test.tsx`.

## Não testado

Contra um Stalwart v0.11.8 real (o formato da resposta de `/api/principal` segue a documentação e o que o cliente já usava) e o fluxo completo de uma restauração em VPS nova.
