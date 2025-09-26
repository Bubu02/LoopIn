// ---------- tiny helpers ----------
const $  = (q) => document.querySelector(q);
const warnMissing = [];
const bind = (sel, evt, handler) => {
  const el = $(sel);
  if (!el) { warnMissing.push(sel); return; }
  el.addEventListener(evt, handler);
  return el;
};
const must = (sel) => {
  const el = $(sel);
  if (!el) warnMissing.push(sel);
  return el;
};

// ---------- app state ----------
const state = {
  code: null,
  roomName: "",
  socket: null,
  me: { name: null, email: null, avatarUrl: "" },
  deferredPrompt: null
};

// ---------- localStorage ----------
const lsGet = (k)=>{ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k,v)=> localStorage.setItem(k, JSON.stringify(v));
const lsDel = (k)=> localStorage.removeItem(k);

// ---------- identity ----------
function setHeaderIdentity() {
  const whoName      = must("#whoName");
  const meAvatar     = must("#meAvatar");
  const avatarPrev   = must("#avatarPreview");
  const menuName     = must("#menuName");
  const menuEmail    = must("#menuEmail");

  if (whoName)  whoName.textContent  = state.me.name || "";
  if (meAvatar) meAvatar.src         = state.me.avatarUrl || "/icons/default-avatar.png";
  if (avatarPrev) avatarPrev.src     = state.me.avatarUrl || "/icons/default-avatar.png";
  if (menuName) menuName.textContent = state.me.name || "";
  if (menuEmail) menuEmail.textContent = state.me.email || "";
}

function initIdentity() {
  const saved = lsGet("identity") || {};
  if (!saved.name || !saved.email) {
    must("#overlay")?.classList.remove("hidden");
    bind("#saveIdentity", "click", () => {
      const name  = must("#nameInput")?.value?.trim();
      const email = must("#emailInput")?.value?.trim()?.toLowerCase();
      if (!name || !email) { alert("Please fill both fields."); return; }
      state.me = { name, email, avatarUrl: "" };
      lsSet("identity", state.me);
      must("#overlay")?.classList.add("hidden");
      setHeaderIdentity();
      refreshRooms();
    });
  } else {
    state.me = { name: saved.name, email: saved.email, avatarUrl: saved.avatarUrl || "" };
    setHeaderIdentity();
    refreshRooms();
  }
}

// ---------- profile menu ----------
const profileMenu = must("#profileMenu");
bind("#meBox", "pointerdown", (e) => {
  e.preventDefault();
  profileMenu?.classList.toggle("hidden");
  must("#chatMenu")?.classList.add("hidden");
});

document.addEventListener("pointerdown", (e) => {
  if (!profileMenu || profileMenu.classList.contains("hidden")) return;
  if (!profileMenu.contains(e.target) && !must("#meBox")?.contains(e.target)) {
    profileMenu.classList.add("hidden");
  }
});

bind("#menuView", "click", () => {
  const prev = must("#avatarPreview");
  if (prev) prev.src = state.me.avatarUrl || "/icons/default-avatar.png";
  must("#avatarModal")?.classList.remove("hidden");
  profileMenu?.classList.add("hidden");
});
bind("#closeAvatar", "click", () => must("#avatarModal")?.classList.add("hidden"));

bind("#menuUpload", "click", () => {
  must("#avatarFile")?.click();
  profileMenu?.classList.add("hidden");
});
bind("#avatarFile", "change", async () => {
  const input = must("#avatarFile");
  const file = input?.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { alert("File too large (max 2 MB)"); return; }
  const fd = new FormData();
  fd.append("avatar", file);
  const res = await fetch("/api/upload-avatar", { method: "POST", body: fd });
  const j = await res.json().catch(()=>({ error: "Upload failed" }));
  if (!res.ok) { alert(j.error || "Upload failed"); return; }
  state.me.avatarUrl = j.url;
  lsSet("identity", state.me);
  setHeaderIdentity();
  if (state.socket && state.socket.connected && state.code) {
    state.socket.emit("join", { code: state.code, ...state.me });
  }
});

bind("#menuLogout", "click", () => {
  try { state.socket?.disconnect(); } catch {}
  lsDel("identity");
  state.me = { name: null, email: null, avatarUrl: "" };
  state.code = null; state.roomName = "";
  const rooms = must("#rooms"); if (rooms) rooms.innerHTML = "";
  showEmpty();
  must("#overlay")?.classList.remove("hidden");
  setHeaderIdentity();
  profileMenu?.classList.add("hidden");
});

// ---------- chats dropdown ----------
const chatMenu = must("#chatMenu");
bind("#btnChatMenu", "pointerdown", (e) => {
  e.preventDefault();
  chatMenu?.classList.toggle("hidden");
  profileMenu?.classList.add("hidden");
});
document.addEventListener("pointerdown", (e) => {
  if (!chatMenu || chatMenu.classList.contains("hidden")) return;
  if (!chatMenu.contains(e.target) && e.target !== must("#btnChatMenu")) {
    chatMenu.classList.add("hidden");
  }
});

// ---------- REST: my rooms ----------
async function refreshRooms() {
  const email = encodeURIComponent(state.me.email || "");
  if (!email) return;
  const res = await fetch(`/api/my-rooms?email=${email}`);
  const data = await res.json();
  const list = must("#rooms");
  if (!list) return;
  list.innerHTML = "";
  if (!data.length) { list.innerHTML = `<div class="muted">No chats yet.</div>`; return; }
  for (const r of data) {
    const div = document.createElement("div");
    div.className = "card";
    const time = new Date(r.lastMessageAt).toLocaleString();
    const title = r.roomName || "(unnamed)";
    div.innerHTML = `<strong>${escapeHtml(title)}</strong><div class="muted">Last: ${time}</div>`;
    div.style.cursor = "pointer";
    div.onclick = () => { chatMenu?.classList.add("hidden"); joinRoom(r.code, r.roomName || ""); };
    list.appendChild(div);
  }
}

// ---------- create/join ----------
bind("#btnExisting", "click", refreshRooms);
bind("#btnNew", "click", () => {
  must("#newOptions")?.classList.remove("hidden");
  must("#joinPanel")?.classList.add("hidden");
  must("#createdPanel")?.classList.add("hidden");
});
bind("#btnCreate", "click", async () => {
  const roomName = must("#roomNameInput")?.value?.trim() || "";
  const res = await fetch("/api/create-room", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ ...state.me, roomName })
  });
  const data = await res.json();
  const code = data.code;
  const rn = data.roomName || roomName || "";
  must("#createdPanel")?.classList.remove("hidden");
  must("#joinPanel")?.classList.add("hidden");
  const codeBox = must("#createdCode"); if (codeBox) codeBox.textContent = code;
  chatMenu?.classList.add("hidden");
  await joinRoom(code, rn);
  refreshRooms();
});
bind("#btnJoin", "click", () => {
  must("#joinPanel")?.classList.remove("hidden");
  must("#createdPanel")?.classList.add("hidden");
  must("#joinCode")?.focus();
});
bind("#confirmJoin", "click", async () => {
  const codeEl = must("#joinCode");
  const code = codeEl?.value?.trim();
  if (!code || code.length !== 8) { alert("Code must be 8 characters."); return; }
  const res = await fetch("/api/join-room", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ code, ...state.me })
  });
  const j = await res.json().catch(()=>({error:"Join failed"}));
  if (!res.ok) { alert(j.error || "Join failed"); return; }
  chatMenu?.classList.add("hidden");
  await joinRoom(code, j.roomName || "");
  refreshRooms();
});

// ---------- chat area visibility ----------
function showChat() { must("#chatArea")?.classList.remove("hidden"); must("#emptyHint")?.classList.add("hidden"); }
function showEmpty() { must("#chatArea")?.classList.add("hidden"); must("#emptyHint")?.classList.remove("hidden"); }

// ---------- room name: text + pen edit ----------
const roomNameText = must("#roomNameText");
const roomNameEdit = must("#roomNameEdit");
const editRoomBtn  = must("#editRoomBtn");

function showRoomName(name) {
  state.roomName = name || "(unnamed)";
  if (roomNameText) roomNameText.textContent = state.roomName;
  if (roomNameEdit) roomNameEdit.value = state.roomName;
}

function startEditingRoom() {
  if (!roomNameText || !roomNameEdit || !editRoomBtn) return;
  roomNameText.classList.add("hidden");
  editRoomBtn.classList.add("hidden");
  roomNameEdit.classList.remove("hidden");
  roomNameEdit.focus();
}
async function stopEditingRoom(save) {
  if (!roomNameText || !roomNameEdit || !editRoomBtn) return;
  roomNameText.classList.remove("hidden");
  editRoomBtn.classList.remove("hidden");
  roomNameEdit.classList.add("hidden");
  if (save && state.code) {
    const newName = roomNameEdit.value.trim();
    const res = await fetch("/api/rename-room", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ code: state.code, roomName: newName })
    });
    if (res.ok) {
      const j = await res.json().catch(()=>({}));
      showRoomName(j.roomName || newName);
    } else {
      showRoomName(state.roomName); // revert
    }
  } else {
    roomNameEdit.value = state.roomName;
  }
}
bind("#editRoomBtn", "click", startEditingRoom);
if (roomNameEdit) {
  roomNameEdit.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); stopEditingRoom(true); }
    if (e.key === "Escape") stopEditingRoom(false);
  });
  roomNameEdit.addEventListener("blur", () => stopEditingRoom(true));
}

// ---------- socket & UI ----------
function setRoomUI(code, roomName) {
  state.code = code;
  showRoomName(roomName || "");
  const rc = must("#roomCode"); if (rc) rc.textContent = code ? code : "";
  const msgs = must("#messages"); if (msgs) msgs.innerHTML = "";
  showChat();
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();

  state.socket.on("connect", () => {
    if (state.code) state.socket.emit("join", { code: state.code, ...state.me });
  });

  state.socket.on("history", (payload) => {
    const { roomName, messages, code } = payload || { roomName: "", messages: [], code: "" };
    if (roomName) showRoomName(roomName);
    if (code) { const rc = must("#roomCode"); if (rc) rc.textContent = code; }
    const msgs = must("#messages"); if (!msgs) return;
    msgs.innerHTML = "";
    for (const m of messages) addMessageRow(m, { initialLoad: true });
    scrollToBottom(true);
  });

  state.socket.on("message", (m) => {
    const stick = isNearBottom();
    addMessageRow(m);
    if (stick) scrollToBottom();
  });

  state.socket.on("roomRenamed", ({ roomName }) => showRoomName(roomName || ""));

  state.socket.on("system", (txt) => console.log(txt));
  state.socket.on("errorMsg", (msg) => alert(msg));
}

// copy room code
bind("#copyCode", "click", async () => {
  if (!state.code) return;
  try { await navigator.clipboard.writeText(state.code); alert("Room code copied"); }
  catch { alert("Could not copy"); }
});

// render + scrolling
function addMessageRow(m, { initialLoad=false } = {}) {
  const msgs = must("#messages"); if (!msgs) return;

  const mine = (m.email || "").toLowerCase() === (state.me.email || "").toLowerCase();
  const row = document.createElement("div");
  row.className = "msgrow" + (mine ? " right" : "");

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = (m.avatarUrl && m.avatarUrl.trim()) ? m.avatarUrl : "/icons/default-avatar.png";
  avatar.alt = mine ? "me" : (m.name || "user");

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (mine ? " mine" : "");
  const who = mine ? "You" : (m.name || "Anonymous");
  const when = new Date(m.ts || Date.now()).toLocaleTimeString();
  bubble.innerHTML = `<div class="meta">${escapeHtml(who)} • ${when}</div><div class="text">${escapeHtml(m.text || "")}</div>`;

  if (mine) { row.appendChild(bubble); row.appendChild(avatar); } else { row.appendChild(avatar); row.appendChild(bubble); }
  msgs.appendChild(row);

  if (!initialLoad && isNearBottom()) scrollToBottom();
}
function isNearBottom() {
  const el = must("#messages"); if (!el) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
}
function scrollToBottom(immediate=false) {
  const el = must("#messages"); if (!el) return;
  if (immediate) el.scrollTop = el.scrollHeight;
  else el.scrollTo({ top: el.scrollHeight });
}

// send
bind("#sendForm", "submit", (e) => {
  e.preventDefault();
  const input = must("#msg");
  const text = input?.value?.trim();
  if (!state.code) { alert("Join or create a room first (use Chats ▾)."); return; }
  if (!text) return;
  state.socket.emit("message", { text });
  if (input) input.value = "";
  scrollToBottom();
});

// join helper
async function joinRoom(code, roomName = "") {
  setRoomUI(code, roomName);
  if (!state.socket) connectSocket();
  if (state.socket.connected) {
    state.socket.emit("join", { code, ...state.me });
  } else {
    const onConnect = () => {
      state.socket.off("connect", onConnect);
      state.socket.emit("join", { code, ...state.me });
    };
    state.socket.on("connect", onConnect);
  }
}

// start
initIdentity();
connectSocket();
showEmpty();

// util
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c])); }

// Surface missing elements (if any) once:
if (warnMissing.length) {
  console.warn("Missing elements in index.html for client.js bindings:", [...new Set(warnMissing)]);
}