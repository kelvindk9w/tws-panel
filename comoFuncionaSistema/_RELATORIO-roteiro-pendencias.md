# Relatório — pendência explícita no roteiro "Deixe o painel pronto" (21/10/2026)

## Problema
O passo 6 (Backups fora da VPS) ficava "em andamento" com uma frase cinza pequena. O dono, testando do
zero, não percebeu que havia pendência.

## O que mudou
- **Servidor** (`services/onboarding.ts`): cada passo devolve `missing` (o que falta e como resolver)
  e `missingCode`. Só vem preenchido com o passo em andamento; nos demais, e quando a pessoa marca
  "Não vou usar", vai `null`. `detail` passou a descrever só a situação, sem repetir o que falta.
  Passos com pendência: proteções (fases que faltam), domínio do painel (DNS, certificado, abrir pelo
  domínio), e-mail (não iniciado, parado, sem domínio, DNS), notificações (falta o teste) e backups.
- **Núcleo** (`packages/core/src/onboarding.ts`): `onboardingStepNeedsAttention` e
  `onboardingAttentionSteps`, usados pela interface.
- **Interface** (`OnboardingChecklist.tsx`): caixa âmbar "O que falta" (role="note", ícone com texto
  alternativo, título, o texto e o botão do passo) fora do "Como fazer"; linha-resumo no topo
  (role="status") "N passos precisam de atenção:" com âncoras. No compacto, o link traz o passo à tela.
  Opcional em andamento também mostra; feito, a fazer, "Não vou usar" e "não confirmado" não mostram.
  Cores: o mesmo padrão âmbar dos outros avisos (o painel é sempre tema escuro, sem Alert próprio).
- **Backups com cópias de outro painel**: o texto manda restaurar o painel antigo primeiro e a
  interface mostra o link do guia (`restoreGuideUrl` em `lib/links.ts`, traduzido e no idioma).
  `missingCode = backups-restore-first` faz o web usar o texto traduzido em vez do texto do servidor.

## Leitura do estado de "painel novo sobre cópias de outro painel"
`BackupService.facts()` ganhou `foreignBackupsHeld` (só quando verdadeiro), usando a própria regra
`panelFreshOverForeign` com um parâmetro `readOnly`: não grava pausa, não conta falha de listagem e não
avisa. O estado `pausedReason` existente só é gravado no horário do agendador, tarde demais para
orientar logo depois de conectar o armazenamento. A regra não mudou. A listagem só roda com
armazenamento conectado e nenhum backup externo conferido.

## Revisão (21/10/2026)
- **Consulta ao armazenamento limitada**: a listagem do roteiro tem prazo de 5 s (só ela; as operações
  de backup mantêm o timeout normal). Só o resultado "há cópias de outro painel" (lado seguro) fica em
  cache por 60 s; o "livre" consulta sempre, porque o conteúdo do bucket muda por fora (cenário: bucket
  vazio conectado e, depois, cópias do painel antigo copiadas à mão para o mesmo bucket: "Conferir de novo"
  já enxerga). A chave do cache muda quando o armazenamento é reconectado ou testado de novo, quando entra
  projeto ou quando o painel é restaurado ou envia backup externo.
- **Uma consulta em voo por vez**: consultas simultâneas dividem o mesmo pedido. Se ele trava, o pedido
  segue aberto até o timeout do `S3Storage` (30 min), mas as recargas não abrem outros: recebem "não deu
  para conferir" na hora até o pedido terminar. Não cancelei o pedido (o `S3Storage` não aceita
  cancelamento por chamada; mudar isso mexeria nas operações reais de backup).
- **Falha nunca vira convite ao backup**: se a listagem falha ou estoura o prazo, `foreignBackupsHeld`
  vira `"unknown"` (código `backups-storage-unknown`). A interface mostra, em âmbar, "Não foi possível
  conferir o armazenamento agora. Se este painel está sendo restaurado, restaure o painel antigo antes do
  primeiro backup", com o guia de restauração e o botão "Conferir de novo". "unknown" não entra em cache,
  então conferir de novo consulta outra vez. O modo continua só leitura: nada é gravado, nenhuma falha é
  contada e nenhum aviso sai.
- **Passo 8 do "Como fazer" de Backups**: com `backups-restore-first` ou `backups-storage-unknown`, o
  "Clique em Fazer backup agora" é trocado por "Restaure primeiro o painel antigo e só então faça o
  primeiro backup". Na instalação do zero o texto original continua.
- **Resumo no primeiro acesso**: a linha-resumo âmbar fica oculta enquanto vale `isOnboardingFirstVisit`
  (roteiro não começado e nenhum passo além das Proteções andou). Com só as Proteções em andamento e
  nada mais começado, o resumo não aparece; a caixa do próprio passo aparece. Assim que a pessoa
  começa o roteiro (Recolher, botão de um passo ou "Não vou usar") ou outro passo anda, o resumo volta.
- **Prazo de 7 dias**: a regra do painel novo (`panelFreshOverForeign`) deixa de valer 7 dias depois da
  conexão do armazenamento. Passado esse prazo o roteiro volta a convidar ao "Fazer backup agora", mesmo
  com cópias de outro painel no armazenamento (o cache de 60 s não muda isso).

## Limites conhecidos
- Os textos de `missing` vêm do servidor em português (padrão de `detail`), então em inglês aparecem em
  português, exceto o caso do backup, traduzido pelo código. Linhas em `_i18n-servidor-fase2.tsv`.
- Capturas (Playwright, dados simulados): Dashboard com passos em andamento, 390 e 1440 px, pt-BR e en,
  sem rolagem horizontal. Ficam fora do repositório.
