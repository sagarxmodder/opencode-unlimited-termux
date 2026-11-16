const TOKEN_KEY = "zycron.token"
const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const SIZES = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1024, 1024],
  "4:3": [1024, 768],
  "3:4": [768, 1024]
}

const state = {
  token: "",
  video: null,
  scenes: [],
  active: 0,
  mode: "storyboard",
  providers: [],
  videos: [],
  images: [],
  playing: false,
  previewToken: 0,
  saveTimer: null,
  saveChain: Promise.resolve(),
  busy: false,
  recognition: null,
  audioContext: null
}

class FlowError extends Error {}

function uid() {
  return `scene-${Math.random().toString(36).slice(2, 9)}`
}

function authHeaders(extra = {}) {
  return state.token ? { ...extra, authorization: `Bearer ${state.token}` } : extra
}

async function api(path, { method = "GET", body, raw = false, signal } = {}) {
  const headers = authHeaders({ accept: raw ? "*/*" : "application/json" })
  if (body !== undefined && !raw) headers["content-type"] = "application/json"
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal
  })
  if (response.status === 401) {
    showTokenGate()
    throw new FlowError("access token required")
  }
  if (raw) {
    if (!response.ok) throw new FlowError(`request failed (${response.status})`)
    return response
  }
  const text = await response.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new FlowError("server returned an invalid response")
  }
  if (!response.ok) throw new FlowError(data.error || `request failed (${response.status})`)
  return data
}

function toast(message, bad = false) {
  const node = document.createElement("div")
  node.className = bad ? "toast bad" : "toast"
  node.textContent = message
  $("#toasts").append(node)
  setTimeout(() => node.remove(), 4200)
}

function bootToken() {
  const params = new URLSearchParams(location.search)
  const queryToken = params.get("token")
  if (queryToken) {
    localStorage.setItem(TOKEN_KEY, queryToken)
    params.delete("token")
    history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`)
  }
  state.token = localStorage.getItem(TOKEN_KEY) || ""
}

function showTokenGate() {
  $("#tokenGate").hidden = false
  setTimeout(() => $("#tokenInput").focus(), 30)
}

async function boot() {
  bootToken()
  bind()
  setStatus("loading")
  try {
    const data = await api("/api/bootstrap")
    state.providers = (data.providers || []).filter((provider) => provider.enabled)
    state.videos = data.videos || []
    const latest = state.videos[0]
    if (latest) openVideo(latest)
    else newDraft()
    renderProviders()
    renderLibrary()
    renderAll()
    setStatus("ready")
  } catch (error) {
    setStatus("offline", "bad")
    toast(error.message, true)
  }
}

function newDraft() {
  state.video = null
  state.scenes = [{ id: uid(), prompt: "", duration: 4, motion: "zoom-in", transition: "fade", image: "", seed: 0 }]
  state.active = 0
  state.mode = "storyboard"
  state.images = []
  $("#title").value = "Untitled film"
  $("#aspect").value = "16:9"
  syncMode()
  resizeCanvas()
  renderAll()
}

function openVideo(video) {
  state.video = video
  state.scenes = (video.scenes || []).length
    ? video.scenes.map((scene) => ({ ...scene, id: scene.id || uid() }))
    : [{ id: uid(), prompt: "", duration: 4, motion: "zoom-in", transition: "fade", image: "", seed: 0 }]
  state.active = 0
  state.mode = video.mode === "provider" ? "provider" : "storyboard"
  state.images = []
  $("#title").value = video.title || "Untitled film"
  $("#aspect").value = SIZES[video.aspect] ? video.aspect : "16:9"
  if (video.providerId) $("#providerSelect").value = video.providerId
  if (video.model) $("#modelInput").value = video.model
  syncMode()
  resizeCanvas()
  loadImages()
  showPlayer(video)
  renderActions()
  renderAll()
}

function showPlayer(video) {
  const player = $("#player")
  if (video?.file) {
    player.hidden = false
    $("#canvas").hidden = true
    $("#stageEmpty").hidden = true
    player.src = `${video.file}?v=${video.updatedAt || Date.now()}`
    $("#downloadBtn").disabled = false
  } else {
    player.hidden = true
    player.removeAttribute("src")
    $("#canvas").hidden = false
    $("#downloadBtn").disabled = true
  }
}

function setStatus(text, tone = "") {
  const chip = $("#statusChip")
  chip.textContent = text
  chip.className = `status ${tone}`.trim()
}

function activeScene() {
  return state.scenes[state.active] || state.scenes[0]
}

function totalDuration() {
  return state.scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0)
}

function fmt(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
}

function renderAll() {
  renderScenes()
  renderTimeline()
  renderEditor()
  renderActions()
  $("#sceneCount").textContent = String(state.scenes.length)
  $("#timeLabel").textContent = `${fmt(0)} / ${fmt(totalDuration())}`
}

function renderScenes() {
  const list = $("#sceneList")
  list.innerHTML = ""
  state.scenes.forEach((scene, index) => {
    const row = document.createElement("button")
    row.className = `scene${index === state.active ? " on" : ""}`
    row.dataset.index = String(index)
    row.innerHTML = `
      <span class="num">${String(index + 1).padStart(2, "0")}</span>
      ${scene.image ? `<img class="thumb" src="${scene.image}" alt="">` : `<span class="thumb"></span>`}
      <span class="meta"><b>${escapeHtml(scene.prompt || "New scene")}</b><small>${scene.duration.toFixed(1)}s · ${scene.motion.replace("-", " ")}</small></span>`
    row.addEventListener("click", () => {
      state.active = index
      renderAll()
    })
    list.append(row)
  })
}

function renderTimeline() {
  const timeline = $("#timeline")
  timeline.innerHTML = ""
  state.scenes.forEach((scene, index) => {
    const block = document.createElement("button")
    block.className = `tl-scene${index === state.active ? " on" : ""}`
    block.style.flex = `${Math.max(1, scene.duration)} 0 0`
    block.innerHTML = `<b>${index + 1}</b> ${scene.duration.toFixed(1)}s`
    block.addEventListener("click", () => {
      state.active = index
      renderAll()
      drawIdleFrame()
    })
    timeline.append(block)
  })
}

function renderEditor() {
  const scene = activeScene()
  if (!scene) return
  const prompt = $("#scenePrompt")
  if (document.activeElement !== prompt) prompt.value = scene.prompt
  $("#sceneDuration").value = String(scene.duration)
  $("#durationValue").textContent = `${Number(scene.duration).toFixed(1)}s`
  $("#sceneMotion").value = scene.motion
  $("#sceneTransition").value = scene.transition
}

function renderActions() {
  const hasPrompts = state.scenes.some((scene) => scene.prompt.trim())
  const ready = state.scenes.length > 0 && state.scenes.every((scene) => scene.image)
  $("#storyboardBtn").textContent = state.mode === "provider" ? "Generate AI video" : "Generate storyboard"
  $("#voicePlayBtn").disabled = !state.video?.voice || state.busy
  $("#voiceBtn").disabled = state.busy
  $("#renderBtn").hidden = state.mode === "provider"
  $("#renderBtn").disabled = !ready || state.busy
  $("#storyboardBtn").disabled = !hasPrompts || state.busy
  $("#actionNote").textContent = state.mode === "provider"
    ? "Sends the full story to your provider's video API. This can take a few minutes."
    : "Storyboard uses your image provider, or free Pollinations, or your own uploaded frames. Rendering composes them into a WebM in real time."
  $("#stageHint").textContent = state.mode === "provider" ? "ai video · provider" : "storyboard mode · keyless"
}

function renderImageProviders() {
  const select = $("#imageProviderSelect")
  select.innerHTML = ""
  const free = document.createElement("option")
  free.value = ""
  free.textContent = "Pollinations · free"
  select.append(free)
  for (const provider of state.providers) {
    const option = document.createElement("option")
    option.value = provider.id
    option.textContent = provider.name
    select.append(option)
  }
}

function renderVoiceProviders() {
  const select = $("#voiceProviderSelect")
  if (!select) return
  const previous = select.value
  select.innerHTML = ""
  const free = document.createElement("option")
  free.value = ""
  free.textContent = "Free · Google"
  select.append(free)
  for (const provider of state.providers) {
    const option = document.createElement("option")
    option.value = provider.id
    option.textContent = provider.name
    select.append(option)
  }
  select.value = previous
}

function renderProviders() {
  renderImageProviders()
  renderVoiceProviders()
  const select = $("#providerSelect")
  select.innerHTML = ""
  if (!state.providers.length) {
    const option = document.createElement("option")
    option.value = ""
    option.textContent = "No providers configured"
    select.append(option)
    return
  }
  const videoish = state.providers.filter((provider) => /openai|google|gemini/i.test(`${provider.id} ${provider.name} ${provider.baseUrl}`))
  for (const provider of videoish.length ? videoish : state.providers) {
    const option = document.createElement("option")
    option.value = provider.id
    option.textContent = provider.name
    select.append(option)
  }
  if (state.video?.providerId) select.value = state.video.providerId
}

function renderLibrary() {
  const list = $("#libraryList")
  list.innerHTML = ""
  if (!state.videos.length) {
    list.innerHTML = `<p class="note">No films yet. Generate a storyboard to save your first one.</p>`
    return
  }
  for (const video of state.videos) {
    const item = document.createElement("div")
    item.className = "lib-item"
    item.innerHTML = `
      <img src="${video.poster || video.scenes?.[0]?.image || "/favicon.svg"}" alt="" loading="lazy">
      <span><b>${escapeHtml(video.title)}</b><small>${video.scenes?.length || 0} scenes · ${fmt(video.duration)} · ${video.status}</small></span>
      <button class="del" title="Delete">✕</button>`
    item.addEventListener("click", (event) => {
      if (event.target.closest(".del")) return
      openVideo(video)
      $("#library").hidden = true
    })
    item.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`Delete "${video.title}"?`)) return
      try {
        await api(`/api/videos/${encodeURIComponent(video.id)}`, { method: "DELETE" })
        state.videos = state.videos.filter((item) => item.id !== video.id)
        if (state.video?.id === video.id) newDraft()
        renderLibrary()
        toast("Film deleted")
      } catch (error) {
        toast(error.message, true)
      }
    })
    list.append(item)
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}

function syncMode() {
  $$("#modeTabs .tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.mode === state.mode))
  $("#providerBox").hidden = state.mode !== "provider"
  $("#imageBox").hidden = state.mode !== "storyboard"
}

function resizeCanvas() {
  const [width, height] = SIZES[$("#aspect").value] || SIZES["16:9"]
  const canvas = $("#canvas")
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
    drawIdleFrame()
  }
}

function currentStore() {
  return {
    title: $("#title").value.trim() || "Untitled film",
    aspect: $("#aspect").value,
    scenes: state.scenes,
    mode: state.mode,
    providerId: $("#providerSelect").value || "",
    model: $("#modelInput").value.trim()
  }
}

function scheduleSave() {
  if (!state.video) return
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(() => {
    persist().catch(() => {})
  }, 700)
}

function persist() {
  state.saveChain = state.saveChain.then(async () => {
    if (!state.video) return null
    const data = await api(`/api/videos/${encodeURIComponent(state.video.id)}`, { method: "PATCH", body: currentStore() })
    state.video = data.video
    return data.video
  })
  return state.saveChain
}

async function ensureVideo() {
  if (state.video) {
    await persist()
    return state.video
  }
  const store = currentStore()
  const data = await api("/api/videos", {
    method: "POST",
    body: { ...store, prompt: state.scenes[0]?.prompt || "", scenes: state.scenes }
  })
  state.video = data.video
  state.scenes = data.video.scenes
  state.videos.unshift(data.video)
  renderLibrary()
  return state.video
}

function overlay(show, title = "", text = "", progress = 0) {
  const node = $("#overlay")
  node.hidden = !show
  if (show) {
    $("#overlayTitle").textContent = title
    $("#overlayText").textContent = text
    $("#overlayBar").style.width = `${Math.max(0, Math.min(100, progress))}%`
  }
}

function setBusy(value) {
  state.busy = value
  renderActions()
}

async function generateStoryboard() {
  const prompt = state.scenes.find((scene) => scene.prompt.trim())
  if (!prompt) return toast("Write a scene prompt first", true)
  setBusy(true)
  setStatus("storyboarding", "busy")
  overlay(true, "Painting scenes", "Sending prompts to the image model…", 4)
  let poll = null
  try {
    const video = await ensureVideo()
    poll = setInterval(async () => {
      try {
        const data = await api(`/api/videos/${encodeURIComponent(video.id)}`)
        const progress = data.video.progress || 0
        overlay(true, "Painting scenes", `${progress}% of the storyboard ready`, Math.max(6, progress))
        if (data.video.status === "failed") overlay(true, "Painting scenes", data.video.error, progress)
      } catch {}
    }, 1600)
    const data = await api(`/api/videos/${encodeURIComponent(video.id)}/storyboard`, {
      method: "POST",
      body: {
        style: $("#styleInput").value.trim(),
        seed: Number($("#seed").value) || 0,
        imageProviderId: $("#imageProviderSelect").value || "",
        imageModel: $("#imageModel").value.trim()
      }
    })
    state.video = data.video
    state.scenes = data.video.scenes
    state.videos = [data.video, ...state.videos.filter((item) => item.id !== data.video.id)]
    renderLibrary()
    loadImages()
    showPlayer(data.video)
    renderAll()
    setStatus("storyboard ready", "live")
    toast("Storyboard ready — review the scenes, then render")
  } catch (error) {
    setStatus("failed", "bad")
    const message = /unsplash|402|503|429|image generation/i.test(error.message)
      ? `${error.message} — pick an image provider or upload a frame per scene`
      : error.message
    toast(message, true)
  } finally {
    if (poll) clearInterval(poll)
    overlay(false)
    setBusy(false)
  }
}

async function uploadFrame(file) {
  if (!file) return
  if (!file.type.startsWith("image/")) return toast("Pick an image file", true)
  try {
    const video = await ensureVideo()
    overlay(true, "Uploading frame", `${Math.round(file.size / 1024)} KB`, 60)
    const response = await fetch(`/api/videos/${encodeURIComponent(video.id)}/scenes/${state.active}/image`, {
      method: "POST",
      headers: authHeaders({ "content-type": file.type }),
      body: file
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new FlowError(data.error || `upload failed (${response.status})`)
    state.video = data.video
    state.scenes = data.video.scenes
    state.videos = [data.video, ...state.videos.filter((item) => item.id !== data.video.id)]
    renderLibrary()
    loadImages()
    renderAll()
    toast("Frame added")
  } catch (error) {
    toast(error.message, true)
  } finally {
    overlay(false)
  }
}

async function generateProvider() {
  if (!state.providers.length) return toast("Add a provider in Settings first", true)
  if (!$("#providerSelect").value) return toast("Select a provider", true)
  if (!state.scenes.some((scene) => scene.prompt.trim())) return toast("Write a scene prompt first", true)
  setBusy(true)
  setStatus("queued", "busy")
  overlay(true, "Generating video", "Sending the story to the provider…", 3)
  try {
    const video = await ensureVideo()
    await api(`/api/videos/${encodeURIComponent(video.id)}/render`, { method: "POST", body: {} })
    const deadline = Date.now() + 16 * 60 * 1000
    while (Date.now() < deadline) {
      await sleep(2500)
      const data = await api(`/api/videos/${encodeURIComponent(video.id)}`)
      const next = data.video
      state.video = next
      overlay(true, "Generating video", next.error || `${next.status} · ${next.progress || 0}%`, Math.max(4, next.progress || 0))
      if (next.status === "ready") {
        showPlayer(next)
        state.videos = [next, ...state.videos.filter((item) => item.id !== next.id)]
        renderLibrary()
        renderAll()
        setStatus("ready", "live")
        toast("Video ready")
        break
      }
      if (next.status === "failed") throw new FlowError(next.error || "video generation failed")
    }
  } catch (error) {
    setStatus("failed", "bad")
    toast(error.message, true)
  } finally {
    overlay(false)
    setBusy(false)
  }
}

function loadImages() {
  state.images = []
  const token = ++state.previewToken
  const loaded = state.scenes.map((scene) => {
    if (!scene.image) return Promise.resolve(null)
    return loadImage(scene.image).catch(() => null)
  })
  Promise.all(loaded).then((images) => {
    if (token !== state.previewToken) return
    state.images = images
    drawIdleFrame()
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = "async"
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("image failed to load"))
    image.src = src
  })
}

function drawIdleFrame() {
  const canvas = $("#canvas")
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = "#050507"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const image = state.images[state.active]
  if (!image) {
    canvas.classList.add("idle")
    return
  }
  canvas.classList.remove("idle")
  drawSceneStill(ctx, image, canvas.width, canvas.height)
}

function drawSceneStill(ctx, image, width, height) {
  const base = Math.max(width / image.width, height / image.height) * 1.04
  const drawWidth = image.width * base
  const drawHeight = image.height * base
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
}

function cameraAt(motion, p, width) {
  switch (motion) {
    case "zoom-in": return { scale: 1.03 + 0.1 * p, dx: 0 }
    case "zoom-out": return { scale: 1.13 - 0.1 * p, dx: 0 }
    case "pan-left": return { scale: 1.12, dx: (0.5 - p) * 0.1 * width }
    case "pan-right": return { scale: 1.12, dx: (p - 0.5) * 0.1 * width }
    default: return { scale: 1.05, dx: 0 }
  }
}

function drawFrameAt(time) {
  const canvas = $("#canvas")
  const ctx = canvas.getContext("2d")
  const width = canvas.width
  const height = canvas.height
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, width, height)
  const scenes = state.scenes
  let cursor = 0
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index]
    const duration = Number(scene.duration) || 4
    const image = state.images[index]
    if (time < cursor + duration || index === scenes.length - 1) {
      const local = Math.min(duration, Math.max(0, time - cursor))
      const p = duration ? local / duration : 0
      if (index > 0 && scene.transition !== "cut" && local < 0.6 && state.images[index - 1]) {
        const blend = local / 0.6
        const previous = scenes[index - 1]
        const prevLocal = Number(previous.duration) || 4
        drawMotion(ctx, state.images[index - 1], previous.motion, 1, width, height)
        if (image) {
          ctx.globalAlpha = blend
          drawMotion(ctx, image, scene.motion, p, width, height)
          ctx.globalAlpha = 1
        }
        return { index, local, prevLocal }
      }
      if (image) drawMotion(ctx, image, scene.motion, p, width, height)
      return { index, local }
    }
    cursor += duration
  }
  return { index: 0, local: 0 }
}

function drawMotion(ctx, image, motion, p, width, height) {
  const camera = cameraAt(motion, p, width)
  const base = Math.max(width / image.width, height / image.height) * camera.scale
  const drawWidth = image.width * base
  const drawHeight = image.height * base
  ctx.drawImage(
    image,
    (width - drawWidth) / 2 + camera.dx,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  )
}

function preview() {
  if (state.video?.file && !$("#player").hidden) {
    const player = $("#player")
    if (player.paused) player.play().catch(() => {})
    else player.pause()
    return
  }
  if (!state.images.some(Boolean)) return toast("Generate a storyboard first", true)
  if (state.playing) {
    state.playing = false
    state.previewToken++
    $("#playIcon").textContent = "▶"
    drawIdleFrame()
    return
  }
  const total = totalDuration()
  const token = ++state.previewToken
  state.playing = true
  $("#playIcon").textContent = "❚❚"
  const started = performance.now()
  const tick = () => {
    if (!state.playing || token !== state.previewToken) return
    const elapsed = (performance.now() - started) / 1000
    drawFrameAt(Math.min(elapsed, total - 0.01))
    $("#timeLabel").textContent = `${fmt(elapsed)} / ${fmt(total)}`
    if (elapsed >= total) {
      state.playing = false
      $("#playIcon").textContent = "▶"
      drawIdleFrame()
      $("#timeLabel").textContent = `${fmt(0)} / ${fmt(total)}`
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function pickMime(withAudio = false) {
  const candidates = withAudio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return "video/webm"
}

async function attachVoice(stream, url) {
  if (!url) return null
  try {
    const audio = new Audio()
    audio.src = url
    audio.preload = "auto"
    await new Promise((resolve, reject) => {
      audio.onloadedmetadata = resolve
      audio.onerror = () => reject(new Error("voice track failed to load"))
      setTimeout(resolve, 2500)
    })
    const Context = window.AudioContext || window.webkitAudioContext
    if (!Context) return null
    state.audioContext = new Context()
    if (state.audioContext.state === "suspended") await state.audioContext.resume().catch(() => {})
    const source = state.audioContext.createMediaElementSource(audio)
    const destination = state.audioContext.createMediaStreamDestination()
    source.connect(destination)
    destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track))
    return audio
  } catch {
    closeAudio()
    return null
  }
}

function closeAudio() {
  try {
    state.audioContext?.close()
  } catch {}
  state.audioContext = null
}

function titleFromPrompt(prompt) {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function narrationScript() {
  const typed = $("#narrationText").value.trim()
  if (typed) return typed.slice(0, 3800)
  return state.scenes.map((scene) => scene.prompt.trim()).filter(Boolean).join(". ").slice(0, 3800)
}

function dictate(target, button) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Recognition) return toast("Voice input needs Chrome or Edge", true)
  if (state.recognition) {
    state.recognition.stop()
    state.recognition = null
    $$(".mic").forEach((node) => node.classList.remove("on", "pulse"))
    return
  }
  const recognition = new Recognition()
  recognition.lang = "en-US"
  recognition.interimResults = true
  recognition.continuous = false
  const base = target.value.trim()
  recognition.onresult = (event) => {
    let transcript = ""
    for (const result of event.results) transcript += result[0].transcript
    target.value = `${base ? `${base} ` : ""}${transcript}`.trim()
    target.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const finish = () => {
    button.classList.remove("on", "pulse")
    if (state.recognition === recognition) state.recognition = null
  }
  recognition.onend = finish
  recognition.onerror = (event) => {
    finish()
    if (event.error !== "aborted") toast("Voice input stopped — check the microphone permission", true)
  }
  try {
    recognition.start()
  } catch {
    return toast("Voice input is already starting", true)
  }
  button.classList.add("on", "pulse")
  state.recognition = recognition
}

async function fallbackFrame(scene, index) {
  const [width, height] = SIZES[$("#aspect").value] || SIZES["16:9"]
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  let hash = 0
  for (const char of `${scene.prompt}${index}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `hsl(${hue} 62% 12%)`)
  gradient.addColorStop(0.55, `hsl(${(hue + 40) % 360} 70% 8%)`)
  gradient.addColorStop(1, `hsl(${(hue + 300) % 360} 55% 6%)`)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  const glow = ctx.createRadialGradient(width * 0.7, height * 0.3, 0, width * 0.7, height * 0.3, width * 0.7)
  glow.addColorStop(0, `hsla(${hue} 90% 65% / 0.35)`)
  glow.addColorStop(1, "transparent")
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = "rgba(255,255,255,0.92)"
  ctx.textAlign = "left"
  ctx.textBaseline = "top"
  const size = Math.round(width * 0.052)
  ctx.font = `600 ${size}px "Inter", system-ui, sans-serif`
  const maxWidth = width * 0.78
  const words = scene.prompt.split(/\s+/)
  const lines = []
  let line = ""
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
      if (lines.length === 5) break
    } else line = test
  }
  if (line && lines.length < 6) lines.push(line)
  lines.slice(0, 6).forEach((text, row) => {
    ctx.fillText(text, width * 0.09, height * 0.34 + row * size * 1.32)
  })
  ctx.fillStyle = "rgba(167,139,250,0.9)"
  ctx.font = `600 ${Math.round(width * 0.016)}px "Inter", system-ui, sans-serif`
  ctx.fillText(`ZYCRON FLOW · SCENE ${String(index + 1).padStart(2, "0")}`, width * 0.09, height * 0.82)
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
}

async function paintFallbackScenes(video) {
  for (let index = 0; index < state.scenes.length; index++) {
    const blob = await fallbackFrame(state.scenes[index], index)
    if (!blob) throw new FlowError("could not draw a fallback frame")
    const response = await fetch(`/api/videos/${encodeURIComponent(video.id)}/scenes/${index}/image`, {
      method: "POST",
      headers: authHeaders({ "content-type": "image/png" }),
      body: blob
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new FlowError(data.error || `frame upload failed (${response.status})`)
    state.video = data.video
  }
  state.scenes = state.video.scenes
  loadImages()
  renderAll()
  return state.video
}

async function quickCreate() {
  if (state.busy) return
  const prompt = $("#quickPrompt").value.trim() || $("#scenePrompt").value.trim()
  if (!prompt) return toast("Describe your film, or tap the mic and speak", true)
  const duration = Math.min(8, Math.max(3, Number($("#sceneDuration").value) || 4))
  state.scenes = [{
    id: uid(),
    prompt,
    duration,
    motion: $("#sceneMotion").value,
    transition: "fade",
    image: "",
    seed: 0
  }]
  state.active = 0
  state.video = null
  state.mode = "storyboard"
  $("#title").value = titleFromPrompt(prompt)
  syncMode()
  renderAll()
  setBusy(true)
  setStatus("creating", "busy")
  overlay(true, "Creating film", "Saving the storyboard…", 3)
  try {
    const video = await ensureVideo()
    overlay(true, "Creating film", "Painting the scene…", 10)
    try {
      const data = await api(`/api/videos/${encodeURIComponent(video.id)}/storyboard`, {
        method: "POST",
        body: {
          style: $("#styleInput").value.trim(),
          seed: Number($("#seed").value) || 0,
          imageProviderId: $("#imageProviderSelect").value || "",
          imageModel: $("#imageModel").value.trim()
        }
      })
      state.video = data.video
      state.scenes = data.video.scenes
    } catch {
      overlay(true, "Creating film", "Image service busy — drawing typographic frames…", 30)
      await paintFallbackScenes(video)
      toast("Image service was unavailable — used typographic frames")
    }
    renderLibrary()
    loadImages()
    renderAll()
    if ($("#quickVoice").checked) {
      overlay(true, "Recording narration", "Synthesizing the voice track…", 90)
      try {
        const data = await api(`/api/videos/${encodeURIComponent(state.video.id)}/voice`, {
          method: "POST",
          body: {
            text: narrationScript(),
            voice: $("#voiceName").value,
            providerId: $("#voiceProviderSelect").value || "",
            lang: "en"
          }
        })
        state.video = data.video
        renderActions()
      } catch (error) {
        toast(`Voice skipped: ${error.message}`, true)
      }
    }
    overlay(true, "Rendering film", "Compositing the final cut…", 94)
    await renderFilm({ autoDownload: true })
  } catch (error) {
    setStatus("failed", "bad")
    toast(error.message, true)
  } finally {
    overlay(false)
    setBusy(false)
  }
}

async function generateVoice() {
  if (state.busy) return
  const script = narrationScript()
  if (!script) return toast("Write a scene first", true)
  setBusy(true)
  setStatus("voice", "busy")
  overlay(true, "Recording narration", "Synthesizing the voice track…", 35)
  try {
    const video = await ensureVideo()
    const data = await api(`/api/videos/${encodeURIComponent(video.id)}/voice`, {
      method: "POST",
      body: {
        text: script,
        voice: $("#voiceName").value,
        providerId: $("#voiceProviderSelect").value || "",
        lang: "en"
      }
    })
    state.video = data.video
    state.videos = [data.video, ...state.videos.filter((item) => item.id !== data.video.id)]
    renderLibrary()
    renderActions()
    toast("Narration ready — render to include it")
  } catch (error) {
    toast(error.message, true)
  } finally {
    overlay(false)
    setBusy(false)
  }
}

function downloadFilm() {
  if (!state.video?.file) return
  const link = document.createElement("a")
  link.href = state.video.file
  const ext = state.video.file.endsWith(".webm") ? "webm" : "mp4"
  link.download = `${(state.video.title || "zycron-flow").replace(/[^\w.-]+/g, "-").toLowerCase()}.${ext}`
  link.click()
}

async function renderFilm({ autoDownload = false } = {}) {
  const scenes = state.scenes
  if (!scenes.every((scene) => scene.image)) return toast("Generate the storyboard first", true)
  if (typeof MediaRecorder === "undefined") return toast("This browser cannot record video", true)
  setBusy(true)
  setStatus("rendering", "busy")
  overlay(true, "Rendering film", "Compositing scenes in real time…", 2)
  let stream = null
  let audioEl = null
  try {
    const video = await ensureVideo()
    const total = totalDuration()
    const canvas = $("#canvas")
    stream = canvas.captureStream(30)
    audioEl = await attachVoice(stream, video.voice)
    const mime = pickMime(Boolean(audioEl))
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 })
    const chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    const stopped = new Promise((resolve) => (recorder.onstop = resolve))
    recorder.start(1000)
    if (audioEl) {
      audioEl.currentTime = 0
      await audioEl.play().catch(() => toast("Narration could not start — film is silent", true))
    }
    const voiceLength = Number(audioEl?.duration) || 0
    const limit = Math.max(total, voiceLength ? voiceLength + 0.25 : 0)
    const started = performance.now()
    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - started) / 1000
        drawFrameAt(Math.min(elapsed, total - 0.01))
        overlay(true, "Rendering film", `${Math.round((elapsed / limit) * 100)}% captured`, Math.min(96, (elapsed / limit) * 100))
        $("#timeLabel").textContent = `${fmt(Math.min(elapsed, total))} / ${fmt(total)}`
        if (elapsed >= limit) return resolve()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    recorder.stop()
    await stopped
    const blob = new Blob(chunks, { type: mime.split(";")[0] })
    if (!blob.size) throw new FlowError("the recording came back empty")
    overlay(true, "Saving film", "Uploading to your workspace…", 98)
    const response = await fetch(`/api/videos/${encodeURIComponent(video.id)}/file`, {
      method: "POST",
      headers: authHeaders({ "content-type": mime.split(";")[0] }),
      body: blob
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new FlowError(error.error || `upload failed (${response.status})`)
    }
    const data = await response.json()
    state.video = data.video
    state.videos = [data.video, ...state.videos.filter((item) => item.id !== data.video.id)]
    renderLibrary()
    showPlayer(data.video)
    renderActions()
    setStatus("ready", "live")
    if (autoDownload) downloadFilm()
    toast(autoDownload ? "Film ready — downloading" : "Film rendered — download it below")
  } catch (error) {
    setStatus("failed", "bad")
    toast(error.message, true)
  } finally {
    try {
      audioEl?.pause()
    } catch {}
    stream?.getTracks().forEach((track) => track.stop())
    closeAudio()
    overlay(false)
    setBusy(false)
    drawIdleFrame()
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bind() {
  $("#title").addEventListener("input", scheduleSave)
  $("#aspect").addEventListener("change", () => {
    resizeCanvas()
    loadImages()
    scheduleSave()
  })
  $("#seed").addEventListener("input", scheduleSave)
  $("#modelInput").addEventListener("input", scheduleSave)
  $("#providerSelect").addEventListener("change", scheduleSave)

  $("#scenePrompt").addEventListener("input", (event) => {
    const scene = activeScene()
    if (!scene) return
    scene.prompt = event.target.value
    renderScenes()
    renderActions()
    scheduleSave()
  })
  $("#sceneDuration").addEventListener("input", (event) => {
    const scene = activeScene()
    if (!scene) return
    scene.duration = Number(event.target.value)
    $("#durationValue").textContent = `${scene.duration.toFixed(1)}s`
    renderScenes()
    renderTimeline()
    scheduleSave()
  })
  $("#sceneMotion").addEventListener("change", (event) => {
    const scene = activeScene()
    if (!scene) return
    scene.motion = event.target.value
    renderScenes()
    scheduleSave()
  })
  $("#sceneTransition").addEventListener("change", (event) => {
    const scene = activeScene()
    if (!scene) return
    scene.transition = event.target.value
    scheduleSave()
  })

  $("#addSceneBtn").addEventListener("click", () => {
    state.scenes.push({ id: uid(), prompt: "", duration: 4, motion: "zoom-in", transition: "fade", image: "", seed: 0 })
    state.active = state.scenes.length - 1
    renderAll()
    $("#scenePrompt").focus()
    scheduleSave()
  })
  $("#dupSceneBtn").addEventListener("click", () => {
    const scene = activeScene()
    if (!scene) return
    state.scenes.splice(state.active + 1, 0, { ...scene, id: uid(), image: scene.image, seed: 0 })
    state.active++
    renderAll()
    loadImages()
    scheduleSave()
  })
  $("#delSceneBtn").addEventListener("click", () => {
    if (state.scenes.length === 1) return toast("Keep at least one scene", true)
    state.scenes.splice(state.active, 1)
    state.active = Math.max(0, state.active - 1)
    renderAll()
    loadImages()
    scheduleSave()
  })

  $$("#styleChips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$("#styleChips .chip").forEach((item) => item.classList.toggle("on", item === chip))
      $("#styleInput").value = chip.dataset.style || ""
    })
  })
  $("#styleInput").addEventListener("input", () => {
    $$("#styleChips .chip").forEach((chip) => chip.classList.toggle("on", chip.dataset.style === $("#styleInput").value))
  })

  $$("#modeTabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.mode = tab.dataset.mode
      syncMode()
      renderActions()
      scheduleSave()
    })
  })

  $("#storyboardBtn").addEventListener("click", () => {
    if (state.mode === "provider") generateProvider()
    else generateStoryboard()
  })
  $("#renderBtn").addEventListener("click", renderFilm)
  $("#playBtn").addEventListener("click", preview)
  $("#fitBtn").addEventListener("click", () => {
    state.playing = false
    state.previewToken++
    $("#playIcon").textContent = "▶"
    drawIdleFrame()
    $("#timeLabel").textContent = `${fmt(0)} / ${fmt(totalDuration())}`
  })

  $("#uploadFrameBtn").addEventListener("click", () => $("#frameInput").click())
  $("#frameInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    uploadFrame(file)
  })

  $("#libraryBtn").addEventListener("click", () => {
    $("#library").hidden = false
    renderLibrary()
  })
  $("#closeLibrary").addEventListener("click", () => ($("#library").hidden = true))

  $("#downloadBtn").addEventListener("click", downloadFilm)

  $("#quickBtn").addEventListener("click", quickCreate)
  $("#quickMic").addEventListener("click", () => dictate($("#quickPrompt"), $("#quickMic")))
  $("#sceneMic").addEventListener("click", () => dictate($("#scenePrompt"), $("#sceneMic")))
  $("#quickPrompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) quickCreate()
  })
  $("#voiceBtn").addEventListener("click", generateVoice)
  $("#voicePlayBtn").addEventListener("click", () => {
    if (!state.video?.voice) return
    const audio = new Audio(state.video.voice)
    audio.play().catch(() => toast("Could not play the narration", true))
  })
  $("#voicePreviewBtn").addEventListener("click", () => {
    const script = narrationScript()
    if (!script) return toast("Write a scene first", true)
    if (!("speechSynthesis" in window)) return toast("This browser cannot preview speech", true)
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(script)
    utterance.rate = 1
    utterance.pitch = 1
    window.speechSynthesis.speak(utterance)
    toast("Previewing with the device voice")
  })

  $$("#mobileTabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.body.dataset.panel = button.dataset.panel
      $$("#mobileTabs button").forEach((item) => item.classList.toggle("on", item === button))
    })
  })

  $("#tokenForm").addEventListener("submit", (event) => {
    event.preventDefault()
    const token = $("#tokenInput").value.trim()
    if (!token) return
    localStorage.setItem(TOKEN_KEY, token)
    state.token = token
    $("#tokenGate").hidden = true
    boot()
  })

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea, select")) return
    if (event.key === " ") {
      event.preventDefault()
      preview()
    }
  })
}

boot()
