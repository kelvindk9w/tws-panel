/**
 * mail-sink-server.cjs — "servidor do destinatário" de mentira para os testes de integração reais
 * (scripts/test-mail-send-log.mts). Fala SMTP com STARTTLS (certificado em /sink) e responde ao DATA
 * como o Gmail: MODE=ok (250), defer (451) ou reject (550). Só roda dentro da rede --internal do teste.
 */
const net = require("net");
const tls = require("tls");
const fs = require("fs");

const ctx = tls.createSecureContext({ key: fs.readFileSync("/sink/key.pem"), cert: fs.readFileSync("/sink/cert.pem") });
const MODE = process.env.MODE || "ok";

function dataReply() {
  if (MODE === "defer") return "451 4.7.1 try again later (greylisted)\r\n";
  if (MODE === "reject") return "550 5.7.1 rejected as spam\r\n";
  return "250 2.0.0 OK  1234abcd - gsmtp\r\n";
}

function talk(socket, offerTls) {
  let inData = false;
  let buf = "";
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write(dataReply());
        }
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) socket.write(`250-sink.example.net\r\n${offerTls ? "250-STARTTLS\r\n" : ""}250 8BITMIME\r\n`);
      else if (cmd.startsWith("STARTTLS") && offerTls) {
        socket.write("220 go ahead\r\n");
        socket.removeAllListeners("data");
        talk(new tls.TLSSocket(socket, { isServer: true, secureContext: ctx }), false);
        return;
      } else if (cmd.startsWith("DATA")) {
        inData = true;
        socket.write("354 go\r\n");
      } else if (cmd.startsWith("QUIT")) {
        socket.write("221 bye\r\n");
        socket.end();
      } else socket.write("250 OK\r\n");
    }
  });
}

net
  .createServer((socket) => {
    socket.write("220 sink.example.net ESMTP\r\n");
    talk(socket, true);
  })
  .listen(25, () => console.log("sink pronto", MODE));
