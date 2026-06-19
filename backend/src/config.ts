import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export interface ProjectEntry {
  name: string
  path: string
}

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default'
export type ModelName = 'sonnet' | 'opus' | 'haiku' | string
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Voice / brain settings persisted in config.json. Keys are server-side
// secrets and are never echoed back over HTTP (the GET /settings route returns
// a masked block instead). All fields optional so old configs still load.
export interface VoiceSettings {
  ttsProvider?: 'browser' | 'elevenlabs' | 'openai'
  elevenlabsApiKey?: string
  elevenlabsVoiceId?: string
  openaiApiKey?: string
  openaiVoice?: string
  brainModel?: string
}

export interface ConfigFile {
  token: string
  projects: ProjectEntry[]
  defaultProjectName: string
  claudeBinary: string
  permissionMode: PermissionMode
  model: ModelName
  openaiApiKey?: string
  voice?: VoiceSettings
  effort?: EffortLevel
  ultracode?: boolean
}

export interface RuntimeConfig extends ConfigFile {
  configPath: string
  configDir: string
  sessionsPath: string
}

export const VALID_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  'bypassPermissions',
  'acceptEdits',
  'default',
])

export const VALID_EFFORTS: ReadonlySet<EffortLevel> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const VALID_TTS_PROVIDERS: ReadonlySet<NonNullable<VoiceSettings['ttsProvider']>> = new Set([
  'browser',
  'elevenlabs',
  'openai',
])

const CONFIG_DIR = path.join(os.homedir(), '.cc-g2')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const SESSIONS_PATH = path.join(CONFIG_DIR, 'sessions.json')

function defaultConfig(): ConfigFile {
  const homeCoding = path.join(os.homedir(), 'Desktop', 'Coding Stuff')
  return {
    token: crypto.randomBytes(32).toString('base64url'),
    projects: [
      {
        name: 'g2',
        path: path.join(homeCoding, 'Side Projects', 'Claude Code G2'),
      },
      {
        name: 'coding',
        path: homeCoding,
      },
      {
        name: 'home',
        path: os.homedir(),
      },
    ],
    defaultProjectName: 'g2',
    claudeBinary: 'claude',
    // Skip permission prompts entirely so voice flows never get stuck waiting
    // for an approval the user can't see. Equivalent to passing
    // --dangerously-skip-permissions / --permission-mode bypassPermissions
    // to the claude CLI.
    permissionMode: 'bypassPermissions',
    model: 'sonnet',
  }
}

export function loadConfig(): RuntimeConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })

  let cfg: ConfigFile
  let created = false
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
      cfg = JSON.parse(raw) as ConfigFile
    } catch (err) {
      console.error(`[config] failed to parse ${CONFIG_PATH}:`, err)
      console.error(`[config] falling back to defaults; your original file is untouched`)
      cfg = defaultConfig()
    }
  } else {
    cfg = defaultConfig()
    created = true
  }

  // Ensure a token exists (even on an existing file that pre-dates this field)
  if (!cfg.token || cfg.token.length < 16) {
    cfg.token = crypto.randomBytes(32).toString('base64url')
    created = true
  }
  // Migrate older configs that pre-date the settings fields. Default to the
  // most permissive / smartest combination so existing users don't have to
  // touch anything.
  if (!cfg.permissionMode || !VALID_PERMISSION_MODES.has(cfg.permissionMode)) {
    cfg.permissionMode = 'bypassPermissions'
    created = true
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    cfg.model = 'sonnet'
    created = true
  }
  if (!cfg.claudeBinary) {
    cfg.claudeBinary = 'claude'
    created = true
  }
  // Newer fields (voice / effort / ultracode) are fully optional — old configs
  // that pre-date them simply load with them undefined. We only normalize away
  // obviously-invalid persisted values so the rest of the app can trust them.
  if (cfg.voice != null && typeof cfg.voice !== 'object') {
    delete cfg.voice
    created = true
  }
  if (cfg.effort != null && !VALID_EFFORTS.has(cfg.effort)) {
    delete cfg.effort
    created = true
  }
  if (cfg.ultracode != null && typeof cfg.ultracode !== 'boolean') {
    cfg.ultracode = Boolean(cfg.ultracode)
    created = true
  }

  if (created) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  }

  // Fix perms on the config file defensively, even if it already existed
  try {
    fs.chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* best effort */
  }

  // Validate project paths; keep only directories that actually exist
  const validProjects: ProjectEntry[] = []
  for (const p of cfg.projects ?? []) {
    try {
      const st = fs.statSync(p.path)
      if (st.isDirectory()) {
        validProjects.push(p)
      } else {
        console.warn(`[config] project "${p.name}" path is not a directory, skipping: ${p.path}`)
      }
    } catch {
      console.warn(`[config] project "${p.name}" path missing, skipping: ${p.path}`)
    }
  }
  cfg.projects = validProjects

  if (!validProjects.some((p) => p.name === cfg.defaultProjectName) && validProjects.length > 0) {
    cfg.defaultProjectName = validProjects[0]!.name
  }

  // Surface the token to the operator ONCE on startup (stderr so stdout stays clean for logs)
  const banner = [
    '',
    '════════════════════════════════════════════════════════════════',
    '  Claude Code G2 backend',
    '  Config:   ' + CONFIG_PATH,
    '  Sessions: ' + SESSIONS_PATH,
    '  Projects: ' + validProjects.map((p) => p.name).join(', '),
    '',
    '  BEARER TOKEN:',
    '  ' + cfg.token,
    '',
    '  Paste the token + the backend URL into the glasses app once.',
    '════════════════════════════════════════════════════════════════',
    '',
  ].join('\n')
  console.error(banner)

  return {
    ...cfg,
    configPath: CONFIG_PATH,
    configDir: CONFIG_DIR,
    sessionsPath: SESSIONS_PATH,
  }
}

// Persist a partial settings update back to ~/.cc-g2/config.json. Only the
// fields the UI is allowed to touch are accepted; the token, projects, and
// claudeBinary are not exposed via the HTTP settings endpoint.
export interface SettingsUpdate {
  permissionMode?: PermissionMode
  model?: ModelName
  defaultProjectName?: string
  voice?: Partial<VoiceSettings> & {
    clearElevenlabsKey?: boolean
    clearOpenaiKey?: boolean
  }
  effort?: EffortLevel
  ultracode?: boolean
}

export function saveSettings(cfg: RuntimeConfig, update: SettingsUpdate): RuntimeConfig {
  const next: RuntimeConfig = { ...cfg }
  if (update.permissionMode && VALID_PERMISSION_MODES.has(update.permissionMode)) {
    next.permissionMode = update.permissionMode
  }
  if (typeof update.model === 'string' && update.model.length > 0) {
    next.model = update.model
  }
  if (
    typeof update.defaultProjectName === 'string' &&
    cfg.projects.some((p) => p.name === update.defaultProjectName)
  ) {
    next.defaultProjectName = update.defaultProjectName
  }
  if (update.effort !== undefined) {
    if (!VALID_EFFORTS.has(update.effort)) {
      throw new Error(`invalid effort: ${update.effort}`)
    }
    next.effort = update.effort
  }
  if (typeof update.ultracode === 'boolean') {
    next.ultracode = update.ultracode
  }
  // Voice block: merge the incoming partial onto the existing voice settings.
  // API keys are special — masked re-saves send back an empty/missing key, so
  // we must NOT overwrite a stored key unless a NON-EMPTY string arrives. The
  // explicit clear flags are the only way to wipe a key.
  if (update.voice && typeof update.voice === 'object') {
    const v = update.voice
    const nextVoice: VoiceSettings = { ...(next.voice ?? {}) }

    if (v.ttsProvider !== undefined) {
      if (!VALID_TTS_PROVIDERS.has(v.ttsProvider)) {
        throw new Error(`invalid ttsProvider: ${v.ttsProvider}`)
      }
      nextVoice.ttsProvider = v.ttsProvider
    }
    if (typeof v.elevenlabsVoiceId === 'string') {
      nextVoice.elevenlabsVoiceId = v.elevenlabsVoiceId
    }
    if (typeof v.openaiVoice === 'string') {
      nextVoice.openaiVoice = v.openaiVoice
    }
    if (v.brainModel !== undefined) {
      if (typeof v.brainModel !== 'string' || v.brainModel.trim().length === 0) {
        throw new Error('brainModel must be a non-empty string')
      }
      nextVoice.brainModel = v.brainModel
    }

    // Only overwrite keys when a non-empty string is supplied.
    if (typeof v.elevenlabsApiKey === 'string' && v.elevenlabsApiKey.length > 0) {
      nextVoice.elevenlabsApiKey = v.elevenlabsApiKey
    }
    if (typeof v.openaiApiKey === 'string' && v.openaiApiKey.length > 0) {
      nextVoice.openaiApiKey = v.openaiApiKey
    }
    // Explicit clears win over everything.
    if (v.clearElevenlabsKey) delete nextVoice.elevenlabsApiKey
    if (v.clearOpenaiKey) delete nextVoice.openaiApiKey

    next.voice = nextVoice
  }
  // Re-write only the on-disk fields, preserving the secret token.
  const onDisk: ConfigFile = {
    token: next.token,
    projects: next.projects,
    defaultProjectName: next.defaultProjectName,
    claudeBinary: next.claudeBinary,
    permissionMode: next.permissionMode,
    model: next.model,
  }
  if (next.voice !== undefined) onDisk.voice = next.voice
  if (next.effort !== undefined) onDisk.effort = next.effort
  if (next.ultracode !== undefined) onDisk.ultracode = next.ultracode
  fs.writeFileSync(next.configPath, JSON.stringify(onDisk, null, 2), { mode: 0o600 })
  return next
}
