/**
 * Jarvis on the phone. Talks to the Jarvis bridge on the PC through two
 * private ntfy.sh topics, every message AES-GCM sealed with the key from the
 * pairing link (it lives only in this phone and on the PC). Messages typed
 * while the PC is off wait at ntfy (12 h) until Jarvis starts.
 */
const RELAY = 'https://ntfy.sh'
// Bumped with every release; version.json on the site says what's current.
const VERSION = 6
const $ = (s) => document.querySelector(s)
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

// ---------- pairing ----------
function readPair(src) {
  const h = new URLSearchParams(String(src).split('#')[1] ?? '')
  const p = { k: h.get('k'), i: h.get('i'), o: h.get('o') }
  return p.k && p.i && p.o ? p : null
}
let pair = readPair(location.href) ?? store.get('jv-pair', null)
if (pair) store.set('jv-pair', pair)

// ---------- crypto ----------
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
}
let keyP = null
const key = () => (keyP ??= crypto.subtle.importKey('raw', b64u.dec(pair.k), 'AES-GCM', false, ['encrypt', 'decrypt']))
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)))
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), 12)
  return b64u.enc(out)
}
async function open(text) {
  const raw = b64u.dec(String(text).trim())
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await key(), raw.slice(12))
  return JSON.parse(new TextDecoder().decode(pt))
}

// ---------- state ----------
let list = store.get('jv-list', null) // { at, tasks, reminders }
let chat = store.get('jv-chat', []) // { id, me, text, at, status }
let pendingDone = store.get('jv-pending', {}) // taskId -> true|false while the PC hasn't confirmed
let lastSeen = store.get('jv-seen', 0) // when Jarvis last answered anything
let lastId = store.get('jv-last', null)
let tab = 'list'
let unread = 0
const saveChat = () => store.set('jv-chat', chat.slice(-120))
const online = () => Date.now() - lastSeen < 150_000

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
async function publish(obj) {
  const r = await fetch(`${RELAY}/${pair.i}`, { method: 'POST', body: await seal(obj) })
  if (!r.ok) throw new Error(`relay ${r.status}`)
}

// ---------- relay in ----------
let es = null
function subscribe() {
  es?.close()
  es = new EventSource(`${RELAY}/${pair.o}/sse?since=${lastId ?? '12h'}`)
  es.onmessage = async (e) => {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    if (ev.event !== 'message') return
    lastId = ev.id
    store.set('jv-last', lastId)
    let m
    try { m = await open(ev.message) } catch { return }
    receive(m, ev.time * 1000)
  }
  es.onerror = () => setStatus()
}

function receive(m, time) {
  const fresh = Date.now() - time < 150_000
  if (fresh) {
    lastSeen = Math.max(lastSeen, time)
    store.set('jv-seen', lastSeen)
  }
  if (m.t === 'state') {
    if (m.notify && m.notify !== store.get('jv-notify-topic', null)) {
      store.set('jv-notify-topic', m.notify)
      renderNotifyCard()
    }
    if (!list || m.at >= list.at) {
      list = m
      store.set('jv-list', list)
      // Anything the PC now agrees with is no longer pending.
      for (const t of list.tasks) if (t.id in pendingDone && Boolean(t.done) === pendingDone[t.id]) delete pendingDone[t.id]
      store.set('jv-pending', pendingDone)
      renderList()
    }
  } else if (m.t === 'ack') {
    const mine = chat.find((c) => c.id === m.to)
    if (mine && mine.status !== 'replied') mine.status = 'ack'
    saveChat()
    renderChat()
    renderList()
  } else if (m.t === 'reply') {
    if (chat.some((c) => c.reply === m.to)) return
    const mine = chat.find((c) => c.id === m.to)
    if (mine) mine.status = 'replied'
    if (mine?.kind === 'photo') forgetPhoto(mine.id)
    chat.push({ id: uid(), me: false, text: m.text, at: m.at ?? time, reply: m.to })
    // Asked out loud (and still here to hear it): answered out loud.
    if (mine?.voice && Date.now() - mine.at < 5 * 60_000 && !document.hidden) speak(m.text)
    saveChat()
    renderList()
    if (tab !== 'chat') { unread++; toast(m.text.length > 70 ? m.text.slice(0, 68) + '…' : m.text) }
    renderChat()
  }
  setStatus()
}

// ---------- status ----------
function setStatus() {
  const el = $('#status')
  const on = online()
  el.className = `status ${on ? 'on' : 'off'}`
  el.querySelector('span').textContent = on ? 'Online' : lastSeen ? `Asleep · seen ${ago(lastSeen)}` : 'Asleep · will get it when your PC is on'
}
let pingAt = 0
function ping() {
  if (Date.now() - pingAt < 20_000) return
  pingAt = Date.now()
  publish({ t: 'ping', at: Date.now(), v: VERSION, voice: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition), standalone: Boolean(navigator.standalone) }).catch(() => {})
}

// ---------- sending ----------
async function sendText(text, { voice = false } = {}) {
  text = text.trim()
  if (!text) return
  const m = { id: uid(), me: true, text, at: Date.now(), status: 'sending', voice }
  chat.push(m)
  saveChat()
  renderChat()
  renderList()
  try {
    await publish({ t: 'msg', id: m.id, text, at: m.at })
    m.status = 'sent'
    toast(online() ? '✓ Sent to Jarvis' : '✓ Saved. Jarvis adds it when your PC turns on')
  } catch {
    m.status = 'failed'
    toast('No signal. Saved here, will send when you are back online')
  }
  saveChat()
  renderChat()
  renderList()
  ping()
}
// Anything never acknowledged, about to fall out of the relay's 12 h memory, goes again.
async function resendOld() {
  for (const m of chat) {
    if (!m.me || m.kind === 'photo') continue
    const age = Date.now() - m.at
    if (m.status === 'failed' || (m.status === 'sent' && age > 11 * 3600_000 && age < 72 * 3600_000 && Date.now() - (m.resent ?? 0) > 11 * 3600_000)) {
      try {
        await publish({ t: 'msg', id: m.id, text: m.text, at: m.at })
        m.status = 'sent'
        m.resent = Date.now()
      } catch { /* next time */ }
    }
  }
  saveChat()
}
async function toggleTask(t) {
  const want = !isDone(t)
  pendingDone[t.id] = want
  store.set('jv-pending', pendingDone)
  if (want) {
    t.doneAt = Date.now()
    leaving[t.id] = Date.now()
    setTimeout(renderList, LEAVE_MS + 20)
  } else delete leaving[t.id]
  renderList()
  try {
    await publish({ t: want ? 'done' : 'undo', id: uid(), task: t.id })
    if (!online()) toast(want ? 'Checked off. Jarvis will update when your PC is on.' : 'Unchecked.')
  } catch {
    delete pendingDone[t.id]
    store.set('jv-pending', pendingDone)
    renderList()
    toast("Couldn't reach the relay. Check your connection.")
  }
}

// ---------- rendering ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const CAT = { SCHOOL: '#19e3ff', FILM: '#ff4d5e', DESIGN: '#b48cff', SCOUTS: '#3ddc84', PERSONAL: '#f0a93c' }
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
function dueOf(due) {
  if (!due) return null
  const dateOnly = due.length === 10
  const d = new Date(dateOnly ? `${due}T23:59` : due)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(d); day.setHours(0, 0, 0, 0)
  const diff = Math.round((day - today) / 86400000)
  const time = dateOnly ? '' : ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d < Date.now()) return { text: diff === 0 ? `Due today${time}` : 'Overdue', cls: diff === 0 ? 'today' : 'late' }
  if (diff === 0) return { text: `Today${time}`, cls: 'today' }
  if (diff === 1) return { text: `Tomorrow${time}`, cls: 'soon' }
  if (diff < 7) return { text: d.toLocaleDateString([], { weekday: 'long' }) + time, cls: '' }
  return { text: d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + time, cls: '' }
}
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
const BELL = '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>'

const FOLDER = '<svg class="folder" viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M8.5 13.5l2 2 4-4"/></svg>'
const CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'
function renderWaiting() {
  const waiting = chat.filter((m) => m.me && ['sending', 'sent', 'ack', 'failed'].includes(m.status) && Date.now() - m.at < 72 * 3600_000)
  if (!waiting.length) return ''
  return `<div class="group waiting"><h3>WAITING FOR JARVIS <span>${waiting.length}</span></h3>${waiting
    .map((m) => {
      const note = m.status === 'ack' ? 'Jarvis is on it…' : m.status === 'failed' ? 'No signal · will retry' : m.status === 'sending' ? 'Saving…' : online() ? 'Sent · Jarvis is on it' : '✓ Saved · added when your PC turns on'
      const what = m.kind === 'photo' ? `📷 Photo${m.text ? `: ${esc(m.text)}` : ''}` : esc(m.text)
      return `<div class="task wait">${CLOCK}<div class="body"><div class="title">${what}</div><div class="meta"><span>${note}</span></div></div></div>`
    })
    .join('')}</div>`
}

const isDone = (t) => (t.id in pendingDone ? pendingDone[t.id] : Boolean(t.done))
const LEAVE_MS = 900
const leaving = {}

function renderList() {
  const tasks = [...(list?.tasks ?? []), ...pendingAdds().map((a) => ({ ...a, local: true }))]
  const open = tasks.filter((t) => !isDone(t))
  $('#count').textContent = open.length || ''
  $('#synced').textContent = list ? `Synced ${ago(list.at)}` : ''
  $('#reminders').innerHTML = (list?.reminders ?? [])
    .map((r) => `<div class="reminder">${BELL}<span>${esc(r.text)}</span><span class="when">${esc(new Date(r.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</span></div>`)
    .join('')
  const waitHtml = renderWaiting()
  if (!tasks.length) {
    renderNext()
    $('#tasks').innerHTML = waitHtml + (list
      ? '<div class="empty"><b>ALL CLEAR</b>Nothing on the list. Type below to add something.</div>'
      : '<div class="empty"><b>NO LIST YET</b>Your list shows up here once Jarvis is on. You can still send him things now.</div>')
    return
  }
  // Ticked things leave the list (after the tick animation) for FINISHED at the bottom.
  const now = Date.now()
  const showOpen = (t) => !isDone(t) || now - (leaving[t.id] ?? 0) < LEAVE_MS
  const openTasks = tasks.filter(showOpen)
  const finished = tasks.filter((t) => !showOpen(t)).sort((a, b) => (b.doneAt ?? now) - (a.doneAt ?? now))
  const groups = {}
  for (const t of openTasks) (groups[t.category] ??= []).push(t)
  let i = 0
  const row = (t, cat) => {
    const done = isDone(t)
    const due = dueOf(t.due)
    const gone = done && now - (leaving[t.id] ?? 0) < LEAVE_MS ? ' leaving' : ''
    const meta = done && !gone
      ? `<span>${esc(cat)}${t.doneAt ? ` · done ${esc(doneLabel(t.doneAt))}` : ''}</span>`
      : `${due ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : ''}${t.effort && !done ? `<span>${esc(t.effort)}</span>` : ''}`
    if (t.local) {
      return `<div class="task local" style="--c:${CAT[cat] ?? '#19e3ff'}">
        <span class="check ghost">${CLOCK}</span>
        <div class="body"><div class="title">${esc(t.title)}</div><div class="meta">${due ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : ''}<span>${t.failed ? 'not sent yet' : online() ? 'adding…' : 'added when your PC is on'}</span></div></div>
      </div>`
    }
    return `<div class="task${done ? ' done' : ''}${gone}${t.id in pendingDone ? ' pending' : ''}" style="--c:${CAT[cat] ?? '#19e3ff'};animation-delay:${gone ? 0 : i++ * 30}ms">
      <button class="check" data-id="${esc(t.id)}" aria-label="${done ? 'Not done' : 'Done'}">${CHECK}</button>
      <div class="body"><div class="title">${esc(t.title)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>
    </div>`
  }
  const openHtml = openTasks.length
    ? Object.entries(groups)
        .map(([cat, ts]) => `<div class="group"><h3>${esc(cat)} <span>${ts.filter((t) => !isDone(t)).length}</span></h3>${ts.map((t) => row(t, cat)).join('')}</div>`)
        .join('')
    : '<div class="empty small"><b>ALL CLEAR</b>Everything is done. Look at you.</div>'
  const finOpen = store.get('jv-fin-open', false)
  const finHtml = finished.length
    ? `<div class="group finished${finOpen ? ' open' : ''}"><h3 class="fin-toggle">${FOLDER}<b>FINISHED</b><span>${finished.length}</span><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></h3><div class="fin-body">${finished.map((t) => row(t, t.category)).join('')}</div></div>`
    : ''
  $('#tasks').innerHTML = waitHtml + openHtml + finHtml
  renderNext()
  // Rows fade in on the first draw only; redraws (a tick, a sync) don't flicker.
  requestAnimationFrame(() => setTimeout(() => document.body.classList.add('drawn'), 700))
}

function doneLabel(t) {
  const d = new Date(t)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (d >= today) return 'today'
  if (d >= today - 86400000) return 'yesterday'
  return d.toLocaleDateString([], { weekday: 'long' })
}

function renderChat() {
  $('#unread').textContent = unread || ''
  const el = $('#chat')
  if (!chat.length) {
    el.innerHTML = '<div class="empty"><b>TALK TO JARVIS</b>Anything you\'d say out loud works here:<br>"chem quiz Thursday", "finished the bio lab",<br>"remind me at 6 to email Mr. Lee".</div>'
    return
  }
  let lastDay = ''
  const parts = []
  for (const m of chat) {
    const day = new Date(m.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    if (day !== lastDay) parts.push(`<div class="day">${esc(day)}</div>`)
    lastDay = day
    if (m.me) {
      const tick = { sending: 'Sending…', sent: online() ? 'Sent' : '✓ Saved · waiting for PC', ack: 'Jarvis got it', replied: '', failed: 'Not sent · will retry' }[m.status] ?? ''
      parts.push(`<div class="msg me">${m.kind === 'photo' && m.thumb ? `<img class="ph" src="${m.thumb}" alt="photo">` : ''}${esc(m.text)}${tick ? `<span class="tick ${m.status === 'ack' ? 'ack' : ''}">${tick}</span>` : ''}</div>`)
    } else parts.push(`<div class="msg jv">${esc(m.text)}</div>`)
  }
  if (chat.some((m) => m.me && m.status === 'ack')) parts.push('<div class="typing"><i></i><i></i><i></i></div>')
  el.innerHTML = parts.join('')
  if (tab === 'chat') requestAnimationFrame(() => ($('#view-chat').scrollTop = 1e9))
}

function showTab(t) {
  tab = t
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t))
  $('.tabs').dataset.on = t
  $('#view-list').classList.toggle('on', t === 'list')
  $('#view-chat').classList.toggle('on', t === 'chat')
  if (t === 'chat') { unread = 0; renderChat() }
}

let toastTimer
function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

// ---------- globe ----------
function globe(canvas) {
  const ctx = canvas.getContext('2d')
  const N = canvas.classList.contains('big') ? 420 : 160
  const pts = Array.from({ length: N }, (_, i) => {
    const y = 1 - (i / (N - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const a = i * 2.399963
    return [Math.cos(a) * r, y, Math.sin(a) * r]
  })
  let last = 0
  const draw = (now) => {
    requestAnimationFrame(draw)
    if (document.hidden || now - last < 33) return
    last = now
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    if (canvas.width !== w * dpr) { canvas.width = canvas.height = w * dpr }
    const s = canvas.width, c = s / 2, R = s * 0.34
    ctx.clearRect(0, 0, s, s)
    const g = ctx.createRadialGradient(c, c, 0, c, c, R * 1.4)
    g.addColorStop(0, 'rgba(25,227,255,0.22)')
    g.addColorStop(1, 'rgba(25,227,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
    const t = now / 1000, ry = t * 0.5, tilt = 0.4
    for (const [x, y, z] of pts) {
      const x1 = x * Math.cos(ry) + z * Math.sin(ry)
      const z1 = -x * Math.sin(ry) + z * Math.cos(ry)
      const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt)
      const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt)
      const a = 0.15 + 0.85 * ((z2 + 1) / 2)
      ctx.fillStyle = `rgba(${130 + 100 * a | 0},${235},255,${a})`
      ctx.beginPath()
      ctx.arc(c + x1 * R, c + y2 * R, s * 0.008 * (0.6 + a), 0, 7)
      ctx.fill()
    }
    ctx.strokeStyle = 'rgba(25,227,255,0.55)'
    ctx.lineWidth = s * 0.008
    ctx.beginPath()
    ctx.ellipse(c, c, R * 1.32, R * 0.36, -0.35, t * 0.8, t * 0.8 + 4.4)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(25,227,255,0.25)'
    ctx.beginPath()
    ctx.arc(c, c, R * 1.18, -t * 0.6, -t * 0.6 + 2.2)
    ctx.stroke()
  }
  requestAnimationFrame(draw)
}

// ---------- wiring ----------
document.querySelectorAll('[data-globe]').forEach(globe)

function start() {
  $('#pair').hidden = true
  $('#app').hidden = false
  renderList()
  renderChat()
  setStatus()
  subscribe()
  ping()
  resendOld()
  resendPhotos()
  resendAdds()
  renderNotifyCard()
  setInterval(() => { setStatus(); renderList() }, 30_000)
}

if (!pair) {
  $('#pair').hidden = false
  $('#pairBtn').onclick = () => {
    const p = readPair($('#pairInput').value)
    if (!p) return toast("That isn't a Jarvis pairing link.")
    pair = p
    store.set('jv-pair', p)
    start()
  }
} else queueMicrotask(start) // after the whole file has run (later sections declare state start() uses)

document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)))
$('#tasks').addEventListener('click', (e) => {
  if (e.target.closest('.fin-toggle')) {
    store.set('jv-fin-open', !store.get('jv-fin-open', false))
    return renderList()
  }
  const b = e.target.closest('.check')
  if (!b) return
  const t = list?.tasks.find((x) => x.id === b.dataset.id)
  if (t) toggleTask(t)
})
const input = $('#input')
const grow = () => {
  input.style.height = 'auto'
  // Measured 0 while the app is still hidden (before pairing shows it): leave it natural.
  if (input.scrollHeight) input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  $('#send').disabled = !input.value.trim()
}
input.addEventListener('input', grow)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit() }
})
$('#form').onsubmit = (e) => {
  e.preventDefault()
  const text = input.value
  input.value = ''
  grow()
  sendText(text)
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b || b.dataset.open || b.dataset.photo !== undefined) return
  if (b.dataset.say) return sendText(b.dataset.say)
  input.value = b.dataset.fill
  grow()
  input.focus()
})
$('#refresh').onclick = () => {
  const b = $('#refresh')
  b.classList.add('spin')
  pingAt = 0
  ping()
  subscribe()
  setTimeout(() => b.classList.remove('spin'), 1500)
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !pair) return
  subscribe() // iOS drops the stream in the background
  ping()
  resendOld()
  resendPhotos()
  resendAdds()
})
grow()
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})

// ---------- voice ----------
/**
 * Apple's speech recognition (webkitSpeechRecognition). Two ways in:
 *  - the mic button: one sentence, sent when you stop talking;
 *  - hands-free ("ears"): while the app is open and on screen, "Jarvis, ..."
 *    sends whatever follows; "Jarvis" alone waits for the next sentence.
 * iOS stops listening whenever the app leaves the screen; it resumes on return.
 */
const Recognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition
let rec = null
let recMode = null // 'mic' | 'ears'
let ears = store.get('jv-ears', false)
let armedUntil = 0 // "Jarvis" heard alone: the next sentence is the request
let talking = false

function setupVoice() {
  $('#mic').hidden = false
  if (!Recognizer()) {
    $('#mic').onclick = () => {
      input.focus()
      toast('Voice is blocked in home-screen apps on this iPhone. Tap the 🎤 on your keyboard to dictate instead.')
    }
    return
  }
  $('#ears').hidden = false
  $('#mic').onclick = () => {
    unlockSpeech()
    if (recMode === 'mic') return stopRec()
    listenOnce()
  }
  $('#ears').onclick = () => {
    unlockSpeech()
    ears = !ears
    store.set('jv-ears', ears)
    toast(ears ? 'Hands-free on: say "Jarvis, ..." while the app is open' : 'Hands-free off')
    if (ears) startEars()
    else if (recMode === 'ears') stopRec()
    voiceUi()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRec()
    else if (ears) startEars()
  })
  if (ears) startEars()
  voiceUi()
}

function voiceUi() {
  $('#mic').classList.toggle('on', recMode === 'mic')
  $('#ears').classList.toggle('on', ears)
  $('#ears').classList.toggle('live', recMode === 'ears')
  $('.bar').classList.toggle('listening', recMode === 'mic' || Date.now() < armedUntil)
  input.placeholder = recMode === 'mic' ? 'Listening…' : Date.now() < armedUntil ? 'Go ahead…' : ears && recMode === 'ears' ? 'Say "Jarvis, …"' : 'Tell Jarvis…'
}

function stopRec() {
  const r = rec
  rec = null
  recMode = null
  try { r?.abort() } catch { /* already stopped */ }
  voiceUi()
}

function makeRec(continuous) {
  const r = new (Recognizer())()
  r.lang = 'en-US'
  r.continuous = continuous
  r.interimResults = true
  return r
}

function listenOnce() {
  stopRec()
  if ('speechSynthesis' in window) speechSynthesis.cancel()
  const r = makeRec(false)
  rec = r
  recMode = 'mic'
  let finalText = ''
  r.onresult = (e) => {
    let interim = ''
    for (const res of e.results) {
      if (res.isFinal) finalText = res[0].transcript
      else interim = res[0].transcript
    }
    input.value = finalText || interim
    grow()
  }
  r.onerror = (e) => {
    if (e.error === 'not-allowed') toast('Allow the microphone for Jarvis in Settings → Safari → Microphone')
  }
  r.onend = () => {
    if (rec !== r) return
    rec = null
    recMode = null
    const text = (finalText || input.value).trim()
    input.value = ''
    grow()
    voiceUi()
    if (text) sendText(text, { voice: true })
    if (ears) setTimeout(startEars, 400)
  }
  r.start()
  voiceUi()
}

/** "Jarvis, add bio lab due Friday" -> "add bio lab due Friday"; "Jarvis" alone -> ''; no name -> null */
function afterName(t) {
  const m = /\b(?:hey\s+)?jarvis\b[\s,.!?:]*(.*)$/i.exec(t)
  return m ? m[1].trim() : null
}

function startEars() {
  if (!ears || document.hidden || recMode === 'mic' || talking || rec) return
  const r = makeRec(true)
  rec = r
  recMode = 'ears'
  r.onresult = (e) => {
    const res = e.results[e.results.length - 1]
    const heard = res[0].transcript.trim()
    if (!res.isFinal) {
      if (Date.now() < armedUntil || afterName(heard) !== null) {
        input.value = heard
        grow()
      }
      return
    }
    const ask = Date.now() < armedUntil ? (afterName(heard) ?? heard) : afterName(heard)
    input.value = ''
    grow()
    if (ask === null) return
    if (!ask) {
      armedUntil = Date.now() + 8000 // "Jarvis..." then a pause
      setTimeout(voiceUi, 8100)
      voiceUi()
      return
    }
    armedUntil = 0
    sendText(ask, { voice: true })
    voiceUi()
  }
  r.onend = () => {
    if (rec !== r) return
    rec = null
    recMode = null
    voiceUi()
    // iOS ends continuous listening every so often; pick it straight back up.
    if (ears && !document.hidden) setTimeout(startEars, 300)
  }
  r.onerror = (e) => {
    if (e.error === 'not-allowed') {
      ears = false
      store.set('jv-ears', false)
      toast('Allow the microphone for Jarvis in Settings → Safari → Microphone')
    }
  }
  try {
    r.start()
  } catch {
    rec = null
    recMode = null
  }
  voiceUi()
}

// ---------- speaking ----------
let voicePick = null
function jarvisVoice() {
  if (voicePick) return voicePick
  const vs = speechSynthesis.getVoices()
  voicePick = ['Daniel', 'Arthur', 'Oliver', 'Google UK English Male'].map((n) => vs.find((v) => v.name.startsWith(n))).find(Boolean) ?? vs.find((v) => v.lang === 'en-GB') ?? null
  return voicePick
}
// iOS only lets a page speak after a tap has spoken once.
let unlocked = false
function unlockSpeech() {
  if (unlocked || !('speechSynthesis' in window)) return
  unlocked = true
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  speechSynthesis.speak(u)
}
function speak(text) {
  if (!('speechSynthesis' in window)) return
  // Not while listening: he'd hear himself.
  const resume = ears
  if (recMode === 'ears') stopRec()
  talking = true
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ''))
  const v = jarvisVoice()
  if (v) u.voice = v
  u.rate = 1.05
  let done = false
  u.onend = u.onerror = () => {
    if (done) return
    done = true
    talking = false
    if (resume) setTimeout(startEars, 300)
  }
  // Some phones never say they finished: listen again after the reply's length anyway.
  setTimeout(() => u.onend(), 2500 + text.length * 90)
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
}

setupVoice()

// ---------- updates ----------
/** A newer version on the site: reload into it (checked on every open). */
async function checkUpdate() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
    const { v } = await r.json()
    // One reload per open, so a stale cache can never loop it.
    if (v > VERSION && sessionStorage.getItem('jv-reloaded') !== String(v)) {
      sessionStorage.setItem('jv-reloaded', String(v))
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
      await Promise.all(regs.map((g) => g.update().catch(() => {})))
      location.reload()
    }
  } catch { /* offline: next time */ }
}
checkUpdate()
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate() })

// ---------- next up ----------
function renderNext() {
  const el = $('#next')
  const open = (list?.tasks ?? []).filter((t) => !isDone(t))
  const dated = open.filter((t) => t.due).sort((a, b) => new Date(a.due.length === 10 ? a.due + 'T23:59' : a.due) - new Date(b.due.length === 10 ? b.due + 'T23:59' : b.due))
  const t = dated[0] ?? open[0]
  if (!t) return (el.innerHTML = '')
  const due = dueOf(t.due)
  el.innerHTML = `<div class="next" style="--c:${CAT[t.category] ?? '#19e3ff'}">
    <div class="next-label">NEXT UP</div>
    <div class="next-title">${esc(t.title)}</div>
    <div class="next-meta">${due ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : '<span>No due date</span>'}<span>${esc(t.category)}</span>${open.length > 1 ? `<span>+${open.length - 1} more</span>` : ''}</div>
  </div>`
}

// ---------- quick add (straight onto the list, no Jarvis needed) ----------
let localAdds = store.get('jv-adds', [])
const saveAdds = () => store.set('jv-adds', localAdds)
/** Local adds the PC hasn't confirmed yet (a newer list without them means not yet). */
function pendingAdds() {
  const titles = new Set((list?.tasks ?? []).map((t) => t.title.toLowerCase()))
  localAdds = localAdds.filter((a) => !(list && list.at > a.at && titles.has(a.title.toLowerCase())) && Date.now() - a.at < 7 * 86400000)
  saveAdds()
  return localAdds
}
const addForm = { category: 'SCHOOL', due: '', effort: 'medium' }
function openSheet(id) {
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = s.id !== id))
  $('#scrim').hidden = false
  setTimeout(() => document.body.classList.add('sheet-open'), 20)
  if (id === 'add-sheet') setTimeout(() => $('#add-title').focus(), 250)
}
function closeSheets() {
  document.body.classList.remove('sheet-open')
  setTimeout(() => {
    document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true))
    $('#scrim').hidden = true
  }, 250)
}
function isoDay(offset) {
  const d = new Date(Date.now() + offset * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function pickIn(group, value) {
  document.querySelectorAll(`[data-${group}]`).forEach((b) => b.classList.toggle('on', b.dataset[group] === value))
}
function setupAdd() {
  $('#add-sheet').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.cat) { addForm.category = b.dataset.cat; pickIn('cat', b.dataset.cat) }
    if (b.dataset.day !== undefined) {
      addForm.due = b.dataset.day === 'pick' ? addForm.due : b.dataset.day === '' ? '' : isoDay(Number(b.dataset.day))
      pickIn('day', b.dataset.day)
      if (b.dataset.day === 'pick') { const d = $('#add-date'); d.showPicker?.(); d.focus() }
    }
    if (b.dataset.effort) { addForm.effort = b.dataset.effort; pickIn('effort', b.dataset.effort) }
  })
  $('#add-date').addEventListener('change', (e) => { addForm.due = e.target.value; pickIn('day', 'pick') })
  $('#add-form').onsubmit = async (e) => {
    e.preventDefault()
    const title = $('#add-title').value.trim()
    if (!title) return $('#add-title').focus()
    const a = { id: uid(), title, category: addForm.category, due: addForm.due || null, effort: addForm.effort, at: Date.now() }
    localAdds.push(a)
    saveAdds()
    $('#add-title').value = ''
    closeSheets()
    renderList()
    try {
      await publish({ t: 'add', id: a.id, task: { title: a.title, category: a.category, due: a.due, effort: a.effort } })
      toast(online() ? `✓ Added ${a.title}` : `✓ Added. On your PC's list when it turns on`)
    } catch {
      a.failed = true
      saveAdds()
      toast('No signal. Saved here, will send when you are back online')
    }
  }
  pickIn('cat', addForm.category)
  pickIn('day', '')
  pickIn('effort', addForm.effort)
}
async function resendAdds() {
  for (const a of localAdds.filter((x) => x.failed)) {
    try {
      await publish({ t: 'add', id: a.id, task: { title: a.title, category: a.category, due: a.due, effort: a.effort } })
      a.failed = false
    } catch { /* still offline */ }
  }
  saveAdds()
}

// ---------- photos ----------
/** Photo -> 1600px JPEG -> sealed -> ntfy attachment. Kept on the phone until Jarvis answers. */
async function shrink(file, max, quality) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url })
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * scale)
    c.height = Math.round(img.naturalHeight * scale)
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(url)
  }
}
async function sealBytes(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), bytes))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}
async function uploadPhoto(m) {
  const dataUrl = store.get(`jv-photo-${m.id}`, null)
  if (!dataUrl) throw new Error('photo no longer on this phone')
  const bytes = b64u.dec(dataUrl.split(',')[1].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  const r = await fetch(`${RELAY}/${pair.i}`, {
    method: 'PUT',
    body: new Blob([await sealBytes(bytes)]),
    headers: { Filename: 'p.bin', 'X-Message': await seal({ t: 'photo', id: m.id, text: m.text, at: m.at }) },
  })
  if (!r.ok) throw new Error(`relay ${r.status}`)
}
async function sendPhoto(file) {
  const caption = input.value.trim()
  input.value = ''
  grow()
  const m = { id: uid(), me: true, kind: 'photo', text: caption, at: Date.now(), status: 'sending' }
  try {
    m.thumb = await shrink(file, 360, 0.6)
    store.set(`jv-photo-${m.id}`, await shrink(file, 1600, 0.72))
  } catch {
    return toast("Couldn't read that photo")
  }
  chat.push(m)
  saveChat()
  renderChat()
  renderList()
  try {
    await uploadPhoto(m)
    m.status = 'sent'
    toast(online() ? '✓ Photo sent. Jarvis is reading it' : '✓ Photo saved. Jarvis reads it when your PC is on (open the app at home)')
  } catch {
    m.status = 'failed'
    toast('No signal. Photo saved here, will send when you are back online')
  }
  saveChat()
  renderChat()
  renderList()
  ping()
}
// The relay keeps photos 3 hours: anything Jarvis hasn't answered goes again when the app opens.
async function resendPhotos() {
  for (const m of chat) {
    if (m.kind !== 'photo' || !m.me || m.status === 'replied') continue
    const stale = Date.now() - (m.resent ?? m.at) > 2.5 * 3600_000
    if (m.status !== 'failed' && !(m.status !== 'ack' && stale)) continue
    if (Date.now() - m.at > 3 * 86400000) continue
    try {
      await uploadPhoto(m)
      m.status = 'sent'
      m.resent = Date.now()
    } catch { /* next time */ }
  }
  saveChat()
}
function forgetPhoto(id) {
  try { localStorage.removeItem(`jv-photo-${id}`) } catch { /* fine */ }
}

// ---------- lock-screen notifications (ntfy app) ----------
const NTFY_APP = 'https://apps.apple.com/app/ntfy/id1625396347'
function renderNotifyCard() {
  const el = $('#notify-card')
  const topic = store.get('jv-notify-topic', null)
  if (!topic) return (el.innerHTML = '')
  el.innerHTML = store.get('jv-notify-ok', false)
    ? '<button class="linkish" data-open="notify-sheet">🔔 Lock-screen notifications</button>'
    : `<div class="setup-card"><div><b>Get reminders on your lock screen</b><span>Even when your PC is off. Takes a minute.</span></div><button class="btn small" data-open="notify-sheet">Set up</button></div>`
}
function setupNotify() {
  $('#copy-topic').onclick = async () => {
    const topic = store.get('jv-notify-topic', '')
    try {
      await navigator.clipboard.writeText(topic)
      toast('Copied. Paste it in ntfy')
    } catch {
      $('#topic-text').select?.()
      toast('Press and hold the name to copy it')
    }
  }
  $('#test-notify').onclick = async () => {
    const topic = store.get('jv-notify-topic', '')
    try {
      await fetch(`${RELAY}/${topic}?title=Jarvis`, { method: 'POST', body: 'Lock-screen notifications work. Nice.', headers: { 'X-Tags': 'white_check_mark' } })
      toast('Sent. It should pop up in a few seconds')
    } catch {
      toast("Couldn't send the test. Check your connection")
    }
  }
  $('#notify-done').onclick = () => {
    store.set('jv-notify-ok', true)
    closeSheets()
    renderNotifyCard()
  }
}

// ---------- wiring for the sheets and the camera ----------
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]')
  if (opener) {
    e.preventDefault()
    if (opener.dataset.open === 'notify-sheet') $('#topic-text').value = store.get('jv-notify-topic', '')
    return openSheet(opener.dataset.open)
  }
  if (e.target.closest('[data-photo]')) {
    e.preventDefault()
    unlockSpeech()
    $('#photo-input').click()
  }
})
$('#photo-input').addEventListener('change', (e) => {
  const f = e.target.files?.[0]
  e.target.value = ''
  if (f) sendPhoto(f)
})
$('#scrim').onclick = closeSheets
setupAdd()
setupNotify()
renderNotifyCard()
renderList()
