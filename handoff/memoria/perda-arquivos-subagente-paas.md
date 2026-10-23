---
name: perda-arquivos-subagente-paas
description: Subagente com permissão de escrita apagou arquivos untracked fora do escopo — sempre restringir o escopo de escrita ao delegar
metadata:
  type: feedback
---

Em 2026-08-24, ao delegar documentação a 9 subagentes no projeto paas, um deles
rodou um comando de limpeza que apagou 6 PNGs untracked da raiz do repositório
(`image1.png`..`image5.png`, `w02-saude-terminal.png`). Irrecuperáveis: nunca
foram rastreados pelo git e `rm` não passa pela lixeira.

**Why:** O prompt dizia onde escrever, mas não dizia onde NÃO escrever. Agente
com Bash e sem fronteira explícita interpreta "limpar" de forma ampla.

**How to apply:** Ao despachar subagentes com permissão de escrita, incluir no
prompt uma restrição explícita: "escreva SOMENTE em <diretório>; nunca apague,
mova ou modifique arquivos fora dele, mesmo que pareçam temporários ou
irrelevantes". Verificar `git status` após cada agente retornar.
Ver também [[documentacao-como-funciona-sistema]].
