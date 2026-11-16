import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ZycronApi } from "../src/tui/api.js"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
)
const MP4 = Buffer.concat([Buffer.from("fake-mp4-"), Buffer.alloc(256, 7)])

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

function imageServer() {
  return createServer((req, res) => {
    if (!req.url.startsWith("/prompt")) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { "content-type": "image/png" })
    res.end(PNG)
  })
}

function soraServer() {
  let polls = 0
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/videos") {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "job-1", status: "queued", progress: 0 }))
      })
      return
    }
    if (req.method === "GET" && req.url === "/v1/videos/job-1") {
      polls++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(polls < 2 ? { id: "job-1", status: "in_progress", progress: 55 } : { id: "job-1", status: "completed", progress: 100, seconds: 8 }))
      return
    }
    if (req.method === "GET" && req.url === "/v1/videos/job-1/content") {
      res.writeHead(200, { "content-type": "video/mp4" })
      res.end(MP4)
      return
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
      })
      return
    }
    res.writeHead(404).end()
  })
}

function veoServer() {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url.includes(":predictLongRunning")) {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ name: "operations/veo-1" }))
      })
      return
    }
    if (req.method === "GET" && req.url === "/v1beta/operations/veo-1") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { bytesBase64Encoded: MP4.toString("base64") } }]
          }
        }
      }))
      return
    }
    res.writeHead(404).end()
  })
}

async function waitHealth(baseUrl, deadline = Date.now() + 25_000) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error("server did not start")
}

async function waitReady(api, id, deadline = Date.now() + 20_000) {
  while (Date.now() < deadline) {
    const { video } = await api.request(`/api/videos/${id}`)
    if (video.status === "ready") return video
    if (video.status === "failed") throw new Error(video.error || "render failed")
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error("render did not finish in time")
}

test("video studio: storyboard, assets, upload, range and delete", { timeout: 120_000 }, async () => {
  const root = new URL("..", import.meta.url).pathname
  const data = await mkdtemp(join(tmpdir(), "zycron-video-data-"))
  const workspace = await mkdtemp(join(tmpdir(), "zycron-video-ws-"))
  const images = imageServer()
  const imagePort = await listen(images)
  const port = 18195
  const baseUrl = `http://127.0.0.1:${port}`
  let child = null
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        ZYCRON_DATA: data,
        ZYCRON_WORKSPACE: workspace,
        ZYCRON_IMAGE_BASE: `http://127.0.0.1:${imagePort}/prompt`,
        ZYCRON_VIDEO_POLL_MS: "60",
        ZYCRON_TOKEN: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let logs = ""
    child.stdout.on("data", (chunk) => (logs += chunk))
    child.stderr.on("data", (chunk) => (logs += chunk))
    await waitHealth(baseUrl).catch((error) => {
      throw new Error(`${error.message}\n${logs.slice(-1500)}`)
    })
    const api = new ZycronApi({ baseUrl })

    const created = await api.request("/api/videos", {
      method: "POST",
      body: {
        title: "Test film",
        aspect: "16:9",
        scenes: [{ prompt: "a violet desert", duration: 3 }, { prompt: "two moons rise", duration: 2.5 }]
      }
    })
    assert.equal(created.video.status, "draft")
    assert.equal(created.video.duration, 5.5)

    const painted = await api.request(`/api/videos/${created.video.id}/storyboard`, {
      method: "POST",
      body: { style: "noir", seed: 12 }
    })
    assert.equal(painted.video.status, "storyboard")
    assert.equal(painted.video.progress, 100)
    assert.match(painted.video.poster, /^\/api\/videos\/assets\//)
    for (const scene of painted.video.scenes) assert.match(scene.image, /^\/api\/videos\/assets\//)

    const assetResponse = await fetch(`${baseUrl}${painted.video.poster}`)
    assert.equal(assetResponse.status, 200)
    assert.equal(assetResponse.headers.get("content-type"), "image/png")
    const assetBytes = Buffer.from(await assetResponse.arrayBuffer())
    assert.ok(assetBytes.equals(PNG))

    const uploadResponse = await fetch(`${baseUrl}/api/videos/${created.video.id}/file`, {
      method: "POST",
      headers: { "content-type": "video/webm" },
      body: MP4
    })
    assert.equal(uploadResponse.status, 200)
    const uploaded = await uploadResponse.json()
    assert.equal(uploaded.video.status, "ready")
    assert.equal(uploaded.video.file, `/api/videos/${created.video.id}/file`)

    const fileResponse = await fetch(`${baseUrl}${uploaded.video.file}`)
    assert.equal(fileResponse.status, 200)
    assert.ok(Buffer.from(await fileResponse.arrayBuffer()).equals(MP4))

    const ranged = await fetch(`${baseUrl}${uploaded.video.file}`, { headers: { range: "bytes=0-3" } })
    assert.equal(ranged.status, 206)
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), "fake")

    const list = await api.request("/api/videos")
    assert.ok(list.videos.some((video) => video.id === created.video.id))

    await api.request(`/api/videos/${created.video.id}`, { method: "DELETE" })
    await assert.rejects(api.request(`/api/videos/${created.video.id}`), /video not found/)
  } finally {
    if (child) {
      child.kill("SIGTERM")
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 4000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await new Promise((resolve) => images.close(resolve))
    await rm(data, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test("video studio: renders through openai and gemini video providers", { timeout: 120_000 }, async () => {
  const root = new URL("..", import.meta.url).pathname
  const data = await mkdtemp(join(tmpdir(), "zycron-video-data-"))
  const workspace = await mkdtemp(join(tmpdir(), "zycron-video-ws-"))
  const sora = soraServer()
  const veo = veoServer()
  const soraPort = await listen(sora)
  const veoPort = await listen(veo)
  const port = 18196
  const baseUrl = `http://127.0.0.1:${port}`
  let child = null
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), ZYCRON_DATA: data, ZYCRON_WORKSPACE: workspace, ZYCRON_VIDEO_POLL_MS: "60", ZYCRON_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let logs = ""
    child.stdout.on("data", (chunk) => (logs += chunk))
    child.stderr.on("data", (chunk) => (logs += chunk))
    await waitHealth(baseUrl).catch((error) => {
      throw new Error(`${error.message}\n${logs.slice(-1500)}`)
    })
    const api = new ZycronApi({ baseUrl })

    const openai = (await api.saveProvider({ name: "Fake Sora", baseUrl: `http://127.0.0.1:${soraPort}/v1`, kind: "openai" })).provider

    const draft = await api.request("/api/videos", {
      method: "POST",
      body: { title: "Provider stills", aspect: "16:9", scenes: [{ prompt: "a paper lantern", duration: 3 }] }
    })
    const painted = await api.request(`/api/videos/${draft.video.id}/storyboard`, {
      method: "POST",
      body: { imageProviderId: openai.id, imageModel: "gpt-image-1" }
    })
    assert.equal(painted.video.status, "storyboard")
    assert.match(painted.video.scenes[0].image, /^\/api\/videos\/assets\//)

    const uploaded = await fetch(`${baseUrl}/api/videos/${draft.video.id}/scenes/0/image`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    })
    assert.equal(uploaded.status, 200)
    const uploadedVideo = (await uploaded.json()).video
    assert.match(uploadedVideo.scenes[0].image, /^\/api\/videos\/assets\//)
    const gemini = (await api.saveProvider({ name: "Fake Veo", baseUrl: `http://127.0.0.1:${veoPort}/v1beta`, kind: "gemini" })).provider

    for (const [provider, model] of [[openai, "sora-2"], [gemini, "veo-3.0"]]) {
      const { video } = await api.request("/api/videos", {
        method: "POST",
        body: {
          title: `${provider.name} film`,
          prompt: "a city made of glass at dawn",
          mode: "provider",
          providerId: provider.id,
          model,
          aspect: "16:9",
          scenes: [{ prompt: "a city made of glass at dawn", duration: 8 }]
        }
      })
      await api.request(`/api/videos/${video.id}/render`, { method: "POST", body: {} })
      const ready = await waitReady(api, video.id)
      assert.equal(ready.status, "ready")
      assert.equal(ready.progress, 100)
      const response = await fetch(`${baseUrl}${ready.file}`)
      assert.equal(response.status, 200)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.ok(bytes.includes(Buffer.from("fake-mp4")), "downloaded provider bytes are stored")
    }
  } finally {
    if (child) {
      child.kill("SIGTERM")
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 4000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await new Promise((resolve) => sora.close(resolve))
    await new Promise((resolve) => veo.close(resolve))
    await rm(data, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
