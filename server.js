const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { Pool } = require("pg");

const port = Number(process.env.PORT || 3000);
const htmlPath = path.join(__dirname, "index.html");
const MAX_HISTORY = 100;
const MAX_MESSAGE_LENGTH = 2000;
const history = [];
const clients = new Map();
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, app: "harbor-chat", persistence: pool ? "postgres" : "memory-only" }));
  }
  if (new URL(req.url, "http://localhost").pathname === "/" || new URL(req.url, "http://localhost").pathname === "/index.html") {
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

function broadcast(payload, room) {
  const data = JSON.stringify(payload);
  for (const socket of wss.clients) {
    const client = clients.get(socket);
    if (socket.readyState === WebSocket.OPEN && (!room || (client && client.room.toLowerCase() === room.toLowerCase()))) socket.send(data);
  }
}
function onlineCount(room) {
  return [...clients.values()].filter(c => c.joined && (!room || c.room.toLowerCase() === room.toLowerCase())).length;
}
function addToRecentHistory(message) {
  history.push(message);
  if (history.length > MAX_HISTORY) history.shift();
}
async function saveMessage(message) {
  if (pool) {
    await pool.query(
      "INSERT INTO chat_messages (id, type, name, text, time, room) VALUES ($1, $2, $3, $4, $5, $6)",
      [message.id || crypto.randomUUID(), message.type, message.name || null, message.text, message.time, message.room || "Harbor Lounge"]
    );
  }
  addToRecentHistory(message);
}

wss.on("connection", (socket, request) => {
  const rawRoom = new URL(request.url, "http://localhost").searchParams.get("room") || "Harbor Lounge";
  const room = rawRoom.trim().replace(/\s+/g, " ").slice(0, 40) || "Harbor Lounge";
  const client = { name: "Guest", joined: false, room };
  clients.set(socket, client);
  socket.send(JSON.stringify({ type: "welcome", history: history.filter(m => (m.room || "Harbor Lounge").toLowerCase() === room.toLowerCase()), online: onlineCount(room) }));

  socket.on("message", async (raw) => {
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
        const system = { type: "system", id: crypto.randomUUID(), text: name + " joined the chat", time: new Date().toISOString(), room: client.room };
        try {
          await saveMessage(system);
          broadcast(system, client.room);
        } catch (err) {
          console.error("Could not save join notice:", err.message);
          addToRecentHistory(system);
          broadcast(system, client.room);
        }
      }
      broadcast({ type: "presence", online: onlineCount(client.room) }, client.room);
      return;
    }

    if (data.type === "chat" && client.joined) {
      const text = typeof data.text === "string" ? data.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (!text) return;
      const message = {
        type: "chat",
        id: crypto.randomUUID(),
        name: client.name,
        text,
        time: new Date().toISOString(),
        room: client.room
      };
      try {
        await saveMessage(message);
        broadcast(message, client.room);
      } catch (err) {
        console.error("Could not persist chat message; message was not broadcast:", err.message);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "storage-error", text: "Your message could not be saved. Please try again." }));
        }
      }
    }
  });

  socket.on("close", async () => {
    const hadJoined = client.joined;
    clients.delete(socket);
    if (hadJoined) {
      const system = { type: "system", id: crypto.randomUUID(), text: client.name + " left the chat", time: new Date().toISOString(), room: client.room };
      try {
        await saveMessage(system);
      } catch (err) {
        console.error("Could not save leave notice:", err.message);
        addToRecentHistory(system);
      }
      broadcast(system, client.room);
    }
    broadcast({ type: "presence", online: onlineCount(client.room) }, client.room);
  });
});

async function start() {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT,
        text TEXT NOT NULL,
        time TIMESTAMPTZ NOT NULL,
        room TEXT NOT NULL DEFAULT 'Harbor Lounge'
      )
    `);
    await pool.query("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS room TEXT NOT NULL DEFAULT 'Harbor Lounge'");
    const result = await pool.query(
      "SELECT id, type, name, text, time, room FROM chat_messages ORDER BY time DESC LIMIT $1",
      [MAX_HISTORY]
    );
    for (const row of result.rows.reverse()) {
      history.push({
        type: row.type,
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        text: row.text,
        room: row.room || "Harbor Lounge",
        time: new Date(row.time).toISOString()
      });
    }
    console.log("Loaded " + history.length + " recent messages from PostgreSQL.");
  } else {
    console.warn("DATABASE_URL is not set; chat history will not survive restarts until PostgreSQL is connected.");
  }
  server.listen(port, "0.0.0.0", () => console.log("Harbor Chat listening on " + port));
}

start().catch(err => {
  console.error("Could not initialize chat storage:", err);
  process.exit(1);
});
