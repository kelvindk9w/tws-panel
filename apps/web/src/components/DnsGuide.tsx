/**
 * Guia do registro de DNS para apontar um domínio próprio para a VPS: o
 * registro exato (tipo A, nome, IP) e onde criá-lo. Usado no Novo Projeto e na
 * seção Domínios do projeto.
 */
export function DnsGuide({ domain, publicIp }: { domain: string; publicIp: string | null }) {
  return (
    <div data-testid="dns-guide" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
      <p>
        No painel onde você comprou o domínio (Registro.br, Hostinger, Cloudflare, GoDaddy…), abra a área de{" "}
        <strong className="text-foreground">DNS</strong> e crie este registro:
      </p>
      <table className="w-full text-left font-mono">
        <thead>
          <tr className="text-muted-foreground">
            <th className="pr-3 font-normal">Tipo</th>
            <th className="pr-3 font-normal">Nome</th>
            <th className="font-normal">Valor</th>
          </tr>
        </thead>
        <tbody className="text-foreground">
          <tr>
            <td className="pr-3">A</td>
            <td className="break-all pr-3">{domain.trim().toLowerCase() || "loja.meusite.com.br"}</td>
            <td>{publicIp ?? "IP da sua VPS"}</td>
          </tr>
        </tbody>
      </table>
      <p>
        Em alguns provedores o "Nome" é só a parte antes do domínio (ex.: <code>loja</code>) — ou <code>@</code> para o
        domínio principal. A mudança costuma valer em minutos, mas pode levar algumas horas. Depois, clique em{" "}
        <strong className="text-foreground">Verificar DNS</strong>.
      </p>
      <p data-testid="dns-guide-cloudflare">
        <strong className="text-foreground">Usa a Cloudflare?</strong> Deixe a nuvem deste registro{" "}
        <strong className="text-foreground">cinza ("Somente DNS")</strong>, não laranja. Com a laranja o tráfego passa
        pelo proxy da Cloudflare, e o painel não consegue confirmar o DNS nem emitir o certificado sozinho.
      </p>
    </div>
  );
}
