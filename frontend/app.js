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
  clearBtn:    document.getElementById("clearBtn"),
  chatPanel:   document.getElementById("chatPanel"),
  chatRestore: document.getElementById("chatRestore"),
  status:      document.getElementById("status"),
  compassWrap: document.querySelector(".compass-wrap"),
  notice:      document.getElementById("notice"),
};

// ===========================================================================
// STATUS + COMPASS STATE
// ===========================================================================
// The status line was removed from the UI; keep this null-safe so the voice/mic
// code that still calls it does nothing instead of erroring.
function setStatus(text) { if (els.status) els.status.textContent = text; }

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
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Lightweight, SAFE Markdown -> HTML for the chat (HTML is escaped first). Turns
// **style.css** into bold instead of showing literal asterisks, handles `code`,
// bullets, headings, and links — so the chat reads clean.
function renderMarkdown(text) {
  let t = escapeHtml(text);
  t = t.replace(/```([\s\S]*?)```/g, (m, c) => "<pre><code>" + c.replace(/^\n+|\n+$/g, "") + "</code></pre>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/^\s{0,3}#{1,6}\s*(.+)$/gm, "<strong>$1</strong>");
  t = t.replace(/^\s*[-*+]\s+/gm, "• ");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\n/g, "<br>");
  return t;
}

function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  // Apollo's messages get a name label; the user's show just their message.
  if (role === "assistant") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = "Apollo";
    wrap.appendChild(who);
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  if (role === "assistant") body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

function showThinking() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant thinking";
  wrap.innerHTML = '<span class="who">Apollo</span><span class="dots">processing</span>';
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

// ===========================================================================
// CHAT — talking to the backend
// ===========================================================================
// Wipe the conversation (UI + the server's stored history). Used by the /clear
// command and the clear button. Facts/workflows and the brain are NOT affected.
function clearChat() {
  fetch("/api/clear", { method: "POST" }).catch((e) => console.error(e));
  els.messages.innerHTML = "";
  els.input.focus();
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text) return;

  // Typed command to clear the chat.
  if (text.toLowerCase() === "/clear" || text.toLowerCase() === "/clear chat") {
    els.input.value = "";
    clearChat();
    return;
  }

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
  if (!voices.length) return;

  // Apollo's voice: a clean, professional BRITISH MAN — natural and smooth, but
  // still subtly synthetic. We prefer Microsoft's NATURAL/neural British male
  // voices (e.g. "Microsoft Ryan - Natural", available in Edge) because they're
  // far less robotic than Chrome's "Google UK English Male". Fallbacks always
  // prefer a British accent, then any MALE voice over a female one.
  const find = (re) => voices.find((v) => re.test(v.name));
  const isGB = (v) =>
    /en[-_]?GB/i.test(v.lang) || /United Kingdom|British|UK English/i.test(v.name);
  const isNatural = (v) => /natural|neural|online/i.test(v.name);
  const soundsMale = (v) =>
    /\b(male|man)\b|George|Ryan|Oliver|Thomas|Daniel|David|Mark|Brian|Guy/i.test(v.name);

  preferredVoice =
    voices.find((v) => isGB(v) && soundsMale(v) && isNatural(v)) ||  // natural British male (Ryan) — least robotic
    find(/Microsoft (Ryan|Thomas|Oliver|George)/i) ||               // UK males by name (Edge)
    voices.find((v) => isGB(v) && soundsMale(v)) ||                  // any British male
    find(/Google UK English Male/i) ||                              // Chrome's (more robotic) fallback
    voices.find(isGB) ||                                             // any British voice
    voices.find((v) => /^en/i.test(v.lang) && soundsMale(v) && isNatural(v)) || // any natural English male
    voices.find((v) => /^en/i.test(v.lang) && soundsMale(v)) ||      // any English MALE before female
    voices.find((v) => /^en/i.test(v.lang)) ||                       // any English voice
    voices[0] || null;
}
if (ttsSupported) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// Returns true if it actually spoke, false if muted/unsupported.
// Turn Apollo's reply (which contains Markdown) into clean, natural speech — so it
// never reads out "asterisk", "hash", bullet symbols, URLs, or emoji.
function speakable(text) {
  let t = String(text);
  t = t.replace(/```[\s\S]*?```/g, " ");            // drop fenced code blocks
  t = t.replace(/`([^`]+)`/g, "$1");                // inline `code` -> keep text
  t = t.replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1");   // [label](url) -> label
  t = t.replace(/https?:\/\/\S+/g, " ");            // drop bare URLs
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "");          // headings
  t = t.replace(/^\s{0,3}>\s?/gm, "");              // blockquotes
  t = t.replace(/^\s*[-*+]\s+/gm, "");              // bullet markers
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");          // **bold**
  t = t.replace(/\*([^*]+)\*/g, "$1");              // *italic*
  t = t.replace(/__([^_]+)__/g, "$1");              // __bold__
  t = t.replace(/_([^_]+)_/g, "$1");                // _italic_
  t = t.replace(/[*_`#>~|]/g, "");                  // any stray markdown symbols
  // strip emoji, arrows, dingbats and other non-spoken pictographs
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, "");
  return t.replace(/\s+/g, " ").trim();
}

function speak(text) {
  if (isMuted || !ttsSupported) return false;
  const clean = speakable(text);
  if (!clean) return false;
  try {
    speechSynthesis.cancel(); // stop anything already speaking
    const u = new SpeechSynthesisUtterance(clean);
    if (preferredVoice) u.voice = preferredVoice;
    // Tuned for a composed, professional delivery. Adjust to taste:
    //   rate  — higher is faster (1.0 is default speed)
    //   pitch — lower is a deeper man's voice with more gravitas
    // Natural voices sound best near pitch 1.0; a slightly brisk rate keeps it
    // professional and not sluggish.
    u.rate = 1.15;
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
  if (!els.status || els.status.textContent === "Listening…") setStatus("Ready");
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

function startStarfield() {
  const canvas = document.getElementById("starfield");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  // Pre-rendered glow sprites, stamped many times (cheap). Stars are a warm gold
  // so they're actually visible on the light cream background; comet heads stay white.
  function makeGlow(r, g, b) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const gx = c.getContext("2d");
    const grd = gx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grd.addColorStop(0.32, `rgba(${r},${g},${b},0.55)`);
    grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    gx.fillStyle = grd;
    gx.fillRect(0, 0, 64, 64);
    return c;
  }
  const glowStar = makeGlow(255, 255, 255);  // clean white starlight (pops on the black sky)
  const glowWhite = makeGlow(255, 255, 255); // comet head

  // ---- Stars: tiny white dots that fade in, drift slowly, fade out (~15s) ----
  const STAR_LIFE = 15000;
  function starTarget() { return Math.min(170, Math.round((W * H) / 15000)); }
  const stars = [];
  function spawnStar(staggered) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 5; // px/sec — very slow
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 1.3 + Math.random() * 2,     // tiny, but visible
      life: STAR_LIFE * (0.75 + Math.random() * 0.6),
      age: staggered ? Math.random() * STAR_LIFE : 0,
      maxA: 0.7 + Math.random() * 0.3,
    });
  }
  for (let i = 0; i < starTarget(); i++) spawnStar(true);

  // ---- Comets: occasional, faster, white head + fading rainbow trail ----
  const comets = [];
  let nextComet = 5000 + Math.random() * 9000;
  function spawnComet() {
    const angle = Math.PI / 2 + (Math.random() - 0.5) * 1.4; // mostly downward, varied
    const speed = 230 + Math.random() * 170;                 // px/sec — faster, not too fast
    comets.push({
      x: Math.random() * W,
      y: -30,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      hist: [],
      hue: Math.random() * 360,
      size: 2.5 + Math.random() * 2,
    });
  }

  // ---- Constellations: faint patterns that blend in with the stars ----
  const CON_TEMPLATES = [
    { // Cassiopeia (W)
      pts: [[0, 0.2], [0.25, 0.62], [0.5, 0.2], [0.75, 0.66], [1, 0.24]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
    },
    { // Cygnus (Northern Cross / swan)
      pts: [[0.5, 0.0], [0.5, 0.45], [0.5, 1.0], [0.12, 0.40], [0.88, 0.42]],
      edges: [[0, 1], [1, 2], [3, 1], [1, 4]],
    },
    { // Scorpius (the curved scorpion)
      pts: [[0.1, 0.08], [0.28, 0.06], [0.45, 0.16], [0.5, 0.34], [0.5, 0.52], [0.45, 0.68], [0.58, 0.8], [0.76, 0.82], [0.9, 0.7]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]],
    },
    { // Leo (sickle + hindquarters triangle)
      pts: [[0.18, 0.62], [0.16, 0.44], [0.22, 0.28], [0.33, 0.18], [0.30, 0.04], [0.55, 0.5], [0.86, 0.42], [0.7, 0.72]],
      edges: [[4, 3], [3, 2], [2, 1], [1, 0], [0, 5], [5, 6], [6, 7], [7, 5]],
    },
    { // Pegasus (Great Square + extension)
      pts: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [1.0, 0.08]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 0], [1, 4]],
    },
    { // Auriga (pentagon)
      pts: [[0.5, 0.0], [0.95, 0.35], [0.78, 0.9], [0.22, 0.9], [0.05, 0.35]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]],
    },
    { // Big Dipper
      pts: [[0, 0.35], [0, 0.62], [0.30, 0.66], [0.33, 0.40], [0.56, 0.30], [0.80, 0.18], [1.0, 0.08]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]],
    },
    { // Lyra (Vega + parallelogram)
      pts: [[0.22, 0.08], [0.12, 0.42], [0.55, 0.5], [0.6, 0.9], [0.18, 0.82]],
      edges: [[0, 1], [0, 2], [1, 2], [2, 3], [3, 4], [4, 1]],
    },
    { // Orion — the hunter, with belt + a faint sketch of the warrior
      mul: 1.3,
      pts: [
        [0.46, 0.05], // 0 head (Meissa)
        [0.30, 0.18], // 1 Betelgeuse (left shoulder)
        [0.62, 0.15], // 2 Bellatrix (right shoulder)
        [0.40, 0.50], // 3 belt left (Alnitak)
        [0.46, 0.52], // 4 belt mid (Alnilam)
        [0.52, 0.54], // 5 belt right (Mintaka)
        [0.34, 0.86], // 6 Saiph (left foot)
        [0.66, 0.88], // 7 Rigel (right foot)
      ],
      edges: [[0, 1], [0, 2], [1, 3], [2, 5], [3, 4], [4, 5], [3, 6], [5, 7]],
      // Detailed warrior line-art (SVG paths in the same 0..1 space as the
      // stars, so it wraps Orion's anatomy). t: "main" = outline, "detail" = interior.
      figure: [
        // — Crested Corinthian helmet —
        { t: "main", d: "M 0.435 -0.018 C 0.42 -0.075 0.50 -0.10 0.575 -0.062 C 0.55 -0.045 0.52 -0.03 0.50 -0.012" },
        { t: "main", d: "M 0.392 0.078 C 0.378 -0.005 0.405 -0.04 0.46 -0.04 C 0.515 -0.04 0.542 -0.005 0.528 0.078" },
        { t: "main", d: "M 0.40 0.072 C 0.398 0.108 0.425 0.138 0.46 0.138 C 0.495 0.138 0.522 0.108 0.52 0.072" },
        { t: "main", d: "M 0.388 0.075 L 0.532 0.075" },
        { t: "main", d: "M 0.46 0.075 L 0.46 0.13" },
        // — Shoulders + muscled cuirass torso —
        { t: "main", d: "M 0.298 0.178 C 0.355 0.15 0.41 0.158 0.46 0.162 C 0.51 0.158 0.565 0.15 0.622 0.178" },
        { t: "main", d: "M 0.622 0.178 C 0.61 0.27 0.575 0.36 0.55 0.42 C 0.535 0.46 0.525 0.49 0.518 0.515" },
        { t: "main", d: "M 0.298 0.178 C 0.315 0.27 0.35 0.36 0.375 0.42 C 0.39 0.46 0.40 0.49 0.407 0.515" },
        // — Belt (sits on Orion's three belt stars) —
        { t: "main", d: "M 0.382 0.498 L 0.535 0.528" },
        { t: "main", d: "M 0.378 0.52 L 0.532 0.55" },
        // — Right arm raised with a sword —
        { t: "main", d: "M 0.612 0.182 C 0.66 0.135 0.71 0.092 0.755 0.035" },
        { t: "main", d: "M 0.752 0.04 L 0.84 -0.14" },
        { t: "main", d: "M 0.715 0.012 L 0.80 0.058" },
        // — Left arm + round hoplite shield —
        { t: "main", d: "M 0.298 0.178 C 0.255 0.225 0.225 0.27 0.215 0.31" },
        { t: "main", d: "M 0.05 0.36 A 0.15 0.15 0 1 0 0.35 0.36 A 0.15 0.15 0 1 0 0.05 0.36 Z" },
        // — Legs (muscled, splayed to Rigel & Saiph) —
        { t: "main", d: "M 0.535 0.55 C 0.575 0.63 0.59 0.685 0.588 0.712 C 0.595 0.785 0.63 0.84 0.665 0.876" },
        { t: "main", d: "M 0.482 0.552 C 0.50 0.62 0.522 0.678 0.547 0.712 C 0.558 0.782 0.59 0.832 0.622 0.862" },
        { t: "main", d: "M 0.402 0.552 C 0.362 0.625 0.345 0.682 0.346 0.705 C 0.336 0.775 0.33 0.828 0.336 0.862" },
        { t: "main", d: "M 0.452 0.552 C 0.432 0.622 0.412 0.678 0.40 0.705 C 0.386 0.772 0.362 0.82 0.357 0.856" },
        { t: "main", d: "M 0.31 0.872 L 0.372 0.872" },
        { t: "main", d: "M 0.632 0.882 L 0.692 0.882" },
        // — Detail: helmet crest comb, eye slits, neckline —
        { t: "detail", d: "M 0.46 -0.07 L 0.475 -0.018 M 0.50 -0.078 L 0.505 -0.022 M 0.532 -0.062 L 0.523 -0.018" },
        { t: "detail", d: "M 0.418 0.088 L 0.443 0.086 M 0.477 0.086 L 0.502 0.088" },
        { t: "detail", d: "M 0.40 0.165 C 0.43 0.195 0.49 0.195 0.52 0.165" },
        // — Detail: cuirass sternum + pectorals + abs —
        { t: "detail", d: "M 0.46 0.165 L 0.46 0.40" },
        { t: "detail", d: "M 0.405 0.225 C 0.43 0.258 0.49 0.258 0.515 0.225" },
        { t: "detail", d: "M 0.418 0.31 C 0.44 0.328 0.48 0.328 0.505 0.31" },
        { t: "detail", d: "M 0.422 0.36 C 0.44 0.375 0.48 0.375 0.50 0.36" },
        { t: "detail", d: "M 0.425 0.41 C 0.44 0.422 0.478 0.422 0.495 0.41" },
        // — Detail: shield rings, boss + Spartan lambda —
        { t: "detail", d: "M 0.08 0.36 A 0.12 0.12 0 1 0 0.32 0.36 A 0.12 0.12 0 1 0 0.08 0.36 Z" },
        { t: "detail", d: "M 0.11 0.36 A 0.09 0.09 0 1 0 0.29 0.36 A 0.09 0.09 0 1 0 0.11 0.36 Z" },
        { t: "detail", d: "M 0.17 0.36 A 0.03 0.03 0 1 0 0.23 0.36 A 0.03 0.03 0 1 0 0.17 0.36 Z" },
        { t: "detail", d: "M 0.13 0.435 L 0.20 0.295 L 0.27 0.435" },
        // — Detail: war skirt (pteruges) —
        { t: "detail", d: "M 0.392 0.525 L 0.388 0.61 L 0.41 0.61 L 0.414 0.525 M 0.422 0.53 L 0.42 0.618 L 0.442 0.618 L 0.444 0.53 M 0.452 0.532 L 0.452 0.622 L 0.474 0.622 L 0.474 0.532 M 0.482 0.532 L 0.484 0.618 L 0.506 0.618 L 0.504 0.532 M 0.512 0.528 L 0.516 0.61 L 0.536 0.608 L 0.532 0.528" },
        // — Detail: greaves / knees + cape —
        { t: "detail", d: "M 0.552 0.715 C 0.57 0.72 0.585 0.72 0.59 0.713 M 0.346 0.708 C 0.362 0.714 0.388 0.714 0.40 0.706" },
        { t: "detail", d: "M 0.578 0.78 L 0.628 0.85 M 0.344 0.78 L 0.352 0.85" },
        { t: "detail", d: "M 0.625 0.185 C 0.73 0.33 0.71 0.59 0.60 0.745" },
      ],
    },
  ];
  let constellations = [];
  function buildConstellations() {
    const regions = [
      { x: [0.36, 0.52], y: [0.02, 0.11] },   // top-center
      { x: [0.64, 0.78], y: [0.04, 0.16] },   // top-right
      { x: [0.70, 0.83], y: [0.27, 0.40] },   // right-upper
      { x: [0.66, 0.80], y: [0.50, 0.62] },   // right-lower
      { x: [0.52, 0.70], y: [0.68, 0.80] },   // bottom-right
      { x: [0.32, 0.48], y: [0.70, 0.82] },   // bottom-center
      { x: [0.05, 0.22], y: [0.62, 0.76] },   // bottom-left
      { x: [0.02, 0.14], y: [0.46, 0.60] },   // left-lower
      { x: [0.70, 0.78], y: [0.30, 0.40] },   // Orion (right — the feature, with the warrior)
    ];
    constellations = [];
    for (let k = 0; k < CON_TEMPLATES.length; k++) {
      const tpl = CON_TEMPLATES[k];
      const reg = regions[k % regions.length];
      const scale = (165 + Math.random() * 85) * (tpl.mul || 1);
      const ox = (reg.x[0] + Math.random() * (reg.x[1] - reg.x[0])) * W;
      const oy = (reg.y[0] + Math.random() * (reg.y[1] - reg.y[0])) * H;
      const pts = tpl.pts.map((p) => ({
        x: ox + p[0] * scale, y: oy + p[1] * scale, ph: Math.random() * Math.PI * 2,
      }));
      // Parse the warrior's SVG line-art once per template (it's in normalized
      // 0..1 space, so it's placement-independent and reusable).
      if (tpl.figure && !tpl._fig) {
        tpl._fig = tpl.figure.map((f) => ({ path: new Path2D(f.d), t: f.t }));
      }
      constellations.push({ pts, edges: tpl.edges, figure: tpl._fig || null, ox, oy, scale });
    }
  }
  buildConstellations();
  window.addEventListener("resize", buildConstellations);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(60, now - last);
    last = now;
    const dts = dt / 1000;
    ctx.clearRect(0, 0, W, H);

    ctx.globalCompositeOperation = "lighter";

    // constellations — faint lines + gently twinkling anchor stars
    for (const con of constellations) {
      ctx.globalAlpha = 1;
      // detailed figure line-art (Orion the warrior) drawn behind the stars,
      // via a scaled transform so the bezier curves stay smooth
      if (con.figure) {
        ctx.save();
        ctx.translate(con.ox, con.oy);
        ctx.scale(con.scale, con.scale);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const fp of con.figure) {
          if (fp.t === "main") {
            ctx.strokeStyle = "rgba(212, 222, 248, 0.24)";
            ctx.lineWidth = 1.5 / con.scale;
          } else {
            ctx.strokeStyle = "rgba(190, 205, 236, 0.13)";
            ctx.lineWidth = 1.0 / con.scale;
          }
          ctx.stroke(fp.path);
        }
        ctx.restore();
      }
      ctx.strokeStyle = "rgba(185, 200, 235, 0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [i, j] of con.edges) {
        ctx.moveTo(con.pts[i].x, con.pts[i].y);
        ctx.lineTo(con.pts[j].x, con.pts[j].y);
      }
      ctx.stroke();
      for (const p of con.pts) {
        const tw = 0.65 + 0.35 * Math.sin(now / 950 + p.ph);
        ctx.globalAlpha = tw;
        ctx.drawImage(glowStar, p.x - 6, p.y - 6, 12, 12);
        ctx.globalAlpha = Math.min(1, tw + 0.2);
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // stars — additive white glow on the black sky
    while (stars.length < starTarget()) spawnStar(false);
    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.age += dt;
      if (s.age >= s.life) { stars.splice(i, 1); continue; }
      s.x += s.vx * dts; s.y += s.vy * dts;
      if (s.x < -12) s.x = W + 12; else if (s.x > W + 12) s.x = -12;
      if (s.y < -12) s.y = H + 12; else if (s.y > H + 12) s.y = -12;
      const t = s.age / s.life;
      const fade = t < 0.18 ? t / 0.18 : (t > 0.82 ? (1 - t) / 0.18 : 1);
      const a = fade * s.maxA;
      // white-centred, gold-ringed glow (the ring provides the contrast)
      ctx.globalAlpha = a;
      const d = s.size * 5.5;
      ctx.drawImage(glowStar, s.x - d / 2, s.y - d / 2, d, d);
      // crisp bright core point
      ctx.globalAlpha = Math.min(1, a + 0.15);
      ctx.fillStyle = "rgb(255, 252, 242)";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // comets — additive glow
    ctx.globalCompositeOperation = "lighter";
    nextComet -= dt;
    if (nextComet <= 0) { spawnComet(); nextComet = 7000 + Math.random() * 13000; }
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      c.x += c.vx * dts; c.y += c.vy * dts;
      const onScreen = c.x > -60 && c.x < W + 60 && c.y > -60 && c.y < H + 60;
      if (onScreen) {
        c.hist.push({ x: c.x, y: c.y });
        if (c.hist.length > 30) c.hist.shift();
      } else if (c.hist.length) {
        c.hist.shift(); // trail shrinks out behind it; never fills the screen
      }
      if (!c.hist.length) { comets.splice(i, 1); continue; }

      const n = c.hist.length;
      for (let j = 1; j < n; j++) {
        const p0 = c.hist[j - 1], p1 = c.hist[j];
        const frac = j / n; // 0 at tail, 1 at head
        ctx.strokeStyle = `hsla(${(c.hue + j * 14) % 360}, 100%, 62%, ${frac * frac * 0.85})`;
        ctx.lineWidth = frac * c.size * 2.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      if (onScreen) {
        ctx.globalAlpha = 1;
        const hd = c.size * 9;
        ctx.drawImage(glowWhite, c.x - hd / 2, c.y - hd / 2, hd, hd);
        ctx.fillStyle = "rgba(255,255,255,0.95)"; // bright core (structure)
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.size * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ===========================================================================
// WIRE UP EVENTS + START
// ===========================================================================
els.sendBtn.addEventListener("click", sendMessage);
els.input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });
els.muteBtn.addEventListener("click", toggleMute);
els.micBtn.addEventListener("click", toggleMic);
els.collapseBtn.addEventListener("click", collapseChat);
if (els.clearBtn) els.clearBtn.addEventListener("click", clearChat);
els.chatRestore.addEventListener("click", restoreChat);

renderMuteButton();
buildCompassDecoration();
startStarfield();
loadHistory();
els.input.focus();
