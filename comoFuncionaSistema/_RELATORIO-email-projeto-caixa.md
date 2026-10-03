# Relatório — e-mail do projeto vira caixa de verdade (02/10/2026)

Branch `feat/email-projeto-caixa` (a partir de `origin/dev`).

## Por que

Validação real do dono do produto: ele criou "Contato - Cassino <contato@envio.…>" no e-mail do projeto e:

1. não conseguia abrir essa caixa para ler as respostas — o endereço era só um apelido (alias) de uma caixa técnica `<slug>@`, cuja senha nunca aparece;
2. o e-mail de teste chegou no Gmail como "cassino" (saía da caixa técnica, sem nome);
3. o campo "Seu domínio" vinha só com o domínio do projeto como dica, vazio;
4. o app do projeto usa outros nomes de variável e ele queria levar os valores do e-mail para as Variáveis.

## O que mudou (pelo comportamento)

### O endereço de envio é a caixa do projeto
- Ao ativar, o painel cria a caixa no próprio endereço escolhido (em branco: `<slug>@<domínio>`). O projeto entra com ela e envia como ela: `SMTP_USER` e `MAIL_FROM` são esse endereço; `MAIL_FROM_NAME` é o nome de exibição. Não existe mais alias.
- A pessoa escolhe a senha da caixa: **digita duas vezes** (mínimo 12 caracteres, campos de senha com o "olho") ou marca **"Gerar uma senha forte para mim"**. A senha gerada aparece **uma única vez**, com botão de copiar e o aviso "Guarde agora: o painel não mostra de novo. Esqueceu? Use Trocar senha.". Depois disso, nenhuma rota devolve a senha (o valor de `SMTP_PASS` continua mascarado).
- **Trocar senha** agora vale também para a caixa do projeto (antes era recusada com `mailbox_managed`). No card do projeto: digitar a nova ou gerar uma forte. O painel troca no servidor de e-mail, guarda e avisa: "O projeto só recebe a senha nova no próximo deploy."
- **Trocar o endereço** (ou o domínio) de um projeto já ativo: o painel pede a senha da caixa nova, cria a caixa e remove a antiga (com as mensagens) se nenhum outro projeto a usa. O card avisa antes de salvar. Se a remoção falhar no servidor de e-mail, a troca vale assim mesmo, a falha vai para o log e a caixa antiga continua na lista do domínio, onde dá para remover.
- Endereço que já é de outra caixa, de outro projeto, ou `postmaster@`/`abuse@`: recusa com `409 address_in_use`. Uma caixa de projeto que ficou sem uso (e-mail desativado antes) é reaproveitada, pedindo senha.
- **Desativar** não apaga a caixa (as mensagens ficam). Ela pode ser removida na página do domínio.
- **"Configurar no app"** no card: usuário, servidor e portas de IMAP e SMTP para abrir a caixa no Outlook, no Gmail ou no celular, sem a senha.
- **E-mail de teste** a partir da caixa de um projeto sai com o nome de exibição: `"Contato Loja" <contato@…>`. Nome com acento vai codificado (RFC 2047, em pedaços de até 75 caracteres, sem cortar letra ao meio). Quebra de linha é removida e aspas/barra são escapadas, então não há como injetar cabeçalho. O schema da rota já recusava `\r \n < > "` e esta é a segunda barreira. Das outras caixas, o teste sai sem nome, como antes.
- O card explica: "O nome de exibição aparece para quem recebe quando o app do projeto usa MAIL_FROM_NAME (ou monta 'Nome <endereço>'). O e-mail de teste já sai com ele."
- **"Seu domínio"** (em "Usar um domínio meu") já vem **preenchido** com o domínio do projeto. Dá para editar.

### Copiar valores e ligar às Variáveis
- Cada valor do card tem botão de copiar, menos `SMTP_PASS`, que nunca é visível nem copiável.
- **"Ligar às variáveis do projeto"** abre um modal com uma linha por valor (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM e MAIL_FROM_NAME). Em cada linha há um seletor com busca. As opções são:
  - "mesmo nome (padrão)";
  - as variáveis do compose;
  - as já cadastradas em Variáveis;
  - um nome novo digitado.

  O modal avisa quando:
  - um nome é inválido ou reservado;
  - o mesmo nome foi escolhido em duas linhas;
  - a variável já tem valor em Variáveis (o valor de lá vence).
- O painel **não copia valores**. Ele guarda só o mapeamento (ex.: `{ SMTP_SENHA: "SMTP_PASS" }`) e, a cada deploy, entrega o valor **atual** também com esse nome. Por isso a senha trocada chega sozinha no próximo deploy.
- As variáveis ligadas vão para o `.env` do projeto, como as Variáveis, e não para todos os serviços do compose. Só os `SMTP_*`/`MAIL_*` padrão continuam injetados em todos os serviços, como sempre. Elas contam como fornecidas no aviso de variáveis faltando.
- Na seção Variáveis, as fornecidas pelo e-mail que não estão na lista aparecem num bloco à parte, só com o nome, e com link para o card do e-mail.
- Componente novo reutilizável: `apps/web/src/components/ui/combobox.tsx`, uma seleção com busca no estilo select2. Ele segue o padrão "combobox com lista" da WAI-ARIA e oferece:
  - setas, Enter e Esc;
  - `aria-activedescendant`;
  - opção de criar valor novo;
  - lista que rola por dentro no celular.

## Decisões
- **Caracteres especiais da senha gerada: só `-`, `_` e `.`.** São os "não reservados" da RFC 3986 e passam sem escape no `.env` do compose, no YAML do override, num `export` de shell, em JSON e numa URL `smtp://usuario:senha@host`. Ficam de fora `$` (interpolação do compose), `#` (comentário no `.env`), aspas, `\`, espaço, `:`, `@`, `/`, `%`, `&` e `!`. A senha tem 24 caracteres, sempre com maiúscula, minúscula, número e especial, e começa com letra ou número. Senha digitada pela pessoa pode ter qualquer caractere: o `.env` já é escrito com aspas e escape (`dotenvLine`).
- **Nomes reservados para ligação:** os próprios seis nomes do e-mail (ligar `SMTP_PASS` a `SMTP_USER` confundiria o app), `COMPOSE_*` e `DOCKER_*` (no `.env` eles mudam o próprio compose), e `PATH`, `HOME`, `HOSTNAME`, `PWD`, `SHELL` e `USER`. O padrão do nome é o mesmo das Variáveis. A regra fica em `packages/core/src/mail.ts` (`envLinkNameProblem`), usada pelo servidor e pela tela.
- **Precedência:** uma variável com o mesmo nome preenchida em Variáveis continua vencendo, como já valia para os `SMTP_*` padrão. O modal avisa.
- **Desativar mantém a caixa:** apagar mensagens sem a pessoa pedir seria pior que deixar uma caixa sobrando.
- A troca de endereço remove a caixa antiga, como foi pedido. O card avisa antes de salvar que as mensagens dela vão junto.

## Migração do que já está gravado
- Registros com `fromAddress` (alias) **continuam funcionando sem nenhuma ação**: o projeto segue entrando com a caixa técnica e enviando como o alias. A API marca `legacyAlias: true` e o card mostra um aviso explicando o modelo antigo.
- Ao salvar de novo ("Alterar remetente" → Salvar), o card pede a senha. O servidor faz, nesta ordem:
  1. tira o alias da caixa técnica (antes de criar a caixa, porque o Stalwart não aceita o mesmo endereço em duas caixas);
  2. cria a caixa no endereço;
  3. grava o modelo novo;
  4. remove a caixa técnica antiga, se ninguém mais a usa.
- Se a pessoa salvar voltando ao padrão `<slug>@`, só o alias sai. A caixa técnica vira a caixa do projeto, e a senha é opcional (dá para usar Trocar senha depois).
- No caso do cassino: abrir o e-mail do projeto, "Alterar remetente", manter `contato`, escolher a senha (ou gerar), Salvar e fazer um novo deploy.

## Como testei
- TDD em cada camada. Os testes novos foram escritos antes e vistos falhando (o do combobox falharia só por não existir o arquivo; não rodei esse antes de criar o componente):
  - `packages/mailer/tests/mailboxes.test.ts` e `smtp-send.test.ts`: senha forte e cabeçalho From com nome;
  - `packages/core/tests/email-links.test.ts`: regra de nomes;
  - `apps/server/tests/mail-service.test.ts`: caixa do projeto, troca de endereço, falha ao remover, conflitos, reaproveitamento, migração do alias, ligações;
  - `mail-test-email.test.ts`: nome no teste;
  - `routes-mail-schema.test.ts`: senha/gerar, rota de ligações, `cache-control: no-store` na senha gerada;
  - `deploy-env.test.ts`: ligadas no `.env`, fora de "todos os serviços", contam como fornecidas;
  - `apps/web/tests/combobox.test.tsx`, `project-email-card.test.tsx` (reescrito) e `project-sections.test.tsx`.
- Tela conferida a 390 px com o Vite e a API simulada no navegador (card ativado, "Configurar no app", "Trocar senha" e o modal com a lista aberta): sem rolagem lateral.
- `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`, antes e depois:

| Pacote | Antes | Depois | Ramos (depois) |
|---|---|---|---|
| core | 45 | 50 | mínimo 98% ok |
| mailer | 169 | 179 | 98,68% (mínimo 98%) |
| deploy | 339 | 339 | 95,74% (mínimo 95%) |
| security | 187 | 187 | 97,26% |
| server | 945 | 976 | 92,44% |
| web | 442 | 466 | — |

Todos passaram, inclusive os mínimos de cobertura.

## O que só dá para validar na VPS
- Criar a caixa no endereço que hoje é alias da caixa técnica: a ordem "tira o alias → cria a caixa" no Stalwart 0.11.8 real.
- Remover a caixa técnica antiga com mensagens dentro.
- Abrir a caixa do projeto num app de e-mail (IMAP 993 / SMTP 587) com a senha definida.
- No Gmail, o teste chegando como "Contato - Cassino", com o acento certo.
- Deploy do cassino recebendo `SMTP_USER`/`MAIL_FROM` = `contato@…` e as variáveis ligadas no `.env`.
- Trocar a senha e conferir que o deploy seguinte leva a nova, inclusive nas variáveis ligadas.

## Pendências / fora do escopo
- `MailDomainPage.tsx` não foi tocado, porque outro agente estava nele. Na lista de caixas do domínio, a caixa do projeto aparece como "projeto" e o modal "Configurar no app" de lá ainda esconde "Trocar senha" para ela. A troca pelo card do projeto funciona. Basta liberar o botão nessa página. Os textos de lá que falam em "caixa técnica" também ficaram como estavam.
- `projectMailboxAddress` (mailer) não é mais usado pelo servidor, mas continua exportado.
