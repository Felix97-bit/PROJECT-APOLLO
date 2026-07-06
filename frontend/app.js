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
    { // Orion — the hunter, with belt + a detailed sketch of the warrior
      mul: 1.45,
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
      // stars, so it wraps Orion's anatomy). Tiers: "main" outline, "detail"
      // interior, "faint" soft striations. Rendered via a scaled transform.
      // Hoplite warrior in a wide fighting stance, gripping a long spear
      // diagonally in both hands. Original line-art in the 0..1 star space:
      // belt lands on Orion's belt stars, feet on Rigel & Saiph. Tiers:
      // "main" outline, "detail" interior, "faint" soft striations.
      figure: [
        // ===== CRESTED CORINTHIAN HELMET (tilted) + face =====
        { t: "main", d: "M 0.44 0.10 C 0.418 0.04 0.435 -0.028 0.492 -0.035 C 0.548 -0.04 0.57 0.015 0.552 0.07 C 0.548 0.092 0.54 0.108 0.528 0.118" },
        { t: "main", d: "M 0.437 0.032 C 0.428 0.058 0.43 0.078 0.442 0.092 L 0.42 0.086 L 0.435 0.108" },
        { t: "main", d: "M 0.442 0.092 C 0.45 0.118 0.468 0.132 0.49 0.126" },
        { t: "detail", d: "M 0.452 0.052 C 0.46 0.046 0.472 0.048 0.478 0.056" },
        { t: "detail", d: "M 0.435 0.04 C 0.465 0.028 0.512 0.03 0.54 0.05" },
        // crest (tall swept plume) + comb
        { t: "main", d: "M 0.5 -0.03 C 0.498 -0.115 0.535 -0.168 0.585 -0.158 C 0.612 -0.112 0.592 -0.05 0.556 -0.012" },
        { t: "detail", d: "M 0.512 -0.048 L 0.522 -0.135 M 0.532 -0.052 L 0.548 -0.15 M 0.554 -0.042 L 0.575 -0.128 M 0.5 -0.03 C 0.52 -0.012 0.545 -0.012 0.558 -0.02" },
        // helmet extra: almond eye opening, nasal bar, cheek plate, crest box, dome ridges, ear
        { t: "detail", d: "M 0.438 0.062 C 0.447 0.052 0.462 0.052 0.47 0.062 C 0.462 0.07 0.447 0.07 0.438 0.062 Z" },
        { t: "detail", d: "M 0.44 0.05 L 0.432 0.108 M 0.448 0.05 L 0.441 0.106" },
        { t: "detail", d: "M 0.452 0.098 C 0.45 0.116 0.459 0.129 0.474 0.131 L 0.48 0.108" },
        { t: "detail", d: "M 0.492 -0.032 C 0.502 -0.046 0.524 -0.049 0.537 -0.04 L 0.531 -0.02" },
        { t: "faint", d: "M 0.45 0.018 C 0.478 0.008 0.514 0.01 0.54 0.026 M 0.5 -0.032 C 0.51 -0.005 0.512 0.03 0.505 0.06" },
        { t: "faint", d: "M 0.435 0.036 C 0.456 0.042 0.476 0.044 0.49 0.05 M 0.5 0.06 C 0.512 0.062 0.52 0.072 0.52 0.086" },
        // ===== NECK, PAULDRONS & SHOULDERS =====
        { t: "main", d: "M 0.462 0.118 L 0.46 0.152 M 0.5 0.122 L 0.5 0.15" },
        { t: "main", d: "M 0.462 0.152 C 0.416 0.152 0.37 0.166 0.346 0.2 C 0.336 0.212 0.338 0.226 0.348 0.238" },
        { t: "detail", d: "M 0.352 0.198 C 0.378 0.21 0.408 0.215 0.43 0.209 M 0.35 0.22 C 0.377 0.231 0.408 0.235 0.43 0.229" },
        { t: "main", d: "M 0.5 0.15 C 0.542 0.152 0.575 0.166 0.59 0.198" },
        // ===== TORSO (narrower shoulders -> waist) =====
        { t: "main", d: "M 0.348 0.238 C 0.35 0.302 0.362 0.372 0.386 0.428 C 0.4 0.458 0.406 0.478 0.41 0.5" },
        { t: "main", d: "M 0.59 0.198 C 0.596 0.26 0.59 0.33 0.574 0.385 C 0.56 0.43 0.548 0.462 0.538 0.492" },
        { t: "detail", d: "M 0.412 0.288 C 0.45 0.31 0.5 0.31 0.538 0.286" },
        { t: "faint", d: "M 0.44 0.252 C 0.454 0.278 0.47 0.283 0.478 0.281 M 0.51 0.252 C 0.496 0.278 0.484 0.283 0.478 0.281" },
        // — six-pack: linea alba, rectus columns, tendinous rows, block rounding, lower V —
        { t: "detail", d: "M 0.477 0.3 C 0.475 0.36 0.475 0.43 0.474 0.488" },
        { t: "detail", d: "M 0.44 0.315 C 0.434 0.36 0.435 0.42 0.444 0.474 M 0.514 0.315 C 0.52 0.36 0.519 0.42 0.51 0.474" },
        { t: "detail", d: "M 0.444 0.348 C 0.458 0.359 0.492 0.359 0.506 0.348 M 0.446 0.39 C 0.46 0.401 0.49 0.401 0.504 0.39 M 0.448 0.432 C 0.46 0.442 0.488 0.442 0.5 0.432" },
        { t: "faint", d: "M 0.45 0.462 C 0.461 0.47 0.487 0.47 0.498 0.462" },
        { t: "faint", d: "M 0.447 0.33 C 0.451 0.338 0.461 0.34 0.47 0.338 M 0.507 0.33 C 0.503 0.338 0.493 0.34 0.484 0.338 M 0.449 0.372 C 0.453 0.38 0.463 0.382 0.47 0.38 M 0.505 0.372 C 0.501 0.38 0.491 0.382 0.484 0.38" },
        { t: "detail", d: "M 0.44 0.474 C 0.45 0.492 0.462 0.502 0.474 0.507 M 0.51 0.474 C 0.5 0.492 0.488 0.502 0.476 0.507" },
        { t: "faint", d: "M 0.414 0.302 C 0.41 0.36 0.415 0.42 0.425 0.475 M 0.538 0.292 C 0.54 0.35 0.534 0.41 0.522 0.465" },
        // ===== SPEAR (long diagonal, both hands) =====
        { t: "main", d: "M 0.048 0.66 L 0.905 0.078" },
        { t: "detail", d: "M 0.06 0.672 L 0.917 0.09" },
        { t: "main", d: "M 0.892 0.092 C 0.912 0.056 0.938 0.03 0.966 0.006 C 0.95 0.042 0.944 0.067 0.93 0.09 Z" },
        { t: "detail", d: "M 0.902 0.084 L 0.958 0.014 M 0.884 0.1 L 0.908 0.08" },
        { t: "main", d: "M 0.062 0.65 L 0.026 0.68 M 0.05 0.665 L 0.03 0.685" },
        // ===== ARMS gripping the shaft =====
        { t: "main", d: "M 0.348 0.238 C 0.328 0.29 0.32 0.348 0.322 0.398 C 0.324 0.432 0.336 0.454 0.352 0.468" },
        { t: "detail", d: "M 0.36 0.255 C 0.352 0.305 0.35 0.362 0.356 0.418" },
        { t: "main", d: "M 0.34 0.458 C 0.356 0.448 0.374 0.458 0.374 0.478 C 0.372 0.494 0.354 0.494 0.342 0.484" },
        { t: "main", d: "M 0.585 0.212 C 0.57 0.27 0.544 0.328 0.514 0.366" },
        { t: "detail", d: "M 0.588 0.216 C 0.59 0.274 0.576 0.314 0.556 0.348" },
        { t: "main", d: "M 0.5 0.362 C 0.516 0.356 0.532 0.366 0.53 0.386 C 0.527 0.398 0.512 0.398 0.5 0.388" },
        // ===== ROUND SHIELD (behind, Greek-key rings + emblem) =====
        { t: "main", d: "M 0.548 0.45 A 0.185 0.185 0 1 0 0.918 0.45 A 0.185 0.185 0 1 0 0.548 0.45 Z" },
        { t: "detail", d: "M 0.573 0.45 A 0.16 0.16 0 1 0 0.893 0.45 A 0.16 0.16 0 1 0 0.573 0.45 Z" },
        { t: "faint", d: "M 0.595 0.45 A 0.138 0.138 0 1 0 0.871 0.45 A 0.138 0.138 0 1 0 0.595 0.45 Z" },
        { t: "detail", d: "M 0.735 0.45 A 0.028 0.028 0 1 0 0.791 0.45 A 0.028 0.028 0 1 0 0.735 0.45 Z" },
        { t: "faint", d: "M 0.72 0.45 C 0.72 0.408 0.78 0.408 0.78 0.45 C 0.78 0.5 0.708 0.5 0.708 0.44" },
        // ===== BELT (Greek-key) + PTERUGES WAR-SKIRT =====
        { t: "main", d: "M 0.398 0.495 C 0.442 0.516 0.492 0.52 0.532 0.508" },
        { t: "main", d: "M 0.398 0.518 C 0.442 0.539 0.492 0.543 0.532 0.531" },
        { t: "faint", d: "M 0.414 0.5 L 0.414 0.516 L 0.43 0.516 M 0.446 0.503 L 0.446 0.519 L 0.462 0.519 M 0.478 0.505 L 0.478 0.521 L 0.494 0.521 M 0.51 0.505 L 0.51 0.52 L 0.524 0.52" },
        { t: "main", d: "M 0.4 0.53 L 0.39 0.618 L 0.414 0.622 L 0.424 0.535" },
        { t: "main", d: "M 0.53 0.522 L 0.548 0.608 L 0.57 0.598 L 0.556 0.515" },
        { t: "detail", d: "M 0.432 0.532 L 0.427 0.628 L 0.451 0.63 L 0.454 0.538 M 0.465 0.536 L 0.463 0.632 L 0.487 0.632 L 0.487 0.538 M 0.498 0.535 L 0.502 0.628 L 0.526 0.622 L 0.52 0.532" },
        // sword sheathed at the near hip
        { t: "main", d: "M 0.35 0.5 L 0.322 0.662 M 0.372 0.505 L 0.346 0.662" },
        { t: "detail", d: "M 0.322 0.662 L 0.335 0.678 L 0.346 0.662 M 0.352 0.486 L 0.376 0.496 M 0.36 0.474 L 0.368 0.486" },
        // ===== LEGS (wide stance) — near (left) to Saiph, far (right) to Rigel =====
        { t: "main", d: "M 0.41 0.55 C 0.37 0.598 0.342 0.642 0.338 0.68 C 0.33 0.73 0.334 0.792 0.345 0.85" },
        { t: "main", d: "M 0.462 0.562 C 0.446 0.608 0.426 0.65 0.406 0.685 C 0.398 0.74 0.378 0.798 0.36 0.848" },
        { t: "detail", d: "M 0.34 0.678 C 0.36 0.694 0.39 0.694 0.408 0.684" },
        { t: "faint", d: "M 0.352 0.72 C 0.342 0.744 0.346 0.768 0.362 0.76 M 0.352 0.79 C 0.345 0.808 0.348 0.826 0.36 0.822" },
        { t: "main", d: "M 0.522 0.552 C 0.566 0.592 0.6 0.636 0.606 0.678 C 0.616 0.73 0.64 0.808 0.662 0.868" },
        { t: "main", d: "M 0.472 0.564 C 0.49 0.606 0.516 0.646 0.548 0.682 C 0.556 0.74 0.586 0.812 0.612 0.858" },
        { t: "detail", d: "M 0.548 0.682 C 0.568 0.696 0.592 0.696 0.606 0.683" },
        { t: "faint", d: "M 0.6 0.72 C 0.618 0.744 0.616 0.77 0.6 0.766 M 0.616 0.796 C 0.63 0.816 0.628 0.836 0.616 0.83" },
        // sandals
        { t: "detail", d: "M 0.318 0.848 L 0.386 0.854 L 0.38 0.87 L 0.316 0.864 Z M 0.336 0.858 L 0.372 0.862 M 0.348 0.864 L 0.36 0.87" },
        { t: "detail", d: "M 0.63 0.862 L 0.698 0.868 L 0.692 0.884 L 0.628 0.878 Z M 0.648 0.872 L 0.684 0.876 M 0.66 0.878 L 0.672 0.884" },
        // ===================== EXTRA DETAIL PASS =====================
        // Helmet: brow ridge, eye slit, dome ridges, cheek guard, rivets, neck guard
        { t: "detail", d: "M 0.437 0.038 C 0.458 0.03 0.492 0.03 0.518 0.042" },
        { t: "detail", d: "M 0.442 0.058 C 0.45 0.052 0.463 0.052 0.471 0.059" },
        { t: "detail", d: "M 0.49 0.126 C 0.506 0.12 0.518 0.107 0.523 0.09" },
        { t: "faint", d: "M 0.452 -0.008 C 0.476 -0.02 0.512 -0.018 0.536 0.002 M 0.446 0.02 C 0.474 0.01 0.512 0.012 0.538 0.028" },
        { t: "detail", d: "M 0.552 0.07 C 0.561 0.094 0.557 0.114 0.543 0.127" },
        { t: "faint", d: "M 0.457 0.0 A 0.005 0.005 0 1 0 0.467 0.0 A 0.005 0.005 0 1 0 0.457 0.0 Z M 0.5 0.006 A 0.005 0.005 0 1 0 0.51 0.006 A 0.005 0.005 0 1 0 0.5 0.006 Z M 0.528 0.03 A 0.005 0.005 0 1 0 0.538 0.03 A 0.005 0.005 0 1 0 0.528 0.03 Z" },
        // Crest: finer comb feathers + socket
        { t: "faint", d: "M 0.506 -0.06 L 0.515 -0.128 M 0.52 -0.07 L 0.532 -0.142 M 0.538 -0.068 L 0.552 -0.14 M 0.556 -0.06 L 0.572 -0.122 M 0.5 -0.028 C 0.516 -0.048 0.53 -0.05 0.54 -0.04" },
        // Deltoids / biceps / forearms striations
        { t: "faint", d: "M 0.352 0.216 C 0.362 0.232 0.366 0.252 0.368 0.272 M 0.354 0.3 C 0.364 0.312 0.374 0.324 0.379 0.338" },
        { t: "faint", d: "M 0.578 0.214 C 0.569 0.234 0.564 0.256 0.562 0.278 M 0.57 0.305 C 0.559 0.322 0.547 0.338 0.537 0.352" },
        { t: "faint", d: "M 0.33 0.4 C 0.337 0.42 0.344 0.44 0.352 0.458" },
        // Pecs inner + serratus + oblique ridges + navel
        { t: "faint", d: "M 0.44 0.25 C 0.455 0.276 0.47 0.281 0.478 0.279 M 0.512 0.25 C 0.498 0.276 0.485 0.281 0.478 0.279" },
        { t: "faint", d: "M 0.418 0.478 C 0.436 0.494 0.458 0.504 0.474 0.508 M 0.532 0.478 C 0.514 0.494 0.492 0.504 0.476 0.508" },
        { t: "faint", d: "M 0.408 0.33 L 0.421 0.35 M 0.412 0.362 L 0.425 0.382 M 0.417 0.394 L 0.43 0.414" },
        { t: "faint", d: "M 0.544 0.33 L 0.531 0.35 M 0.54 0.362 L 0.527 0.382 M 0.535 0.394 L 0.522 0.414" },
        { t: "faint", d: "M 0.472 0.462 C 0.468 0.467 0.468 0.473 0.473 0.475" },
        // Spear: grip binding, socket bands, blade edges + barbs
        { t: "detail", d: "M 0.302 0.476 L 0.32 0.501 M 0.322 0.463 L 0.34 0.488 M 0.342 0.45 L 0.36 0.475 M 0.362 0.437 L 0.38 0.462" },
        { t: "detail", d: "M 0.5 0.372 L 0.516 0.395 M 0.516 0.362 L 0.532 0.385" },
        { t: "detail", d: "M 0.878 0.108 L 0.9 0.086 M 0.868 0.12 L 0.89 0.098" },
        { t: "faint", d: "M 0.905 0.075 C 0.919 0.078 0.931 0.074 0.94 0.065 M 0.884 0.101 C 0.874 0.106 0.866 0.104 0.86 0.096" },
        { t: "detail", d: "M 0.07 0.642 L 0.09 0.624 M 0.058 0.652 L 0.078 0.634" },
        // Shield face: radial rim ticks (Greek-key hint), boss rivets, coiled emblem
        { t: "faint", d: "M 0.893 0.45 L 0.916 0.45 M 0.888 0.404 L 0.91 0.396 M 0.888 0.496 L 0.91 0.504 M 0.873 0.362 L 0.89 0.349 M 0.873 0.538 L 0.89 0.551 M 0.846 0.328 L 0.859 0.311 M 0.846 0.572 L 0.859 0.589" },
        { t: "faint", d: "M 0.733 0.422 A 0.004 0.004 0 1 0 0.741 0.422 A 0.004 0.004 0 1 0 0.733 0.422 Z M 0.759 0.436 A 0.004 0.004 0 1 0 0.767 0.436 A 0.004 0.004 0 1 0 0.759 0.436 Z M 0.759 0.464 A 0.004 0.004 0 1 0 0.767 0.464 A 0.004 0.004 0 1 0 0.759 0.464 Z M 0.733 0.478 A 0.004 0.004 0 1 0 0.741 0.478 A 0.004 0.004 0 1 0 0.733 0.478 Z M 0.707 0.464 A 0.004 0.004 0 1 0 0.715 0.464 A 0.004 0.004 0 1 0 0.707 0.464 Z M 0.707 0.436 A 0.004 0.004 0 1 0 0.715 0.436 A 0.004 0.004 0 1 0 0.707 0.436 Z" },
        { t: "faint", d: "M 0.746 0.45 C 0.746 0.442 0.756 0.442 0.756 0.451 C 0.756 0.463 0.738 0.463 0.738 0.448 C 0.738 0.43 0.766 0.43 0.766 0.452" },
        // Belt studs + inner meander + second (under) row of pteruges
        { t: "faint", d: "M 0.418 0.508 A 0.004 0.004 0 1 0 0.426 0.508 A 0.004 0.004 0 1 0 0.418 0.508 Z M 0.448 0.512 A 0.004 0.004 0 1 0 0.456 0.512 A 0.004 0.004 0 1 0 0.448 0.512 Z M 0.478 0.514 A 0.004 0.004 0 1 0 0.486 0.514 A 0.004 0.004 0 1 0 0.478 0.514 Z M 0.508 0.513 A 0.004 0.004 0 1 0 0.516 0.513 A 0.004 0.004 0 1 0 0.508 0.513 Z" },
        { t: "faint", d: "M 0.418 0.6 L 0.414 0.642 L 0.434 0.644 L 0.438 0.602 M 0.452 0.602 L 0.45 0.646 L 0.47 0.646 L 0.472 0.604 M 0.486 0.602 L 0.488 0.644 L 0.508 0.64 L 0.505 0.6" },
        // Legs: quad separation, knee caps, greave rims + decorative swirls
        { t: "faint", d: "M 0.43 0.57 C 0.416 0.61 0.404 0.646 0.397 0.68 M 0.5 0.575 C 0.518 0.612 0.534 0.646 0.547 0.68" },
        { t: "faint", d: "M 0.362 0.686 C 0.374 0.696 0.39 0.696 0.4 0.687 M 0.552 0.686 C 0.566 0.696 0.586 0.696 0.598 0.687" },
        { t: "detail", d: "M 0.34 0.692 C 0.362 0.702 0.39 0.702 0.406 0.692 M 0.548 0.692 C 0.57 0.702 0.596 0.702 0.61 0.692" },
        { t: "faint", d: "M 0.352 0.762 C 0.344 0.776 0.349 0.79 0.361 0.784 C 0.367 0.778 0.359 0.77 0.353 0.775 M 0.607 0.77 C 0.615 0.784 0.61 0.798 0.598 0.792 C 0.592 0.786 0.6 0.778 0.606 0.783" },
        { t: "faint", d: "M 0.346 0.82 C 0.34 0.834 0.344 0.845 0.356 0.84 M 0.6 0.826 C 0.594 0.84 0.598 0.851 0.61 0.846" },
        // ===================== MUSCLE BULK + MENACE =====================
        // massive traps sweeping neck -> shoulders
        { t: "detail", d: "M 0.462 0.128 C 0.43 0.134 0.392 0.15 0.362 0.19 M 0.5 0.13 C 0.53 0.137 0.562 0.152 0.586 0.188" },
        // rounder, heavier deltoid caps
        { t: "detail", d: "M 0.346 0.2 C 0.328 0.214 0.324 0.238 0.334 0.26 M 0.59 0.198 C 0.608 0.212 0.612 0.236 0.602 0.258" },
        // bicep peak + forearm mass (near arm)
        { t: "faint", d: "M 0.33 0.3 C 0.345 0.318 0.352 0.342 0.351 0.364 M 0.336 0.42 C 0.343 0.44 0.351 0.456 0.361 0.466" },
        // far arm thick underside + tricep
        { t: "detail", d: "M 0.6 0.245 C 0.586 0.296 0.562 0.346 0.532 0.378" },
        { t: "faint", d: "M 0.596 0.262 C 0.58 0.3 0.558 0.336 0.53 0.362" },
        // deep pec undercuts + upper-pec mass
        { t: "detail", d: "M 0.42 0.298 C 0.446 0.324 0.47 0.327 0.478 0.324 M 0.536 0.298 C 0.51 0.324 0.486 0.327 0.478 0.324" },
        { t: "faint", d: "M 0.43 0.26 C 0.448 0.28 0.468 0.286 0.478 0.286 M 0.526 0.26 C 0.508 0.28 0.488 0.286 0.478 0.286" },
        // thick neck / sternocleidomastoid
        { t: "faint", d: "M 0.47 0.128 L 0.478 0.152 M 0.494 0.128 L 0.488 0.152" },
        // bigger quads
        { t: "faint", d: "M 0.4 0.58 C 0.384 0.616 0.372 0.65 0.366 0.68 M 0.505 0.582 C 0.522 0.616 0.537 0.65 0.548 0.68" },
        // fuller calf bellies
        { t: "faint", d: "M 0.335 0.72 C 0.324 0.746 0.328 0.776 0.342 0.79 M 0.607 0.722 C 0.62 0.748 0.617 0.778 0.603 0.792" },
        // heavier helmet brow shadow (menace)
        { t: "detail", d: "M 0.433 0.056 C 0.449 0.049 0.467 0.049 0.479 0.056 M 0.436 0.062 C 0.45 0.058 0.464 0.058 0.474 0.063" },
        // ===================== SHADING / FORM (tonal hatching) =====================
        // under-pec shadow
        { t: "shade", d: "M 0.428 0.315 C 0.44 0.325 0.458 0.327 0.47 0.324 M 0.43 0.322 C 0.442 0.331 0.458 0.333 0.468 0.33 M 0.434 0.329 C 0.444 0.336 0.456 0.338 0.464 0.336" },
        { t: "shade", d: "M 0.528 0.315 C 0.516 0.325 0.498 0.327 0.486 0.324 M 0.526 0.322 C 0.514 0.331 0.498 0.333 0.488 0.33 M 0.522 0.329 C 0.512 0.336 0.5 0.338 0.492 0.336" },
        // rectus column side shadow (left / right)
        { t: "shade", d: "M 0.438 0.35 L 0.44 0.366 M 0.437 0.372 L 0.439 0.388 M 0.437 0.394 L 0.439 0.41 M 0.438 0.416 L 0.44 0.432 M 0.44 0.438 L 0.442 0.454" },
        { t: "shade", d: "M 0.512 0.35 L 0.51 0.366 M 0.513 0.372 L 0.511 0.388 M 0.513 0.394 L 0.511 0.41 M 0.512 0.416 L 0.51 0.432 M 0.51 0.438 L 0.508 0.454" },
        // deltoid shadow (near / far)
        { t: "shade", d: "M 0.334 0.225 C 0.33 0.238 0.33 0.25 0.334 0.26 M 0.34 0.226 C 0.336 0.24 0.336 0.252 0.34 0.262 M 0.346 0.23 C 0.343 0.242 0.343 0.253 0.346 0.262" },
        { t: "shade", d: "M 0.602 0.225 C 0.606 0.238 0.606 0.25 0.602 0.26 M 0.596 0.226 C 0.6 0.24 0.6 0.252 0.596 0.262 M 0.59 0.23 C 0.593 0.242 0.593 0.253 0.59 0.262" },
        // cross-contour wrap lines — near arm (cylindrical form)
        { t: "shade", d: "M 0.326 0.32 C 0.336 0.324 0.348 0.322 0.356 0.316 M 0.324 0.38 C 0.334 0.385 0.346 0.383 0.354 0.377 M 0.33 0.44 C 0.34 0.445 0.35 0.443 0.358 0.438" },
        // wrap lines — far arm
        { t: "shade", d: "M 0.582 0.28 C 0.59 0.29 0.6 0.29 0.606 0.284 M 0.56 0.33 C 0.568 0.34 0.578 0.34 0.585 0.334 M 0.535 0.365 C 0.542 0.374 0.552 0.374 0.558 0.368" },
        // neck + jaw shadow
        { t: "shade", d: "M 0.46 0.122 L 0.462 0.14 M 0.47 0.124 L 0.471 0.142 M 0.48 0.124 L 0.48 0.142 M 0.49 0.123 L 0.489 0.14" },
        // helmet face-recess shadow
        { t: "shade", d: "M 0.44 0.07 C 0.446 0.082 0.45 0.094 0.456 0.104 M 0.448 0.068 C 0.454 0.08 0.458 0.092 0.463 0.102 M 0.456 0.07 C 0.46 0.082 0.463 0.094 0.467 0.104" },
        // inner-thigh shadow (near / far)
        { t: "shade", d: "M 0.44 0.585 C 0.43 0.61 0.42 0.638 0.414 0.664 M 0.448 0.59 C 0.438 0.615 0.43 0.642 0.424 0.666 M 0.456 0.596 C 0.447 0.62 0.44 0.646 0.435 0.668" },
        { t: "shade", d: "M 0.5 0.585 C 0.51 0.61 0.52 0.638 0.526 0.664 M 0.492 0.59 C 0.502 0.615 0.51 0.642 0.516 0.666 M 0.484 0.596 C 0.493 0.62 0.5 0.646 0.505 0.668" },
        // calf shadow (near / far)
        { t: "shade", d: "M 0.348 0.73 C 0.342 0.755 0.344 0.785 0.352 0.81 M 0.356 0.732 C 0.35 0.757 0.352 0.787 0.36 0.812" },
        { t: "shade", d: "M 0.598 0.732 C 0.606 0.757 0.605 0.787 0.598 0.812 M 0.606 0.735 C 0.614 0.76 0.613 0.79 0.606 0.815" },
        // skirt fold shadows + shield dome shading
        { t: "shade", d: "M 0.428 0.55 L 0.424 0.61 M 0.462 0.552 L 0.46 0.612 M 0.496 0.55 L 0.498 0.61" },
        { t: "shade", d: "M 0.86 0.5 C 0.85 0.52 0.836 0.535 0.82 0.545 M 0.87 0.48 C 0.862 0.5 0.85 0.516 0.836 0.528" },
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
      { x: [0.66, 0.73], y: [0.28, 0.38] },   // Orion (right — the feature, with the warrior)
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
            ctx.strokeStyle = "rgba(216, 226, 252, 0.28)";
            ctx.lineWidth = 1.7 / con.scale;
          } else if (fp.t === "detail") {
            ctx.strokeStyle = "rgba(198, 212, 242, 0.17)";
            ctx.lineWidth = 1.1 / con.scale;
          } else if (fp.t === "shade") { // soft tonal hatching for volume
            ctx.strokeStyle = "rgba(168, 186, 224, 0.06)";
            ctx.lineWidth = 0.8 / con.scale;
          } else { // faint striations (muscle, rivets, ornament)
            ctx.strokeStyle = "rgba(184, 200, 232, 0.11)";
            ctx.lineWidth = 0.9 / con.scale;
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
