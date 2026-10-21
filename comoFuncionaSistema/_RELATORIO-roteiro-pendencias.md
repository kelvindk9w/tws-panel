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

## Limites conhecidos
- Os textos de `missing` vêm do servidor em português (padrão de `detail`), então em inglês aparecem em
  português, exceto o caso do backup, traduzido pelo código. Linhas em `_i18n-servidor-fase2.tsv`.
- Capturas (Playwright, dados simulados): Dashboard com passos em andamento, 390 e 1440 px, pt-BR e en,
  sem rolagem horizontal. Ficam fora do repositório.
