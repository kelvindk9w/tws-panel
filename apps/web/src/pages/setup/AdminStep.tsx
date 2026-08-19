import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UserRound } from "lucide-react";

export function AdminStep() {
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Conta de administrador</h2>
        <p className="text-sm text-muted-foreground">
          Último passo: criar o acesso ao painel e encerrar o modo de setup.
        </p>
      </div>

      <Card>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <UserRound className="h-6 w-6" />
          </div>
          <CardTitle className="flex items-center gap-2">
            Criar conta admin <Badge variant="secondary">Em breve</Badge>
          </CardTitle>
          <CardDescription className="max-w-md">
            A criação da conta de administrador (com senha forte e sessão segura) chega junto com o
            hardening, na Fase 1. Por enquanto, o servidor já está diagnosticado e protegido pelo
            setup token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="mx-auto flex max-w-md flex-col gap-3 opacity-60">
            <Input placeholder="Usuário administrador" disabled />
            <Input placeholder="Senha forte" type="password" disabled />
            <Input placeholder="Confirmar senha" type="password" disabled />
            <Button disabled>Concluir setup (disponível na Fase 1)</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
