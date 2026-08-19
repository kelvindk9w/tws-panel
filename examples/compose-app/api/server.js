/**
 * API mínima do exemplo compose-app: GET / retorna JSON com o status do Redis
 * (PING via protocolo RESP cru, sem dependências).
 */
import { createServer } from "node:http";
import { connect } from "node:net";

function redisPing() {
  return new Promise((resolve) => {
    const socket = connect({ host: "redis", port: 6379, timeout: 2000 });
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data", (data) => {
      socket.destroy();
      resolve(data.toString().includes("PONG") ? "PONG" : "resposta inesperada");
    });
    socket.on("error", (err) => resolve(`erro: ${err.message}`));
    socket.on("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
  });
}

const server = createServer(async (req, res) => {
  const redis = await redisPing();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ app: "compose-app", ok: true, redis }) + "\n");
});

server.listen(3000, () => console.log("api ouvindo na porta 3000"));
