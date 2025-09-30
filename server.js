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

/* ================= In-memory store ================= */
const rooms = new Map();
/*
  rooms.set(code, {
    code,
    name,
    owner,
    createdAt,
    messages: [
      { id, name, email, text, ts, avatarUrl, status: "sent" | "seen", seenBy: Set<emailLower> }
    ],
    participants: Set<emailLower>
  });
*/
const userRooms = new Map(); // emailLower -> Set<code>

/* --- typing timers: code -> email -> Timeout --- */
const typingTimers = new Map();
const TYPING_TIMEOUT_MS = 5000;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const genCode = (n = 8) =>
  Array.from(crypto.randomFillSync(new Uint32Array(n)))
    .map(x => ALPHABET[x % ALPHABET.length]).join("");

const ensureRoom = (code, { roomName = "", owner } = {}) => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      name: String(roomName || "").slice(0, 80),
      owner: (owner || "").toLowerCase(),
      createdAt: Date.now(),
      messages: [],
      participants: new Set(owner ? [owner.toLowerCase()] : [])
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

/* ================= REST ================= */

app.get("/health", (_req, res) => res.status(200).send("OK"));

/* List my rooms */
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
      isOwner: r.owner === email
    }))
    .sort((a,b) => b.lastMessageAt - a.lastMessageAt);
  res.json(result);
});

/* Create room (owner = creator) */
app.post("/api/create-room", (req, res) => {
  const { email, roomName } = req.body || {};
  const owner = (email || "").toLowerCase();
  const code = genCode(8);
  const room = ensureRoom(code, { roomName, owner });
  if (owner) attachUserToRoom(owner, code);
  res.json({ code, roomName: room.name || "" });
});

/* Join room (multi-user) */
app.post("/api/join-room", (req, res) => {
  const { code, email } = req.body || {};
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  const room = rooms.get(code);
  const e = (email || "").toLowerCase();
  if (e) {
    room.participants.add(e);
    attachUserToRoom(e, code);
  }
  res.json({ ok: true, roomName: room.name || "" });
});

/* Rename (owner only) */
app.post("/api/rename-room", (req, res) => {
  const { code, roomName } = req.body || {};
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  const name = String(roomName || "").slice(0, 80);
  rooms.get(code).name = name;
  io.to(code).emit("roomRenamed", { roomName: name });
  res.json({ ok: true, roomName: name });
});

/* Leave room (remove from *my* list only) */
app.post("/api/leave-room", (req, res) => {
  const { code, email } = req.body || {};
  const e = (email || "").toLowerCase().trim();
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  if (!e) return res.status(400).json({ error: "Email required" });

  const room = rooms.get(code);
  room.participants.delete(e);
  detachUserFromRoom(e, code);

  if (room.participants.size === 0) {
    rooms.delete(code);
    io.to(code).emit("roomDeleted", { code });
  }
  res.json({ ok: true });
});

/* Delete room (owner only) */
app.post("/api/delete-room", (req, res) => {
  const { code, email } = req.body || {};
  const e = (email || "").toLowerCase().trim();
  if (!code || !rooms.has(code)) return res.status(404).json({ error: "Room not found" });
  const room = rooms.get(code);
  if (room.owner !== e) return res.status(403).json({ error: "Only the creator can delete this room." });

  rooms.delete(code);
  for (const [ue, set] of userRooms.entries()) {
    set.delete(code);
    if (set.size === 0) userRooms.delete(ue);
  }
  io.to(code).emit("roomDeleted", { code });
  res.json({ ok: true });
});

/* ================= Socket.IO ================= */
io.on("connection", (socket) => {
  socket.on("join", ({ code, name, email, avatarUrl }) => {
    if (!code || !rooms.has(code)) { socket.emit("errorMsg", "Room not found."); return; }
    socket.join(code);
    socket.data.user = {
      code,
      name,
      email: (email || "").toLowerCase(),
      avatarUrl: avatarUrl || ""
    };
    const room = rooms.get(code);

    // compute "unseen for you"
    const viewer = socket.data.user.email;
    const unseenForYou = room.messages.filter(m => m.email !== viewer && !m.seenBy?.has(viewer)).length;

    socket.emit("history", { roomName: room.name || "", messages: room.messages, code, unseenForYou });
  });

  /* New message -> status 'sent', seenBy = empty set for now */
  socket.on("message", ({ text }) => {
    const u = socket.data.user;
    if (!u?.code) return;
    const msg = {
      id: crypto.randomUUID(),
      name: u.name || "Anonymous",
      email: u.email || "",
      text: String(text || "").slice(0, 2000),
      ts: Date.now(),
      avatarUrl: u.avatarUrl || "",
      status: "sent",
      seenBy: new Set() // track per-user views (excluding sender)
    };
    const room = rooms.get(u.code);
    if (!room) return;
    room.messages.push(msg);
    room.participants.add(u.email);
    attachUserToRoom(u.email, u.code);

    io.to(u.code).emit("message", { ...msg, seenBy: undefined });

    // sender clearly stopped typing
    clearTyping(u.code, u.email);
  });

  /* Mark one or more messages as seen by this viewer */
  socket.on("markSeen", ({ code, messageIds }) => {
    const viewer = (socket.data.user?.email || "").toLowerCase();
    if (!code || !rooms.has(code) || !Array.isArray(messageIds) || !viewer) return;
    const room = rooms.get(code);

    for (const id of messageIds) {
      const m = room.messages.find(x => x.id === id);
      if (!m) continue;
      if (!m.seenBy) m.seenBy = new Set();
      if (m.email !== viewer && !m.seenBy.has(viewer)) {
        m.seenBy.add(viewer);

        if (m.status !== "seen" && m.seenBy.size >= 1) {
          m.status = "seen";
          io.to(code).emit("messageSeen", { id: m.id });
        }
      }
    }
  });

  /* ===== Typing indicator ===== */
  socket.on("typing", () => {
    const u = socket.data.user;
    if (!u?.code) return;
    socket.to(u.code).emit("peerTyping", { email: u.email, name: u.name || "Someone" });
    ensureTypingTimer(u.code, u.email);
  });

  socket.on("stopTyping", () => {
    const u = socket.data.user;
    if (!u?.code) return;
    clearTyping(u.code, u.email);
  });

  socket.on("disconnect", () => {
    const u = socket.data.user;
    if (u?.code && u?.email) clearTyping(u.code, u.email);
  });
});

/* --- helpers for typing timers --- */
function ensureTypingTimer(code, email) {
  if (!typingTimers.has(code)) typingTimers.set(code, new Map());
  const perRoom = typingTimers.get(code);
  if (perRoom.has(email)) clearTimeout(perRoom.get(email));
  perRoom.set(email, setTimeout(() => clearTyping(code, email), TYPING_TIMEOUT_MS));
}

function clearTyping(code, email) {
  const perRoom = typingTimers.get(code);
  if (!perRoom) return;
  const tid = perRoom.get(email);
  if (tid) clearTimeout(tid);
  perRoom.delete(email);
  io.to(code).emit("peerStopTyping", { email });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
