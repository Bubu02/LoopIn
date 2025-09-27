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

// ===== In-memory store =====
const rooms = new Map(); // code -> {code,name,createdAt,messages[],participants:Set<string>}
const userRooms = new Map(); // email(lower) -> Set<code>

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const genCode = (n = 8) =>
  Array.from(crypto.randomFillSync(new Uint32Array(n)))
    .map(x => ALPHABET[x % ALPHABET.length]).join("");

const ensureRoom = (code, roomName = "") => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      name: (roomName || "").toString().slice(0, 80),
      createdAt: Date.now(),
      messages: [],
      participants: new Set()
    });
  }
  return rooms.get(code);
};

const attachUserToRoom = (email, code) => {
  const e = (email || "").toLowerCase().trim();
  if (!e) return;
  if (!userRooms.has(e)) userRooms.set(e, new Set());
  userRooms.get(e).add(code);
};

const detachUserFromRoom = (email, code) => {
  const e = (email || "").toLowerCase().trim();
  if (!e) return;
  if (userRooms.has(e)) {
    userRooms.get(e).delete(code);
    if (userRooms.get(e).size === 0) userRooms.delete(e);
  }
};

// Health check
app.get("/health", (_req, res) => res.status(200).send("OK"));

// List my rooms
app.get("/api/my-rooms", (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  const codes = [...(userRooms.get(email) || [])];
  const result = codes
    .map(c => rooms.get(c))
    .filter(Boolean)
    .map(r => ({
      code: r.code,
      roomName: r.name || "",
      createdAt: r.createdAt,
      lastMessageAt: r.messages.at(-1)?.ts ?? r.createdAt,
      participants: [...r.participants]
    }))
    .sort((a,b) => b.lastMessageAt - a.lastMessageAt);
  res.json(result);
});

// Create room
app.post("/api/create-room", (req, res) => {
  const { email, roomName } = req.body || {};
  const code = genCode(8);
  const room = ensureRoom(code, roomName);
  if (email) {
    room.participants.add(email.toLowerCase());
    attachUserToRoom(email.toLowerCase(), code);
  }
  res.json({ code, roomName: room.name || "" });
});

// Join room (multi-user allowed)
app.post("/api/join-room", (req, res) => {
  const { code, email } = req.body || {};
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  const room = rooms.get(code);
  if (email) {
    room.participants.add(email.toLowerCase());
    attachUserToRoom(email.toLowerCase(), code);
  }
  res.json({ ok: true, roomName: room.name || "" });
});

// Rename room
app.post("/api/rename-room", (req, res) => {
  const { code, roomName } = req.body || {};
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  const name = String(roomName || "").slice(0, 80);
  rooms.get(code).name = name;
  io.to(code).emit("roomRenamed", { roomName: name });
  res.json({ ok: true, roomName: name });
});

// Leave / delete from my list
// If the room becomes empty, it is removed entirely.
app.post("/api/leave-room", (req, res) => {
  const { code, email } = req.body || {};
  const e = (email || "").toLowerCase().trim();
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  if (!e) return res.status(400).json({ error: "Email required" });

  const room = rooms.get(code);
  room.participants.delete(e);
  detachUserFromRoom(e, code);

  // If no participants left, delete room permanently
  if (room.participants.size === 0) {
    rooms.delete(code);
    io.to(code).emit("roomDeleted", { code });
  }

  res.json({ ok: true });
});

// ===== Socket.IO =====
io.on("connection", (socket) => {
  socket.on("join", ({ code, name, email, avatarUrl }) => {
    if (!code || !rooms.has(code)) { socket.emit("errorMsg", "Room not found."); return; }
    socket.join(code);
    socket.data.user = { code, name, email: (email||"").toLowerCase(), avatarUrl: avatarUrl || "" };
    const room = rooms.get(code);
    socket.emit("history", { roomName: room.name || "", messages: room.messages, code });
    socket.to(code).emit("system", `${name || "Someone"} joined the chat.`);
  });

  socket.on("message", ({ text }) => {
    const u = socket.data.user;
    if (!u?.code) return;
    const msg = {
      name: u.name || "Anonymous",
      email: u.email || "",
      text: String(text || "").slice(0, 2000),
      ts: Date.now(),
      avatarUrl: u.avatarUrl || ""
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