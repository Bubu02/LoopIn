const $ = (q) => document.querySelector(q);
const state = {
  code: null,
  socket: null,
  me: { name: null, email: null },
  deferredPrompt: null
};

/* ===== Identity ===== */
function lsGet(k){ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k,v){ localStorage.setItem(k, JSON.stringify(v)); }

function initIdentity() {
  const saved = lsGet("identity") || {};
  if (!saved.name || !saved.email) {
    $("#overlay").classList.remove("hidden");
    $("#saveIdentity").onclick = () => {
      const name = $("#nameInput").value.trim();
      const email = $("#emailInput").value.trim().toLowerCase();
      if (!name || !email) return alert("Please fill both fields.");
      lsSet("identity", { name, email });
      state.me = { name, email };
      $("#overlay").classList.add("hidden");
      $("#who").textContent = `${name} • ${email}`;
      refreshRooms();
    };
  } else {
    state.me = saved;
    $("#who").textContent = `${saved.name} • ${saved.email}`;
    refreshRooms();
  }
}

/* ===== REST helpers ===== */
async function refreshRooms() {
  const email = encodeURIComponent(state.me.email || "");
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
    div.innerHTML = `<strong>${r.code}</strong><div class="muted">Last: ${time}</div>`;
    div.style.cursor = "pointer";
    div.onclick = () => joinRoom(r.code);
    list.appendChild(div);
  }
}

/* ===== UI wiring ===== */
$("#btnExisting").onclick = refreshRooms;
$("#btnNew").onclick = () => {
  $("#newOptions").classList.remove("hidden");
  $("#joinPanel").classList.add("hidden");
  $("#createdPanel").classList.add("hidden");
};
$("#btnCreate").onclick = async () => {
  const res = await fetch("/api/create-room", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(state.me)
  });
  const data = await res.json();
  const code = data.code;
  $("#createdPanel").classList.remove("hidden");
  $("#joinPanel").classList.add("hidden");
  $("#createdCode").textContent = code;
  await joinRoom(code);
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
  if (!res.ok) {
    const j = await res.json().catch(()=>({error:"Join failed"}));
    return alert(j.error || "Join failed");
  }
  await joinRoom(code);
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

/* ===== Socket ===== */
function setRoomUI(code) {
  state.code = code;
  $("#roomCode").textContent = code || "(none)";
  $("#roomHint").textContent = code ? "You can start chatting." : "Pick an option on the left.";
  $("#messages").innerHTML = "";
}
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();

  state.socket.on("connect", () => {
    if (state.code) state.socket.emit("join", { code: state.code, ...state.me });
  });
  state.socket.on("history", (messages) => {
    $("#messages").innerHTML = "";
    for (const m of messages) addMessageBubble(m);
  });
  state.socket.on("message", (m) => addMessageBubble(m));
  state.socket.on("system", (txt) => toast(txt));
  state.socket.on("errorMsg", (msg) => alert(msg));
}
function addMessageBubble(m) {
  const mine = (m.email || "").toLowerCase() === (state.me.email || "").toLowerCase();
  const div = document.createElement("div");
  div.className = "bubble";
  const who = mine ? "You" : `${m.name}`;
  const when = new Date(m.ts).toLocaleTimeString();
  div.innerHTML = `<div class="meta">${who} • ${when}</div><div class="text">${escapeHtml(m.text)}</div>`;
  $("#messages").appendChild(div);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
function toast(t){ console.log(t); }

/* ===== PWA “Install App” button ===== */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();            // keep event for later
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
window.addEventListener('appinstalled', () => {
  toast('App installed!');
});

/* ===== Helpers ===== */
async function joinRoom(code) {
  setRoomUI(code);
  if (!state.socket) connectSocket();
  if (state.socket.connected) {
    state.socket.emit("join", { code, ...state.me });
  } else {
    // wait for connect event to re-emit join
    const onConnect = () => {
      state.socket.off("connect", onConnect);
      state.socket.emit("join", { code, ...state.me });
    };
    state.socket.on("connect", onConnect);
  }
}

/* ===== Start ===== */
initIdentity();
connectSocket();