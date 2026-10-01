# Relatório — roteiro "Deixe o painel pronto" (01/10/2026)

Branch: `feat/primeiros-passos`. Documentação técnica completa em
`configuracoes/roteiro-primeiros-passos.json`.

## O que foi feito

- **Dashboard:** cartão "Deixe o painel pronto" no topo.
  - Primeiro acesso (roteiro não começado): **aberto**, com os cinco passos, o status de
    cada um e a pasta dos projetos (`/opt/tws-projects`, só informativa).
  - Depois que a pessoa começa ("Recolher", o botão de um passo ou "Não vou usar"):
    **compacto**, só o próximo passo e o progresso, com "Ver todos os passos" numa janela.
  - Tudo resolvido: o cartão **some** do Dashboard.
- **Configurações → Primeiros passos** (`/settings/onboarding`): o roteiro inteiro, sempre,
  com "Tudo pronto" quando não falta nada.
- **Cada passo** tem "Como fazer": o que é, por que importa, passo a passo e o botão que
  leva à tela certa. "Conferir de novo" busca o status depois que a pessoa fez o passo.
- **Opcionais** (e-mail do servidor, notificações): "Não vou usar" e "Desfazer".
- **Servidor:** `GET /api/onboarding`, `POST /api/onboarding/start`,
  `PUT /api/onboarding/steps/:id`. Tipos e regras (ordem, próximo passo, concluído) em
  `packages/core/src/onboarding.ts`.

## Passos e como cada status é calculado

| # | Passo | Status |
|---|---|---|
| 1 | Proteções da VPS | Lê o último relatório e o histórico de segurança gravados em `data/` (nunca dispara varredura). Fase resolvida = aplicada de verdade com sucesso, ou sem checagem corrigível reprovada na última varredura. Todas → feito; parte → em andamento; nenhuma → a fazer. A frase traz "X de 8 fases", a nota do Lynis (ou interna) e o que falta. |
| 2 | Verificação em duas etapas | Ligada na conta → feito; senão a fazer. |
| 3 | Domínio do painel | **Em breve.** `*.sslip.io` ou túnel → em breve, explicando que o endereço atual tem o IP da VPS no nome. Quem instalou com domínio próprio em `PAAS_PANEL_DOMAIN` → feito. |
| 4 | E-mail do servidor (opcional) | Servidor criado e ligado, domínios e DNS verificado. Ligado com ao menos um domínio com DNS certo → feito; caminho andado → em andamento (diz o que falta); não deu para saber se está ligado → não confirmado. "Como fazer" recomenda subdomínio só de envio (`envio.exemplo.com.br`) e avisa do MX do domínio principal. |
| 5 | Notificações (opcional) | **Em breve.** Texto: Telegram primeiro, e-mail depois, um, outro ou os dois. |

Passos "em breve" não seguram o cartão. Um passo cuja conferência falha vira "não
confirmado" (nunca "feito") sem derrubar os outros.

## Decisões

- **Status calculado, nunca marcado à mão.** Só "Não vou usar" e "roteiro iniciado" são
  escolhas da pessoa, gravadas na conta (`StoredUser.onboarding` em `data/users.json`, ao
  lado de `preferences`). Ficaram num campo próprio, não dentro de `preferences`, para não
  mudar o contrato de `/api/auth/me` nem aceitar esses valores pela rota de preferências.
- **E-mail configurado vence o "Não vou usar".** Se a pessoa pulou e depois configurou, o
  passo aparece como feito.
- **"Roteiro iniciado" = a pessoa agiu no roteiro**, não "algum passo feito". O hardening
  costuma ser feito na instalação; se isso contasse, o roteiro nunca abriria aberto no
  primeiro acesso.
- **Como o servidor chega ao estado de segurança e e-mail.** Os serviços de segurança e
  e-mail são criados dentro dos plugins de rota, e o Fastify não os mostra aos outros
  plugins. Em vez de mexer nesses plugins (o de e-mail está sendo alterado em outro branch),
  o roteiro lê o estado de segurança pelos mesmos arquivos (`loadLastSecurityReport` e
  `loadSecurityHistory`, extraídos de `security-service.ts`) e o do e-mail com uma
  instância nova de `MailService` só para leitura, a cada consulta. `mail-service.ts` e
  `packages/mailer` não foram tocados.
- **Hardening: fase aplicada conta como resolvida** mesmo se uma checagem continuar
  reprovada (caso Contabo, em que reaplicar não resolve).
- **O aviso de 2FA do Dashboard foi mantido** abaixo do roteiro (foi pedido antes). Com o
  roteiro aberto e o 2FA desligado, os dois falam do 2FA — ver pendências.

## Como plugar os passos "em breve"

1. Servidor: em `createOnboardingChecks` (`apps/server/src/services/onboarding.ts`), troque a
   conferência de `panel-domain` ou `notifications` por uma que leia o estado novo e
   devolva feito / em andamento / a fazer. Se o estado morar num serviço de outro plugin,
   passe uma função de leitura pelas opções do plugin (como `mailFactsSource` faz).
2. Interface: em `apps/web/src/components/onboarding/steps-content.ts`, troque o passo a
   passo e ponha `action: { label, to }` com a tela nova.
3. Nada mais muda. O passo volta a contar como pendente e o cartão reaparece para quem já
   tinha concluído (de propósito: avisa que há algo novo).

## Testes

- `packages/core`: 44 testes (eram 39), cobertura 100%.
- `apps/server`: 811 testes (eram 784). Cobertura geral subiu: linhas 98,26 → 98,38%,
  ramos 92,35 → 92,57%. As novas rotas e serviços entraram no escopo de cobertura;
  `onboarding-sources.ts` ficou fora, pelo mesmo motivo de `mail-service.ts` (fala com o Docker).
- `apps/web`: 382 testes (eram 366). Cobertura geral subiu: linhas 81,94 → 82,67%.
- Tipos sem erro nos três pacotes.
- Uma execução teve uma falha intermitente em `docker-service.test.ts` (fala com o Docker
  real da máquina: erro do snapshotter do Docker Desktop local). Não tem relação com esta
  mudança e passou na execução seguinte.

## Conferência visual

Vite em `apps/web` (porta 5199) com `/api` simulado pelo Playwright, tema escuro. Em 390 px,
sem rolagem lateral em todos os estados medidos (aberto, compacto, janela, Configurações).
Capturas em `.playwright-mcp/` (ignorada pelo git):

- `primeiros-passos-1280-aberto.png` — primeiro acesso, roteiro aberto
- `primeiros-passos-1280-como-fazer-email.png` — "Como fazer" do e-mail aberto
- `primeiros-passos-1280-compacto.png` — depois de recolher, só o próximo passo
- `primeiros-passos-1280-janela.png` — "Ver todos os passos"
- `primeiros-passos-1280-compacto-email.png` — compacto com o e-mail como próximo passo
- `primeiros-passos-1280-dashboard-concluido.png` — depois de "Não vou usar" no último: cartão some
- `primeiros-passos-1280-configuracoes.png` — Configurações → Primeiros passos, tudo pronto
- `primeiros-passos-390-aberto.png`, `primeiros-passos-390-compacto.png`,
  `primeiros-passos-390-janela.png`, `primeiros-passos-390-configuracoes.png`

## Pendências

- **Validar na VPS real** (status do hardening com os arquivos de verdade, e-mail com o
  Stalwart ligado).
- **Decidir sobre o aviso de 2FA do Dashboard** agora que o roteiro cobre o 2FA: manter,
  esconder enquanto o roteiro estiver aberto, ou remover.
- Ao concluir o último passo pelo Dashboard, o cartão some na hora, sem mensagem de
  "tudo pronto". Se o dono do produto quiser, dá para mostrar a mensagem por alguns segundos.
- **Achado lateral (não corrigido):** o gancho de blacklist do monitoramento
  (`routes/monitoring.ts`) usa `app.mailService`, que não existe naquele plugin (o Fastify
  esconde o que outro plugin decora). O check de blacklist do monitoramento agendado não
  roda, e a falha não aparece (o scan trata a blacklist como "melhor esforço").
- Domínio do painel e notificações continuam "em breve" até a funcionalidade existir.
