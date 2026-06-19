import { useEffect, useState } from 'react'
import { Badge, Button, Select, Divider, Toggle } from 'even-toolkit/web'
import type { SelectOption } from 'even-toolkit/web'
import {
  getSettings,
  saveSettings,
  type Settings as SettingsData,
  type PermissionMode,
  type EffortLevel,
  type VoiceSettingsUpdate,
} from '../api'
import { store, useAppState } from '../store'

const PERM_OPTS: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'bypassPermissions', label: 'Skip all (recommended)', hint: '--dangerously-skip-permissions' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'gates Bash + dangerous tools' },
  { value: 'default', label: 'Prompt every time', hint: 'not hands-free' },
]

const MODEL_OPTS: { value: string; label: string }[] = [
  { value: 'opus', label: 'Opus 4.8 (smartest)' },
  { value: 'sonnet', label: 'Sonnet 4.6 (fast)' },
  { value: 'haiku', label: 'Haiku 4.5 (cheap)' },
  { value: 'fable', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
  { value: 'claude-fable-5', label: 'claude-fable-5' },
]

const EFFORT_OPTS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'Extra (xhigh)' },
  { value: 'max', label: 'Max' },
]

const TTS_OPTS: { value: 'browser' | 'elevenlabs' | 'openai'; label: string }[] = [
  { value: 'browser', label: 'Apagado (browser)' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'openai', label: 'OpenAI' },
]

export function SettingsCard() {
  const state = useAppState()
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Local draft state for the write-only API key inputs (never prefilled from
  // the backend — it only ever returns a masked *KeySet boolean).
  const [elevenKeyDraft, setElevenKeyDraft] = useState('')
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState('')
  const configured = Boolean(state.backendUrl && state.token && state.connection === 'ok')

  useEffect(() => {
    if (!configured) { setSettings(null); return }
    void (async () => {
      try {
        const s = await getSettings()
        setSettings(s)
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [configured])

  async function update(partial: Partial<Omit<SettingsData, 'voice'>>) {
    if (!settings) return
    setSaving(true)
    setSettings({ ...settings, ...partial })
    try {
      const next = await saveSettings(partial)
      setSettings((cur) => cur ? { ...cur, ...next } : cur)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Voice carries a write-only update shape (API keys are never returned), so it
  // can't merge into local state directly — we optimistically patch the GET-shaped
  // voice fields we know about, then reconcile with the masked server response.
  async function updateVoice(patch: VoiceSettingsUpdate) {
    if (!settings) return
    setSaving(true)
    const optimistic: Partial<SettingsData['voice']> = {}
    if (patch.ttsProvider !== undefined) optimistic.ttsProvider = patch.ttsProvider
    if (patch.elevenlabsVoiceId !== undefined) optimistic.elevenlabsVoiceId = patch.elevenlabsVoiceId
    if (patch.openaiVoice !== undefined) optimistic.openaiVoice = patch.openaiVoice
    if (patch.brainModel !== undefined) optimistic.brainModel = patch.brainModel
    if (patch.elevenlabsApiKey) optimistic.elevenlabsKeySet = true
    if (patch.openaiApiKey) optimistic.openaiKeySet = true
    if (patch.clearElevenlabsKey) optimistic.elevenlabsKeySet = false
    if (patch.clearOpenaiKey) optimistic.openaiKeySet = false
    setSettings({ ...settings, voice: { ...settings.voice, ...optimistic } })
    try {
      const next = await saveSettings({ voice: patch })
      setSettings((cur) => cur ? { ...cur, ...next } : cur)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // The voice (TTS) toggle is a local, localStorage-backed preference — show it
  // regardless of backend connection so it's always discoverable.
  const voiceToggle = (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <label className="text-normal-subtitle">Voz (TTS)</label>
          <div className="text-normal-detail text-text-dim">
            lee en voz alta las respuestas del cerebro · {state.voiceEnabled ? 'on' : 'off'}
          </div>
        </div>
        <Toggle
          checked={state.voiceEnabled}
          onChange={(v) => store.setVoiceEnabled(v)}
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <label className="text-normal-subtitle">Scroll invertido</label>
          <div className="text-normal-detail text-text-dim">
            {state.scrollInverted
              ? 'deslizá ARRIBA para ver mensajes más viejos'
              : 'deslizá ABAJO para ver mensajes más viejos'}
          </div>
        </div>
        <Toggle
          checked={state.scrollInverted}
          onChange={(v) => store.setScrollInverted(v)}
        />
      </div>
      <Divider />
    </div>
  )

  if (!configured) return voiceToggle

  if (error && !settings) {
    return (
      <div className="space-y-3">
        {voiceToggle}
        <div className="rounded bg-negative/10 px-3 py-2 flex items-center justify-between">
          <span className="text-normal-detail text-negative">{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>×</Button>
        </div>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="space-y-3">
        {voiceToggle}
        <div className="text-normal-detail text-text-dim">loading settings…</div>
      </div>
    )
  }

  const permHint = PERM_OPTS.find((m) => m.value === settings.permissionMode)?.hint ?? ''

  return (
    <div className="space-y-3">
      {voiceToggle}
      <div className="flex items-center justify-between">
        <span className="text-normal-subtitle">Settings</span>
        {saving && <Badge>saving…</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-normal-detail text-text-dim">Permissions</label>
          <Select
            value={settings.permissionMode}
            options={PERM_OPTS.map<SelectOption>((m) => ({ value: m.value, label: m.label }))}
            onValueChange={(v) => void update({ permissionMode: v as PermissionMode })}
          />
          <div className="text-normal-detail text-text-dim font-mono text-xs">{permHint}</div>
        </div>

        <div className="space-y-1">
          <label className="text-normal-detail text-text-dim">Model</label>
          <Select
            value={settings.model}
            options={MODEL_OPTS}
            onValueChange={(v) => void update({ model: v })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-normal-detail text-text-dim">Effort</label>
          <Select
            value={settings.effort}
            options={EFFORT_OPTS}
            onValueChange={(v) => void update({ effort: v as EffortLevel })}
          />
        </div>

        <div className="space-y-1 flex flex-col justify-end">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <label className="text-normal-subtitle">Ultracode (experimental)</label>
            </div>
            <Toggle
              checked={settings.ultracode}
              onChange={(v) => void update({ ultracode: v })}
            />
          </div>
        </div>
      </div>

      <Divider />

      <div className="space-y-2">
        <span className="text-normal-subtitle">Voz en la nube</span>

        <div className="space-y-1">
          <label className="text-normal-detail text-text-dim">Proveedor TTS</label>
          <Select
            value={settings.voice.ttsProvider}
            options={TTS_OPTS}
            onValueChange={(v) =>
              void updateVoice({ ttsProvider: v as 'browser' | 'elevenlabs' | 'openai' })
            }
          />
        </div>

        {settings.voice.ttsProvider === 'elevenlabs' && (
          <div className="space-y-1">
            <label className="text-normal-detail text-text-dim">ElevenLabs API key</label>
            <input
              type="password"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-normal-detail"
              placeholder={settings.voice.elevenlabsKeySet ? '••••••• (configurada)' : ''}
              value={elevenKeyDraft}
              onChange={(e) => setElevenKeyDraft(e.target.value)}
              onBlur={() => {
                const k = elevenKeyDraft.trim()
                if (!k) return // empty = no change, don't send the key field
                void updateVoice({ elevenlabsApiKey: k })
                setElevenKeyDraft('')
              }}
            />
            {settings.voice.elevenlabsKeySet && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void updateVoice({ clearElevenlabsKey: true })}
              >
                borrar key
              </Button>
            )}
            <div className="text-normal-detail text-text-dim">
              la key viaja a tu Mac por tu red local y se guarda ahí (no en la app)
            </div>
            <label className="text-normal-detail text-text-dim">Voice ID</label>
            <input
              type="text"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-normal-detail"
              placeholder="ej. 21m00Tcm4TlvDq8ikWAM"
              defaultValue={settings.voice.elevenlabsVoiceId}
              onBlur={(e) => {
                const id = e.target.value.trim()
                if (id !== settings.voice.elevenlabsVoiceId) void updateVoice({ elevenlabsVoiceId: id })
              }}
            />
            <div className="text-normal-detail text-text-dim">
              dejá vacío para usar la voz por defecto de ElevenLabs
            </div>
          </div>
        )}

        {settings.voice.ttsProvider === 'openai' && (
          <div className="space-y-1">
            <label className="text-normal-detail text-text-dim">OpenAI API key</label>
            <input
              type="password"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-normal-detail"
              placeholder={settings.voice.openaiKeySet ? '••••••• (configurada)' : ''}
              value={openaiKeyDraft}
              onChange={(e) => setOpenaiKeyDraft(e.target.value)}
              onBlur={() => {
                const k = openaiKeyDraft.trim()
                if (!k) return // empty = no change, don't send the key field
                void updateVoice({ openaiApiKey: k })
                setOpenaiKeyDraft('')
              }}
            />
            {settings.voice.openaiKeySet && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void updateVoice({ clearOpenaiKey: true })}
              >
                borrar key
              </Button>
            )}
            <div className="text-normal-detail text-text-dim">
              la key viaja a tu Mac por tu red local y se guarda ahí (no en la app)
            </div>
            <label className="text-normal-detail text-text-dim">Voz</label>
            <input
              type="text"
              className="w-full rounded border border-border bg-surface px-2 py-1 text-normal-detail"
              placeholder="ej. alloy"
              defaultValue={settings.voice.openaiVoice}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== settings.voice.openaiVoice) void updateVoice({ openaiVoice: v })
              }}
            />
          </div>
        )}

        <div className="space-y-1">
          <label className="text-normal-detail text-text-dim">Brain model</label>
          <input
            type="text"
            className="w-full rounded border border-border bg-surface px-2 py-1 text-normal-detail"
            placeholder="llama-3.3-70b-versatile"
            defaultValue={settings.voice.brainModel}
            key={settings.voice.brainModel}
            onBlur={(e) => {
              const m = e.target.value.trim()
              if (m && m !== settings.voice.brainModel) void updateVoice({ brainModel: m })
            }}
          />
        </div>
      </div>

      <Divider />

      <div className="space-y-1">
        <label className="text-normal-detail text-text-dim">Default project</label>
        <Select
          value={settings.defaultProjectName}
          options={settings.projects.map<SelectOption>((p) => ({ value: p.name, label: p.name }))}
          onValueChange={(v) => void update({ defaultProjectName: v })}
        />
      </div>

      {error && (
        <div className="text-normal-detail text-negative">{error}</div>
      )}

      <Divider />
    </div>
  )
}
