import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { all, one, run } from "./db.js"
import { keylessProvider, providerKey, providerRow } from "./providers.js"
import { HttpError, now, safeJson, uid } from "./util.js"

const JOB_TIMEOUT = 15 * 60 * 1000
const IMAGE_BASE = process.env.ZYCRON_IMAGE_BASE || "https://image.pollinations.ai/prompt"
const POLL_MS = Math.max(50, Number(process.env.ZYCRON_VIDEO_POLL_MS) || 5000)
const active = new Set()

const MOTIONS = new Set(["zoom-in", "zoom-out", "pan-left", "pan-right", "still"])
const ASPECTS = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1024, 1024],
  "4:3": [1024, 768],
  "3:4": [768, 1024]
}

export function videoPublic(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode,
    providerId: row.provider_id,
    model: row.model,
    aspect: row.aspect,
    duration: Number(row.duration || 0),
    scenes: safeJson(row.scenes, []),
    status: row.status,
    progress: Number(row.progress || 0),
    error: row.error,
    file: row.file,
    poster: row.poster,
    voice: row.voice || "",
    outScale: Number(row.out_scale || 1),
    fit: row.fit === "contain" ? "contain" : "cover",
    zoom: Number(row.zoom || 1),
    trimStart: Number(row.trim_start || 0),
    trimEnd: Number(row.trim_end || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listVideos(db) {
  return all(db, "SELECT * FROM videos ORDER BY updated_at DESC LIMIT 200").map(videoPublic)
}

export function getVideo(db, id) {
  const row = one(db, "SELECT * FROM videos WHERE id = ?", id)
  if (!row) throw new HttpError(404, "video not found")
  return row
}

export function createVideo(db, input = {}) {
  const mode = input.mode === "provider" ? "provider" : "storyboard"
  const aspect = ASPECTS[input.aspect] ? input.aspect : "16:9"
  const scenes = normalizeScenes(input.scenes, input.prompt)
  if (!scenes.length) throw new HttpError(400, "add at least one scene prompt")
  if (scenes.length > 20) throw new HttpError(400, "maximum 20 scenes")
  const id = uid()
  const title = String(input.title || scenes[0].prompt || "Untitled film").slice(0, 160)
  const framing = frameValues(input)
  run(
    db,
    `INSERT INTO videos (id, title, prompt, mode, provider_id, model, aspect, duration, scenes, status, progress, error, file, poster, out_scale, fit, zoom, trim_start, trim_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, '', '', '', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    title,
    String(input.prompt || "").slice(0, 4000),
    mode,
    String(input.providerId || "").slice(0, 64),
    String(input.model || "").slice(0, 120),
    aspect,
    scenes.reduce((sum, scene) => sum + scene.duration, 0),
    JSON.stringify(scenes),
    framing.outScale,
    framing.fit,
    framing.zoom,
    framing.trimStart,
    framing.trimEnd,
    now(),
    now()
  )
  return videoPublic(getVideo(db, id))
}

export function patchVideo(db, id, input = {}) {
  getVideo(db, id)
  const fields = []
  const values = []
  if (input.title !== undefined) {
    fields.push("title = ?")
    values.push(String(input.title || "Untitled film").slice(0, 160))
  }
  if (input.aspect !== undefined && ASPECTS[input.aspect]) {
    fields.push("aspect = ?")
    values.push(input.aspect)
  }
  if (input.scenes !== undefined) {
    const scenes = normalizeScenes(input.scenes, input.prompt)
    fields.push("scenes = ?")
    values.push(JSON.stringify(scenes))
    fields.push("duration = ?")
    values.push(scenes.reduce((sum, scene) => sum + scene.duration, 0))
  }
  if (input.providerId !== undefined) {
    fields.push("provider_id = ?")
    values.push(String(input.providerId || "").slice(0, 64))
  }
  if (input.model !== undefined) {
    fields.push("model = ?")
    values.push(String(input.model || "").slice(0, 120))
  }
  if ([input.outScale, input.fit, input.zoom, input.trimStart, input.trimEnd].some((value) => value !== undefined)) {
    const framing = frameValues({ ...videoPublic(getVideo(db, id)), ...input })
    fields.push("out_scale = ?", "fit = ?", "zoom = ?", "trim_start = ?", "trim_end = ?")
    values.push(framing.outScale, framing.fit, framing.zoom, framing.trimStart, framing.trimEnd)
  }
  if (input.mode !== undefined) {
    fields.push("mode = ?")
    values.push(input.mode === "provider" ? "provider" : "storyboard")
  }
  if (!fields.length) return videoPublic(getVideo(db, id))
  fields.push("updated_at = ?")
  values.push(now())
  run(db, `UPDATE videos SET ${fields.join(", ")} WHERE id = ?`, ...values, id)
  return videoPublic(getVideo(db, id))
}

export async function deleteVideo(db, dataDir, id) {
  getVideo(db, id)
  run(db, "DELETE FROM videos WHERE id = ?", id)
  const dir = path.join(dataDir, "videos")
  for (const file of [`${id}.mp4`, `${id}.webm`]) {
    await fsp.rm(path.join(dir, file), { force: true })
  }
  const assets = path.join(dir, "assets")
  let names = []
  try {
    names = await fsp.readdir(assets)
  } catch {}
  await Promise.all(names.filter((name) => name.startsWith(`${id}-`)).map((name) => fsp.rm(path.join(assets, name), { force: true })))
}

function frameValues(input) {
  const outScale = clamp(Number(input.outScale) || 1, 0.5, 2)
  const zoom = clamp(Number(input.zoom) || 1, 1, 1.8)
  const trimStart = Math.max(0, Number(input.trimStart) || 0)
  const trimEnd = Math.max(0, Number(input.trimEnd) || 0)
  return { outScale, fit: input.fit === "contain" ? "contain" : "cover", zoom, trimStart, trimEnd }
}

function normalizeScenes(input, fallbackPrompt = "") {
  const list = Array.isArray(input) && input.length ? input : fallbackPrompt ? [{ prompt: fallbackPrompt }] : []
  return list
    .map((scene, index) => {
      const prompt = String(scene?.prompt ?? scene ?? "").trim().slice(0, 2000)
      if (!prompt) return null
      return {
        id: String(scene?.id || `scene-${index + 1}`).slice(0, 64),
        prompt,
        duration: clamp(Number(scene?.duration) || 4, 2, 10),
        motion: MOTIONS.has(scene?.motion) ? scene.motion : "zoom-in",
        transition: scene?.transition === "cut" ? "cut" : "fade",
        image: typeof scene?.image === "string" ? scene.image : "",
        seed: Number(scene?.seed) || 0
      }
    })
    .filter(Boolean)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function aspectSize(aspect) {
  return ASPECTS[aspect] || ASPECTS["16:9"]
}

export function assetDir(dataDir) {
  return path.join(dataDir, "videos", "assets")
}

export function assetPath(dataDir, name) {
  const safe = path.basename(String(name || ""))
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) throw new HttpError(400, "bad asset name")
  const file = path.join(assetDir(dataDir), safe)
  if (!fs.existsSync(file)) throw new HttpError(404, "asset not found")
  return file
}

export async function generateStoryboard(db, dataDir, secret, id, { style = "", seed = 0, negative = "", imageProviderId = "", imageModel = "", imageToken = "" } = {}) {
  const pollen = String(imageToken || "").trim().slice(0, 200)
  const row = getVideo(db, id)
  if (active.has(id)) throw new HttpError(409, "video is already generating")
  active.add(id)
  try {
    run(db, "UPDATE videos SET status = 'storyboard', progress = 0, error = '', updated_at = ? WHERE id = ?", now(), id)
    const aspect = row.aspect
    const [width, height] = aspectSize(aspect)
    const scenes = safeJson(row.scenes, [])
    const dir = assetDir(dataDir)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const out = []
    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index]
      const prompt = [scene.prompt, style && `style: ${style}`, negative && `avoid: ${negative}`].filter(Boolean).join(". ")
      const sceneSeed = Number(seed || 0) + index * 97 + 11
      const image = imageProviderId
        ? await providerImage(db, secret, imageProviderId, imageModel, prompt, width, height)
        : await fetchImage(`${IMAGE_BASE}/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${sceneSeed}&nologo=true`, pollen)
      const ext = image.type === "image/png" ? "png" : "jpg"
      const name = `${id}-${index}.${ext}`
      await fsp.writeFile(path.join(dir, name), image.buffer)
      out.push({ ...scene, image: `/api/videos/assets/${name}`, seed: sceneSeed })
      setProgress(db, id, Math.round(((index + 1) / scenes.length) * 100))
    }
    run(
      db,
      "UPDATE videos SET scenes = ?, status = 'storyboard', progress = 100, poster = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(out),
      out[0]?.image || "",
      now(),
      id
    )
    return videoPublic(getVideo(db, id))
  } catch (error) {
    run(db, "UPDATE videos SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(error.message || error), now(), id)
    throw error
  } finally {
    active.delete(id)
  }
}

async function fetchImage(url, token = "") {
  const headers = { "user-agent": "zycron-ai/0.1" }
  if (token) headers.authorization = `Bearer ${token}`
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(150_000), headers })
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 220)
        const error = new Error(`image provider returned ${response.status}${detail ? `: ${detail}` : ""}`)
        error.status = response.status
        error.retryAfter = Number(response.headers.get("retry-after")) || 0
        throw error
      }
      const type = response.headers.get("content-type") || "image/jpeg"
      if (!type.startsWith("image/")) throw new Error(`image provider returned ${type}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 32) throw new Error("image provider returned an empty image")
      return { buffer, type }
    } catch (error) {
      lastError = error
      if (error.status === 401 || error.status === 403) break
      if (error.status === 429) {
        if (!token) {
          throw new HttpError(429, `image service is rate limited: ${error.message}. Add a pollen key in Image generator, or upload frames per scene.`)
        }
        const wait = Math.min(45, error.retryAfter || 8) * 1000
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
  throw new HttpError(502, `image generation failed: ${lastError?.message || "unknown error"}`)
}

async function providerImage(db, secret, providerId, model, prompt, width, height) {
  const provider = providerRow(db, providerId)
  if (!provider) throw new HttpError(404, "image provider no longer exists")
  const key = providerKey(provider, secret)
  if (!key && !keylessProvider(provider)) throw new HttpError(400, `${provider.name} has no API key`)
  const base = provider.base_url.replace(/\/+$/, "")
  const headers = { "content-type": "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  const data = await fetchJson(`${base}/images/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: model || "gpt-image-1", prompt, size: `${width}x${height}`, n: 1, response_format: "b64_json" })
  }, 180_000)
  const first = data.data?.[0] || data.images?.[0]
  if (!first) throw new HttpError(502, "image provider returned no image")
  if (first.b64_json || first.b64) {
    return { buffer: Buffer.from(first.b64_json || first.b64, "base64"), type: "image/png" }
  }
  const url = first.url || first.image
  if (!url) throw new HttpError(502, "image provider returned no image data")
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new HttpError(502, `image download failed (${response.status})`)
  const type = response.headers.get("content-type") || "image/png"
  if (!type.startsWith("image/")) throw new HttpError(502, `image provider returned ${type}`)
  return { buffer: Buffer.from(await response.arrayBuffer()), type }
}

export async function saveSceneImage(db, dataDir, id, index, req, { limit = 20 * 1024 * 1024 } = {}) {
  const row = getVideo(db, id)
  const scenes = safeJson(row.scenes, [])
  const position = Number(index)
  if (!Number.isInteger(position) || position < 0 || position >= scenes.length) throw new HttpError(400, "invalid scene index")
  const type = String(req.headers["content-type"] || "")
  if (!type.startsWith("image/")) throw new HttpError(400, "scene upload must be an image")
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"
  const dir = assetDir(dataDir)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const name = `${id}-${position}.${ext}`
  const file = path.join(dir, name)
  await new Promise((resolve, reject) => {
    let size = 0
    const stream = fs.createWriteStream(file, { mode: 0o600 })
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        stream.destroy()
        reject(new HttpError(413, "image too large"))
        return
      }
      if (!stream.write(chunk)) req.pause()
    })
    stream.on("drain", () => req.resume())
    req.on("end", () => stream.end(resolve))
    req.on("error", reject)
    stream.on("error", reject)
  })
  scenes[position] = { ...scenes[position], image: `/api/videos/assets/${name}`, seed: 0 }
  run(
    db,
    "UPDATE videos SET scenes = ?, poster = COALESCE(NULLIF(poster, ''), ?), updated_at = ? WHERE id = ?",
    JSON.stringify(scenes),
    scenes[position].image,
    now(),
    id
  )
  return videoPublic(getVideo(db, id))
}

export async function synthesizeVoice(db, dataDir, secret, id, { text = "", voice = "alloy", lang = "en", providerId = "", model = "" } = {}) {
  getVideo(db, id)
  const script = String(text || "").trim().slice(0, 4000)
  if (!script) throw new HttpError(400, "write a narration script first")
  const audio = providerId
    ? await providerSpeech(db, secret, providerId, model, voice, script)
    : await googleSpeech(script, lang)
  const dir = assetDir(dataDir)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const ext = audio.type.includes("wav") ? "wav" : audio.type.includes("ogg") ? "ogg" : "mp3"
  const name = `${id}-voice.${ext}`
  await fsp.writeFile(path.join(dir, name), audio.buffer)
  run(db, "UPDATE videos SET voice = ?, updated_at = ? WHERE id = ?", `/api/videos/assets/${name}`, now(), id)
  return videoPublic(getVideo(db, id))
}

async function providerSpeech(db, secret, providerId, model, voice, text) {
  const provider = providerRow(db, providerId)
  if (!provider) throw new HttpError(404, "voice provider no longer exists")
  const key = providerKey(provider, secret)
  if (!key) throw new HttpError(400, `${provider.name} has no API key`)
  const base = provider.base_url.replace(/\/+$/, "")
  const response = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: model || "gpt-4o-mini-tts", input: text, voice, response_format: "mp3" }),
    signal: AbortSignal.timeout(120_000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new HttpError(502, `voice provider failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`)
  }
  const type = response.headers.get("content-type") || "audio/mpeg"
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < 256) throw new HttpError(502, "voice provider returned empty audio")
  return { buffer, type }
}

async function googleSpeech(text, lang) {
  const hosts = process.env.ZYCRON_TTS_BASE
    ? [process.env.ZYCRON_TTS_BASE]
    : ["https://translate.google.com/translate_tts", "https://translate.googleapis.com/translate_tts"]
  const locale = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : "en"
  const chunks = []
  let rest = text.replace(/\s+/g, " ").trim()
  while (rest) {
    let size = Math.min(180, rest.length)
    if (size < rest.length) {
      const slice = rest.slice(0, size)
      const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(", "), slice.lastIndexOf(" "))
      if (cut > 60) size = cut + 1
    }
    chunks.push(rest.slice(0, size))
    rest = rest.slice(size).trim()
  }
  let lastError = null
  for (const base of hosts) {
    try {
      const buffers = []
      for (const chunk of chunks) {
        const url = `${base}?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(locale)}&total=1&idx=0&textlen=${chunk.length}&q=${encodeURIComponent(chunk)}`
        const response = await fetch(url, {
          headers: { "user-agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
          signal: AbortSignal.timeout(30_000)
        })
        if (!response.ok) throw new Error(`speech service returned ${response.status}`)
        const type = response.headers.get("content-type") || ""
        if (!type.startsWith("audio/")) throw new Error("speech service returned non-audio")
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length < 256) throw new Error("speech service returned empty audio")
        buffers.push(buffer)
      }
      return { buffer: Buffer.concat(buffers), type: "audio/mpeg" }
    } catch (error) {
      lastError = error
    }
  }
  throw new HttpError(
    502,
    `free voice service is unreachable (${lastError?.message || "no audio"}) — add an OpenAI-compatible provider and choose it as the voice engine`
  )
}

function setProgress(db, id, progress) {
  run(db, "UPDATE videos SET progress = ?, updated_at = ? WHERE id = ?", clamp(progress, 0, 100), now(), id)
}

export function startRender(db, dataDir, secret, id) {
  const row = getVideo(db, id)
  if (row.mode !== "provider") throw new HttpError(400, "provider render needs mode=provider")
  if (!row.provider_id) throw new HttpError(400, "select a video provider first")
  if (active.has(id)) throw new HttpError(409, "video is already generating")
  const provider = providerRow(db, row.provider_id)
  if (!provider) throw new HttpError(404, "provider no longer exists")
  const key = providerKey(provider, secret)
  if (!key && !keylessProvider(provider)) throw new HttpError(400, `${provider.name} has no API key`)
  active.add(id)
  run(db, "UPDATE videos SET status = 'queued', progress = 1, error = '', updated_at = ? WHERE id = ?", now(), id)
  renderJob(db, dataDir, provider, key, row).catch((error) => {
    run(db, "UPDATE videos SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(error.message || error), now(), id)
  }).finally(() => active.delete(id))
  return videoPublic(getVideo(db, id))
}

async function renderJob(db, dataDir, provider, key, row) {
  const prompt = [row.prompt, ...safeJson(row.scenes, []).map((scene) => scene.prompt)].filter(Boolean).join("\n\n")
  const [width, height] = aspectSize(row.aspect)
  const mode = /generativelanguage\.googleapis\.com/.test(provider.base_url) || provider.kind === "gemini" ? "gemini" : "openai"
  const generated = mode === "gemini"
    ? await geminiGenerate({ provider, key, model: row.model, prompt, width, height, aspect: row.aspect, duration: row.duration })
    : await openaiGenerate({ provider, key, model: row.model, prompt, width, height, duration: row.duration, onProgress: (progress) => setProgress(db, row.id, progress) })
  const dir = path.join(dataDir, "videos")
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${row.id}.mp4`)
  await fsp.writeFile(file, generated.buffer)
  run(
    db,
    "UPDATE videos SET status = 'ready', progress = 100, file = ?, duration = ?, updated_at = ? WHERE id = ?",
    `/api/videos/${row.id}/file`,
    generated.seconds || row.duration,
    now(),
    row.id
  )
}

async function openaiGenerate({ provider, key, model, prompt, width, height, duration, onProgress }) {
  const base = provider.base_url.replace(/\/+$/, "")
  const headers = { "content-type": "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  const body = {
    model: model || "sora-2",
    prompt,
    size: `${width}x${height}`,
    seconds: String(clamp(Math.round(duration || 8), 4, 12))
  }
  const created = await fetchJson(`${base}/videos`, { method: "POST", headers, body: JSON.stringify(body) }, 120_000)
  const jobId = created.id
  if (!jobId) throw new HttpError(502, "video provider did not return a job id")
  const deadline = Date.now() + JOB_TIMEOUT
  let progress = 3
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const job = await fetchJson(`${base}/videos/${jobId}`, { headers }, 60_000)
    if (typeof job.progress === "number") progress = clamp(job.progress, 3, 97)
    onProgress(progress)
    if (job.status === "completed" || job.status === "succeeded") {
      const response = await fetch(`${base}/videos/${jobId}/content`, { headers, signal: AbortSignal.timeout(300_000) })
      if (!response.ok) throw new HttpError(502, `video download failed (${response.status})`)
      return { buffer: Buffer.from(await response.arrayBuffer()), seconds: Number(job.seconds) || duration }
    }
    if (job.status === "failed") throw new HttpError(502, job.error?.message || "video generation failed")
  }
  throw new HttpError(504, "video generation timed out")
}

async function geminiGenerate({ provider, key, model, prompt, width, height, aspect, duration }) {
  const base = provider.base_url.replace(/\/+$/, "")
  const name = model || "veo-3.0-generate-preview"
  const created = await fetchJson(`${base}/models/${encodeURIComponent(name)}:predictLongRunning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio: aspect, durationSeconds: clamp(Math.round(duration || 8), 4, 8), personGeneration: "allow_adult" }
    })
  }, 120_000)
  if (!created.name) throw new HttpError(502, "Veo did not return an operation name")
  const deadline = Date.now() + JOB_TIMEOUT
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const operation = await fetchJson(`${base}/${created.name}`, { headers: { "x-goog-api-key": key } }, 60_000)
    if (operation.error) throw new HttpError(502, operation.error.message || "Veo generation failed")
    if (operation.done) {
      const uri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
      const inline = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded
      if (inline) return { buffer: Buffer.from(inline, "base64"), seconds: duration }
      if (!uri) throw new HttpError(502, "Veo finished without a video")
      const response = await fetch(uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok) throw new HttpError(502, `video download failed (${response.status})`)
      return { buffer: Buffer.from(await response.arrayBuffer()), seconds: duration }
    }
    await fetch(`${base}/${created.name}`, { headers: { "x-goog-api-key": key } }).catch(() => {})
  }
  throw new HttpError(504, "Veo generation timed out")
}

async function fetchJson(url, options = {}, timeout = 60_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
  const text = await response.text()
  if (!response.ok) {
    let message = `provider returned ${response.status}`
    try {
      const parsed = JSON.parse(text)
      message = parsed.error?.message || parsed.error || parsed.message || message
    } catch {}
    throw new HttpError(502, String(message).slice(0, 300))
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, "provider returned invalid JSON")
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function saveRendered(db, dataDir, id, req, { limit = 200 * 1024 * 1024 } = {}) {
  getVideo(db, id)
  const type = String(req.headers["content-type"] || "")
  const ext = type.includes("mp4") ? "mp4" : "webm"
  const dir = path.join(dataDir, "videos")
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${id}.${ext}`)
  await new Promise((resolve, reject) => {
    let size = 0
    const stream = fs.createWriteStream(file, { mode: 0o600 })
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        stream.destroy()
        reject(new HttpError(413, "video file too large"))
        return
      }
      if (!stream.write(chunk)) req.pause()
    })
    stream.on("drain", () => req.resume())
    req.on("end", () => stream.end(resolve))
    req.on("error", reject)
    stream.on("error", reject)
  })
  run(
    db,
    "UPDATE videos SET status = 'ready', progress = 100, file = ?, updated_at = ? WHERE id = ?",
    `/api/videos/${id}/file`,
    now(),
    id
  )
  return videoPublic(getVideo(db, id))
}

export function videoFilePath(db, dataDir, id) {
  getVideo(db, id)
  for (const ext of ["mp4", "webm"]) {
    const file = path.join(dataDir, "videos", `${id}.${ext}`)
    if (fs.existsSync(file)) return file
  }
  throw new HttpError(404, "video file not ready")
}
