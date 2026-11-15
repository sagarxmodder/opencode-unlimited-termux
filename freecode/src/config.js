import os from "node:os"
import path from "node:path"
import { deepMerge, expandHome, readJson } from "./util.js"

export const DEFAULT_CONFIG = {
  model: "auto",
  preferred: [],
  temperature: null,
  maxSteps: 40,
  timeoutMs: 300000,
  sessionDir: "",
  providers: {},
  models: []
}

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME ? expandHome(process.env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config")
  return path.join(base, "freecode")
}

export function dataDir() {
  const base = process.env.XDG_DATA_HOME ? expandHome(process.env.XDG_DATA_HOME) : path.join(os.homedir(), ".local", "share")
  return path.join(base, "freecode")
}

export function globalConfigPath() {
  return process.env.FREECODE_CONFIG ? expandHome(process.env.FREECODE_CONFIG) : path.join(configDir(), "config.json")
}

export function projectConfigPath(cwd = process.cwd()) {
  return path.join(cwd, ".freecode.json")
}

export function configPaths(cwd = process.cwd()) {
  return [globalConfigPath(), projectConfigPath(cwd)]
}

export function loadConfig(cwd = process.cwd()) {
  const globalConfig = readJson(globalConfigPath(), {}) || {}
  const projectConfig = readJson(projectConfigPath(cwd), {}) || {}
  const raw = deepMerge(DEFAULT_CONFIG, deepMerge(globalConfig, projectConfig))
  const merged = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { ...DEFAULT_CONFIG }
  merged.providers = merged.providers && typeof merged.providers === "object" && !Array.isArray(merged.providers) ? merged.providers : {}
  merged.models = Array.isArray(merged.models) ? merged.models : []
  merged.preferred = Array.isArray(merged.preferred) ? merged.preferred : merged.preferred ? [merged.preferred] : []
  merged.preferred = merged.preferred.filter(Boolean)
  return merged
}

export function sessionDir(config = {}) {
  return config.sessionDir ? expandHome(config.sessionDir) : path.join(dataDir(), "sessions")
}
