# Relatório — endereço temporário do projeto e backup do e-mail na aba Backups

Data: 22/10/2026.

## Tarefa 1 — o endereço temporário era removido?

Conclusão da investigação:

- Conectar o domínio oficial (POST /api/projects/:id/domains) só acrescenta um adicional. "Tornar principal"
  troca de lugar: o antigo principal vira adicional. "Remover" só age sobre o que o usuário clica. Nenhum
  desses fluxos remove o endereço automático (teste `deploy-domains.test.ts`).
- Quem descartava o endereço era o passo 3 do assistente de novo projeto: ao escolher "Meu domínio", o
  `finish()` faz PATCH do domínio principal, o endereço automático (sslip.io ou o provisório .localhost) sai da
  lista e nada o recolocava. A página Domínios do projeto também não oferecia como criar outro.
- Correção: o assistente passa a manter o endereço sugerido como adicional quando o DNS do domínio próprio
  ainda não aponta (e o painel é público e o endereço não é .localhost); a página Domínios ganhou o botão
  "Adicionar endereço temporário para testar" (nenhum domínio resolve para a VPS) e o lembrete de remover o
  temporário depois que o oficial funcionar. Nada é removido automaticamente.
- Texto honesto: o aviso do sslip.io cita o limite de emissão de certificados do Let's Encrypt e aponta o
  domínio/subdomínio próprio como caminho.

## Tarefa 2 — e-mail na aba Backups do projeto

Duas seções distintas: "Backup do projeto" e "Backup do e-mail" (só com e-mail ligado), com selos, frequência,
último backup, conferência externa, aviso âmbar se desligado, atalho para Configurações → Backups → E-mail e
"Fazer backup do e-mail agora". Estado vazio explícito para projeto sem banco/arquivos.

## Não feito / limites

- Lista de projetos incluídos no cartão E-mail de Configurações → Backups: o dado não existe sem varrer
  projeto a projeto; não foi acrescentada.
- Verificação visual real no navegador e emissão real de certificado sslip.io não foram feitas.
- O lembrete só considera endereços *.sslip.io como temporários.
