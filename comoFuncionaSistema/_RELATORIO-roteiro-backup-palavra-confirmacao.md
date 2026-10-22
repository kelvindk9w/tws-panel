# Relatório: roteiro do passo 6 (backups) e palavra de confirmação

Data: 22/10/2026. Pedido do dono: reaproveitou o bucket R2 do painel antigo, não quer
restaurá-lo e questionou o card "Restaure primeiro o painel antigo".

## A. Passo 6 "Backups fora da VPS" com cópias de outro painel

Verificado no código (`services/onboarding.ts`, `services/backup-service.ts`):

- `backups-restore-first` só aparece quando o armazenamento guarda backups de OUTRO painel e este é
  novo. Bucket vazio já mostrava "Falta um backup externo conferido... Fazer backup agora".
- A regra `panelFreshOverForeign` pausa só o backup automático. O backup à mão sempre sai. A pausa
  acaba com projeto cadastrado, painel restaurado, backup externo enviado ou 7 dias após conectar.
- A retenção remota (`retentionVictims`) apaga as cópias mais antigas da pasta, inclusive as do
  painel antigo no mesmo prefixo, quando as novas passam de `remoteKeep`.

Comportamento novo:

- O card "O que falta" diz que o armazenamento já guarda backups de outro painel e dá os dois
  caminhos: restaurar o antigo (guia) para continuá-lo, ou, sendo painel novo, fazer o primeiro
  backup à mão em Configurações → Backups (não é bloqueado). Avisa que a retenção já apaga as cópias
  mais antigas a partir do primeiro backup (mantém as 5 mais novas por padrão) e que é preciso baixar
  as antigas ANTES do primeiro backup ou usar outro bucket/pasta.
- "Abrir Backups" é o botão principal (primeiro, destacado) nesse caso; o guia continua como botão
  secundário.
- Passo 8 do "Como fazer": com cópias de outro painel, oferece restaurar OU fazer o primeiro backup;
  bucket vazio, só o backup; armazenamento que não respondeu, continua só "restaure primeiro"
  (`howTo.8Unknown`, texto antigo).
- Mensagem de pausa (`pausedReason`), texto do servidor do roteiro, `_i18n-servidor-fase2.tsv`, docs
  `comoFuncionaSistema` e docs do site (pt-br e en: features, complete-guide, restore-new-server)
  concordam.

## B. Palavra de confirmação ambígua

- Novo `apps/web/src/components/ConfirmWordInput.tsx`: a palavra aparece em fonte de código no
  rótulo, há dica de que é a palavra literal (e-mail: "não é o seu endereço de e-mail"), o próprio
  texto é o placeholder e há botão de copiar (que não envia o formulário em que está).
- Usado em: restauração (painel, e-mail e projeto, `backup-ui.tsx`), "Recomeçar do zero"
  (`SetupDone.tsx`) e desativar o acesso pelo IP (`PanelDomainSettings.tsx`). Não há outro diálogo
  que peça digitar uma palavra (busca por "digite"/"type" nos dicionários).
- A lógica de comparação não mudou em nenhum dos três (restauração aceita a palavra do idioma ou a
  do servidor, sem caixa e sem espaços nas pontas; o endereço de e-mail da pessoa não confirma).
- `CopyButton` do e-mail passou a ter `type="button"`.

## Testes

- Servidor: `onboarding.test.ts` (dois caminhos e bucket vazio), `backup-service.test.ts`
  (mensagem de pausa).
- Web: `onboarding-checklist.test.tsx` (card, botão principal, passo 8, pt-BR e en),
  `confirm-word-input.test.tsx`, `panel-restore-dialog.test.tsx`, `setup-page.test.tsx`,
  `panel-domain-settings.test.tsx`.
