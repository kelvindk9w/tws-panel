// Namespace "panelDomain" (pt-BR). Chaves planas; plural com sufixos _one/_other.
export default {
  // Command / Field
  "command.copyAria": "Copiar o comando",
  "field.copyAria": "Copiar {label}",

  // Carga e erros
  "load.error": "Não foi possível consultar o domínio do painel. Recarregue a página.",
  "error.save": "Não foi possível salvar o domínio.",
  "error.verify": "Não foi possível verificar o DNS.",
  "error.remove": "Não foi possível remover o domínio.",
  "error.disableIp": "Não foi possível desativar o acesso pelo IP.",
  "error.enableIp": "Não foi possível reativar o acesso pelo IP.",
  "error.refresh": "Não foi possível conferir de novo.",

  // Modo túnel
  "tunnel.title": "Domínio do painel",
  "tunnel.intro": "Este painel foi instalado no modo <b>túnel SSH</b>: ele só abre pelo túnel, no seu computador, e não tem endereço na internet. Por isso não há domínio para configurar — e nenhum IP aparece em endereço nenhum.",
  "tunnel.switch": "Para abrir o painel por um endereço na internet (com HTTPS) e depois usar um domínio seu, mude o acesso para HTTPS rodando na VPS, por SSH:",
  "tunnel.note": "O instalador mantém usuários, projetos e configurações; ele só passa a publicar o painel em https://{host}.sslip.io pelas portas 80 e 443. Depois disso, volte a esta tela.",
  "tunnel.hostPlaceholder": "ip-com-hífens",

  // Endereço do painel
  "addresses.title": "Endereço do painel",
  "addresses.description": "Por onde o painel abre hoje. O endereço automático tem o IP da VPS no nome: com um domínio seu, ele fica mais discreto e fácil de lembrar.",
  "addresses.badgeIp": "pelo IP",
  "addresses.badgeDomain": "seu domínio",
  "addresses.badgeCurrent": "esta página",
  "addresses.ipDisabled": "O endereço https://{ip} está desativado: o painel não responde mais nele.",

  // Seu domínio
  "domain.title": "Seu domínio",
  "domain.description": "Use um subdomínio só para o painel, como painel.exemplo.com.br.",
  "domain.label": "Domínio do painel",
  "domain.placeholder": "painel.exemplo.com.br",
  "domain.changeWarning": "Ao trocar, o acesso pelo IP volta (https://{ip}) até o domínio novo ficar pronto. Você vai precisar entrar de novo lá.",
  "domain.save": "Salvar domínio",
  "domain.cancel": "Cancelar",
  "domain.badgeActive": "DNS conferido",
  "domain.badgePending": "aguardando o DNS",
  "domain.createRecord": "No seu provedor de DNS, crie este registro:",
  "domain.recordType": "Tipo",
  "domain.recordName": "Nome",
  "domain.recordValue": "Valor (IP da VPS)",
  "domain.recordValueFallback": "IP da VPS",
  "domain.cloudflareNote": "No Cloudflare, deixe a nuvem cinza (“Somente DNS”): com a nuvem laranja o certificado não sai. Se houver um registro AAAA com esse nome, apague. A propagação costuma levar de minutos a algumas horas.",
  "domain.verify": "Verificar DNS",
  "domain.change": "Trocar domínio",
  "domain.remove": "Remover domínio",
  "domain.removeConfirm": "O painel deixa de responder em https://{domain} e volta a abrir só por https://{ip}{extra}. Se você está nesta página pelo domínio, vai precisar entrar de novo no endereço do IP.",
  "domain.removeConfirmReactivated": " (o acesso pelo IP é reativado)",
  "domain.removeCancel": "Cancelar",
  "domain.removeYes": "Sim, remover",

  // Certificado HTTPS
  "certificate.title": "Certificado HTTPS",
  "certificate.description": "Emitido sozinho pelo Let's Encrypt assim que o domínio entra no proxy. Costuma levar de segundos a 2 minutos.",
  "certificate.unknown": "Ainda não deu para conferir o certificado. Clique em “Conferir de novo”.",
  "certificate.refresh": "Conferir de novo",
  "certificate.openNew": "Abrir o painel pelo endereço novo",
  "certificate.openNewNote": "Lá você vai precisar entrar de novo (usuário, senha e código): a sessão vale só no endereço em que você entrou. Este endereço continua funcionando.",

  // Acesso pelo IP
  "ip.title": "Acesso pelo IP",
  "ip.description": "O endereço https://{ip} mostra o IP da VPS. Depois que o domínio novo funcionar, você pode desativá-lo.",
  "ip.disabledInfo": "O acesso pelo IP está desativado: o painel responde só em https://{domain}.",
  "ip.enable": "Reativar o acesso pelo IP",
  "ip.disable": "Desativar o acesso pelo IP",
  "ip.blockerDefault": "Abra o painel pelo endereço novo (https://{domain}) para liberar o botão.",
  "ip.blockerDefaultDomain": "seu domínio",
  "ip.disableConfirm": "O painel vai responder <b>só</b> em https://{domain}. O endereço https://{ip} deixa de abrir. Se um dia o domínio parar de funcionar (DNS apagado, domínio vencido), reative pelo SSH da VPS com:",
  "ip.typeToConfirm": "Digite {domain} para confirmar",
  "ip.cancel": "Cancelar",
  "ip.disableNow": "Desativar agora",
  "ip.lostAccess": "Se perder o acesso pelo domínio",
  "ip.lostAccessHelp": "Entre na VPS por SSH e rode o comando abaixo: ele reativa o endereço pelo IP.",
  "ip.configNote": "A escolha fica gravada em {file} e vale também depois de reiniciar o painel ou a VPS.",
} as const;
