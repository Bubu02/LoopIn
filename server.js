import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check for Render
app.get("/health", (req, res) => res.status(200).send("OK"));

// ===== In-memory store =====
const rooms = new Map();
const userRooms = new Map();

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const genCode = (n = 8) =>
  Array.from(crypto.randomFillSync(new Uint32Array(n)))
    .map(x => ALPHABET[x % ALPHABET.length]).join("");

const ensureRoom = (code) => {
  if (!rooms.has(code)) {
    rooms.set(code, { code, createdAt: Date.now(), messages: [], participants: new Set() });
  }
  return rooms.get(code);
};
const attachUserToRoom = (email, code) => {
  if (!userRooms.has(email)) userRooms.set(email, new Set());
  userRooms.get(email).add(code);
};

// ===== REST API =====
app.get("/api/my-rooms", (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  const codes = [...(userRooms.get(email) || [])];
  const result = codes
    .map(c => rooms.get(c))
    .filter(Boolean)
    .map(r => ({
      code: r.code,
      createdAt: r.createdAt,
      lastMessageAt: r.messages.at(-1)?.ts ?? r.createdAt,
      participants: [...r.participants]
    }))
    .sort((a,b) => b.lastMessageAt - a.lastMessageAt);
  res.json(result);
});

app.post("/api/create-room", (req, res) => {
  const { name, email } = req.body || {};
  const code = genCode(8);
  const room = ensureRoom(code);
  if (email) {
    room.participants.add(email.toLowerCase());
    attachUserToRoom(email.toLowerCase(), code);
  }
  res.json({ code });
});

app.post("/api/join-room", (req, res) => {
  const { code, name, email } = req.body || {};
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  const room = rooms.get(code);
  if (email) {
    room.participants.add(email.toLowerCase());
    attachUserToRoom(email.toLowerCase(), code);
  }
  res.json({ ok: true });
});

// ===== Socket.IO =====
io.on("connection", (socket) => {
  socket.on("join", ({ code, name, email }) => {
    if (!code || !rooms.has(code)) { socket.emit("errorMsg", "Room not found."); return; }
    socket.join(code);
    socket.data.user = { code, name, email: (email||"").toLowerCase() };
    socket.emit("history", rooms.get(code).messages);
    socket.to(code).emit("system", `${name || "Someone"} joined the chat.`);
  });

  socket.on("message", ({ text }) => {
    const u = socket.data.user;
    if (!u?.code) return;
    const msg = {
      name: u.name || "Anonymous",
      email: u.email || "",
      text: String(text || "").slice(0, 2000),
      ts: Date.now()
    };
    const room = rooms.get(u.code);
    if (!room) return;
    room.messages.push(msg);
    room.participants.add(u.email);
    attachUserToRoom(u.email, u.code);
    io.to(u.code).emit("message", msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));