---
name: delegar-todo-pedido-a-subagente
description: "Todo pedido novo do Kelvin vira um subagente próprio, para não misturar assuntos nem interromper o que está em andamento"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e34c520e-bac4-4c56-b13e-bff7bba4ef19
  modified: 2026-10-22T14:08:07.346Z
---

O Kelvin pede muitas coisas e mistura assuntos. Todo pedido de execução dele deve ser disparado como um subagente próprio (um por assunto), em vez de eu fazer no meio do que já estou acompanhando.

**Why:** ele não quer que um pedido novo interrompa, misture ou atrase o que está em curso (lotes em revisão, planejamento etc.). Disse isso em 22/10/2026.

**How to apply:** ao receber um pedido novo, abrir o agente (executor/revisor para código; agente de pesquisa/redação para o resto, com o modelo que ele pedir, ex. Opus) com briefing completo e escopo de escrita restrito; responder a ele em texto curto dizendo o que foi disparado, e seguir acompanhando os demais. Perguntas simples ou de esclarecimento eu respondo direto. Ver [[perda-arquivos-subagente-paas]] para restringir escrita e [[pedido-explicito-nao-reduzir]].
