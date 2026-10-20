# Relatório — guia de restauração alinhado ao lote 8

Parte de `origin/dev`. Só documentação (site en e pt-br); nenhum código, dicionário ou teste foi tocado, então a cobertura não foi rodada.

## O que mudou (pelo comportamento)

- **Guia `restore-new-server.md` (en e pt-br):** a seção `projetos-fora-do-github` e a linha da tabela saíram; o passo 7 agora explica que projetos de upload e de pasta do servidor voltam sozinhos (pasta de origem dentro da pasta de projetos, sem link para fora, gravável pelo usuário 10001; pasta já existente com arquivos fica como está; renomear/esvaziar antes de restaurar, nunca depois; `.env` gerado pelo painel não volta, o do dono volta).
- **Passo 3:** o aviso ganhou as condições da pausa do painel novo (sem projeto, sem backup do painel/e-mail feito aqui, armazenamento com backups em `_painel/`, menos de 7 dias desde a conexão), a notificação esperada, o "não envia se a listagem falhar" e o risco de passar de 7 dias; o backup à mão continua sempre rodando.
- **Passo 5:** avisos de chaves e de acesso pelo IP viraram notas para a restauração pela tela (chaves em uso mantidas; IP ativo até o domínio apontar, com a mensagem do servidor e o caminho para desativar de novo) e continuam como avisos para o `restaurar-painel.sh`. Incluída a ressalva sslip.io x domínio no "O que conferir".
- **Tabelas:** "O que você precisa" (chaves) e "O que volta" (configurações de backup, exceto endereço e chaves; projetos de upload/pasta).
- **Conferências finais:** a linha dos backups automáticos virou a da pausa das agendas (e a ressalva do script, que não pausa).
- **Se algo falhar:** causa do download reescrita e dois itens novos (pasta fora da pasta de projetos; pasta já existente).
- **Funcionalidades (backups):** bloco "Depois de restaurar o painel de outro servidor" com a pausa de até 7 dias, a regra do painel novo e o armazenamento mantido.
- **Operação:** aviso de que o `restaurar-painel.sh` traz tudo sem ajustes (chaves antigas, IP desativado, agenda sem pausa).
- **Solução de problemas e Produção:** `ALLOWED_ORIGINS` para quem usa outro proxy e recebe `403 forbidden_origin`.

## Verificado no código

- `backup-service.ts`: `holdReason`/`releaseHold` (7 dias, projeto criado depois, painel fora, liberação por restauração ou backup à mão), `panelFreshOverForeign` (condições, 7 dias da conexão, falha de listagem, notificações `backup-panel-held` e `backup-panel-held-error` na 3ª falha), `adaptStagedBackupSettings` (chaves em uso mantidas, e-mail só liberado com container), `adaptStagedPanelDomain` (usa `pointsHere` em `panel-domain.ts`), `restoreSourceBeforeDeploy` (mensagens, pasta existente, só upload/existing), remoção do `.env` com `GENERATED_HEADER`.
- `adaptRestoredPanel` só é chamado por `stagePanel`: o `restaurar-painel.sh` não passa pelos ajustes.
- Dicionários en/pt-BR: `lastBackup.next` ("Next: …"/"Próximo: …"), `restore.redeploy`, `ip.disable`, rótulos de Configurações → Domínio do painel; `pausedReason` exibido em `BackupSettings.tsx` e `ProjectBackupsCard.tsx`.
- Kit (`packages/core/src/backups.ts`): seção "O QUE ESTE KIT NÃO TEM" e passos 3 e 5 já coerentes com o guia.
- `docker-compose.yml` repassa `ALLOWED_ORIGINS`; `docs/internal/allowed-origins.md` confere com o texto escrito.

## Verificação executada

`pnpm install --frozen-lockfile`, build do site, `check:build`, `docs:links` e `check-no-real-hosts.mjs`: todos passaram.

## Dúvidas e observações

- O rótulo "Publicar do GitHub antes de restaurar" continua citando GitHub; o guia avisa que a caixa serve também aos outros projetos (decisão de rótulo é do Kelvin).
- A afirmação de que, depois de publicado, esvaziar a pasta de origem não adianta vem do relatório do lote 8 e da leitura de `restoreProject`; não foi testada numa VPS real.
- Nada foi testado em VPS real (DNS, 7-Zip e armazenamento reais), como no lote 8.
- O achado de bind mount `:ro` do lote 8 continua aberto e não está nos guias.

## Correções da revisão

- Conferências finais: removida a afirmação falsa de que projeto sem containers "desliga o backup automático". Com zero containers, `buildDetection` devolve "Nenhum container do projeto encontrado" (`backup-detect.ts`): falha com notificação. Acrescentado que projeto publicado sem os dados pode enviar backup sem eles, e que se deve restaurar os projetos logo.
- Passos 1 e 3: o painel novo roda a agenda às 03:00 mesmo sem armazenamento; o guia manda desmarcar "Automatic backup on" / "Backup automático ligado" no cartão Painel antes do passo 3 (VPS que passou uma madrugada ligada ou passo 5 com mais de 7 dias) e removeu o "não mude as agendas" contraditório.
- Passo 1: não iniciar o servidor de e-mail antes do passo 8; usar `--projects-dir` igual ao da VPS antiga (opção confirmada em `scripts/install.sh`).
- Passo 8: escolher a data do backup do e-mail anotada no passo 2. Passo 7: gravação na pasta de projetos (não na de origem). Parênteses repetidos removidos no guia em inglês.

## Achado de código (não corrigido)

Backup só local conta como backup concluído na regra `panelFreshOverForeign` (`lastSuccessAt` é preenchido em `backup-service.ts` mesmo sem cópia externa) e cancela a proteção do painel novo.
- Última rodada: passo 2 anota também o backup do e-mail; o aviso do e-mail no passo 1 explica que o container já existente o deixa fora da pausa; as conferências finais mandam religar o backup automático do painel se o backup era antigo (sem configurações de backup; confirmado em adaptStagedBackupSettings, que nesse caso mantém as de agora).
