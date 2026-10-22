# Relatório — Realinhar a senha das caixas depois de restaurar o e-mail

Parte de `main` (b3875c4). Sem push nem PR.

## 1. O problema (VPS nova do dono)

O teste de notificação por e-mail falhava com "O servidor de e-mail recusou (AUTH): 535 5.7.8 Authentication credentials invalid". Causa: o painel novo criou `postmaster@<domínio>` com uma senha própria (guardada em `mail.json`); depois o dono restaurou o backup do e-mail, a caixa voltou no Stalwart com a senha ANTIGA do backup, e o painel seguiu autenticando com a dele. A adoção só acrescentava o que faltava no cadastro e nunca alinhava senha de caixa que o painel já conhecia.

## 2. O que mudou (pelo comportamento)

- **Realinhamento de senhas.** Sincronizar com o servidor de e-mail e a adoção do fim da restauração (as duas usam `MailService.adoptFromStalwart`, coalescido) reaplicam no Stalwart a senha que o painel guardou para as caixas de sistema (`postmaster@`) e de projeto, com o `setMailboxPassword` existente. Só entram caixas com senha conhecida, de domínio cadastrado e que o Stalwart de fato lista. Não toca em caixa de usuário (a pessoa pode ter trocado a senha no webmail, ou ela veio do backup), em caixa sem senha conhecida (inclui as recém-adotadas) nem em caixa que o servidor não tem. Nada reinicia. Idempotente: repetir grava o mesmo valor e não muda o `mail.json`.
- **Falha parcial.** Falha numa caixa vai para `passwordsFailed` (só o endereço), vira linha de log sem senha e não impede as outras caixas nem a sincronização.
- **Onde aparece.** Resposta de `POST /api/mail/sync` (`passwordsRealigned`, `passwordsFailed`); a tela de E-mail diz "Realinhei a senha de N caixas com a que o painel guarda" e lista as que falharam; o registro da restauração ganha o passo/aviso "Realinhei a senha de N caixas do painel" e, se houve falha, um aviso com os endereços e o caminho (Sincronizar ou Trocar senha). A auditoria `mail.sync` registra só contagens.
- **Concorrência com Trocar senha.** Uma fila por caixa (`withMailboxLock`) serializa o realinhamento com Trocar senha e com a ativação do e-mail do projeto. A senha é lida quando chega a vez da caixa na fila, então uma troca feita durante o realinhamento nunca é desfeita (teste dedicado).
- **Mensagem melhor para o 535.** `SmtpSendError` passou a carregar o comando recusado (`command`). Recusa 5xx no `AUTH` vira `email_auth_rejected` (409): "O servidor de e-mail recusou o login: a senha guardada pelo painel não é a do servidor. Abra E-mail e use Sincronizar (realinha a senha) ou Trocar senha na caixa postmaster@." Vale para o teste de notificação, para o motivo no histórico dos avisos reais (curto, cabe nos 200 caracteres do histórico e não contém endereço) e para o e-mail de teste do domínio. Em Configurações → Notificações aparece o botão **Abrir E-mail para sincronizar**. Textos em pt-BR e en (`errors.code.email_auth_rejected`, `notifications.email.openMailToSync`, `mail.page.sync.*`); códigos novos no `_i18n-servidor-fase2.tsv`.

## 3. Risco: reaplicar sempre ou só quando o Stalwart recusa?

Decisão: **reaplicar sempre** para as caixas de sistema e de projeto, sem verificar antes.

- O mailer não tem cliente de "só autenticar" (o envio SMTP faz a mensagem inteira). Criar um seria possível, mas verificar com uma senha possivelmente errada conta como tentativa de login falha no Stalwart, que bloqueia automaticamente o IP depois de algumas (o IP bloqueado seria o do próprio painel, e o envio de avisos e o webmail parariam). Reaplicar não gera tentativa falha.
- Gravar de novo a mesma senha é inofensivo e idempotente (o Stalwart guarda só o hash). Para essas caixas o painel é a fonte da verdade: a `postmaster@` e a caixa do projeto só funcionam se o painel (e o projeto, via variáveis `SMTP_*`) souberem a senha.
- Custo: uma chamada PATCH por caixa (sequencial) a cada Sincronizar; o resultado então diz "realinhei N" mesmo quando já estava igual (o texto diz "com a que o painel guarda", sem afirmar que estava diferente).
- Risco aceito e documentado: se a pessoa trocou a senha de uma caixa de projeto diretamente no webmail, o Sincronizar desfaz isso (a senha do projeto é a do painel; a troca correta é Trocar senha). Caixa de usuário nunca é tocada.

## 4. Testes

- `apps/server/tests/mail-realign-passwords.test.ts` (integração, Stalwart falso por fetch com o `StalwartClient` real): postmaster@ divergente, caixa de projeto, caixa de usuário intocada, caixa sem senha intocada, caixa ausente no servidor, recém-adotada, falha parcial, sem segredo em resposta/log, idempotência, chamadas simultâneas, troca de senha concorrente, nada a realinhar.
- `backup-service.test.ts` (aviso/passo no registro da restauração, singular, falhas), `routes-mail-sync.test.ts` (resposta e auditoria só com contagens), `mail-system-send.test.ts`, `notification-service.test.ts`, `mail-test-email.test.ts` (535 no AUTH), `smtp-send.test.ts` (comando recusado), `mail-page.test.tsx`, `notification-settings.test.tsx` (botão para sincronizar).
- Os testes de integração e da tela foram vistos falhando antes da implementação; os do 535 no servidor foram escritos junto da implementação do `command`.

## 5. Como validar contra Stalwart real (v0.11.8, `packages/core/src/images.ts`) — não feito aqui

1. Numa VPS de teste, crie o domínio e a `postmaster@` pelo painel (senha do painel A).
2. Restaure um backup do e-mail cuja `postmaster@` tem senha B. Confirme que o teste de notificação falha com 535 (reproduz o bug).
3. Em E-mail, clique em Sincronizar: deve dizer "Realinhei a senha de N caixas".
4. Envie o teste em Configurações → Notificações (deve passar) e confirme que o login com a senha B passou a ser recusado e com a A, aceito (por exemplo `swaks` na porta de submissão, ou o webmail).
5. Confirme que uma caixa de usuário com senha trocada no webmail continua com a senha dela.

## 6. O que não foi testado

- Stalwart e Docker reais (Stalwart falso por fetch; gerenciador do Docker é dublê).
- A VPS do dono.
- O comportamento exato do bloqueio automático por login falho do Stalwart (motivo de não verificar antes) vem da configuração padrão documentada do servidor, não foi medido.
