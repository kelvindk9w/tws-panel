# Relatório do lote 9 — backup só local não cancela a proteção do painel novo

Parte de `origin/dev` (878c340). Sem push.

## Causa confirmada

`finishArchive` grava `lastSuccessAt` assim que a cópia local existe, antes de qualquer envio. A regra `panelFreshOverForeign` consultava `lastSuccessAt` (do painel e do e-mail). O painel novo vem com a agenda ligada e `runNow` não exige destino, então o backup das 03:00 só local já cancelava a proteção. O prazo de 7 dias conta de `destination.connectedAt` (confirmado: só muda se endpoint ou bucket mudam).

## Decisão (mudança mínima)

- Campo novo por item, `lastRemoteSentAt`: gravado só quando um backup COMPLETO foi enviado ao armazenamento externo e conferido (baixado e aberto). Backup incompleto, envio com falha ou cópia só na VPS não gravam.
- A regra passou a considerar conteúdo próprio: projeto cadastrado, painel restaurado (`panelRestoredAt`, campo novo da configuração) ou `lastRemoteSentAt` do painel ou do e-mail. `lastSuccessAt` saiu da regra e continua com os demais usos (tela).
- Mantidos: backup à mão sempre sai; prazo de 7 dias desde a conexão; notificação única persistida; listagem que falha não envia e avisa na 3ª; `disableEmptyProject`, retenção, `lastSlot`, aviso "sem backup externo há N dias" e pausa por item do lote 8 não foram tocados.
- Texto da pausa mudou (servidor, só em português, como o resto): agora diz que o backup à mão precisa do armazenamento já conectado e que cópia só na VPS não conta. Registrado em `_i18n-servidor-fase2.tsv`.

## Migração (backups.json existente)

Na carga, `lastRemoteSentAt` ausente recebe `lastRemoteVerifiedAt` (que só era gravado no mesmo momento) ou nulo. Resultado:
- Painel antigo que já enviou e conferiu cópia externa: continua sem a proteção (tem conteúdo próprio), nada muda.
- Painel antigo só com cópia na VPS: passa a ser tratado como novo. Se o armazenamento conectado nos últimos 7 dias tem backups em `_painel/`, o agendado fica em pausa até 7 dias da conexão; passado o prazo, ou com projeto, restauração ou backup à mão com armazenamento, sai normalmente. Nunca fica bloqueado para sempre. Esse é justamente o caso do defeito, então a pausa é o comportamento desejado.
- Restauração do painel: a cópia de `backups.json` preparada recebe `panelRestoredAt` (também no caminho de backup antigo sem `backups.json`). Sem isso, o primeiro backup de um painel restaurado, cujo `backups.json` interno ainda não conhece o próprio envio, voltaria a ser tratado como painel novo. Backups feitos por versões antigas se leem sem o campo e funcionam.

## Testes (todos vistos falhar antes pelo motivo certo; os de regressão já passavam e ficam como guarda)

Em `apps/server/tests/backup-service.test.ts`, bloco "lote 9": só local por dias e armazenamento depois com backups alheios (segura, uma notificação); reinício mantém a proteção; backup à mão com armazenamento libera os seguintes; backup à mão sem armazenamento não libera; envio que falha não conta; e-mail só local não conta e com cópia externa conta; 7 dias da conexão soltam mesmo com histórico só local; migração (painel antigo com envio externo, só local, só local com conexão antiga, arquivo sem os campos); restauração marca o painel e o painel restaurado sem projetos envia; backup antigo sem `backups.json`; reinício após envio externo persiste.

## Guia e documentação

`restore-new-server.md` (en e pt-br): passo 1 deixou de mandar desligar o automático (explica que a cópia das 03:00 é inofensiva e permite instalar num dia e conectar em outro); passo 3: condições atualizadas (cópia só na VPS não conta) e o desligamento ficou como cuidado extra só para quem já sabe que passará de 7 dias entre os passos 3 e 5; conferência final ajustada. `features.md` (en e pt-br) com a mesma condição. Risco que RESTA e continua escrito: mais de 7 dias entre os passos 3 e 5, backup à mão no painel novo depois de conectar o armazenamento, e e-mail iniciado antes do passo 8 (envia e-mail vazio e conta como conteúdo próprio). Também `comoFuncionaSistema/backups/index.json`.

## Verificação

`pnpm install --frozen-lockfile`, `pnpm -r run typecheck`, cobertura de todos os pacotes (`--no-bail`, `--maxWorkers=2`), build do site, `check:build`, `docs:links`, `check-no-real-hosts.mjs`: tudo passou. Server 97,73 / 93,34 / 98,14 / 98,88 (mínimos 94/91/98/94), 1986 testes; deploy 95,72% de ramos; mailer 98,45%; core, security e web passam.

## Não testado / riscos

- Nada em VPS, 7-Zip ou armazenamento S3/R2 reais; relógio simulado.
- Trocar de bucket não zera `lastRemoteSentAt`: painel que já enviou ao bucket A e conecta o B com backups alheios não é segurado (já tinha conteúdo próprio).
- E-mail com cópia externa concluída ainda conta como conteúdo próprio (decisão do lote 8, mantida), mesmo que o servidor de e-mail estivesse vazio.
- Falha da conferência após o upload deixa o item sem `lastRemoteSentAt`: o agendado segue em pausa até 7 dias (lado seguro).

## Revisão do lote 9 (veredito e correção)

O revisor aprovou, exceto por um defeito, já corrigido: com `"targets": {"panel": null}` (ou `email: null`) no `backups.json`, a migração da carga lançava TypeError e derrubava o serviço de backups. Agora itens que não são objeto são ignorados, e a migração só roda quando `lastRemoteSentAt` nunca foi gravado (`undefined`); um `null` já gravado não é reescrito a partir de `lastRemoteVerifiedAt`. Dois testes de guarda na seção "migração", vistos falhar antes.

Veredito sobre os riscos: troca de bucket sem zerar `lastRemoteSentAt` é risco aceito; e-mail iniciado cedo e backup manual com cópias alheias no bucket já estão descritos no guia.

Os números de linha de `backup-service.ts` no `_i18n-servidor-fase2.tsv` foram recalculados (conferidos pelo texto); 8 referências de mensagens só dinâmicas (`${reasonOf(err)}` etc.) não puderam ser casadas pelo texto e seguem aproximadas.
