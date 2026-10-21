# Revisão — reconciliação depois de restaurar e reparo da senha do e-mail

Branch `worktree-agent-a9ba817d42e0e16ea`, commit 3c0d286, sobre `origin/dev` (7d627a4). Revisado numa
cópia descartável do worktree (já removida); o worktree do executor não foi tocado.

O nome tem o sufixo `-revisao` porque o branch revisado já versiona
`comoFuncionaSistema/_RELATORIO-reconciliacao-restauracao.md` (o relatório do executor). Um arquivo
não versionado com o mesmo nome em `dev` impediria o merge.

**Veredito geral: REPROVADO.** As correções pedidas são pequenas e localizadas (seção "O que corrigir").
O reparo do 401 em si funciona: foi conferido com um Stalwart real e não apaga dados.

| Item | Resultado |
|---|---|
| 1. Reparo do 401 | APROVADO com ressalva (falta bloqueio de concorrência) |
| 2. Segredo | APROVADO |
| 3. Conferência e pendências | **REPROVADO** (falha de DNS aparece como "não aponta") |
| 4. Interface e mensagem do 401 | **REPROVADO** (Envios continua com o 401 cru) |
| 5. Guia e docs | APROVADO com ressalva (uma frase falsa por causa do item 3) |
| 6. Regressões e qualidade | APROVADO |

---

## 1. Reparo do 401 — APROVADO com ressalva

**Com Stalwart real:** imagem fixada `stalwartlabs/mail-server:v0.11.8@sha256:a5ce…`, criada pelo
próprio `MailService.startServer()` com as portas deslocadas. O pool de endereços do Docker desta
máquina estava esgotado, então as redes `paas-mail-admin` e `paas-mail` foram criadas antes com uma
sub-rede explícita. O teste preparou um domínio, uma assinatura DKIM, uma caixa e uma mensagem
entregue por SMTP (o filtro mandou para "Junk Mail").

| Cenário | Resultado |
|---|---|
| mail.json com a senha B, container com a A (painel restaurado) | `setMailboxPassword` → **401 "You have to authenticate first."** (reproduz); `checkAdminAuth` = `mismatch` |
| `repairAdminAuth()` | `repaired` em cerca de 16 s; **mesmo ID de container** (só `docker restart`), volume `paas_stalwart_data` intacto, caixa listada, domínio e as 11 chaves `signature.rsa-exemplo.test.*` (DKIM) preservados, login IMAPS da caixa ok, mensagem continua na caixa; config.toml no container 0600 root:root (igual ao "Iniciar") |
| Variante "restaurar o e-mail" (config.toml antigo copiado para dentro e restart) | `mismatch` → `repaired`, os mesmos dados preservados |
| Repetir o reparo (idempotência) | `ok` em 0,6 s, **sem reinício** (StartedAt igual) |
| Subida com pendência `mail-auth` aberta e painel saudável (`repairOpen`) | `ok`, **nenhum reinício**; a pendência resolve na lista |
| Stalwart parado | `not_running`, não liga nada |
| Stalwart travado (`docker pause`) | `unreachable` depois de cerca de 49 s, **sem reinício**; não entra em laço |
| Dois reparos simultâneos | `["repaired","repaired"]`: **dois reinícios seguidos**, sem bloqueio (ver ressalva) |

- **Laço:** não há laço de reinícios. O reparo automático roda uma vez, 20 s depois da subida, e só
  com a pendência `mail-auth` aberta. Também roda uma vez ao fim da restauração do e-mail. Se o
  reparo falhar, a pendência continua, e cada subida seguinte do painel reinicia o Stalwart uma vez.
  É aceitável.
- **Entrega:** o reinício só acontece quando há divergência. A divergência atinge apenas a API de
  administração; o SMTP continua entregando. Por isso o reinício automático na subida custa alguns
  segundos de SMTP e IMAP fora do ar logo depois de uma restauração. A fila do Stalwart fica no
  volume. Não consegui provar empiricamente que a fila sobrevive: a mensagem de teste para um
  domínio `.invalid` voltou na hora.
- **Ressalva (concorrência):** não há bloqueio entre o reparo da subida (instância nova de
  `MailService`), o "Reparar agora" (instância das rotas) e as operações de e-mail em andamento. O
  pior caso medido é inofensivo para os dados: um reinício duplo, e uma operação de caixa durante o
  reinício falha com erro de conexão. Recomendado, sem bloquear a aprovação: execução única
  (promessa em módulo) em `MailService.repairAdminAuth`.
- **Mensagem de falha:** quando `applyTls` falha, a rota devolve 500 com o texto do Docker, sem
  segredo. "Reparar agora" com o Stalwart travado devolve `ok:true, result:"unreachable"` e a tela
  não diz que nada foi feito. Melhoria desejável.

## 2. Segredo — APROVADO

- Argumentos de todos os `docker` do reparo (registrados por um intermediário no PATH): `inspect`,
  `exec --version`, `cp -` (o config vai por tar na entrada padrão), `restart`. **Nenhuma** das
  senhas A, B ou C aparece. `docker inspect paas-stalwart` também não contém nenhuma delas.
- A chamada de verificação usa Basic no cabeçalho, para `/api/queue/messages?limit=1`; nada vai na URL.
- O arquivo de pendências guarda só id, estado, origem, data e domínio (0600). A auditoria, as
  respostas e os avisos não levam a senha. O log do serviço ficou vazio nos testes reais.
- Observação, padrão anterior ao branch: o espelho local `data/mail/stalwart/config.toml` (0600) não
  é regravado pelo reparo e fica com a senha antiga. Ninguém lê esse arquivo; vale regravá-lo um dia.

## 3. Conferência e pendências — REPROVADO

O que está certo:

- **(a)** Backup com webmail ativo e VPS sem webmail: gera a pendência, a flag fica `false` só na
  pasta preparada (o arquivo original fica intacto) e nada é ativado.
- **(b)** Tudo rodando: nenhum arquivo e nenhum aviso.
- **(c)** Backup sem webmail: nada acontece.
- **(d)** Backup antigo sem os campos: tratado por `readJsonObject`.
- **(e)** Docker fora do ar: a pendência fica com status `unknown`. Prazo de 30 s por consulta, duas
  em sequência; a restauração não trava além disso.
- **(g)** Servidor de e-mail ativo no backup e ausente aqui: gera a pendência, e "Iniciar" regrava o
  config com a senha certa.
- **(h)** A conferência não mexe em `panel-domain.json`. A regra do lote 8 (`adaptStagedPanelDomain`)
  continua sozinha.
- **(i)** A pendência persiste em arquivo, se resolve sozinha e pode ser dispensada (todas as
  pendências são dispensáveis).
- **(j)** Uma restauração nova do painel substitui o arquivo; a do e-mail reabre a pendência.
- **(k)** `restaurar-painel.sh` também passa pela conferência (`afterApplied`).
- Não encontrei pendência que fique presa para sempre.

**Defeito (f), com falso positivo:** `PanelDomainService.pointsHere()` devolve `check.ok` e nunca
lança erro. Por isso, com o DNS sem resposta (`problem: "unavailable"`) ou sem IP público conhecido
(`"no_server_ip"`, acesso por túnel), a conferência entende "não aponta". O ramo "não foi possível
conferir" (`points === null`, status `unknown`) nunca é alcançado em produção, só com os dublês dos
testes. Reproduzido com `checkPanelDomainDns` real e resolvedores que dão ETIMEOUT. O resultado foi
o aviso *"o DNS dele ainda não aponta para esta VPS. Aponte o registro A…"* e a lista com
`status: "pending"`, guardado no cache por 5 min. Quem tem o DNS certo vê uma instrução falsa, e o
guia promete o contrário.

Menores: com Docker e DNS fora do ar, a preparação pode esperar cerca de 60 s de Docker mais o DNS.
O DNS é consultado duas vezes quando o acesso pelo IP estava desativado (lote 8 e reconciliação).
"Rodando" vem de `.State.Running`: um webmail em laço de reinício pode resolver a pendência por
engano. É raro.

## 4. Interface — REPROVADO

O que está certo:

- O aviso âmbar aparece no Dashboard, no alto de Configurações → Backups e no resultado da
  restauração.
- Tem `role="status"`, ícone com título, uma `role="note"` por pendência e botões com nome.
- "Reparar agora" pede confirmação ("Reiniciar o servidor de e-mail agora?", Confirmar ou Cancelar),
  o texto diz "reinicia por alguns segundos, sem apagar dados" e não há palavra-chave perigosa.
- Paridade pt-BR/en e GLOSSARY estão ok.
- Playwright (Vite com a API simulada, Dashboard com três pendências e a confirmação aberta): sem
  sobreposição nem rolagem lateral a 390 px (scrollWidth 380) e a 1440 px.
- O Dashboard mudou só uma linha. `git merge-tree` com o branch do roteiro
  (`worktree-agent-ab339d742001985cc`) não dá conflito.

**Defeito:** a mensagem amigável do 401 existe só no `sendError` de `routes/mail.ts`, que cobre
caixas, domínios e DKIM. Em **E-mail → Envios** o 401 continua cru:

- `MailEnviosService.queue()` devolve *"Não deu para ler a fila do servidor de e-mail: Stalwart: You
  have to authenticate first."*;
- `retry` e `cancel` passam por `stalwartError`, que repassa o `StalwartApiError` 401, e o
  `sendError` de `routes/mail-envios.ts` responde **500 "Erro interno."**.

Menores: o botão **Ativar agora** do webmail só navega para /mail. O texto ao lado explica, mas o
rótulo promete uma ação; "Ir para o webmail" seria mais honesto. Em Configurações → Backups, com o
diálogo de restauração aberto, o aviso aparece duas vezes.

## 5. Guia e docs — APROVADO com ressalva

- Rótulos conferidos contra os dicionários: "Ativar webmail"/"Enable webmail", "Iniciar
  servidor"/"Start server", "Reparar agora", "Dispensar".
- A saída manual "parar e iniciar" é verdadeira: `start()` faz `pushConfig` com a senha do mail.json
  antes do `docker start`.
- O troubleshooting do 401 e o do webmail estão presentes nos dois idiomas, sem IP nem domínio real.
- `docs:build`, `check:build`, `docs:links` e `docs:site-url` passaram, e `check-no-real-hosts` deu ok.
- **Frase falsa até corrigir o item 3:** "If the panel could not check (Docker **or DNS** did not
  answer), the notice says so", e o equivalente em pt-BR em `restore-new-server.md`.
- A mensagem do 409 diz "ou use o aviso do Dashboard", mas o aviso só existe se houver pendência
  `mail-auth` aberta. Aceitável, porque a saída manual vem antes.

## 6. Regressões e qualidade — APROVADO

- `pnpm install --frozen-lockfile` e `pnpm -r run typecheck` passaram.
- `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage -- --maxWorkers=2` terminou com
  saída 0.
- **server: 2060 testes (2 pulados), 97,55 / 93,32 / 98,04 / 98,73. Confere** com o que o executor
  declarou (mínimos 94/91/98/94).
- deploy: 95,72 % de ramos; mailer: 98,45 %; core: 119 testes; security: 215; web: 1035.
- Os pulados são `describe.skipIf(image === null)` do teste com Docker real.
- Nenhuma linha de teste removida nem enfraquecida. `vitest.config.ts` só **acrescenta** arquivos à
  cobertura.
- Os testes dos lotes 8 e 9 (restauração, pausa, painel novo, chaves) e os do e-mail passaram.
- Build do web ok.
- Conflito de merge com o branch do domínio de aplicações (`worktree-agent-a64328f813237c255`) só em
  `comoFuncionaSistema/_i18n-servidor-fase2.tsv`: as duas pontas acrescentam linhas, resolve somando.

---

## O que corrigir

1. **`apps/server/src/app.ts`, sonda `panelDomainPointsHere` da `RestoreReconciliation` (e a do
   `BackupService`, se o executor preferir uniformizar).** Com o DNS sem resposta, a conferência não
   pode concluir "não aponta". A sonda passa a **lançar erro** quando `checkPanelDomainDns` devolver
   `problem` igual a `"unavailable"` ou `"no_server_ip"`. Por exemplo, um método novo em
   `PanelDomainService` que devolva o `check` inteiro, ou que lance nesses dois casos. O
   `pointsHere` de hoje continua igual para o lote 8, que trata falha como "não aponta" e por
   segurança mantém o acesso pelo IP. Teste novo em `restore-reconciliation.test.ts`, ou de
   integração, com o `checkPanelDomainDns` **real** e resolvedores que dão ETIMEOUT: tanto a
   preparação quanto `list()` devem dar `unknown`, com o aviso "não foi possível conferir".
2. **`apps/server/src/services/mail-envios-service.ts` e `routes/mail-envios.ts`.** Levar o
   tratamento do 401 e do 403 para Envios:
   - em `stalwartError`, transformar `StalwartApiError` com status 401 ou 403 em
     `httpError(409, "mail_auth_failed", <mesma mensagem de routes/mail.ts>)`;
   - no `catch` de `queue()`, usar essa mesma mensagem, sem o texto cru do Stalwart.

   Convém extrair a mensagem para um único lugar e reaproveitar nos dois arquivos. Teste: fila,
   tentar de novo e cancelar com 401 → 409 `mail_auth_failed` e a mensagem amigável.
3. Recomendado, sem bloquear a aprovação: execução única em `MailService.repairAdminAuth`, para não
   reiniciar o Stalwart duas vezes quando o reparo da subida e o "Reparar agora" coincidem.

## Limpeza

O container `paas-stalwart`, o volume `paas_stalwart_data`, as redes `paas-mail-admin` e `paas-mail`
e a imagem do Stalwart baixada para a revisão foram removidos. O servidor Vite foi parado e o
worktree descartável foi removido. Nada foi alterado no worktree do executor.

---

# 2ª rodada — commit 1dbd1ae

**Veredito: APROVADO.** Os dois defeitos foram corrigidos e a ressalva de concorrência também.

| Item | Resultado |
|---|---|
| 1. DNS da conferência e lote 8 | APROVADO |
| 2. 401 real em cada tela | APROVADO |
| 3. Coalescência do reparo | APROVADO |
| 4. Segredo | APROVADO |
| 5. Verificações e testes antigos | APROVADO |

## 1. DNS — APROVADO

Script próprio com o `PanelDomainService` real e a `RestoreReconciliation` real. A tabela mostra o
aviso da preparação, o status na lista e o resultado de `pointsHere` (usado pelo lote 8):

| DNS | Aviso | Status na lista | `pointsHere` (lote 8) |
|---|---|---|---|
| ETIMEOUT | "não foi possível conferir" | `unknown` | false |
| ECONNREFUSED | "não foi possível conferir" | `unknown` | false |
| sem IP público (túnel) | "não foi possível conferir" | `unknown` | false |
| A com o IP desta VPS | nenhum | (resolvido) | true |
| A com outro IP | "ainda não aponta" | `pending` | false |
| NXDOMAIN | "ainda não aponta" | `pending` | false |

- Lote 8 sem mudança de comportamento: `pointsHere` está intacto (o diff só acrescenta
  `pointsHereOrThrow`), e o `BackupService` continua usando `pointsHere` (`app.ts`). Com falha de
  DNS ele segue entendendo "não aponta" e, por segurança, mantém o acesso pelo IP. Os testes do
  lote 8 passaram.
- O guia (en/pt-br) agora cita o caso do túnel.

## 2. 401 com Stalwart REAL, pelas rotas reais — APROVADO

**Montagem:**
- `routes/mail.ts`, com `mail-envios` e `webmail` aninhados, sobre o app de teste com autenticação;
- `MailService` real e Docker real;
- servidor iniciado pela rota, domínio e caixa criados com a senha certa.

**Divergência:** a mesma da restauração do e-mail (config.toml do container com outra senha e
restart). As chamadas só começaram depois de o Stalwart voltar a responder.

| Tela | Status | Resultado |
|---|---|---|
| Envios: fila | 200 | `available:false` com a mensagem amigável |
| Envios: Tentar de novo | **409** | `mail_auth_failed` |
| Envios: Cancelar | **409** | `mail_auth_failed` |
| Caixa: trocar senha | **409** | `mail_auth_failed` |
| Caixa: criar | **409** | `mail_auth_failed` |
| Domínio: criar (com DKIM) | **409** | `mail_auth_failed` |
| Checklist de DNS/DKIM | 200 | não chama o Stalwart |
| Status do webmail | 200 | sem erro |

Em nenhuma resposta aparece 401, o texto cru "authenticate first" ou alguma das senhas.

**Grep final:**
- Fora do `MailService`, só o webmail chama o Stalwart (`exemptWebmailIp` e
  `removeWebmailIpExemption`). As duas falhas são registradas em log e não chegam à resposta.
- `onboarding-sources` usa `listDomains`, que é local.
- `mail.ts` registra o handler compartilhado, que agora converte o 401/403 do Stalwart. Envios e
  Webmail herdam esse handler ou têm o próprio `sendError` já tratado.

**Não testado com Stalwart real:**
- ativar o webmail (exige a imagem do Roundcube); o caminho do 401 ali é o da isenção, que só vai
  para o log;
- remover um domínio existente sob divergência.

**Fora do escopo:** com o Stalwart fora do ar (sem conexão), criar caixa ou domínio continua
respondendo 500 com "Sem conexão com o Stalwart". Esse comportamento é anterior ao branch e não é
o 401.

## 3. Coalescência — APROVADO

- Três reparos simultâneos com Stalwart real (a rota "Reparar agora" e duas instâncias novas de
  `MailService`) deram `["repaired","repaired","repaired"]` com **1 reinício**. Conferido por
  `docker events` e pelo registro de argumentos do Docker. O outro reinício do registro veio antes
  da divergência, da sincronização de TLS depois do cadastro do domínio (comportamento já existente).
- Logo depois, trocar a senha da caixa respondeu 200, e um reparo novo deu `ok` sem reiniciar.
- A falha não trava os pedidos seguintes: o `.finally` limpa o mapa também quando há exceção, e o
  teste novo cobre o caso `failed` seguido de `repaired`.
- Não há laço.
- Sem querer, o primeiro teste deixou o Stalwart em laço de reinício (configuração inválida gerada
  pelo meu script). O reparo respondeu `unreachable` e não mexeu em nada.

## 4. Segredo — APROVADO

Refeito com o registro de argumentos do Docker durante toda a execução (start, cadastro, divergência
e reparos). Nenhuma das duas senhas aparece nos argumentos nem no `docker inspect`. O config.toml no
container continua 0600 root:root. Nenhuma das respostas HTTP da tabela contém senha.

## 5. Verificações — APROVADO

- `pnpm install --frozen-lockfile` e o typecheck de todos os pacotes passaram.
- Cobertura com `--no-bail` e `--maxWorkers=2` terminou com saída 0:

| Pacote | Resultado |
|---|---|
| server | 2071 testes (2 pulados, Docker real), **97,57 / 93,31 / 98,04 / 98,73** |
| deploy | 95,72 % de ramos |
| mailer | 98,45 % de ramos |
| core | 119 testes |
| security | 215 testes |
| web | 1035 testes |

- Site: `docs:build`, `check:build`, `docs:links`, `docs:site-url` e `check-no-real-hosts` ok.
- Testes antigos: o diff da rodada só acrescenta linhas aos testes, sem remoção nem
  enfraquecimento.

Limpeza da 2ª rodada: container, volume, redes, imagem e worktree descartável removidos. O worktree
do executor ficou intocado.
