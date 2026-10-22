# Relatório — nome de exibição das caixas de e-mail (22/10/2026)

Pedido do dono: na aba E-mail de um projeto, ao criar uma NOVA caixa não havia campo para o nome de exibição. Ele lembrava de informar o nome ao criar a caixa no painel geral e não sabia se o nome existia para todas as caixas ou só para a primeira.

## Como funcionava ANTES (resposta à dúvida)

O nome de exibição existia **só para a caixa de envio do projeto** (a "primeira", criada ao ativar o e-mail do projeto). Para nenhuma outra caixa, em nenhum dos dois lugares.

| Onde se cria | Pedia o nome? | Onde ficava |
|---|---|---|
| Ativar o e-mail do projeto (caixa de envio) | Sim (`fromName`, opcional; em branco = nome do projeto) | `data/mail/mail.json` (`projects[id].fromName`). **Nunca ia ao Stalwart.** |
| "Usar uma caixa que já existe" | Sim (mesmo campo, em branco = nome do projeto) | idem |
| Caixa nova na página do domínio (E-mail → Caixas) | **Não** (a memória do dono não confere: nunca houve o campo ali) | não existia |
| Caixa extra criada na aba Caixas do projeto | **Não** | não existia |
| Editar depois | **Não existia** em lugar nenhum (só salvando de novo a ativação do projeto) | — |

Onde o nome era usado:

- **Deploy:** `MAIL_FROM_NAME` (injetado por `buildSmtpEnv`, só quando há nome). `MAIL_FROM` é sempre o endereço puro. O app monta o `From` ("Nome" <endereço>) por conta própria; o painel não monta o cabeçalho dos e-mails dos apps.
- **E-mail de teste do painel:** cabeçalho `From` montado por `formatFromHeader` (aspas e barra escapadas, CR/LF removidos, UTF-8 em palavras codificadas RFC 2047 de até 75 caracteres). Só a caixa de projeto saía com nome; as outras, sem.
- **Avisos do painel** (`sendSystemMail`): nome fixo "TWS Panel", independente da caixa.
- **Webmail (Roundcube):** o plugin `paas_identity` recebia só o nome das caixas de projeto (`webmailIdentities`). Ele preenche a identidade no primeiro login ou se estiver vazia; nunca sobrescreve um nome que a pessoa já tenha no webmail.
- **Stalwart:** o campo `description` do principal (API v0.11: `POST /api/principal` e `PATCH` com `set description`) **não era usado** — o nome só existia no painel.

### Inconsistências encontradas

1. Criar no projeto (caixa extra) e no painel geral não permitia nome; só a ativação do projeto permitia.
2. O nome da caixa de projeto não era gravado no Stalwart (qualquer cliente de e-mail que lê o cadastro do servidor via a API não o via; restaurar o backup do e-mail perdia o nome no painel).
3. Não havia como editar o nome sem refazer a ativação.
4. As listas de caixas não mostravam nome; o cartão do projeto mostrava o nome, mas não dizia de onde vem o `From` que o app usa.
5. O limite do campo (1 a 80 caracteres, sem CR/LF/`< > "` `\`) estava só no schema da rota, sem núcleo compartilhado; não barrava TAB, NUL, separadores Unicode nem marcas de direção. Nome do projeto usado como padrão não era limpo (um projeto chamado `Loja <b>` ia ao `MAIL_FROM_NAME`).
6. E-mail de teste de caixa comum saía sempre sem nome.

## O que mudou (pelo comportamento)

- **Todo lugar que cria caixa tem "Nome de exibição (opcional)":** página do domínio, aba Caixas do projeto (também caixas extras) e a ativação do e-mail do projeto (que já tinha; agora usa o mesmo campo, com a mesma validação em tela). Placeholder de exemplo, dica e erro na hora (aria-invalid, texto descritivo).
- **Regra única** em `@paas/core` (`normalizeDisplayName`, `MAILBOX_DISPLAY_NAME_PATTERN`, `MAILBOX_DISPLAY_NAME_MAX = 80`): até 80 caracteres (conta caracteres, não bytes), sem caracteres de controle (CR, LF, TAB, NUL, C1), sem U+2028/2029, sem marcas de direção (U+202A–202E, U+2066–2069), sem `< > "` e barra invertida. Apara e junta espaços repetidos. Servidor (schema da rota e, de novo, o service: 400 `invalid_display_name`) e tela usam a mesma função.
- **Valor padrão quando vazio:** caixa de envio do projeto = nome do projeto (limpo dos caracteres inválidos e cortado em 80); caixa comum ou extra = **sem nome** (o `From` sai só com o endereço; nada é inventado). Em "usar uma caixa que já existe": nome digitado; senão o que a caixa já tem; senão o do projeto.
- **Gravado no Stalwart:** `description` do principal (JSON, `POST /api/principal` na criação e `PATCH set description` na alteração). Nunca em URL nem comando.
- **Alterar depois:** botão "Alterar nome de exibição" em cada caixa das listas (página do domínio e aba Caixas do projeto), modal curto. Rota nova `PUT /api/mail/mailboxes/:id/display-name`. Só o campo `description` é tocado: senha, 2FA, senhas de app, apelidos e mensagens ficam. Nome vazio remove (na caixa de envio do projeto, volta ao nome do projeto).
- **Caixa de envio do projeto:** a alteração atualiza também `projects[id].fromName` (o `MAIL_FROM_NAME` do próximo deploy). A tela avisa que o app só usa o nome novo no próximo deploy; **não há deploy automático**.
- **Escopo do projeto:** na aba do projeto o corpo leva `projectId`; caixa de outro projeto ou de nenhum responde 403 `mailbox_not_in_project`. Caixa inexistente, 404.
- **Auditoria:** `mail.mailbox.display-name` com o endereço e "alterado"/"removido" (o texto do nome não entra na trilha).
- **Listas:** o nome aparece abaixo do endereço (ou "Sem nome de exibição"); quebra linha em tela estreita; renderizado como texto.
- **Cartão do e-mail do projeto:** diz de onde vem o `From` do app: `MAIL_FROM_NAME` + `MAIL_FROM`, o nome vem da caixa do projeto e vale no próximo deploy.
- **E-mail de teste** de qualquer caixa com nome sai com o nome dela. **Webmail** passa a receber o nome de todas as caixas que têm nome (a de envio do projeto vale o `MAIL_FROM_NAME`). **Sincronizar** (adoção depois de restaurar) lê o `description` do Stalwart e, se for um nome válido, adota.

## Correções da revisão (1ª rodada)

- **Projetos ativados antes do lote:** o nome vivia só em `projects[].fromName`. Ao carregar o cadastro, o painel copia esse nome para a caixa de envio que não tem nome (em memória, idempotente, nunca sobrescreve), então a lista e o modal mostram o nome efetivo. O Stalwart recebe o nome no próximo **Sincronizar**, e só se a caixa estiver sem `description` lá (não sobrescreve nome existente; falha vai para o log).
- **Nome cru do projeto:** `MAIL_FROM_NAME` do deploy, identidades do webmail, e-mail de teste e a configuração devolvida à tela passam por `sanitizeDisplayName` (em `@paas/core`). Se a limpeza dá vazio (projeto chamado `<<>>`), não há nome: sem `MAIL_FROM_NAME` e `From` só com o endereço, nunca o texto cru.
- **Regra mais estrita:** também recusa zero-width (U+200B–200D, U+2060, U+FEFF — isso inclui o ZWJ de emoji compostos), LRM/RLM/ALM (U+200E, U+200F, U+061C) e surrogate solitário (o Stalwart recusa com "JSON deserialization failed"). "Sem marcas de direção" agora é verdade.
- **"@" no nome é aceito** (ex.: `ceo@example.com`): o endereço real da caixa continua visível ao lado. Não há normalização NFC nem proteção contra homógrafos.
- **Sincronizar** só traz o nome do Stalwart para caixas **novas** (adoção); não sobrescreve nome já conhecido nem desfaz um nome alterado depois no painel.
- **Trocar para "usar caixa existente" num projeto já ativado:** o nome que o formulário traz preenchido (o do projeto) deixou de contar como digitado; só o que a pessoa digita de novo é enviado. Assim o nome que a caixa escolhida já tem prevalece; sem nenhum, vale o nome do projeto. Efeito: o nome antigo do projeto não acompanha a troca para outra caixa, a menos que seja digitado de novo.
- **Modal:** Esc fecha, Tab fica dentro dele e o foco volta ao botão que o abriu (vale para os três modais da aba Caixas). A dica do modal da caixa de envio concorda com o aviso ("em branco, o nome do projeto"). A prévia e o exemplo da ativação usam a mesma limpeza do servidor; o rótulo voltou a dizer "(opcional)". O botão visível é "Alterar nome" (o nome acessível continua completo) para a linha de botões caber melhor em 1024 px.
- **Origem provável da confusão do dono:** existem outros dois rótulos "Nome de exibição" no painel — Configurações → Perfil (nome do usuário do painel) e a configuração do projeto —, que não têm relação com o nome da caixa.

## Decisões e limites

- Rate limit: o global do painel (200/min por IP), igual às demais rotas de escrita do e-mail; CSRF e sessão vêm do guard global. Não criei limite próprio.
- Nome sem `< > " \`: mantido do schema anterior para não quebrar apps que montam `Nome <endereço>` sem aspas. Não dá para ter aspas no nome.
- Webmail: a identidade de quem **já tem** nome no Roundcube não é sobrescrita (decisão antiga, para não apagar escolha da pessoa). Mudar o nome no painel afeta quem entrar pela primeira vez ou estiver com a identidade vazia; os demais trocam em Configurações → Identidades.
- Avisos do painel continuam com o nome fixo "TWS Panel".
- O envio pelo painel usa RFC 2047 (já existia em `formatFromHeader`; reforçado por testes). Os apps montam o próprio cabeçalho a partir de `MAIL_FROM_NAME`.
- Caixas antigas sem nome: continuam sem nome; a caixa de envio de registro antigo sem `fromName` usa o nome do projeto no deploy.

## Verificação

- Teste real contra o Stalwart v0.11.8 em Docker (`scripts/test-mail-display-name.mts`, rede `--internal`; sub-rede explícita porque o host estava sem faixas livres para redes novas — `TWS_DN_SUBNET` troca): criar com nome grava `description`; alterar grava UTF-8 (acento, CJK, emoji, aspas simples) sem perda; senha, 2FA (`otpauth://`), senha de app (`$app$`) e aliases permanecem idênticos; a listagem traz o nome; 80 caracteres passam; vazio limpa. Container, rede e volume removidos no fim; nenhuma imagem criada (a do Stalwart e a `node:22-alpine` já existiam).
- Testes novos: `packages/core/tests/display-name.test.ts`, `packages/mailer/tests/client-display-name.test.ts`, `apps/server/tests/mail-display-name.test.ts`, `apps/server/tests/routes-mail-display-name.test.ts`, `apps/web/tests/mailbox-display-name.test.tsx`, mais casos em `mail-adopt-service`, `mail-test-email` e `project-email-card`.
- Não verificado: layout real em 360 px (jsdom não calcula layout; conferi as classes de quebra de linha); webmail Roundcube real com o nome novo (só a geração do arquivo de identidades).
