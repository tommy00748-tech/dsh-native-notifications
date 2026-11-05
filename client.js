/**
 * dsh-native-notifications - native desktop notifications for DeepSeek Harness.
 *
 * Client half (renderless, always mounted). Long-polls the Host half's
 * authenticated route and shows each banner with the platform's own
 * notification API, so the banner is attributed to the DeepSeek Harness app
 * (name, icon, click target) instead of a helper process:
 *
 *   - Electron desktop shell -> native macOS banner / Windows toast, clicking
 *     focuses DSH and opens the exact conversation.
 *   - A plain browser tab -> Web Notification, with the browser permission
 *     prompt requested on the first gesture when it is still undecided.
 *
 * The Host owns detection and the text; this half owns presentation and the
 * click action. `sessionStorage`-backed cursor + Host epoch keep a page reload
 * from replaying old banners.
 *
 * @module dsh-native-notifications
 */

window.__ModuleLoader__.load({
  id: 'dsh-native-notifications',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Same-origin routes served by this package's Host half. */
    const EVENTS_ROUTE = '/native-notifications/events'
    const REPORT_ROUTE = '/native-notifications/report'
    /** Cursor record: `{ epoch, cursor }`, so a Host restart restarts from "now". */
    const STORAGE_KEY = 'dsh-native-notifications:v1'
    /** Long-poll budget; the Host clamps this to its own ceiling. */
    const POLL_WAIT_MS = 20000
    /** Backoff after a transport failure. */
    const RETRY_MS = 2000
    const MAX_RETRY_MS = 30000

    /** Best-effort diagnostic report; never throws, never blocks. */
    const report = (payload) => {
      try {
        void fetch(REPORT_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* diagnostics must never break the page */
      }
    }

    /** Wait `ms`, cancellable through a disposed flag. */
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * The plugin's own notification chime.
     *
     * A short bell motif is synthesised with Web Audio instead of playing the
     * operating system's notification sound, so every DSH banner sounds like
     * DSH and never like the system default. Each event kind gets its own
     * motif; one note is a sine fundamental with a quiet octave on top, a fast
     * attack and an exponential decay.
     */
    /** Semitone offsets inside one octave, for `C#6`-style note names. */
    const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

    /**
     * Motifs as `[frequencyHz, offsetSeconds, durationSeconds]`. Every preset
     * plays these notes; the preset only chooses the timbre.
     */
    const SOUND_MOTIFS = {
      // "done": three bouncy plucks rising do-mi-so (C6 - E6 - G6).
      complete: [[1046.5, 0, 0.2], [1318.51, 0.11, 0.2], [1567.98, 0.22, 0.55]],
      mount: [[1046.5, 0, 0.2], [1318.51, 0.11, 0.2], [1567.98, 0.22, 0.55]],
      // "attention": two bright boops (G6 - G6).
      approval: [[1567.98, 0, 0.14], [1567.98, 0.17, 0.26]],
      question: [[1567.98, 0, 0.14], [1567.98, 0.17, 0.26]],
      account: [[1567.98, 0, 0.14], [1567.98, 0.17, 0.26]],
      // "problem": a soft falling pair (F5 - C5), gentle rather than alarming.
      error: [[698.46, 0, 0.2], [523.25, 0.15, 0.45]],
      // "background finished": one soft note (E6).
      subagent: [[1318.51, 0, 0.34]],
      workflow: [[1318.51, 0, 0.34]],
    }

    /** The selectable presets, in display order; `off` mutes the chime. */
    const SOUND_PRESETS = [
      { id: 'cute', label: 'settings.sound.preset.cute' },
      { id: 'bell', label: 'settings.sound.preset.bell' },
      { id: 'bright', label: 'settings.sound.preset.bright' },
      { id: 'custom', label: 'settings.sound.preset.custom' },
      { id: 'off', label: 'settings.sound.preset.off' },
    ]
    const SOUND_DEFAULT_PRESET = 'cute'
    const SOUND_DEFAULT_CUSTOM = 'C6 E6 G6'
    const SOUND_STORAGE_KEY = 'dsh-native-notifications:sound'
    /** Client locale namespace owned by the settings row. */
    const SOUND_NS = 'desktopNotificationsSound'
    /** Custom sequences: spacing between notes and the tail note length. */
    const CUSTOM_SOUND_SPACING = 0.13
    const CUSTOM_SOUND_DURATION = 0.2
    const CUSTOM_SOUND_TAIL = 0.5

    /** Read the stored sound preference, degrading to the playful default. */
    const readSoundPreference = () => {
      const fallback = { preset: SOUND_DEFAULT_PRESET, custom: SOUND_DEFAULT_CUSTOM }
      try {
        const raw = window.localStorage.getItem(SOUND_STORAGE_KEY)
        if (typeof raw !== 'string' || raw === '') return fallback
        const parsed = JSON.parse(raw)
        const preset = SOUND_PRESETS.some((entry) => entry.id === parsed?.preset) ? parsed.preset : fallback.preset
        const custom = typeof parsed?.custom === 'string' && parsed.custom.trim() !== '' ? parsed.custom : fallback.custom
        return { preset, custom }
      } catch {
        return fallback
      }
    }

    /** Persist the sound preference; a failed write still applies this session. */
    const writeSoundPreference = (preference) => {
      try {
        window.localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(preference))
      } catch {
        /* private mode: keep the choice in memory only */
      }
    }

    /**
     * Parse a user-authored sequence: note names (`C6 E6 G#6`, `Bb5`) or raw
     * frequencies (`1046.5 1318.5`), separated by spaces or commas, max 8 notes.
     * Unknown tokens are skipped so a typo degrades instead of breaking the UI.
     */
    const parseNotes = (text) => {
      const frequencies = []
      const parts = String(text ?? '').split(/[\s,，、;]+/u).filter(Boolean).slice(0, 8)
      for (const part of parts) {
        const numeric = Number(part)
        if (Number.isFinite(numeric)) {
          if (numeric >= 80 && numeric <= 8000) frequencies.push(numeric)
          continue
        }
        const match = /^([A-Ga-g])([#b]?)(-?\d{1,2})$/u.exec(part)
        if (match === null) continue
        const semitone = NOTE_OFFSETS[match[1].toUpperCase()]
        const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0
        const midi = 12 * (Number(match[3]) + 1) + semitone + accidental
        if (midi < 24 || midi > 108) continue
        frequencies.push(440 * Math.pow(2, (midi - 69) / 12))
      }
      return frequencies
    }

    let audioContext

    /** Lazily create the AudioContext and take the chance to resume it. */
    const ensureAudio = () => {
      try {
        if (audioContext === undefined) {
          const Ctor = window.AudioContext || window.webkitAudioContext
          if (typeof Ctor !== 'function') return undefined
          audioContext = new Ctor()
        }
        if (audioContext.state === 'closed') {
          audioContext = new Ctor()
        }
        if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
        return audioContext
      } catch {
        return undefined
      }
    }

    /** Unlock audio on the first user gesture, for autoplay policies. */
    const unlockAudioOnGesture = () => {
      const unlock = () => {
        window.removeEventListener('pointerdown', unlock, true)
        window.removeEventListener('keydown', unlock, true)
        ensureAudio()
      }
      try {
        window.addEventListener('pointerdown', unlock, true)
        window.addEventListener('keydown', unlock, true)
      } catch {
        /* ignore */
      }
      return () => {
        try {
          window.removeEventListener('pointerdown', unlock, true)
          window.removeEventListener('keydown', unlock, true)
        } catch {
          /* ignore */
        }
      }
    }

    /** Release the audio graph on teardown so hot reloads cannot leak contexts. */
    const closeAudio = () => {
      const ctx = audioContext
      audioContext = undefined
      if (ctx === undefined) return
      try {
        void ctx.close?.().catch(() => {})
      } catch {
        /* ignore */
      }
    }

    /**
     * Ring one note in the requested timbre:
     *   cute   - triangle body with a soft upward glide and a high twinkle
     *   bell   - sine body with a quiet octave overtone
     *   bright - short triangle pluck with no glide
     */
    const ringTone = (ctx, out, frequency, at, duration, volume, style) => {
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = style === 'bright' ? 4400 : 3600
      filter.Q.value = 0.8
      filter.connect(out)
      if (style === 'bell') {
        const body = ctx.createOscillator()
        const octave = ctx.createOscillator()
        const bodyGain = ctx.createGain()
        const octaveGain = ctx.createGain()
        body.type = 'sine'
        body.frequency.value = frequency
        octave.type = 'sine'
        octave.frequency.value = frequency * 2.01
        bodyGain.gain.setValueAtTime(0.0001, at)
        bodyGain.gain.exponentialRampToValueAtTime(volume, at + 0.012)
        bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
        octaveGain.gain.setValueAtTime(0.0001, at)
        octaveGain.gain.exponentialRampToValueAtTime(volume * 0.22, at + 0.008)
        octaveGain.gain.exponentialRampToValueAtTime(0.0001, at + duration * 0.55)
        body.connect(bodyGain).connect(filter)
        octave.connect(octaveGain).connect(filter)
        body.start(at)
        octave.start(at)
        body.stop(at + duration + 0.05)
        octave.stop(at + duration + 0.05)
        return
      }
      const body = ctx.createOscillator()
      const bodyGain = ctx.createGain()
      body.type = 'triangle'
      if (style === 'cute') {
        body.frequency.setValueAtTime(frequency * 0.86, at)
        body.frequency.exponentialRampToValueAtTime(frequency * 1.06, at + Math.min(duration * 0.45, 0.09))
      } else {
        body.frequency.setValueAtTime(frequency, at)
      }
      bodyGain.gain.setValueAtTime(0.0001, at)
      bodyGain.gain.exponentialRampToValueAtTime(volume, at + 0.012)
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
      body.connect(bodyGain).connect(filter)
      body.start(at)
      body.stop(at + duration + 0.05)
      if (style === 'cute') {
        const twinkle = ctx.createOscillator()
        const twinkleGain = ctx.createGain()
        twinkle.type = 'sine'
        twinkle.frequency.value = frequency * 2.4
        twinkleGain.gain.setValueAtTime(0.0001, at)
        twinkleGain.gain.exponentialRampToValueAtTime(volume * 0.12, at + 0.012)
        twinkleGain.gain.exponentialRampToValueAtTime(0.0001, at + duration * 0.5)
        twinkle.connect(twinkleGain).connect(filter)
        twinkle.start(at)
        twinkle.stop(at + duration + 0.05)
      }
    }

    /** The timbre a preset id renders with; custom sequences use the playful one. */
    const styleOf = (preset) => {
      if (preset === 'bell') return 'bell'
      if (preset === 'bright') return 'bright'
      return 'cute'
    }

    /**
     * Play the chime for one event kind.
     * @param kind - the banner kind (`complete`, `question`, ...).
     * @param presetOverride - play this preset instead of the stored preference.
     */
    const playSound = (kind, presetOverride) => {
      const preference = readSoundPreference()
      const preset = presetOverride ?? preference.preset
      if (preset === 'off') return
      const notes = preset === 'custom' ? parseNotes(preference.custom) : undefined
      const sequence = notes !== undefined && notes.length > 0
        ? notes.map((frequency, index) => [
            frequency,
            index * CUSTOM_SOUND_SPACING,
            index === notes.length - 1 ? CUSTOM_SOUND_TAIL : CUSTOM_SOUND_DURATION,
          ])
        : SOUND_MOTIFS[kind] ?? SOUND_MOTIFS.complete
      const style = styleOf(preset)
      const ctx = ensureAudio()
      if (ctx === undefined) return
      try {
        // A context that is still suspended cannot ring yet; the next gesture resumes it.
        if (ctx.state === 'suspended') return
        const master = ctx.createGain()
        const lowpass = ctx.createBiquadFilter()
        const limiter = ctx.createDynamicsCompressor()
        master.gain.value = 0.9
        lowpass.type = 'lowpass'
        lowpass.frequency.value = 6000
        limiter.threshold.value = -10
        limiter.knee.value = 10
        limiter.ratio.value = 4
        limiter.attack.value = 0.003
        limiter.release.value = 0.3
        master.connect(lowpass).connect(limiter).connect(ctx.destination)
        const start = ctx.currentTime + 0.02
        for (const [frequency, offset, duration] of sequence) {
          ringTone(ctx, master, frequency, start + offset, duration, 1, style)
        }
        report({ type: 'sound', kind, preset })
      } catch {
        /* audio is best effort */
      }
    }

    /** Read the stored cursor; malformed or unavailable storage means "start now". */
    const readCursor = () => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (typeof raw !== 'string' || raw === '') return undefined
        const parsed = JSON.parse(raw)
        if (typeof parsed?.epoch === 'string' && Number.isInteger(parsed?.cursor)) return parsed
      } catch {
        /* private mode, disabled storage, or a corrupt record */
      }
      return undefined
    }

    /** Persist the cursor so a reload does not replay banners already shown. */
    const writeCursor = (epoch, cursor) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ epoch, cursor }))
      } catch {
        /* storage unavailable: worst case one banner is repeated after a reload */
      }
    }

    /** The page's notification permission, or 'unsupported'. */
    const permissionOf = () => {
      try {
        if (typeof window.Notification !== 'function') return 'unsupported'
        return window.Notification.permission
      } catch {
        return 'unsupported'
      }
    }

    /** Reachable General-settings row classes (prefixed so host CSS cannot collide). */
    const SOUND_ROW = {
      row: 'dsnSoundRow',
      text: 'dsnSoundText',
      title: 'dsnSoundTitle',
      desc: 'dsnSoundDesc',
      input: 'dsnSoundInput',
      controls: 'dsnSoundControls',
      selector: 'dsnSoundSelector',
      preview: 'dsnSoundPreview',
    }

    /** Row styling copied from the host's General preference rows, theme tokens only. */
    const SOUND_CSS = [
      '.dsnSoundRow{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
      '.dsnSoundText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
      '.dsnSoundTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dsnSoundDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.dsnSoundInput{box-sizing:border-box;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;max-width:280px;padding:7px 10px}',
      '.dsnSoundControls{align-items:center;gap:8px;display:flex}',
      '.dsnSoundSelector{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;border:none;height:36px;padding:0 12px;font:inherit;font-size:14px;line-height:22px}',
      '.dsnSoundSelector:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsnSoundPreview{border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-state-business-primary);cursor:pointer;border:none;height:36px;padding:0 10px;font:inherit;font-size:14px;line-height:22px}',
      '.dsnSoundPreview:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    ].join('')

    /** Simplified Chinese copy for the sound row (the key-set source of truth). */
    const SOUND_LOCALE_ZH = {
      'settings.sound.title': '通知音效',
      'settings.sound.description': '任务完成、需要你操作时的提示音。可选预设，或自定义音高序列（如 C6 E6 G6，支持音名或频率）。',
      'settings.sound.preview': '试听',
      'settings.sound.preset.cute': '可爱气泡',
      'settings.sound.preset.bell': '清脆铃声',
      'settings.sound.preset.bright': '明亮拨弦',
      'settings.sound.preset.custom': '自定义',
      'settings.sound.preset.off': '静音',
    }

    /** English copy, checked complete against the zh key set. */
    const SOUND_LOCALE_EN = {
      'settings.sound.title': 'Notification sound',
      'settings.sound.description': 'The chime for finished tasks and requests. Pick a preset, or enter your own note sequence (for example C6 E6 G6; note names or frequencies).',
      'settings.sound.preview': 'Preview',
      'settings.sound.preset.cute': 'Playful bubbles',
      'settings.sound.preset.bell': 'Soft bell',
      'settings.sound.preset.bright': 'Bright pluck',
      'settings.sound.preset.custom': 'Custom',
      'settings.sound.preset.off': 'Muted',
    }

    /**
     * One General-settings row: choose a preset, preview it, or author a note
     * sequence. The preference lives in localStorage, so it is read lazily by
     * `playSound` on every banner and needs no Host round trip.
     */
    function SoundSettingsRow({ t }) {
      const [preference, setPreference] = React.useState(readSoundPreference)
      const [draft, setDraft] = React.useState(preference.custom)
      const commit = (next) => {
        setPreference(next)
        writeSoundPreference(next)
      }
      const choose = (preset) => {
        commit({ ...preference, preset })
      }
      const editCustom = (value) => {
        setDraft(value)
        commit({ ...preference, preset: 'custom', custom: value })
      }
      const children = [
        h('div', { className: SOUND_ROW.text, key: 'text' }, [
          h('div', { className: SOUND_ROW.title, key: 'title' }, t('settings.sound.title')),
          h('div', { className: SOUND_ROW.desc, key: 'desc' }, t('settings.sound.description')),
          preference.preset === 'custom'
            ? h('input', {
                className: SOUND_ROW.input,
                key: 'custom',
                value: draft,
                placeholder: SOUND_DEFAULT_CUSTOM,
                'aria-label': t('settings.sound.preset.custom'),
                spellCheck: false,
                onChange: (event) => editCustom(event.target.value),
              })
            : null,
        ]),
        h('div', { className: SOUND_ROW.controls, key: 'controls' }, [
          h(
            'select',
            {
              className: SOUND_ROW.selector,
              key: 'select',
              value: preference.preset,
              'aria-label': t('settings.sound.title'),
              onChange: (event) => choose(event.target.value),
            },
            SOUND_PRESETS.map((entry) => h('option', { key: entry.id, value: entry.id }, t(entry.label))),
          ),
          h(
            'button',
            {
              className: SOUND_ROW.preview,
              key: 'preview',
              type: 'button',
              onClick: () => playSound('complete', preference.preset),
            },
            t('settings.sound.preview'),
          ),
        ]),
      ]
      return h('div', { className: SOUND_ROW.row }, children)
    }

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        if (typeof window === 'undefined' || typeof document === 'undefined') return
        let stopped = false
        /** Abort handle of the in-flight long poll, so teardown never leaves it hanging. */
        let activeAbort
        let permissionReported = false
        let config = { enabled: true, onlyWhenUnfocused: false, silent: false }

        /** Report the permission state once, so the Host audit log explains silence. */
        const notePermission = (permission) => {
          if (permissionReported) return
          permissionReported = true
          report({ type: 'permission', permission })
        }

        /**
         * Ask the browser for permission on the first user gesture, but only when
         * it is still undecided. Electron already grants it; a plain browser needs
         * the gesture.
         */
        const askPermissionOnGesture = () => {
          const ask = () => {
            window.removeEventListener('pointerdown', ask, true)
            try {
              const pending = window.Notification.requestPermission()
              if (pending !== undefined && typeof pending.then === 'function') {
                pending.then((permission) => report({ type: 'permission', permission })).catch(() => {})
              }
            } catch {
              /* a browser that refuses the request stays silent */
            }
          }
          try {
            if (typeof window.Notification !== 'function') return () => {}
            if (window.Notification.permission !== 'default') return () => {}
            window.addEventListener('pointerdown', ask, true)
          } catch {
            /* ignore */
          }
          return () => {
            try {
              window.removeEventListener('pointerdown', ask, true)
            } catch {
              /* ignore */
            }
          }
        }

        /** Whether the page is in the foreground right now. */
        const isForeground = () => {
          try {
            return document.visibilityState === 'visible' && document.hasFocus()
          } catch {
            return false
          }
        }

        /** Open the banner's conversation and focus the app. */
        const focusSession = (sessionId) => {
          try {
            window.focus()
          } catch {
            /* ignore */
          }
          if (typeof sessionId !== 'string' || sessionId === '') return
          try {
            const uiWorkspace = ctx.get('uiWorkspace')
            if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
              uiWorkspace.openSession(sessionId)
            }
          } catch {
            /* navigation is best effort */
          }
        }

        /** Show one Host-authored banner through the platform notification API. */
        const show = (event) => {
          if (config.enabled === false) return
          if (config.onlyWhenUnfocused === true && isForeground()) {
            report({ type: 'suppressed', kind: event.kind })
            return
          }
          const permission = permissionOf()
          if (permission === 'unsupported') {
            notePermission(permission)
            return
          }
          if (permission === 'denied') {
            notePermission(permission)
            return
          }
          if (permission === 'default') {
            notePermission(permission)
            return
          }
          if (config.silent !== true) playSound(event.kind)
          try {
            const notification = new window.Notification(String(event.title), {
              body: String(event.body ?? ''),
              // The plugin's own chime carries the sound; the OS default stays off.
              silent: true,
              tag: `dsh-${event.sessionId || 'app'}-${event.seq}`,
            })
            notification.onclick = () => {
              focusSession(event.sessionId)
              try {
                notification.close()
              } catch {
                /* ignore */
              }
            }
            notification.onerror = () => report({ type: 'banner-error', kind: event.kind })
            report({ type: 'shown', kind: event.kind, permission })
          } catch (error) {
            report({ type: 'banner-failed', kind: event.kind, message: String(error) })
          }
        }

        /** One long-poll request; resolves after the response was applied. */
        const pollOnce = async () => {
          const stored = readCursor()
          const params = new URLSearchParams()
          params.set('wait', String(POLL_WAIT_MS))
          params.set('after', stored === undefined ? '-1' : String(stored.cursor))
          const request = typeof AbortController === 'function' ? new AbortController() : undefined
          activeAbort = request
          // The Host holds the request for `wait`; anything longer means the
          // carrier or the Host went away. Retry instead of hanging forever.
          const timer = setTimeout(() => {
            try {
              request?.abort()
            } catch {
              /* ignore */
            }
          }, POLL_WAIT_MS + 10000)
          let response
          try {
            response = await fetch(`${EVENTS_ROUTE}?${params.toString()}`, {
              headers: { accept: 'application/json' },
              signal: request?.signal,
            })
          } finally {
            clearTimeout(timer)
            activeAbort = undefined
          }
          if (!response.ok) {
            const error = new Error(`events route answered ${response.status}`)
            error.status = response.status
            throw error
          }
          const payload = await response.json()
          const epoch = typeof payload?.epoch === 'string' ? payload.epoch : 'unknown'
          if (payload?.config !== null && typeof payload?.config === 'object') {
            config = { ...config, ...payload.config }
          }
          const events = Array.isArray(payload?.events) ? payload.events : []
          if (stored !== undefined && stored.epoch !== epoch) {
            // The Host restarted; its sequence restarted too. Start from "now".
            writeCursor(epoch, Number.isInteger(payload?.cursor) ? payload.cursor : 0)
            return
          }
          for (const event of events) {
            if (event !== null && typeof event === 'object' && typeof event.title === 'string') show(event)
          }
          const cursor = Number.isInteger(payload?.cursor) ? payload.cursor : stored?.cursor ?? 0
          writeCursor(epoch, cursor)
        }

        /** The polling loop; one banner per event, cursor persisted across reloads. */
        const loop = async () => {
          let backoff = RETRY_MS
          while (!stopped) {
            try {
              await pollOnce()
              backoff = RETRY_MS
            } catch (error) {
              if (stopped) return
              const status = error?.status
              if (status === 401 || status === 403) {
                report({ type: 'unauthorized', status })
                await delay(MAX_RETRY_MS)
                continue
              }
              if (status === 404) {
                report({ type: 'route-missing', status })
                await delay(MAX_RETRY_MS)
                continue
              }
              report({ type: 'poll-failed', message: String(error) })
              await delay(backoff)
              backoff = Math.min(MAX_RETRY_MS, backoff * 2)
            }
          }
        }

        // Settings row: styles, dictionaries, and the General-section entry. These
        // are page-level effects owned by this plugin; teardown removes them.
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-native-notifications'
          tag.textContent = SOUND_CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-native-notifications: settings styles')
        ctx.effect(() => ctx.locale.register(SOUND_NS, { zh: SOUND_LOCALE_ZH, en: SOUND_LOCALE_EN }), 'dsh-native-notifications: settings dictionaries')
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'desktop-notifications-sound',
          order: 25,
          locale: SOUND_NS,
        }, SoundSettingsRow))

        ctx.effect(() => {
          report({
            type: 'boot',
            permission: permissionOf(),
            protocol: window.location.protocol,
            path: window.location.pathname,
            visibility: document.visibilityState,
            sound: readSoundPreference().preset,
            chime: 'v5-robust',
          })
          const releasePermission = askPermissionOnGesture()
          const releaseUnlock = unlockAudioOnGesture()
          void loop()
          return () => {
            stopped = true
            try {
              activeAbort?.abort()
            } catch {
              /* ignore */
            }
            releasePermission()
            releaseUnlock()
            closeAudio()
            report({ type: 'shutdown' })
          }
        }, 'dsh-native-notifications: client')
      },
    }
  },
})
