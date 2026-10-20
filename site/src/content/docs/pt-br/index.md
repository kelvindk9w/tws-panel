---
title: TWS Panel
description: Painel open source que transforma uma VPS Ubuntu na sua própria plataforma de hospedagem.
template: splash
hero:
  tagline: Transforme uma VPS Ubuntu na sua própria plataforma de hospedagem. Proteja a máquina, publique projetos com HTTPS e cuide do e-mail profissional, em um painel que você controla.
  actions:
    - text: Instalar em minutos
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
- [Problemas comuns](guides/troubleshooting.md): porta 25 bloqueada, e-mail em spam, certificado que não sai.
