# Relatório — Realinhar a senha das caixas depois de restaurar o e-mail

Parte de `main` (b3875c4). Sem push nem PR.

## 1. O problema (VPS nova do dono)

O teste de notificação por e-mail falhava com "O servidor de e-mail recusou (AUTH): 535 5.7.8 Authentication credentials invalid". Causa: o painel novo criou `postmaster@<domínio>` com uma senha própria (guardada em `mail.json`); depois o dono restaurou o backup do e-mail, a caixa voltou no Stalwart com a senha ANTIGA do backup, e o painel seguiu autenticando com a dele. A adoção só acrescentava o que faltava no cadastro e nunca alinhava senha de caixa que o painel já conhecia.

## 2. O que mudou (pelo comportamento)

- **Realinhamento de senhas.** Sincronizar com o servidor de e-mail e a adoção do fim da restauração (as duas usam `MailService.adoptFromStalwart`, coalescido) comparam e reaplicam no Stalwart (com o `setMailboxPassword` existente) a senha que o painel guardou para as caixas de sistema (`postmaster@`) e de projeto, só quando a do servidor difere (ver seção 3). Só entram caixas com senha conhecida, de domínio cadastrado e que o Stalwart de fato lista. Não toca em caixa de usuário (a pessoa pode ter trocado a senha no webmail, ou ela veio do backup), em caixa sem senha conhecida (inclui as recém-adotadas) nem em caixa que o servidor não tem. Nada reinicia. Idempotente: repetir encontra tudo igual, não regrava nada e não muda o `mail.json`.
- **Falha parcial.** Falha numa caixa vai para `passwordsFailed` (só o endereço), vira linha de log sem senha e não impede as outras caixas nem a sincronização.
- **Onde aparece.** Resposta de `POST /api/mail/sync` (`passwordsRealigned`, `passwordsFailed`); a tela de E-mail diz "Realinhei a senha de N caixas com a que o painel guarda" e lista as que falharam; o registro da restauração ganha o passo/aviso "Realinhei a senha de N caixas do painel" e, se houve falha, um aviso com os endereços e o caminho (Sincronizar ou Trocar senha). A auditoria `mail.sync` registra só contagens.
- **Concorrência com Trocar senha.** Uma fila por caixa (`withMailboxLock`) serializa o realinhamento com Trocar senha e com a ativação do e-mail do projeto. A senha é lida quando chega a vez da caixa na fila, então uma troca feita durante o realinhamento nunca é desfeita (teste dedicado).
- **Mensagem melhor para o 535.** `SmtpSendError` passou a carregar o comando recusado (`command`). Recusa 5xx no `AUTH` vira `email_auth_rejected` (409): "O servidor de e-mail recusou o login: a senha guardada pelo painel não é a do servidor. Abra E-mail e use Sincronizar (realinha a senha) ou Trocar senha na caixa postmaster@." Vale para o teste de notificação, para o motivo no histórico dos avisos reais (curto, cabe nos 200 caracteres do histórico e não contém endereço) e para o e-mail de teste do domínio. Em Configurações → Notificações aparece o botão **Abrir E-mail para sincronizar**. Textos em pt-BR e en (`errors.code.email_auth_rejected`, `notifications.email.openMailToSync`, `mail.page.sync.*`); códigos novos no `_i18n-servidor-fase2.tsv`.

## 3. Risco: comparar antes de reaplicar (revisão do 0092037)

Na primeira versão o painel reaplicava SEMPRE, e por isso toda restauração terminava "com aviso" e a tela mostrava a frase de que o servidor "voltou com a senha antiga" mesmo quando a senha já era igual. Medido no Stalwart real v0.11.8: `GET /api/principal/<caixa>` devolve a senha **como foi enviada (texto puro; o Stalwart não guarda só o hash)**. Agora:

- O painel compara em memória (`StalwartClient.mailboxPasswordMatches`): a senha do servidor nunca é guardada, logada, auditada nem devolvida. Igual: nada é regravado nem contado. Diferente: regrava e conta em `passwordsRealigned`. Só esse caso gera o aviso "Realinhei a senha de N caixas" e rebaixa a restauração para "com aviso".
- Leitura com erro (não 404), sem o campo ou só hash: reaplica mesmo assim e conta à parte em `passwordsReapplied` ("reaplicada, não verificada"): na tela e no registro, frase neutra, sem afirmar que estava diferente e sem rebaixar o status.
- Por que não testar o login com a senha guardada: cada login errado leva ~5 s, e o auto-ban do v0.11.8 (`server.auto-ban.auth.rate = 100/1d`) corta as conexões do IP depois de ~100 falhas, inclusive a API HTTP de administração que o painel usa. Comparar a senha lida não faz nenhum login errado.
- Caixa apagada no servidor durante a sincronização: no v0.11.8 real o GET responde **HTTP 200 com `{"error":"notFound","item":"…"}`** (não 404); `mailboxPasswordMatches` trata isso (e também um 404 HTTP) como caixa inexistente, e ela fica de fora, sem contar e sem aparecer em "Não consegui realinhar". O mesmo vale para a caixa removida do cadastro durante a sincronização (conferido de novo na vez dela na fila; o teste cai se a checagem for removida).
- Risco aceito e documentado ao usuário: se a pessoa trocou direto no webmail a senha de uma caixa de PROJETO (ou da `postmaster@`), o Sincronizar e o fim da restauração desfazem a troca (a senha do projeto é a do painel; a troca correta é Trocar senha). Caixa de usuário comum nunca é tocada.

## 4. Testes

- Revisão: `mailboxPasswordMatches` (mailer, true/false/hash/sem campo/erro); caso igual, diferente, leitura sem senha/com erro, 404, caixa removida do cadastro (antes e depois de entrar na fila), domínio não cadastrado; a senha é lida na vez da caixa (troca em andamento não é desfeita); fila na ativação do e-mail do projeto (testado removendo a fila: o teste cai); fronteira 4xx/5xx do AUTH nos dois envios; mensagem do e-mail de teste cita a caixa que enviou. Isso achou um erro real: caixa removida do cadastro entre a listagem e a vez dela derrubava a sincronização (`Cannot read properties of undefined`).

- `apps/server/tests/mail-realign-passwords.test.ts` (integração, Stalwart falso por fetch com o `StalwartClient` real): postmaster@ divergente, caixa de projeto, caixa de usuário intocada, caixa sem senha intocada, caixa ausente no servidor, recém-adotada, falha parcial, sem segredo em resposta/log, idempotência, chamadas simultâneas, troca de senha concorrente, nada a realinhar.
- `backup-service.test.ts` (aviso só quando realinhou de verdade e status sucesso quando já conferia; passo neutro quando não deu para conferir; singular; falhas), `routes-mail-sync.test.ts` (resposta e auditoria só com contagens), `mail-system-send.test.ts`, `notification-service.test.ts`, `mail-test-email.test.ts` (535 no AUTH), `smtp-send.test.ts` (comando recusado), `mail-page.test.tsx`, `notification-settings.test.tsx` (botão para sincronizar).
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
- O auto-ban do Stalwart (`server.auto-ban.auth.rate = 100/1d`, ~5 s por login errado) foi medido pelo revisor no v0.11.8; aqui só está documentado. A leitura da senha em texto pelo `GET /principal/<caixa>` também foi medida pelo revisor, não por mim.
