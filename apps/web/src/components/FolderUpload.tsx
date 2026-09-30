import { useRef } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FolderUp } from "lucide-react";

/** Pastas que não vão para o servidor (pesadas e refeitas no build, ou internas do git). */
const SKIPPED = new Set(["node_modules", ".git"]);

export interface PickedFolder {
  name: string;
  /** Arquivo + caminho relativo à pasta escolhida ("assets/logo.svg"). */
  files: Array<{ file: File; path: string }>;
  bytes: number;
}

/** Transforma a seleção da janela de pasta no que será enviado. */
export function pickFolder(list: FileList | File[]): PickedFolder | null {
  const all = Array.from(list);
  if (all.length === 0) return null;
  const first = (all[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? all[0]!.name;
  const name = first.split("/")[0] ?? "pasta";
  const files: PickedFolder["files"] = [];
  for (const file of all) {
    const rel = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).split("/");
    const inside = rel.length > 1 ? rel.slice(1) : rel;
    if (inside.some((part) => SKIPPED.has(part))) continue;
    files.push({ file, path: inside.join("/") });
  }
  return { name, files, bytes: files.reduce((n, f) => n + f.file.size, 0) };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Envia a pasta escolhida: abre um envio no servidor e manda os arquivos, 4 de
 * cada vez. Devolve a pasta do servidor que vira a origem do projeto.
 */
export async function uploadFolder(folder: PickedFolder, onProgress: (done: number, total: number) => void): Promise<string> {
  const { id, dir } = await apiFetch<{ id: string; dir: string }>("/api/uploads", { method: "POST" });
  let next = 0;
  let done = 0;
  const total = folder.files.length;
  onProgress(0, total);
  async function worker() {
    while (next < total) {
      const item = folder.files[next++]!;
      await apiFetch(`/api/uploads/${id}/file?path=${encodeURIComponent(item.path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: item.file,
      });
      done += 1;
      onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  return dir;
}

/**
 * "Enviar do meu computador": a janela de escolher pasta do navegador. Funciona
 * igual com a VPS (online) e com o painel no próprio computador; no Windows, as
 * pastas do WSL aparecem em \\wsl$ (ou "Linux", no Explorador).
 */
export function FolderUpload({
  folder,
  onPick,
  progress,
}: {
  folder: PickedFolder | null;
  onPick: (folder: PickedFolder | null) => void;
  progress: { done: number; total: number } | null;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <input
        ref={input}
        data-testid="folder-input"
        type="file"
        multiple
        className="hidden"
        // atributos não padronizados: a janela escolhe uma PASTA inteira
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => onPick(e.target.files ? pickFolder(e.target.files) : null)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => input.current?.click()}>
          <FolderUp className="h-4 w-4" /> {folder ? "Escolher outra pasta" : "Escolher pasta…"}
        </Button>
        {folder && (
          <span data-testid="folder-summary" className="text-muted-foreground">
            📁 <strong className="text-foreground">{folder.name}</strong> — {folder.files.length} arquivos,{" "}
            {formatBytes(folder.bytes)}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Escolha a pasta principal do projeto (a que tem o <code className="font-mono">index.html</code>,{" "}
        <code className="font-mono">package.json</code> ou <code className="font-mono">Dockerfile</code>). As pastas{" "}
        <code className="font-mono">node_modules</code> e <code className="font-mono">.git</code> ficam de fora. No
        Windows, as pastas do WSL aparecem como <strong className="text-foreground">Linux</strong> no Explorador.
      </p>
      {progress && (
        <p data-testid="upload-progress" className="text-xs text-sky-400">
          Enviando {progress.done} de {progress.total} arquivos…
        </p>
      )}
    </div>
  );
}
