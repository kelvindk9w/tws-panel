---
name: cobertura-antes-do-pr
description: "Antes de abrir PR no paas, rodar a cobertura de todos os pacotes (o CI reprova por mínimo de ramos)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e34c520e-bac4-4c56-b13e-bff7bba4ef19
  modified: 2026-10-02T14:51:24.482Z
---

Antes de abrir ou atualizar um PR do TWS Panel, rodar `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage` na raiz, não só `npx vitest run` em cada pacote.

**Why:** o CI (`pnpm test:coverage`) tem mínimos de cobertura de ramos por pacote (mailer 98%, deploy 95%…). Em 02/10/2026 o PR #65 passou em todos os testes locais e mesmo assim reprovou duas vezes no CI por cobertura; o Kelvin viu as falhas antes de mim. Sem `--no-bail`, o pnpm para no primeiro pacote reprovado e esconde os outros.

**How to apply:** antes de citar o PR ao Kelvin como pronto, rodar o comando acima; se algum pacote ficar abaixo, escrever os testes que faltam (ou remover ramos inalcançáveis) antes do push. Subagentes também devem receber essa instrução.
