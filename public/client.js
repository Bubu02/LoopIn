/* ========== tiny helpers ========== */
const $ = (q) => document.querySelector(q);
const warnMissing = [];
const on = (sel, evt, fn) => { const el = $(sel); if (!el) { warnMissing.push(sel); return; } el.addEventListener(evt, fn); return el; };
const must = (sel) => { const el = $(sel); if (!el) warnMissing.push(sel); return el; };

/* ========== avatars (PNG) ========== */
const AVATARS = Array.from({ length: 7 }, (_, i) => `/avatars/${i + 1}.png`);

/* ========== name colors (stable per-email) ========== */
const NAME_COLORS = ["#22d3ee","#f472b6","#a78bfa","#34d399","#f59e0b","#60a5fa","#f97316","#ef4444","#10b981","#eab308","#93c5fd","#fca5a5"];
const hash = (s="") => { let h = 2166136261; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h>>>0)*16777619; } return h>>>0; };
const colorFor = (emailOrName="") => NAME_COLORS[ hash(emailOrName.toLowerCase()) % NAME_COLORS.length ];

/* ========== state ========== */
const state = {
  code: null,
  roomName: "",
  socket: null,
  me: { name: null, email: null, avatarUrl: AVATARS[0] },
  deferredPrompt: null
};

/* ========== storage utils (robust) ========== */
const lsGetRaw = (k) => localStorage.getItem(k);
const lsGet = (k)=>{ try { const v = lsGetRaw(k); if (v == null) return null; return JSON.parse(v); } catch { return null; } };
const lsSet = (k,v)=> localStorage.setItem(k, JSON.stringify(v));
const lsDel = (k)=> localStorage.removeItem(k);

/* validate identity */
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||"").toLowerCase());
function normalizeIdentity(obj){
  if (!obj || typeof obj !== "object") return null;
  const name = String(obj.name||"").trim();
  const email = String(obj.email||"").trim().toLowerCase();
  if (!name || !isValidEmail(email)) return null;
  return { name, email, avatarUrl: obj.avatarUrl || AVATARS[0] };
}

/* ========== identity flow ========== */
function setHeaderIdentity() {
  const who = must("#whoName");
  const ava = must("#meAvatar");
  const mname = must("#menuName");
  const memail = must("#menuEmail");
  if (who) who.textContent = state.me.name || "";
  if (ava) ava.src = state.me.avatarUrl || AVATARS[0];
  if (mname) mname.textContent = state.me.name || "";
  if (memail) memail.textContent = state.me.email || "";
}
function showLogin() { must("#overlay")?.classList.remove("hidden"); }
function hideLogin() { must("#overlay")?.classList.add("hidden"); }

function loadIdentity() {
  const saved = normalizeIdentity(lsGet("identity"));
  if (saved) { state.me = saved; setHeaderIdentity(); refreshRooms(); }
  else { lsDel("identity"); showLogin(); }
}
on("#saveIdentity","click",()=>{
  const name = must("#nameInput")?.value?.trim();
  const email = must("#emailInput")?.value?.trim()?.toLowerCase();
  if (!name || !isValidEmail(email)) { alert("Please enter a valid name & email."); return; }
  state.me = { name, email, avatarUrl: AVATARS[0] };
  lsSet("identity", state.me);
  hideLogin();
  setHeaderIdentity();
  refreshRooms();
});
on("#resetApp","click",()=>{ try{ localStorage.clear(); }catch{} try{ state.socket?.disconnect(); }catch{} location.reload(); });
on("#menuLogout","click",()=>{ try{ state.socket?.disconnect(); }catch{} try{ localStorage.clear(); }catch{} state.code=null; state.roomName=""; location.reload(); });

window.addEventListener("storage",(e)=>{
  if (e.key === "identity") {
    const id = normalizeIdentity(lsGet("identity"));
    if (!id) { showLogin(); return; }
    state.me = id; setHeaderIdentity();
  }
});

/* ========== profile menu & avatar picker ========== */
const profileMenu = must("#profileMenu");
on("#meBox","pointerdown",(e)=>{ e.preventDefault(); profileMenu?.classList.toggle("hidden"); must("#chatMenu")?.classList.add("hidden"); });
document.addEventListener("pointerdown",(e)=>{ if (!profileMenu || profileMenu.classList.contains("hidden")) return;
  if (!profileMenu.contains(e.target) && !must("#meBox")?.contains(e.target)) profileMenu.classList.add("hidden"); });

function openAvatarPicker(){
  const grid = must("#avatarGrid"); if (!grid) return;
  grid.innerHTML = "";
  AVATARS.forEach((src, idx)=>{
    const btn = document.createElement("button");
    btn.className = "avatar-option";
    btn.innerHTML = `<img src="${src}" alt="avatar ${idx+1}">`;
    btn.onclick = ()=>{
      state.me.avatarUrl = src;
      lsSet("identity", state.me);
      setHeaderIdentity();
      must("#avatarPicker")?.classList.add("hidden");
      if (state.socket?.connected && state.code) state.socket.emit("join", { code: state.code, ...state.me });
    };
    grid.appendChild(btn);
  });
  must("#avatarPicker")?.classList.remove("hidden");
}
on("#menuChooseAvatar","click",()=>{ openAvatarPicker(); profileMenu?.classList.add("hidden"); });
on("#closePicker","click",()=> must("#avatarPicker")?.classList.add("hidden"));

/* ========== chats dropdown ========== */
const chatMenu = must("#chatMenu");
on("#btnChatMenu","pointerdown",(e)=>{ e.preventDefault(); chatMenu?.classList.toggle("hidden"); profileMenu?.classList.add("hidden"); });
document.addEventListener("pointerdown",(e)=>{ if (!chatMenu || chatMenu.classList.contains("hidden")) return;
  if (!chatMenu.contains(e.target) && e.target !== must("#btnChatMenu")) chatMenu.classList.add("hidden"); });

/* ========== REST: my rooms ========== */
async function refreshRooms(){
  const email = encodeURIComponent(state.me.email || ""); if (!email) return;
  const res = await fetch(`/api/my-rooms?email=${email}`).catch(()=>null);
  if (!res) return;
  const data = await res.json().catch(()=>[]);
  const list = must("#rooms"); if (!list) return; list.innerHTML="";
  if (!data.length){ list.innerHTML = `<div class="muted">No chats yet.</div>`; return; }

  for (const r of data){
    const row = document.createElement("div"); row.className = "room-item";
    const time = new Date(r.lastMessageAt).toLocaleString();
    row.innerHTML = `
      <div class="room-info">
        <strong>${escapeHtml(r.roomName || "(unnamed)")}</strong>
        <div class="muted small">Last: ${time}</div>
      </div>
      ${r.isOwner ? `
      <button class="iconbtn-trash" title="Delete">
        <svg viewBox="0 0 24 24" class="icon"><path d="M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H4V5h4l1-2z"/></svg>
      </button>` : ``}
    `;

    row.querySelector(".room-info").onclick = ()=>{ chatMenu?.classList.add("hidden"); joinRoom(r.code, r.roomName || ""); };
    const del = row.querySelector(".iconbtn-trash");
    if (del){
      del.onclick = async (ev)=>{ ev.stopPropagation();
        if (!confirm("Delete this room for everyone? (Only creator can)")) return;
        const res = await fetch("/api/delete-room",{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ code: r.code, email: state.me.email })});
        if (!res.ok){ const j=await res.json().catch(()=>({})); alert(j.error || "Delete failed"); return; }
        if (state.code === r.code){ state.code=null; state.roomName=""; showEmpty(); }
        refreshRooms();
      };
    }
    list.appendChild(row);
  }
}

/* ========== Start / Join ========== */
on("#btnExisting","click",refreshRooms);
on("#btnNew","click",()=>{ must("#newOptions")?.classList.remove("hidden"); must("#joinPanel")?.classList.add("hidden"); must("#createdPanel")?.classList.add("hidden"); });
on("#btnCreate","click",async ()=>{
  const roomName = must("#roomNameInput")?.value?.trim() || "";
  const res = await fetch("/api/create-room",{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ ...state.me, roomName })});
  const data = await res.json();
  const code = data.code; const rn = data.roomName || roomName || "";
  must("#createdPanel")?.classList.remove("hidden"); must("#joinPanel")?.classList.add("hidden");
  const codeBox = must("#createdCode"); if (codeBox) codeBox.textContent = code;
  chatMenu?.classList.add("hidden"); await joinRoom(code, rn); refreshRooms();
});
on("#btnJoin","click",()=>{ must("#joinPanel")?.classList.remove("hidden"); must("#createdPanel")?.classList.add("hidden"); must("#joinCode")?.focus(); });
on("#confirmJoin","click",async ()=>{
  const code = must("#joinCode")?.value?.trim();
  if (!code || code.length!==8){ alert("Code must be 8 characters."); return; }
  const res = await fetch("/api/join-room",{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ code, ...state.me })});
  const j = await res.json().catch(()=>({error:"Join failed"}));
  if (!res.ok){ alert(j.error||"Join failed"); return; }
  chatMenu?.classList.add("hidden"); await joinRoom(code, j.roomName || ""); refreshRooms();
});

/* ========== Chat area visibility ========== */
function showChat(){ must("#chatArea")?.classList.remove("hidden"); must("#emptyHint")?.classList.add("hidden"); }
function showEmpty(){ must("#chatArea")?.classList.add("hidden"); must("#emptyHint")?.classList.remove("hidden"); }

/* ========== Room rename ========== */
const roomNameText = must("#roomNameText");
const roomNameEdit = must("#roomNameEdit");
on("#editRoomBtn","click",()=>{ if(!roomNameText||!roomNameEdit) return; roomNameText.classList.add("hidden"); must("#editRoomBtn")?.classList.add("hidden"); roomNameEdit.classList.remove("hidden"); roomNameEdit.focus(); });
async function stopEditingRoom(save){
  if(!roomNameText||!roomNameEdit) return;
  roomNameText.classList.remove("hidden"); must("#editRoomBtn")?.classList.remove("hidden"); roomNameEdit.classList.add("hidden");
  if (save && state.code){
    const newName = roomNameEdit.value.trim();
    const res = await fetch("/api/rename-room",{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ code: state.code, roomName: newName })});
    if (res.ok){ const j = await res.json().catch(()=>({})); showRoomName(j.roomName || newName); }
    else { showRoomName(state.roomName); }
  } else { roomNameEdit.value = state.roomName; }
}
if (roomNameEdit){
  roomNameEdit.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); stopEditingRoom(true); } if(e.key==="Escape") stopEditingRoom(false); });
  roomNameEdit.addEventListener("blur",()=> stopEditingRoom(true));
}
function showRoomName(name){ state.roomName = name || "(unnamed)"; if (roomNameText) roomNameText.textContent = state.roomName; if (roomNameEdit) roomNameEdit.value = state.roomName; }

/* ========== Socket & messages (with ticks) ========== */
function setRoomUI(code, roomName){
  state.code = code;
  showRoomName(roomName||"");
  const rc = must("#roomCode"); if(rc) rc.textContent = code || "";
  const msgs = must("#messages"); if(msgs) msgs.innerHTML="";
  showChat();
}
function connectSocket(){
  if (state.socket) state.socket.disconnect();
  state.socket = io();

  state.socket.on("connect",()=>{ if (state.code) state.socket.emit("join",{ code: state.code, ...state.me }); });

  state.socket.on("history",(payload)=>{
    const { roomName, messages, code } = payload || { roomName:"", messages:[], code:"" };
    if (roomName) showRoomName(roomName);
    if (code){ const rc=must("#roomCode"); if(rc) rc.textContent = code; }
    const msgs = must("#messages"); if(!msgs) return;
    msgs.innerHTML="";
    for (const m of messages) addMessageRow(m,{initialLoad:true});
    scrollToBottom(true);
    // Mark others' messages as seen on load
    reportSeenFor(messages.filter(m => (m.email||"").toLowerCase() !== (state.me.email||"").toLowerCase()).map(m=>m.id));
  });

  state.socket.on("message",(m)=>{
    const stick = isNearBottom();
    addMessageRow(m);
    if(stick) scrollToBottom();
    // If the message is from someone else, mark it seen immediately
    if ((m.email||"").toLowerCase() !== (state.me.email||"").toLowerCase()) {
      reportSeenFor([m.id]);
    }
  });

  // Sender-side tick upgrade
  state.socket.on("messageSeen", ({ id }) => {
    const tick = document.querySelector(`[data-ticks-for="${CSS.escape(id)}"]`);
    if (tick) tick.classList.add("seen"), (tick.textContent = "✓✓");
  });

  state.socket.on("roomRenamed",({ roomName })=> showRoomName(roomName||""));
  state.socket.on("roomDeleted",({ code })=>{ if (state.code===code){ alert("Room was deleted by the creator."); state.code=null; showEmpty(); refreshRooms(); }});
  state.socket.on("system",(txt)=>console.log(txt));
  state.socket.on("errorMsg",(msg)=>alert(msg));
}

/* Report seen */
function reportSeenFor(ids){
  if (!ids?.length || !state.socket?.connected || !state.code) return;
  state.socket.emit("markSeen", { code: state.code, messageIds: ids });
}

/* copy room code */
on("#copyCode","click",async()=>{ if(!state.code) return; try{ await navigator.clipboard.writeText(state.code); alert("Room code copied"); }catch{ alert("Could not copy"); }});

/* Render messages (ticks element placed after text for bottom-right CSS) */
function addMessageRow(m,{initialLoad=false}={}){
  const msgs = must("#messages"); if(!msgs) return;
  const mine = (m.email||"").toLowerCase() === (state.me.email||"").toLowerCase();
  const row = document.createElement("div"); row.className = "msgrow" + (mine ? " right" : "");

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = (m.avatarUrl && m.avatarUrl.trim()) ? m.avatarUrl : AVATARS[0];
  avatar.alt = mine ? "me" : (m.name||"user");

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (mine ? " mine" : "");
  const who = mine ? "You" : (m.name || "Anonymous");
  const when = new Date(m.ts || Date.now()).toLocaleTimeString();
  const nameColor = colorFor(m.email || m.name || "");

  let ticks = "";
  if (mine) {
    const seen = (m.status === "seen");
    ticks = `<span class="ticks ${seen ? "seen" : ""}" data-ticks-for="${m.id}">${seen ? "✓✓" : "✓"}</span>`;
  }

  bubble.innerHTML = `
    <div class="meta"><span class="who" style="color:${nameColor}">${escapeHtml(who)}</span> • ${when}</div>
    <div class="text">${escapeHtml(m.text || "")}</div>
    ${ticks}
  `;

  if (mine){ row.appendChild(bubble); row.appendChild(avatar); } else { row.appendChild(avatar); row.appendChild(bubble); }
  msgs.appendChild(row);

  if (!initialLoad && isNearBottom()) scrollToBottom();
}

function isNearBottom(){ const el = must("#messages"); if(!el) return true; return el.scrollTop + el.clientHeight >= el.scrollHeight - 80; }
function scrollToBottom(immediate=false){ const el = must("#messages"); if(!el) return; if(immediate) el.scrollTop = el.scrollHeight; else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }

/* send */
on("#sendForm","submit",(e)=>{ e.preventDefault(); const input = must("#msg"); const text = input?.value?.trim();
  if (!state.code){ alert("Join or create a room first (use Chats ▾)."); return; }
  if (!text) return; state.socket.emit("message",{ text }); if (input) input.value=""; scrollToBottom(); });

/* join helper */
async function joinRoom(code, roomName=""){
  setRoomUI(code, roomName);
  if(!state.socket) connectSocket();
  if (state.socket.connected){ state.socket.emit("join",{ code, ...state.me }); }
  else { const onConnect = ()=>{ state.socket.off("connect", onConnect); state.socket.emit("join",{ code, ...state.me }); }; state.socket.on("connect", onConnect); }
}

/* start */
loadIdentity();
connectSocket();
showEmpty();

/* util */
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => (
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;"  :
    c === ">" ? "&gt;"  :
    c === '"' ? "&quot;":
    "&#039;"
  ));
}
if (warnMissing.length) console.warn("Missing elements in index.html for client.js:", [...new Set(warnMissing)]);