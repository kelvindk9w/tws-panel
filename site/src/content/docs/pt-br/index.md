---
title: TWS Panel
description: Painel open source que transforma uma VPS Ubuntu na sua própria plataforma de hospedagem.
template: splash
hero:
  tagline: Transforme uma VPS Ubuntu na sua própria plataforma de hospedagem. Proteja a máquina, publique projetos com HTTPS e cuide do e-mail profissional, em um painel que você controla.
  actions:
    - text: Instalar o painel
      link: /tws-panel/pt-br/getting-started/installation/
      icon: right-arrow
    - text: Código no GitHub
      link: https://github.com/kelvindk9w/tws-panel
      icon: external
      variant: minimal
---

import { Card, CardGrid } from '@astrojs/starlight/components';

<CardGrid>
  <Card title="Deploy" icon="rocket">
    Repositórios git, HTML puro, projetos com build, `Dockerfile` e `docker-compose`, com vários
    domínios por projeto e HTTPS automático.
  </Card>
  <Card title="Segurança primeiro" icon="approve-check">
    Wizard de hardening com simulação e rollback automático, guardrails de deploy, monitoramento
    contínuo e login com verificação em duas etapas (TOTP).
  </Card>
  <Card title="E-mail" icon="envelope">
    Servidor de e-mail próprio (Stalwart) com checklist de DNS verificável, caixas, variáveis
    SMTP por projeto e webmail.
  </Card>
  <Card title="Backups" icon="download">
    Backups agendados em `.7z` do painel, do e-mail e dos projetos, copiados na VPS e no
    Cloudflare R2 ou em outro S3, com criptografia opcional.
  </Card>
</CardGrid>

## Por onde seguir

- [Instalação](getting-started/installation.md): passo a passo numa VPS limpa.
- [Do zero ao painel pronto](getting-started/complete-guide.md): um roteiro único, em ordem, até um backup restaurado.
- [Funcionalidades](guides/features.md): o que cada módulo faz.
- [Modelo de segurança](reference/security.md): o que o painel protege e o que ele exige.
- [Solução de problemas](guides/troubleshooting.md): porta 25 bloqueada, e-mail em spam, certificado que não sai.
- [Restaurar numa VPS nova](guides/restore-new-server.md): traga o painel, os projetos e o e-mail de volta a partir dos backups externos.

## O que você precisa

Uma VPS limpa com Ubuntu 22.04 ou 24.04 LTS (no mínimo 1 vCPU, 2 GB de RAM e 25 GB de disco) e as
portas 80 e 443 abertas. O Docker, o Node e o resto são instalados pelo instalador.

A interface do painel está disponível em português e em inglês. Ela começa no primeiro idioma do seu
navegador que o painel tem (inglês, se nenhum combinar) e você pode trocar no menu do usuário, nas telas de
login e do assistente e em **Configurações → Aparência**. Algumas mensagens que vêm do servidor
(resultados das verificações de saúde e de segurança, mensagens do deploy e da checagem de DNS,
alertas, detalhes da auditoria e muitas mensagens de erro) ainda aparecem em português; os guias
avisam quando citam uma. Veja [Traduzir a interface](development/translating-the-interface.md) e o
[roadmap](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).
