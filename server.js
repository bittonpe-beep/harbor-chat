const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT || 3000);
const htmlPath = path.join(__dirname, "index.html");
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, app: "harbor-chat" }));
  }
  if (req.url === "/" || req.url === "/index.html") {
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Harbor Chat could not load its homepage.");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server });
const clients = new Map();
const history = [];
const MAX_HISTORY = 100;
const MAX_MESSAGE_LENGTH = 2000;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}
function onlineCount() {
  return [...clients.values()].filter(c => c.joined).length;
}
wss.on("connection", (socket) => {
  const client = { name: "Guest", joined: false };
  clients.set(socket, client);
  socket.send(JSON.stringify({ type: "welcome", history, online: onlineCount() }));

  socket.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data !== "object") return;

    if (data.type === "join") {
      const name = String(data.name || "Guest").trim().replace(/\s+/g, " ").slice(0, 24) || "Guest";
      const wasJoined = client.joined;
      client.name = name;
      client.joined = true;
      socket.send(JSON.stringify({ type: "joined", name }));
      if (!wasJoined) {
        const system = { type: "system", text: name + " joined the chat", time: new Date().toISOString() };
        history.push(system); if (history.length > MAX_HISTORY) history.shift();
        broadcast(system);
      }
      broadcast({ type: "presence", online: onlineCount() });
      return;
    }

    if (data.type === "chat" && client.joined) {
      const text = typeof data.text === "string" ? data.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (!text) return;
      const message = {
        type: "chat",
        id: require("node:crypto").randomUUID(),
        name: client.name,
        text,
        time: new Date().toISOString()
      };
      history.push(message); if (history.length > MAX_HISTORY) history.shift();
      broadcast(message);
    }
  });

  socket.on("close", () => {
    const hadJoined = client.joined;
    clients.delete(socket);
    if (hadJoined) {
      const system = { type: "system", text: client.name + " left the chat", time: new Date().toISOString() };
      history.push(system); if (history.length > MAX_HISTORY) history.shift();
      broadcast(system);
    }
    broadcast({ type: "presence", online: onlineCount() });
  });
});
server.listen(port, "0.0.0.0", () => console.log("Harbor Chat real-time server listening on " + port));