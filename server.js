import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import multer from "multer";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Ensure uploads dir exists (served from /public/uploads)
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer storage for avatars
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || "") || ".png").toLowerCase();
    const name = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPG/WebP allowed"));
  }
});

// Health check
app.get("/health", (_req, res) => res.status(200).send("OK"));

// ===== In-memory store =====
const rooms = new Map(); // code -> {code,name,createdAt,messages[],participants:Set}
const userRooms = new Map(); // email -> Set<code>

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
  if (!userRooms.has(email)) userRooms.set(email, new Set());
  userRooms.get(email).add(code);
};

// Upload avatar
app.post("/api/upload-avatar", upload.single("avatar"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const urlPath = `/uploads/${req.file.filename}`; // publicly served
    res.json({ url: urlPath });
  } catch (e) {
    res.status(400).json({ error: e.message || "Upload failed" });
  }
});

// List my rooms (name only)
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

// Create / Join
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