const $ = (q) => document.querySelector(q);
const state = {
  code: null,
  roomName: "",
  socket: null,
  me: { name: null, email: null, avatarUrl: "" },
  deferredPrompt: null
};

function lsGet(k){ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k,v){ localStorage.setItem(k, JSON.stringify(v)); }
function lsDel(k){ localStorage.removeItem(k); }

function setHeaderIdentity() {
  $("#who").textContent = state.me.name && state.me.email ? `${state.me.name} • ${state.me.email}` : "";
  $("#meAvatar").src = state.me.avatarUrl || "/icons/default-avatar.png";
  $("#avatarPreview").src = state.me.avatarUrl || "/icons/default-avatar.png";
}

function initIdentity() {
  const saved = lsGet("identity") || {};
  if (!saved.name || !saved.email) {
    $("#overlay").classList.remove("hidden");
    $("#saveIdentity").onclick = () => {
      const name = $("#nameInput").value.trim();
      const email = $("#emailInput").value.trim().toLowerCase();
      if (!name || !email) return alert("Please fill both fields.");
      state.me = { name, email, avatarUrl: "" };
      lsSet("identity", state.me);
      $("#overlay").classList.add("hidden");
      setHeaderIdentity();
      refreshRooms();
    };
  } else {
    state.me = { name: saved.name, email: saved.email, avatarUrl: saved.avatarUrl || "" };
    setHeaderIdentity();
    refreshRooms();
  }
}

/* Avatar menu logic */
const menu = $("#profileMenu");
$("#meBox").addEventListener("click", (e) => {
  const expanded = menu.classList.toggle("hidden");
  $("#meBox").setAttribute("aria-expanded", (!expanded).toString());
  positionMenu();
  e.stopPropagation();
});
function positionMenu() {
  // keep simple; CSS handles small screens
}
document.addEventListener("click", (e) => {
  if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== $("#meBox") && !$("#meBox").contains(e.target)) {
    menu.classList.add("hidden");
    $("#meBox").setAttribute("aria-expanded", "false");
  }
});

$("#menuView").addEventListener("click", () => {
  $("#avatarPreview").src = state.me.avatarUrl || "/icons/default-avatar.png";
  $("#avatarModal").classList.remove("hidden");
  menu.classList.add("hidden");
});
$("#closeAvatar").addEventListener("click", () => {
  $("#avatarModal").classList.add("hidden");
});

$("#menuUpload").addEventListener("click", () => {
  $("#avatarFile").click();
  menu.classList.add("hidden");
});
$("#avatarFile").addEventListener("change", async () => {
  const file = $("#avatarFile").files && $("#avatarFile").files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { alert("File too large (max 2 MB)"); return; }
  const fd = new FormData();
  fd.append("avatar", file);
  const res = await fetch("/api/upload-avatar", { method: "POST", body: fd });
  const j = await res.json().catch(()=>({ error: "Upload failed" }));
  if (!res.ok) return alert(j.error || "Upload failed");
  state.me.avatarUrl = j.url;
  lsSet("identity", state.me);
  setHeaderIdentity();
  if (state.socket && state.socket.connected && state.code) {
    state.socket.emit("join", { code: state.code, ...state.me });
  }
});

/* Logout */
$("#btnLogout").onclick = () => {
  if (state.socket) { try { state.socket.disconnect(); } catch(e){} }
  lsDel("identity");
  state.me = { name: null, email: null, avatarUrl: "" };
  state.code = null;
  state.roomName = "";
  $("#rooms").innerHTML = "";
  showEmpty();
  $("#overlay").classList.remove("hidden");
  setHeaderIdentity();
};

/* REST helpers */
async function refreshRooms() {
  const email = encodeURIComponent(state.me.email || "");
  if (!email) return;
  const res = await fetch(`/api/my-rooms?email=${email}`);
  const data = await res.json();
  const list = $("#rooms");
  list.innerHTML = "";
  if (!data.length) {
    list.innerHTML = `<div class="muted">No chats yet.</div>`;
    return;
  }
  for (const r of data) {
    const div = document.createElement("div");
    div.className = "card";
    const time = new Date(r.lastMessageAt).toLocaleString();
    const title = r.roomName ? `${r.roomName} (${r.code})` : r.code;
    div.innerHTML = `<strong>${title}</strong><div class="muted">Last: ${time}</div>`;
    div.style.cursor = "pointer";
    div.onclick = () => joinRoom(r.code, r.roomName || "");
    list.appendChild(div);
  }
}

/* UI wiring */
$("#btnExisting").onclick = refreshRooms;
$("#btnNew").onclick = () => {
  $("#newOptions").classList.remove("hidden");
  $("#joinPanel").classList.add("hidden");
  $("#createdPanel").classList.add("hidden");
};
$("#btnCreate").onclick = async () => {
  const roomName = ($("#roomNameInput").value || "").trim();
  const res = await fetch("/api/create-room", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ ...state.me, roomName })
  });
  const data = await res.json();
  const code = data.code;
  const rn = data.roomName || roomName || "";
  $("#createdPanel").classList.remove("hidden");
  $("#joinPanel").classList.add("hidden");
  $("#createdCode").textContent = code;
  await joinRoom(code, rn);
  refreshRooms();
};
$("#btnJoin").onclick = () => {
  $("#joinPanel").classList.remove("hidden");
  $("#createdPanel").classList.add("hidden");
  $("#joinCode").focus();
};
$("#confirmJoin").onclick = async () => {
  const code = ($("#joinCode").value || "").trim();
  if (code.length !== 8) return alert("Code must be 8 characters.");
  const res = await fetch("/api/join-room", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ code, ...state.me })
  });
  const j = await res.json().catch(()=>({error:"Join failed"}));
  if (!res.ok) return alert(j.error || "Join failed");
  await joinRoom(code, j.roomName || "");
  refreshRooms();
};

$("#sendForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#msg").value.trim();
  if (!state.code) return alert("Join or create a room first.");
  if (!text) return;
  state.socket.emit("message", { text });
  $("#msg").value = "";
});

/* Chat area visibility */
function showChat() {
  $("#chatArea").classList.remove("hidden");
  $("#emptyHint").classList.add("hidden");
}
function showEmpty() {
  $("#chatArea").classList.add("hidden");
  $("#emptyHint").classList.remove("hidden");
}

/* Socket */
function setRoomUI(code, roomName) {
  state.code = code;
  state.roomName = roomName || "";
  $("#roomCode").textContent = code || "(none)";
  $("#roomName").textContent = state.roomName || "(unnamed)";
  $("#messages").innerHTML = "";
  showChat();
}
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();

  state.socket.on("connect", () => {
    if (state.code) state.socket.emit("join", { code: state.code, ...state.me });
  });
  state.socket.on("history", (payload) => {
    const { roomName, messages } = payload || { roomName: "", messages: [] };
    if (roomName && !state.roomName) {
      state.roomName = roomName;
      $("#roomName").textContent = roomName;
    }
    $("#messages").innerHTML = "";
    for (const m of messages) addMessageRow(m);
  });
  state.socket.on("message", (m) => addMessageRow(m));
  state.socket.on("system", (txt) => toast(txt));
  state.socket.on("errorMsg", (msg) => alert(msg));
}

/* Render a message row (avatar + bubble) */
function addMessageRow(m) {
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
  bubble.innerHTML = `
    <div class="meta">${who} • ${when}</div>
    <div class="text">${escapeHtml(m.text || "")}</div>
  `;

  if (mine) {
    row.appendChild(bubble);
    row.appendChild(avatar);
  } else {
    row.appendChild(avatar);
    row.appendChild(bubble);
  }

  $("#messages").appendChild(row);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
function toast(t){ console.log(t); }

/* PWA install button */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredPrompt = e;
  $("#btnInstall").hidden = false;
});
$("#btnInstall").addEventListener('click', async () => {
  $("#btnInstall").hidden = true;
  if (!state.deferredPrompt) return;
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
});
window.addEventListener('appinstalled', () => toast('App installed!'));

/* Helper */
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

/* Start */
initIdentity();
connectSocket();
showEmpty();