# Relatório — apagar o projeto solta o e-mail; e-mail do projeto numa caixa que já existe (22/10/2026)

Branch do worktree `worktree-agent-a440754fa2edacf36` (a partir de `dev`).

## Por que

O dono apagou o projeto do site da TWS (o painel não apagou o e-mail, como deve ser). Ao recriar o projeto e ligar o e-mail no mesmo endereço, o painel respondeu "já existe" (409 `address_in_use`) e ele teve de apagar a caixa à mão, perdendo o que havia nela. Ele também quer ligar o e-mail de um projeto a uma caixa que já configurou no webmail, sem apagar nem refazer nada.

## Diagnóstico (confirmado no código)

- `MailService.requireFreeAddress` considera o endereço "de outro projeto" quando `data.projects[<id>]` guarda `mailbox === endereço`.
- `DeployService.deleteProject` e a rota `DELETE /api/projects/:id` nunca chamavam `disableProjectEmail` (só `routes/mail.ts` chamava), então o registro do projeto apagado ficava órfão e bloqueava o endereço.
- `requireFreeAddress` só deixava uma caixa existente virar a do projeto se fosse caixa de projeto sem uso, ou adotada sem senha conhecida no endereço padrão `<slug>@`. Qualquer caixa de usuário (ex.: `contato@`) era recusada. Continua assim no fluxo "criar caixa nova"; o novo caminho é explícito.

## O que mudou (pelo comportamento)

### Tarefa 1 — apagar o projeto solta o e-mail
- Remover um projeto agora solta o vínculo de e-mail dele: some o registro e as ligações de variáveis (`envLinks`). A caixa e as mensagens ficam no servidor de e-mail. Falha ao soltar não impede a remoção: vai para o log da remoção e para o log do painel.
- O que a caixa vira: a criada para o projeto continua `kind: "project"` sem dono (o código já a reaproveita), com a senha guardada. Assim o realinhamento (Sincronizar/restauração, que só regrava caixas de projeto e de sistema) continua colocando a senha certa nela. A caixa que já existia antes de virar a do projeto (marca interna `external`) volta a ser de usuário.
- Órfãos que já existem (projetos apagados antes): o painel compara os registros com a lista de projetos que existem e solta os órfãos ao ativar o e-mail, listar caixas, listar caixas usáveis e Sincronizar. Sem a lista de projetos (ou com erro nela), nada é considerado órfão.
- Recriar o projeto com o mesmo endereço: a caixa solta é reaproveitada sem apagar nada. Na tela ela aparece em "Usar uma caixa que já existe" com "Manter a senha que o painel já guarda"; o fluxo "caixa nova" no mesmo endereço continua pedindo senha nova.
- Trocar o endereço do projeto não apaga mais uma caixa que já existia antes de virar a do projeto (só a solta). A criada pelo painel para o projeto continua sendo removida, como antes.

### Tarefa 2 — usar uma caixa que já existe
- `GET /api/projects/:id/email/mailboxes?domain=` lista as caixas do domínio que o projeto pode usar: de usuário e de projeto sem uso. Ficam de fora as de sistema, `postmaster@`/`abuse@`/`dmarc@`, a caixa atual do projeto e qualquer caixa de outro projeto que exista (registro de e-mail dele ou dono gravado). Nunca traz senha, só se o painel a conhece.
- `POST /api/projects/:id/email` com `useExistingMailbox` (e `fromLocalPart` = a caixa) aceita três caminhos:
  - `current_password`: a pessoa informa a senha atual. O painel confere comparando com o cadastro do servidor de e-mail (`mailboxPasswordMatches`, uma leitura, sem tentar login). Assim não há falha de autenticação que conte para o auto-ban do Stalwart (100/dia por IP, ~5 s cada). Diferente: 400 `mailbox_password_mismatch`. Se o servidor só guarda hash ou falha, a senha é aceita e a resposta traz `passwordVerified: false` (a tela avisa).
  - `keep_password`: usa a senha que o painel já guarda e confere do mesmo jeito (409 `stored_password_stale` se mudou; 400 `password_required` se não a conhece).
  - `replace_password`: o painel gera uma senha forte, aplica na caixa e a mostra uma vez; a tela avisa que apps e webmail com a senha antiga precisam ser atualizados.
- A caixa de usuário vira "do projeto" (o Sincronizar/restauração a realinha). A tela diz para não trocar a senha dela direto no webmail.
- Cuidados: caixa em uso por outro projeto existente (409 `mailbox_taken_by_project`, com o nome do projeto na mensagem), `SYSTEM_LOCAL_PARTS`/sistema (409 `address_in_use`), caixa inexistente (404), servidor parado (409), caixa que sumiu no meio (409 `mailbox_gone`), senha curta (400 `weak_password`, antes de falar com o servidor), concorrência (tudo dentro de `withMailboxLock` com revalidação; duas ligações na mesma caixa: só uma vence). Reversão: o cadastro é gravado antes de trocar a senha no servidor; se algo falhar, caixa e registro do projeto voltam como estavam e o cadastro é regravado.
- Senha nunca vai para log, auditoria (`mail.project.mailbox.connect` guarda só caixa e caminho) nem resposta (a gerada só vem em `generatedPassword`, com `cache-control: no-store`). O campo interno `external` não sai pela API.
- Tela (`ProjectEmailCard`): fieldset "Caixa do projeto" (criar nova / usar existente), seleção da caixa, os caminhos de senha, aviso de gerenciamento, aviso de senha não verificada; erros em `role="alert"`. Textos em pt-BR e en; códigos novos em `errors.code.*`; GLOSSARY e `_i18n-servidor-fase2.tsv` atualizados.

## Testes
- Servidor: `apps/server/tests/mail-project-existing-mailbox.test.ts` (27 testes: remoção solta, órfão pré-existente, recriar, lista de caixas, senha informada/trocada/mantida, recusas, falha no meio, sumiu, concorrência, log sem senha), `routes-mail-schema.test.ts` (rotas, auditoria sem senha, ouvinte da remoção) e `deploy-env.test.ts` (ouvinte, falha não impede a remoção).
- Web: `apps/web/tests/project-email-card.test.tsx` (cartão com a opção, os três caminhos, vazio, erro, outro projeto, inglês).
- Os testes foram escritos antes do código, mas não rodei cada um falhando de forma isolada antes de implementar (os de rota foram vistos falhando; os de serviço, web e deploy passaram na primeira execução depois do código).
- Cobertura: server 2405 testes ok (instr. 97,59%, ramos 93,53%); web 1263 ok; core 149 ok (ramos 98,53%); mailer não foi tocado.

## Correções da revisão (22/10/2026)
- A conferência de senha ignora as entradas `$app$…` (senha de app) e `otpauth://…` (2FA) do campo `secrets`: antes, uma senha ERRADA virava "não deu para conferir". Se há senha principal em texto e ela difere: "não confere".
- Não conseguir conferir em caixa de USUÁRIO agora recusa (409 `password_unverifiable`): guardar a senha errada faria o Sincronizar gravá-la na caixa. Em caixa criada pelo painel segue aceitando com o aviso (que agora diz a consequência).
- "Trocar por gerada" troca só o item principal e preserva senhas de app e 2FA (`setMailboxMainPassword`); o realinhamento do Sincronizar também usa essa troca quando a leitura funcionou. Se não dá para ler a caixa, falha sem trocar nada.
- Desativar o e-mail solta a caixa adotada (volta a ser de usuário) e o bloqueio por "dono" só vale para o e-mail de projeto registrado; a mensagem "Desative o e-mail dele" passa a ser verdadeira.
- Lista de projetos vazia com vínculos registrados vale como "não sei" (projects.json ausente é lido como lista vazia).
- Web: o erro recebe foco e rolagem; ícone da legenda com `shrink-0`; texto sobre Desativar e-mail.
- Testes: mutação do filtro de órfãos (projetos vivos preservados), caixa de sistema com parte local comum, Desativar libera, lista vazia, e os de mailer (`$app$`/`otpauth`, `setMailboxMainPassword`).

## Correções da 2ª revisão
- "Trocar senha", o assumir da caixa adotada `<slug>@` e o Sincronizar (também quando a leitura falha: então não troca e lista a falha) usam `setMailboxMainPassword`, que preserva `$app$` e `otpauth://`. Não sobra uso de `setMailboxPassword` sobre caixa existente.
- Caixa criada na aba Caixas de outro projeto que existe fica fora da lista e é recusada (409 `mailbox_taken_by_project`, mensagem própria). Ao adotar, o dono original é guardado (`ownerBefore`) e volta ao soltar (Desativar, remoção do projeto, troca de endereço). Desativar continua liberando a caixa adotada.
- O dublê de teste agora distingue as duas trocas (`setMailboxPassword` apaga app/2FA, como o Stalwart real) e há testes para os pontos acima. Mutações que caem: trocar por gerada, Trocar senha, assumir `<slug>@`, realinhamento, guarda da lista vazia (caixas com dono e sem registro), dono de outro projeto, restaurar o dono e a rolagem até o erro.

## Limites e o que não foi verificado
- Não rodado contra um Stalwart real: a conferência da senha depende do `GET /principal/<caixa>` devolver a senha em texto (v0.11.8, como o realinhamento já assume); com hash, o caminho cai em "aceita sem verificação".
- Layout a 360/1024 px e acessibilidade foram feitos com as mesmas classes e padrões do cartão (colunas que empilham, `min-w-0`, `overflow-wrap`), mas não conferi no navegador.
- Em caixa criada pelo painel, senha aceita sem verificação e errada será regravada pelo Sincronizar; o aviso na tela diz isso.
- Não tratei o diálogo de apagar projeto com a opção de apagar o e-mail/backup (outro lote).
