import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

/** "dono/repositório" de uma URL do GitHub (https ou .git), ou null. */
function githubRepo(url: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function isGitLab(url: string): boolean {
  return /gitlab\./i.test(url);
}

const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * "Como gerar o token" do repositório privado. O guia sai da URL colada: no
 * GitHub (o caminho validado pelo painel), passo a passo com link direto e o
 * nome do repositório; em outros provedores, a orientação geral — sem prometer
 * telas que o painel não conferiu.
 */
export function TokenGuide({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const repo = githubRepo(url);
  const gitlab = !repo && isGitLab(url);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start text-xs font-medium text-sky-400 hover:underline"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <BookOpen className="h-3.5 w-3.5" /> Como gerar o token
      </button>

      {open && (
        <div data-testid="token-guide" className="flex flex-col gap-2 rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
          {repo || !gitlab ? (
            <>
              <a
                href={GITHUB_NEW_TOKEN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 self-start font-medium text-sky-400 hover:underline"
              >
                Abrir a página do GitHub <ExternalLink className="h-3 w-3" />
              </a>
              <ol className="flex list-decimal flex-col gap-1.5 pl-4">
                <li>
                  Entre na sua conta do GitHub, se pedir. Na página que abriu (<em>New fine-grained personal access
                  token</em>), dê um nome ao token — por exemplo <strong className="text-foreground">TWS Panel</strong>.
                </li>
                <li>
                  Em <strong className="text-foreground">Expiration</strong>, escolha uma validade (90 dias é um bom
                  equilíbrio). Quando vencer, gere outro e troque na página do projeto.
                </li>
                <li>
                  Em <strong className="text-foreground">Repository access</strong>, marque{" "}
                  <strong className="text-foreground">Only select repositories</strong> e escolha{" "}
                  <strong className="font-mono text-foreground">{repo ?? "o repositório do projeto"}</strong>.
                </li>
                <li>
                  Em <strong className="text-foreground">Permissions → Repository permissions</strong>, procure{" "}
                  <strong className="text-foreground">Contents</strong> e escolha{" "}
                  <strong className="text-foreground">Read-only</strong>. Não marque mais nada: o painel só lê o
                  código.
                </li>
                <li>
                  Clique em <strong className="text-foreground">Generate token</strong>, copie o token (começa com{" "}
                  <code className="font-mono">github_pat_</code>) e cole no campo acima. Ele{" "}
                  <strong className="text-foreground">só aparece uma vez</strong> no GitHub.
                </li>
              </ol>
            </>
          ) : (
            <>
              <p>
                No <strong className="text-foreground">GitLab</strong>, crie um <em>Personal access token</em> (ou um{" "}
                <em>Project access token</em> só deste projeto) com o escopo{" "}
                <code className="font-mono text-foreground">read_repository</code> — somente leitura — e cole no
                campo acima. O token só aparece uma vez.
              </p>
              <p>
                Em outros provedores, o caminho é o mesmo: um token de acesso com permissão somente leitura do
                repositório.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
