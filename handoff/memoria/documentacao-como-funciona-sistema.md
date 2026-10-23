---
name: documentacao-como-funciona-sistema
description: O projeto paas (TWS Panel) tem documentação legível por máquina em comoFuncionaSistema/ — consultar antes de explorar o código
metadata:
  type: project
---

O diretório `comoFuncionaSistema/` na raiz do projeto paas é documentação
escrita **para agentes de IA**, não para humanos. Criada em 2026-08-24.

Ponto de entrada: `comoFuncionaSistema/index.json` → `<modulo>/index.json` →
arquivo do endpoint específico. Peças transversais em `global/`. O contrato de
formato está em `comoFuncionaSistema/_ESQUEMA.md`.

**Why:** Kelvin pediu explicitamente que ela existisse para que, ao encerrar uma
conversa, o próximo agente não precise refazer um code review do sistema inteiro
para saber onde as coisas estão.

**How to apply:** Ao receber uma tarefa neste projeto, ler o index e o índice do
módulo relevante ANTES de sair explorando arquivos. Ao alterar código, atualizar
o JSON correspondente — documentação desatualizada é pior que ausente.
Ver também [[perda-arquivos-subagente-paas]].
