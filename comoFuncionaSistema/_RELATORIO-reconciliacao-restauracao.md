# Relatório — reconciliação depois de restaurar (webmail e demais serviços) e senha de administração do e-mail

Parte de `origin/dev` (7d627a4). Sem push. Escopo original (webmail "marcado" sem estar ativo) mais o acréscimo do coordenador (401 "You have to authenticate first" no Stalwart).

## 1. Diagnóstico — o webmail "ok" sem estar ativo

**Onde o estado "webmail ativado" é guardado.** `data/mail/webmail.json` (`enabled`, `desKey`, `exemptIp`), lido por `WebmailService` (`services/webmail-service.ts`). O backup do painel leva o diretório de dados inteiro, então o arquivo volta com `enabled: true` (confirmado: `PANEL_PRESERVED` só exclui `backups`, `setup-token` e `projects`). O container `paas-webmail` e o `paas-stalwart` **não** vêm no backup do painel: nascem na VPS nova.

**Causa raiz (duas fontes, ambas confirmadas no código):**

1. **A flag restaurada vira a "fonte da verdade" do painel.** `WebmailService.status().enabled` devolve a flag; `proxyState()` manda o Caddy apontar `mail.<domínio>` para `paas-webmail` só pela flag; `sync()` (a cada hora e quando o servidor de e-mail inicia) sobe o container por causa da flag. Nada comparava a flag com o Docker no momento da restauração. O ponto onde o estado do backup precisa ser conferido com a realidade é a preparação da restauração (`stagePanel`/`adaptRestoredPanel`), e ali não havia conferência de webmail, servidor de e-mail nem domínio.
2. **O "check" verde da tela da restauração.** `restoreEmail` executa o passo "Restaurar o webmail" (que só devolve os DADOS do volume `paas_webmail_data`) e o registro mostra esse passo como concluído; `StepList` (`apps/web/src/components/backups/backup-ui.tsx`) desenha um `CheckCircle2` verde para todo passo `done`. Com o container inexistente isso lia como "webmail ok". O passo termina sem aviso nenhum.

Não consegui reproduzir a tela exata do dono (não há a VPS dele). Reproduzi as duas causas por teste: o teste "backup com webmail ativo e VPS sem webmail rodando" (`restore-reconciliation.test.ts`) mostra a flag `enabled: true` vindo no estado restaurado sem container; o teste de e-mail em `backup-service.test.ts` mostra o passo "Restaurar o webmail" concluído sem nenhum aviso (antes da mudança o resultado não tinha aviso algum).

**Correção da fonte da verdade.** A conferência usa o Docker (`DockerCli.probe`, que distingue "não existe" de "o Docker não respondeu"), não a flag. Quando o container não existe, a flag `enabled` do estado que entra no lugar passa a `false` (a cópia preparada, nunca o backup original); assim nada sobe sozinho quando o e-mail iniciar e o Caddy não aponta para um container que não existe. Container existente e parado: a flag fica.

## 2. Reconciliação pós-restauração

Serviço novo `RestoreReconciliation` (`apps/server/src/services/restore-reconciliation.ts`). Itens: `webmail`, `mail-server`, `panel-domain`, `mail-auth`.

- **Painel (tela):** `stagePanel` chama `planStaged` na pasta preparada. Para cada item que o backup dizia ativo (webmail com `enabled`, servidor de e-mail com `adminSecret`, domínio do painel `active`) e que não roda aqui (Docker/DNS), grava `restore-reconciliation.json` na pasta preparada (viaja com o estado restaurado) e devolve avisos no registro da restauração. Tudo rodando: nenhum arquivo, nenhum aviso.
- **E-mail (tela):** `restoreEmail` marca `webmail` e/ou `mail-server` como pendentes se não rodam, e acrescenta o aviso "Os dados do webmail voltaram, mas o webmail não está rodando nesta VPS…".
- **`restaurar-painel.sh`:** o marcador do script tem `actor: "ssh"`; `restorePanelAtBoot` chama `afterApplied` depois de uma troca aplicada, que roda a mesma conferência sobre o estado já restaurado (`index.ts`). Pela tela não repete (já conferiu).
- **Persistência e resolução:** `data/restore-reconciliation.json` (0600). `GET /api/restore-reconciliation` reconfere AGORA no Docker/DNS: o que passou a rodar vira `resolved` e some; o que não deu para conferir fica com status `unknown` ("não foi possível conferir"), nunca resolve por engano. `POST .../:id/dismiss` dispensa (auditado). Reinício do painel mantém (arquivo). DNS do domínio tem cache de 5 min.
- **Nunca ativa nada:** o serviço só tem consultas (`probe`, `pointsHere`) e, para a senha de administração, o reparo descrito abaixo (reinicia o container já existente, sem apagar dados).
- A falha em qualquer conferência não bloqueia a restauração (vira aviso).

Decisões: não incluí **notificações** (canais e tokens voltam cifrados com as chaves do próprio backup e funcionam sem ação) nem **armazenamento externo** (a restauração já mantém o destino em uso nesta VPS, lote 8). **Acesso pelo IP** continua tratado pelo ajuste do lote 8 (reativa e avisa); a pendência de DNS do domínio cobre o resto.

## 3. Interface

`apps/web/src/components/restore/ReconciliationNotice.tsx`: aviso âmbar (mesmo estilo do `TwoFactorNudge`), `role="status"`, ícone + título, cada pendência uma `role="note"`, botões com nome. "O painel antigo tinha o webmail ativo. Ativar agora?" com **Ativar agora** (link para E-mail, reaproveitando o fluxo existente de Ativar webmail; não executa a ativação), **Iniciar agora**, **Conferir o DNS** e **Dispensar**. Aparece no Dashboard (uma linha em `DashboardPage.tsx`, sem tocar em `components/onboarding` nem `onboarding.ts`), no alto de Configurações → Backups e no resultado da restauração (`RestoreDialog`). Textos em pt-BR e en (`backups.ts`, `errors.ts`; `GLOSSARY.md`). Mensagens do servidor registradas em `_i18n-servidor-fase2.tsv`. Não vi worktree do outro executor com mudanças em onboarding para comparar (o worktree `agent-ab339d742001985cc` existe, mas não consegui lê-lo pelo meu isolamento); o aviso é independente e usa o mesmo estilo visual.

## 4. Acréscimo: "You have to authenticate first" depois de restaurar

**Causa confirmada.** `adminSecret` mora em dois lugares: `data/mail/mail.json` (o que o painel envia, `MailService.client()`) e o `config.toml` DENTRO do container (`[authentication.fallback-admin]`, gravado por `StalwartManager.pushConfig` a partir do `adminSecret`). Combinações que quebram:
- **Restaurar o e-mail** depois de o servidor ter sido iniciado aqui: `restoreEmail` devolve o `etc/` do servidor antigo (`docker.copyIn` da pasta `etc`) com a senha ANTIGA; o mail.json desta VPS tem a nova.
- **Restaurar o painel** depois de o servidor ter sido iniciado aqui: o mail.json restaurado traz a senha do painel antigo; o container em execução tem outra.
O roteiro do Dashboard induz a iniciar o servidor antes, por isso aparece.

**Correção.** `MailService.checkAdminAuth()` faz uma chamada autenticada de leitura (401/403 = divergente) e `repairAdminAuth()` regrava a configuração com a senha do painel e reinicia o container (`applyTls({restart:true})`, dados no volume ficam), esperando a API subir antes. Roda: ao fim da restauração do e-mail; 20 s depois da subida se houver pendência `mail-auth` (painel restaurado: `planStaged` cria o item quando o Stalwart já roda); e pelo novo `POST /api/mail/server/repair-auth` (botão **Reparar agora**, com confirmação, no aviso âmbar). Se não resolver, aviso âmbar com a ação em vez do erro cru. O 401 do Stalwart nas rotas de e-mail vira `409 mail_auth_failed` com "O painel não conseguiu autenticar no servidor de e-mail… pare e inicie o servidor em E-mail → Servidor". Nenhuma senha vai para log, resposta ou auditoria (teste confere).

## 5. Testes (todos vistos falhar antes pelo motivo certo; exceção abaixo)

- `restore-reconciliation.test.ts` (32): webmail ativo sem container; parado; já rodando (nenhuma pendência); backup sem webmail; backup antigo sem campos/arquivos estranhos; Docker falhando (pendência "não foi possível conferir", flag intacta); pendência persiste a "reinício" (outra instância); some ao ativar; dispensar; servidor de e-mail; domínio; mail-auth; `repairOpen`.
- `restore-reconciliation-docker.test.ts`: `DockerCli.probe` com docker de mentira (inexistente x daemon fora do ar x sem permissão) **e com Docker real** (container qualquer rotulado: inexistente → parado → rodando → removido). Roteiro real não foi rodado com Roundcube (pesado).
- `backup-service.test.ts` (+12): painel e e-mail com/sem webmail, nada ativado (nenhuma chamada start/run/create), reconciliação quebrada não impede a restauração, senha de administração reaplicada/consistente/falha.
- `panel-restore-interrupcao.test.ts` (+5): caminho do script SSH com arquivos reais.
- `mail-admin-auth.test.ts`: restaura com `adminSecret` divergente, reaplica, chamada autenticada passa; sem segredo no log.
- `routes-restore-reconciliation.test.ts`, `routes-mail-auth.test.ts`; web: `restore-reconciliation-notice.test.tsx` (11), `dashboard-reconciliation.test.tsx`, `panel-restore-dialog.test.tsx` (+1).

Desvio de TDD: `DockerCli.probe` foi escrito antes do teste; vi o teste falhar renomeando o método temporariamente.

## 6. Verificação

`pnpm install --frozen-lockfile`, `pnpm -r run typecheck`, cobertura de todos os pacotes, `docs:build`, `check:build`, `docs:links`, `docs:site-url`, `check-no-real-hosts`: tudo passou. Server (`--maxWorkers=2`) 97,55 / 93,32 / 98,04 / 98,73 (mín. 94/91/98/94), 2060 testes; deploy 95,72% de ramos (mín. 95); mailer 98,45% (mín. 98); core 119, security 215 testes; web 1035 testes.

## 7. O que NÃO foi testado

- Restauração de ponta a ponta numa VPS real (7-Zip, armazenamento S3/R2, Stalwart e Roundcube reais): só dublês, mais Docker real para a consulta de estado.
- O reparo da senha de administração contra um Stalwart real (restart do container); testado com dublê do gerenciador e do cliente.
- DNS real do domínio do painel.
- Navegador real; a interface foi testada em jsdom.

## 8. Riscos e decisões

- O reparo usa uma instância nova de `MailService`; ele grava `tls` no mail.json e a instância das rotas pode ter uma cópia velha desse campo até a próxima sincronização horária (efeito pequeno).
- Reparar reinicia o servidor de e-mail por alguns segundos (pede confirmação na tela; automático só ao fim da restauração do e-mail e na subida com pendência).
- `webmail.json` com `enabled` forçado a `false` quando o container não existe: ativar de novo é o fluxo normal (a chave `desKey` é mantida).

## 9. Correções depois da revisão

1. **Conferência do domínio (antes dizia "ainda não aponta" mesmo sem conseguir conferir).** `PanelDomainService.pointsHereOrThrow` lança quando o DNS não responde ou o IP público é desconhecido (acesso por túnel); a reconciliação usa essa consulta, então produz "não foi possível conferir" em produção. O ajuste do acesso pelo IP (lote 8) continua com `pointsHere`, sem mudança. Testes com a consulta real e resolvedores que expiram, sem IP público e com IP de outro servidor.
2. **401 do Stalwart em todas as telas.** Mensagem e conversão num módulo só (`services/mail-auth-error.ts`): 401/403 viram 409 `mail_auth_failed`. Aplicado em E-mail (`routes/mail.ts`), Envios (`stalwartError`, fila, tentar de novo, cancelar, `routes/mail-envios.ts`), Webmail (`routes/webmail.ts`) e no `registerErrorHandler` (rota sem try/catch própria nunca devolve 401 do Stalwart, que o navegador leria como sessão expirada). Reputação, relatórios e logs não chamam a API do Stalwart (DNS/listas/arquivos). Testes para cada rota.
3. **Um reparo por vez.** `repairAdminAuth` agora coalesce chamadas simultâneas por pasta de dados no processo (instâncias diferentes: subida, botão e fim da restauração); o Stalwart reinicia uma vez. Teste de concorrência.
