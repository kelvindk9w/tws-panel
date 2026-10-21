# Relatório: idioma no cabeçalho e menu do topo com "Mais"

## O que mudou (comportamento)
- O seletor de idioma agora fica sempre à vista no cabeçalho, ao lado do menu do
  usuário: ícone de idiomas e código curto (PT/EN). No topo e na barra móvel é
  compacto; na lateral (esquerda/direita) mostra o nome completo, acima do menu do usuário.
  Cada opção mantém o nome completo como rótulo acessível; o campo tem rótulo "Idioma"/"Language".
- Menu do topo: à vista só Dashboard, Novo projeto, E-mail, Segurança e Alertas (com o
  badge). Envios, Certificados, Auditoria, Configurações e Setup ficam em "Mais".
  "Mais" abre/fecha por clique, Enter/Espaço, seta para baixo/cima (percorre os
  links), Esc (devolve o foco ao botão), clique fora, troca de rota e saída do foco;
  tem aria-expanded e fica destacado quando uma rota filha está aberta (inclui /mail/envios).
- Lateral e menu móvel listam os 10 itens, sem agrupar, na ordem de antes.
- A lista horizontal passou a valer a partir de 1024px (lg); abaixo disso aparece o botão "Menu".
  Antes era 768px, onde os itens já quebravam em várias linhas.

## Decisões
- Idioma removido do menu do usuário: evitava dois seletores iguais e o do cabeçalho
  o substitui. Continua em Configurações → Aparência, no login e no assistente.
- Configurações fica em "Mais" (também já está no menu do usuário), mantendo a rota na navegação.
- Seletor nativo (select) em vez de menu customizado: acessível por teclado e leitor de tela sem código extra.
- Código curto vem da chave nova `language.short` em common (fallback: pasta em maiúsculas).
- Textos novos: shell `nav.more`, `nav.label`; common `language.short`; glossário ganhou "mais / more".

## Testes
- Novo: apps/web/tests/header-language-menu.test.tsx (visto falhar antes da implementação).
- Alterado: apps/web/tests/layout.test.tsx, bloco "Envios no menu". Como Envios agora mora em "Mais"
  no topo, a verificação "logo depois de E-mail" passou a usar a lateral (lista completa) e
  os testes de destaque abrem "Mais" antes. As asserções de comportamento foram mantidas;
  o que mudou foi o ponto de partida (Envios visível no topo), por pedido.
- Cobertura (web): 977 testes, 91,83% instruções / 86,13% ramos. Demais pacotes passaram
  (core 119, deploy, mailer, security, server 1972 + 2 ignorados).

## Verificação visual
- Capturas com Playwright (dev server com API simulada) em 1024px e 390px, pt-BR e en,
  topo e lateral direita: sem rolagem horizontal; "Mais" aberto conferido. Um ajuste de
  espaçamento no móvel (gap menor) veio dessa conferência.

## Correções da revisão
- Topo em 1024px com nome longo e badge 99+: espaços menores em lg (gap-4, e gap-6 só em xl) e nome limitado a max-w-24 (max-w-32 em xl). Conferido a 1009 e 1014px (rolagem vertical simulada), pt-BR e en, e a 768/1023/1024/1440/390 nos três modos: sem rolagem horizontal.
- "Mais": seta para cima parte do último item (aberto ou fechado), Home/End, e clicar na rota já aberta fecha o painel.
- Cobertura final (web): 981 testes, 91,98% instruções / 86,37% ramos; Layout.tsx entrou na cobertura (95,9% / 93,9%).

## 2026-10-21: "Mais" vira "Configurações" com submenu
- No topo, o item "Mais" saiu. Em seu lugar há "Configurações": o rótulo é um link para
  /settings/profile e, colado a ele, uma seta (botão separado, nome acessível "Submenu de
  Configurações" / "Settings submenu") abre e fecha o submenu com Envios, Certificados,
  Auditoria e Setup. Configurações não se repete dentro do submenu.
- O submenu mantém tudo que o "Mais" tinha: aria-expanded, Enter/Espaço, setas, Home/End, Esc
  devolvendo o foco à seta, clique fora, troca de rota e saída do foco. A seta fica destacada
  quando uma rota filha está aberta (Envios, Certificados, Auditoria, Setup e qualquer /settings/*);
  o link também fica destacado em /settings/*. Só um menu aberto por vez (usuário, ajuda, idioma, submenu).
- Lateral e menu móvel seguem listando os 10 itens, sem submenu.
- Chave `nav.more` removida (pt-BR e en); nova `nav.settingsMenu`. Glossário atualizado.
- Documentação do site (guia completo, pt-br e en) passou a citar "seta ao lado de Configurações".
- Testes: header-language-menu, layout e help-menu atualizados e ampliados (vistos falhar antes);
  asserções de comportamento mantidas.
- Medição no Chromium (Vite + API simulada, nome longo e badge 99+): sem rolagem horizontal a
  360/390/768/1023/1024/1440 px, em pt-BR e en; submenu aberto dentro da tela em 1024 e 1440.

## Não testado
- Navegadores além do Chromium; leitor de tela real; telas entre 768 e 1023px só por regra de CSS.
- Idiomas além de pt-BR/en.
