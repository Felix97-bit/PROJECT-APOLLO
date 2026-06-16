/* ===========================================================================
   Apollo — frontend logic
   - chat send/receive + history
   - text-to-speech (voice ON by default) driving the compass glow
   - mute toggle (persisted)
   - microphone voice-to-text
   - chat collapse/restore
   - builds the compass's decorative rings + background stars
   =========================================================================== */

const SVG_NS = "http://www.w3.org/2000/svg";

// ---- Grab the elements we need --------------------------------------------
const els = {
  messages:    document.getElementById("messages"),
  input:       document.getElementById("input"),
  sendBtn:     document.getElementById("sendBtn"),
  micBtn:      document.getElementById("micBtn"),
  muteBtn:     document.getElementById("muteBtn"),
  collapseBtn: document.getElementById("collapseBtn"),
  chatPanel:   document.getElementById("chatPanel"),
  chatRestore: document.getElementById("chatRestore"),
  status:      document.getElementById("status"),
  compassWrap: document.querySelector(".compass-wrap"),
  notice:      document.getElementById("notice"),
};

// ===========================================================================
// STATUS + COMPASS STATE
// ===========================================================================
function setStatus(text) { els.status.textContent = text; }

function startSpeakingGlow() {
  els.compassWrap.classList.remove("pulse-once", "listening");
  els.compassWrap.classList.add("speaking");
  setStatus("Speaking…");
}
function stopSpeakingGlow() {
  els.compassWrap.classList.remove("speaking");
  setStatus("Ready");
}
// One gentle glow pulse (used when Apollo replies while muted)
function pulseOnce() {
  els.compassWrap.classList.remove("pulse-once");
  void els.compassWrap.offsetWidth;           // restart the CSS animation
  els.compassWrap.classList.add("pulse-once");
}

// ===========================================================================
// CHAT — rendering messages
// ===========================================================================
function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "assistant" ? "Apollo" : "You";
  const body = document.createElement("span");
  body.textContent = text;
  wrap.appendChild(who);
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

function showThinking() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant thinking";
  wrap.innerHTML = '<span class="who">Apollo</span><span class="dots">thinking</span>';
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

// ===========================================================================
// CHAT — talking to the backend
// ===========================================================================
async function sendMessage() {
  const text = els.input.value.trim();
  if (!text) return;

  addMessage("user", text);
  els.input.value = "";
  els.input.disabled = true;
  els.sendBtn.disabled = true;
  const thinking = showThinking();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    thinking.remove();
    const reply = data.reply || "(no reply)";
    addMessage("assistant", reply);
    deliverReply(reply);
  } catch (err) {
    thinking.remove();
    addMessage("assistant", "I couldn't reach my own server — is Apollo still running?");
    console.error(err);
  } finally {
    els.input.disabled = false;
    els.sendBtn.disabled = false;
    els.input.focus();
  }
}

// Decide how Apollo "delivers" a reply: speak it (if not muted) or pulse.
function deliverReply(text) {
  const spoke = speak(text);
  if (!spoke) {
    // Muted (or speech unavailable): give a brief visual pulse instead.
    pulseOnce();
    setStatus("Ready");
  }
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    (data.messages || []).forEach((m) => addMessage(m.role, m.content));
  } catch (err) {
    console.error("Could not load history:", err);
  }
}

// ===========================================================================
// VOICE OUT — text to speech (ON by default)
// ===========================================================================
let isMuted = localStorage.getItem("apollo_muted") === "true";
const ttsSupported = "speechSynthesis" in window;
let preferredVoice = null;

function pickVoice() {
  if (!ttsSupported) return;
  const voices = speechSynthesis.getVoices();
  // Prefer a natural-sounding English voice if the system has one.
  preferredVoice =
    voices.find((v) => /en[-_]?(US|GB)/i.test(v.lang) && /natural|google|zira|aria|jenny/i.test(v.name)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0] || null;
}
if (ttsSupported) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// Returns true if it actually spoke, false if muted/unsupported.
function speak(text) {
  if (isMuted || !ttsSupported) return false;
  try {
    speechSynthesis.cancel(); // stop anything already speaking
    const u = new SpeechSynthesisUtterance(text);
    if (preferredVoice) u.voice = preferredVoice;
    u.rate = 1.0;
    u.pitch = 1.0;
    // The glow is tied to the ACTUAL speech events, not a timer:
    u.onstart = startSpeakingGlow;
    u.onend = stopSpeakingGlow;
    u.onerror = stopSpeakingGlow;
    speechSynthesis.speak(u);
    return true;
  } catch (err) {
    console.error("TTS error:", err);
    return false;
  }
}

// ---- Mute toggle ----------------------------------------------------------
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor"/><path d="M16 9a3 3 0 0 1 0 6M18.5 7a6 6 0 0 1 0 10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';

function renderMuteButton() {
  els.muteBtn.innerHTML = isMuted ? ICON_MUTED : ICON_SPEAKER;
  els.muteBtn.classList.toggle("muted", isMuted);
  els.muteBtn.title = isMuted ? "Unmute Apollo's voice" : "Mute Apollo's voice";
}
function toggleMute() {
  isMuted = !isMuted;
  localStorage.setItem("apollo_muted", String(isMuted));
  if (isMuted && ttsSupported) speechSynthesis.cancel();
  renderMuteButton();
}

// ===========================================================================
// VOICE IN — microphone, speech to text (fills the input box, never auto-sends)
// ===========================================================================
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

function showNotice(msg) {
  els.notice.textContent = msg;
  els.notice.hidden = false;
}
function hideNotice() { els.notice.hidden = true; }

function setupRecognition() {
  if (!SpeechRec) return null;
  const rec = new SpeechRec();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;

  rec.onstart = () => {
    isListening = true;
    els.micBtn.classList.add("active");
    els.compassWrap.classList.add("listening");
    setStatus("Listening…");
    hideNotice();
  };
  rec.onresult = (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    // Put the words in the input box for the user to review/edit & send.
    els.input.value = transcript;
  };
  rec.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showNotice("I couldn't access the microphone. Allow mic permission in your browser and try again.");
    } else if (event.error === "no-speech") {
      showNotice("I didn't hear anything — tap the mic and try again.");
    }
    stopListening();
  };
  rec.onend = () => stopListening();
  return rec;
}

function stopListening() {
  isListening = false;
  els.micBtn.classList.remove("active");
  els.compassWrap.classList.remove("listening");
  if (els.status.textContent === "Listening…") setStatus("Ready");
}

function toggleMic() {
  if (!SpeechRec) {
    showNotice("Voice input needs Chrome or Edge. You're set there — but it isn't available in this browser.");
    return;
  }
  if (!recognition) recognition = setupRecognition();
  if (isListening) {
    recognition.stop();
  } else {
    els.input.focus();
    try { recognition.start(); } catch (e) { /* already starting */ }
  }
}

// ===========================================================================
// CHAT COLLAPSE / RESTORE
// ===========================================================================
function collapseChat() {
  els.chatPanel.classList.add("collapsed");
  els.chatRestore.hidden = false;
}
function restoreChat() {
  els.chatPanel.classList.remove("collapsed");
  els.chatRestore.hidden = true;
  els.input.focus();
}

// ===========================================================================
// DECORATION — build the compass's beads, ticks, filigree + background stars
// ===========================================================================
function circle(cx, cy, r, attrs = {}) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
  for (const k in attrs) c.setAttribute(k, attrs[k]);
  return c;
}
function line(x1, y1, x2, y2, attrs = {}) {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", x1); l.setAttribute("y1", y1);
  l.setAttribute("x2", x2); l.setAttribute("y2", y2);
  for (const k in attrs) l.setAttribute(k, attrs[k]);
  return l;
}

function buildCompassDecoration() {
  const cx = 200, cy = 200;
  const beadRing = document.getElementById("beadRing");
  const tickRing = document.getElementById("tickRing");
  const filigree = document.getElementById("filigree");
  if (!beadRing || !tickRing || !filigree) return;

  // Ring of evenly-spaced beads just inside the outer ring
  const beadCount = 60, beadR = 176;
  for (let i = 0; i < beadCount; i++) {
    const a = (i / beadCount) * Math.PI * 2;
    beadRing.appendChild(circle(cx + beadR * Math.sin(a), cy - beadR * Math.cos(a), 2,
      { fill: "#9C7A1E", opacity: "0.7" }));
  }

  // Tick marks — every 9th is a longer "major" tick
  const tickCount = 72;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * Math.PI * 2;
    const major = i % 9 === 0;
    const rOuter = 164;
    const rInner = major ? 151 : 157;
    tickRing.appendChild(line(
      cx + rOuter * Math.sin(a), cy - rOuter * Math.cos(a),
      cx + rInner * Math.sin(a), cy - rInner * Math.cos(a),
      { stroke: "#B8902E", "stroke-width": major ? "1.6" : "0.8", opacity: "0.75" }));
  }

  // Filigree mandala backing — restrained & elegant (group opacity set in CSS)
  filigree.appendChild(circle(cx, cy, 130, { fill: "none", stroke: "#D4AF37", "stroke-width": "0.8" }));
  filigree.appendChild(circle(cx, cy, 95,  { fill: "none", stroke: "#D4AF37", "stroke-width": "0.8" }));
  // small diamonds around r=112
  const diamondCount = 16, dr = 112, dsize = 5;
  for (let i = 0; i < diamondCount; i++) {
    const a = (i / diamondCount) * Math.PI * 2;
    const x = cx + dr * Math.sin(a), y = cy - dr * Math.cos(a);
    const d = document.createElementNS(SVG_NS, "polygon");
    d.setAttribute("points",
      `${x},${y - dsize} ${x + dsize},${y} ${x},${y + dsize} ${x - dsize},${y}`);
    d.setAttribute("fill", "#D4AF37");
    filigree.appendChild(d);
  }
  // fine inner engraving ticks
  const innerTicks = 48;
  for (let i = 0; i < innerTicks; i++) {
    const a = (i / innerTicks) * Math.PI * 2;
    filigree.appendChild(line(
      cx + 88 * Math.sin(a), cy - 88 * Math.cos(a),
      cx + 95 * Math.sin(a), cy - 95 * Math.cos(a),
      { stroke: "#B8902E", "stroke-width": "0.6" }));
  }
}

function buildStars() {
  const stars = document.getElementById("stars");
  if (!stars) return;
  const count = 26;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "star";
    const size = 1 + Math.random() * 2.5;
    s.style.width = `${size}px`;
    s.style.height = `${size}px`;
    // Bias toward the edges so the luminous center stays clean
    let x = Math.random(), y = Math.random();
    if (x > 0.3 && x < 0.7) x = x < 0.5 ? x - 0.28 : x + 0.28;
    if (y > 0.3 && y < 0.7) y = y < 0.5 ? y - 0.24 : y + 0.24;
    s.style.left = `${x * 100}%`;
    s.style.top = `${y * 100}%`;
    s.style.opacity = `${0.08 + Math.random() * 0.16}`;
    stars.appendChild(s);
  }
}

// ===========================================================================
// WIRE UP EVENTS + START
// ===========================================================================
els.sendBtn.addEventListener("click", sendMessage);
els.input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });
els.muteBtn.addEventListener("click", toggleMute);
els.micBtn.addEventListener("click", toggleMic);
els.collapseBtn.addEventListener("click", collapseChat);
els.chatRestore.addEventListener("click", restoreChat);

renderMuteButton();
buildCompassDecoration();
buildStars();
loadHistory();
els.input.focus();
