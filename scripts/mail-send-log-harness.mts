/**
 * mail-send-log-harness.mts — o "painel" do teste de integração real dos
 * envios por SMTP (scripts/test-mail-send-log.mts). Roda DENTRO de um
 * container na rede interna do Docker, ao lado de um Stalwart v0.11.8 real, e
 * usa o código de verdade do painel:
 *
 *  - o ouvido do aviso (buildMailHookServer, porta 9100) com o MailSendLogService;
 *  - a leitura do registro (MailEnviosService + DeliveryLogReader), alimentada
 *    pelas linhas que o orquestrador pega com `docker logs` do Stalwart;
 *  - uma porta de controle (9101, só do teste) para o orquestrador consultar.
 *
 * Variáveis: HOOK_SECRET (hex), DATA_DIR.
 */
import http from "node:http";
import nodemailer from "nodemailer";
import { StalwartClient } from "../packages/mailer/src/client.js";
import { lookup } from "node:dns/promises";
import { buildMailHookServer } from "../apps/server/src/services/mail-send-hook-server.js";
import { MailSendLogService } from "../apps/server/src/services/mail-send-log-service.js";
import { MailEnviosService } from "../apps/server/src/services/mail-envios-service.js";

const secret = process.env.HOOK_SECRET!;
const dataDir = process.env.DATA_DIR ?? "/data";

const senders = async () => [
  { address: "loja@example.com", mailbox: "loja@example.com", projectId: "proj-loja", system: false },
  { address: "postmaster@example.com", mailbox: "postmaster@example.com", projectId: null, system: true },
];
const projectNames = async () => new Map([["proj-loja", "Loja"]]);

let lines: string[] = [];
/** Simula o resultado de entrega que se perde a caminho do registro (o histórico guarda, o painel não aplica). */
let dropEvents = false;
const sends = new MailSendLogService({
  dataDir,
  senders,
  projectNames,
  serverCreated: async () => true,
  localDomains: async () => ["example.com"],
  listQueue: async () => ({ items: [], total: 0 }),
  captureConfigured: async () => true,
  eventsFor: (ids, sinceMs) => envios.eventsFor(ids, sinceMs),
  log: (m) => console.log("[painel]", m),
});
const envios = new MailEnviosService({
  dataDir,
  serverCreated: async () => true,
  listQueue: async () => ({ items: [], total: 0 }),
  retry: async () => true,
  cancel: async () => true,
  senders,
  projectNames,
  readLogs: async (_since, onLine) => {
    for (const l of lines) onLine(l);
  },
  onEvents: (events) => (dropEvents ? Promise.resolve() : sends.applyEvents(events)),
});

const hook = buildMailHookServer({
  verify: async (s) => s === secret,
  // como no painel: só o container do Stalwart (endereço resolvido pelo nome na rede)
  allowFrom: async () => (await lookup("paas-stalwart", { all: true })).map((a) => a.address),
  submit: (payload) => sends.submit(payload),
});
await hook.listen({ port: 9100, host: "0.0.0.0" });

// Porta de controle (só deste teste).
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        let out: unknown;
        if (url.pathname === "/collect") {
          lines = (JSON.parse(body || "{}") as { lines?: string[] }).lines ?? [];
          await sends.flush();
          out = await envios.collect();
          envios.stop();
        } else if (url.pathname === "/drop") {
          dropEvents = url.searchParams.get("on") === "1";
          out = { dropEvents };
        } else if (url.pathname === "/reconcile") {
          await sends.flush();
          out = await sends.reconcile();
        } else if (url.pathname === "/list") {
          await sends.flush();
          out = await sends.list(Object.fromEntries(url.searchParams));
        } else if (url.pathname === "/reveal") {
          out = await sends.reveal(url.searchParams.get("id") ?? "");
        } else if (url.pathname === "/provision") {
          const client = new StalwartClient("http://paas-stalwart:8080", "admin", process.env.ADMIN_SECRET!);
          await client.createDomain("example.com");
          await client.createMailbox("loja@example.com", "senha-da-caixa-123");
          await client.createMailbox("postmaster@example.com", "senha-postmaster-123");
          out = { ok: true };
        } else if (url.pathname === "/tune") {
          // Entrega a um servidor de teste sem certificado válido: STARTTLS opcional e certificado inválido aceito
          // (o painel não mexe nisso; é só para o destinatário de mentira da rede interna).
          const auth = "Basic " + Buffer.from(`admin:${process.env.ADMIN_SECRET}`).toString("base64");
          for (const [key, value] of [["queue.outbound.tls.starttls", "optional"], ["queue.outbound.tls.allow-invalid-certs", "true"]] as const) {
            await fetch("http://paas-stalwart:8080/api/settings", {
              method: "POST",
              headers: { authorization: auth, "content-type": "application/json" },
              body: JSON.stringify([{ type: "clear", prefix: key }, { type: "insert", prefix: null, values: [[key, value]], assert_empty: false }]),
            });
          }
          out = { ok: true };
        } else if (url.pathname === "/send") {
          // Envio de um app: submissão autenticada (587 + STARTTLS) pela caixa do projeto.
          const o = JSON.parse(body) as { from: string; to: string; subject: string; text: string; user: string; pass: string };
          const t0 = Date.now();
          const transport = nodemailer.createTransport({
            host: "paas-stalwart",
            port: 587,
            secure: false,
            requireTLS: true,
            // certificado autoassinado do Stalwart de teste, em rede interna sem saída
            tls: { rejectUnauthorized: false, servername: "mail.example.com" },
            auth: { user: o.user, pass: o.pass },
          });
          const info = await transport.sendMail({
            from: o.from,
            to: o.to,
            subject: o.subject,
            text: o.text,
            attachments: [{ filename: "relatorio.csv", content: "a;b\n1;2\n" }],
          });
          out = { response: info.response, ms: Date.now() - t0 };
        } else if (url.pathname === "/inbound") {
          // Mensagem recebida de fora (porta 25, sem login) com o remetente FORJADO da caixa do projeto: não pode virar registro.
          const transport = nodemailer.createTransport({ host: "paas-stalwart", port: 25, secure: false, ignoreTLS: true });
          const info = await transport.sendMail({ from: "loja@example.com", to: "postmaster@example.com", subject: "entrada", text: "oi" });
          out = { response: info.response };
        } else {
          out = { ok: true };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
  })
  .listen(9101, "0.0.0.0");
console.log("harness pronto");
