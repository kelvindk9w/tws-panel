---
name: pedido-explicito-nao-reduzir
description: Não deixar subagente (nem a mim) reduzir o escopo de um pedido explícito do Kelvin com justificativa técnica
metadata:
  node_type: memory
  type: feedback
  originSessionId: e34c520e-bac4-4c56-b13e-bff7bba4ef19
  modified: 2026-09-28T15:31:51.209Z
---

Quando o Kelvin pede algo explicitamente, entregar o que foi pedido. Se houver objeção técnica, dizer em uma frase e entregar mesmo assim (ou perguntar) — nunca trocar silenciosamente por uma versão "melhor".

**Why:** ele pediu um comando para achar porta livre no computador do usuário antes de instalar; o subagente decidiu não publicar ("não existe um igual em Linux/macOS/Windows") e eu repassei a decisão como se fosse boa. Ele cobrou: "a não ser que você não fez o que eu pedi". A solução era óbvia: publicar os três comandos.

**How to apply:** ao revisar o relato de um subagente, conferir item a item contra o pedido original do usuário; qualquer "optei por não fazer X" em algo que ele pediu é bloqueio — reabrir antes de mesclar. Ver também [[perda-arquivos-subagente-paas]].
