/**
 * dsh-native-notifications - native desktop notifications for DeepSeek Harness.
 *
 * Host half. Watches the Harness events that mean "a human is needed or the work
 * is done" and hands each one to the connected Web client, which shows it as a
 * native OS notification attributed to the DeepSeek Harness app (macOS banner,
 * Windows toast, Linux notification). A click focuses DSH and opens the exact
 * conversation.
 *
 * Wired events:
 *   agent/status (idle, after running)    -> "任务完成 · 用时 …"
 *   approval/request (still pending)      -> "需要你确认权限 · …"
 *   user-questions/request (still pending)-> "正在等待你的选择 · …"
 *   agent/error                           -> "执行出错 · …"
 *   deepseek-account/*                    -> "需要登录 …"
 *   subagent/end, workflow/end            -> optional, off by default
 *
 * Transport: this half keeps a small ring buffer and serves two same-origin
 * routes on `ctx.webServer`:
 *   GET  /native-notifications/events?after=<seq>&wait=<ms>  (long poll)
 *   POST /native-notifications/report                        (client diagnostics)
 * Both are gated by `ctx.connection.requestRejection`, exactly like other
 * Host-owned Web routes, so only the authenticated page can read them.
 *
 * The optional `osascript` lane stays available for hosts whose page cannot show
 * Web notifications (for example a plain browser without permission); it is off
 * by default because macOS attributes those banners to Script Editor.
 *
 * Compatible with dsh 0.2.1-rc.5 through the 0.2.2 line; the row declares the
 * top-level `engines.dsh` range the runtime evaluates (0.2.2 ignores `dsh.engines`).
 *
 * @module dsh-native-notifications
 */

import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin name shown by the loader. */
export const name = 'dsh-native-notifications'

/** Absolute osascript path on macOS; overridable through config. */
const DEFAULT_OSASCRIPT = '/usr/bin/osascript'

/** Same-origin routes shared verbatim with the client half. */
const EVENTS_ROUTE = '/native-notifications/events'
const REPORT_ROUTE = '/native-notifications/report'

/** Upper bounds that keep one slow or hostile caller from pinning the Host. */
const MAX_QUEUE = 50
const MAX_WAIT_MS = 20000
const MAX_EVENTS_PER_RESPONSE = 20
const MAX_REPORT_BYTES = 32 * 1024

/** Default configuration; every field can be overridden from the profile patch. */
const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** How banners are delivered: the browser page, the osascript lane, or both. */
  delivery: 'client',
  /** Play the notification sound. */
  sound: true,
  /** macOS sound name for the osascript lane; empty means no sound. */
  soundName: 'Glass',
  /** Subtitle line for the osascript lane (the app identity). */
  subtitle: 'DeepSeek Harness',
  /** osascript executable; empty means /usr/bin/osascript. */
  osascriptPath: '',
  /** Let the page skip banners while its window is focused (native-app behaviour). */
  onlyWhenUnfocused: false,
  /** Ask the client to show banners without sound. */
  silent: false,
  /** Notify while an approval request still waits for a human. */
  notifyApproval: true,
  /** Notify while a user question waits for a choice. */
  notifyQuestion: true,
  /** Notify when a session finishes its turn and goes idle. */
  notifyComplete: true,
  /** Notify on agent errors. */
  notifyError: true,
  /** Notify when the account needs a sign-in. */
  notifyAccount: true,
  /** Notify when a delegated child agent settles (off: usually noisy). */
  notifySubagent: false,
  /** Notify when a workflow run settles (off: usually noisy). */
  notifyWorkflow: false,
  /** Ring once when the plugin mounts, which doubles as an install check. */
  notifyOnMount: false,
  /** Completion notifications only for root sessions, not subagents/teams. */
  onlyRootSessions: true,
  /** Title = the conversation title; false uses the fixed fallback title. */
  useSessionTitle: true,
  /** Strip markdown markers out of the title/body before showing the banner. */
  stripMarkdown: true,
  /** A resolved conversation title is truncated to this many characters. */
  titleMaxChars: 60,
  /** How long a folded conversation title stays cached. */
  titleCacheTtlMs: 30000,
  /** Wait this long before announcing an approval (0 = at once). */
  approvalDelayMs: 1500,
  /** Wait this long before announcing a question (0 = at once). */
  questionDelayMs: 500,
  /** Idle must hold this long before it counts as "done" (goal rounds re-enter fast). */
  idleGraceMs: 4000,
  /** Do not announce completion this soon after an error banner (0 disables). */
  errorSuppressMs: 8000,
  /** Drop a repeated identical banner inside this window. */
  dedupeWindowMs: 1500,
  /** Body text is truncated to this many characters. */
  bodyMaxChars: 180,
  /** Append one line per notification to an audit log. */
  logEnabled: true,
  /** Audit log path; empty means `<DSH home>/dsh-native-notifications.log`. */
  logPath: '',
  /** Rotate the audit log once it grows past this size. */
  logMaxBytes: 262144,
}

/**
 * Merge the row config over the defaults, dropping values of the wrong type so a
 * malformed patch entry degrades to a working default instead of throwing.
 * @param config - the raw config object the loader passed to apply().
 * @returns a fully populated, type-checked configuration.
 */
function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const resolved = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') resolved[key] = value
      continue
    }
    if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) resolved[key] = value
      continue
    }
    if (typeof value === 'string') resolved[key] = value
  }
  if (!['client', 'osascript', 'both'].includes(resolved.delivery)) resolved.delivery = DEFAULTS.delivery
  return resolved
}

/** Resolve the audit log path; an empty `logPath` means `<DSH home>/dsh-native-notifications.log`. */
function logPathOf(config) {
  if (typeof config.logPath === 'string' && config.logPath.trim() !== '') return config.logPath
  const envHome = process.env.DSH_HOME
  const home = typeof envHome === 'string' && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return join(home, 'dsh-native-notifications.log')
}

/**
 * Append one audit line so "why did no banner appear?" has an answer outside the
 * host process. Never throws: a broken log must not break a turn.
 */
function appendLog(config, line) {
  if (!config.logEnabled) return
  try {
    const path = logPathOf(config)
    mkdirSync(dirname(path), { recursive: true })
    try {
      if (statSync(path).size > config.logMaxBytes) renameSync(path, `${path}.1`)
    } catch {
      /* the log does not exist yet */
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* logging must never break a turn */
  }
}

/**
 * Strip inline markdown so a banner never shows `**`, backticks or `~~`.
 * Underscores are deliberately left alone: they are far more common inside file
 * names and identifiers than as emphasis.
 */
function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*\*|\*\*|~~|\*)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|\n)\s*#{1,6}\s+/g, '$1')
    .replace(/(^|\n)\s*>\s?/g, '$1')
    .replace(/[*~`]/g, '')
}

/** Collapse whitespace and cut the text to `max` characters with an ellipsis. */
function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Human-readable elapsed time such as `3 秒` / `2 分 05 秒`. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}

/** Best-effort human message out of an unknown thrown value. */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = error.message
    if (typeof message === 'string') return message
    const reason = error.reason
    if (typeof reason === 'string') return reason
    const code = error.code
    if (typeof code === 'string') return code
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error ?? '')
}

/** Pick the localised approval reason when the harness supplied one. */
function approvalReason(req) {
  const display = req?.displayReason
  if (display !== null && typeof display === 'object') {
    for (const key of ['zh-CN', 'zh', 'zh-Hans', 'en']) {
      const value = display[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  const reason = req?.reason
  return typeof reason === 'string' ? reason : ''
}

/** First id-looking value among the candidates, so payloads can vary safely. */
function pickSessionId(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (candidate !== null && typeof candidate === 'object') {
      const id = candidate.id
      if (typeof id === 'string' && id !== '') return id
    }
  }
  return ''
}

/** Escape one AppleScript string literal (backslashes and double quotes). */
function appleScriptString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

/**
 * Build the AppleScript that posts one macOS notification banner.
 * @param config - resolved plugin configuration.
 * @param title - banner title (the conversation name).
 * @param body - banner body (what happened).
 * @returns one `-e` script for osascript.
 */
function notificationScript(config, title, body) {
  const parts = [`display notification "${appleScriptString(body)}"`, `with title "${appleScriptString(title)}"`]
  const subtitle = typeof config.subtitle === 'string' ? config.subtitle.trim() : ''
  if (subtitle !== '') parts.push(`subtitle "${appleScriptString(subtitle)}"`)
  const soundName = typeof config.soundName === 'string' ? config.soundName.trim() : ''
  if (config.sound && soundName !== '') parts.push(`sound name "${appleScriptString(soundName)}"`)
  return parts.join(' ')
}

/**
 * Raise one banner through osascript (the optional non-client lane).
 * @returns a promise that settles when the helper exits (never rejects).
 */
function deliverOsascript(config, title, body, trace) {
  if (process.platform !== 'darwin') {
    trace(`osascript lane: unsupported platform ${process.platform}`)
    return Promise.resolve()
  }
  const executable = config.osascriptPath !== '' ? config.osascriptPath : DEFAULT_OSASCRIPT
  const script = notificationScript(config, title, body)
  return new Promise((resolve) => {
    try {
      execFile(
        executable,
        ['-e', script],
        { timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error !== null) {
            const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : errorMessage(error)
            trace(`osascript failed: ${truncate(detail, 200)}`)
          } else {
            trace('osascript accepted the banner')
          }
          resolve()
        },
      )
    } catch (error) {
      trace(`osascript spawn threw: ${errorMessage(error)}`)
      resolve()
    }
  })
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** JSON response (no-store: banners are live facts). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Clamp one query parameter to a safe integer. */
function queryInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Send one banner outside the plugin lifecycle. Exposed for diagnostics
 * (`node --input-type=module -e "import('./index.js').then(m => m.notifyTest())"`)
 * and for `node -e` smoke tests of the osascript lane.
 * @param title - banner title (first line).
 * @param body - banner body (second line).
 * @param overrides - partial config, resolved over the defaults.
 * @returns a promise that settles once the banner was handed to the OS.
 */
export async function notifyTest(title = '通知通道测试', body = '桌面通知横幅工作正常。', overrides = {}) {
  const config = resolveConfig(overrides)
  const clean = config.stripMarkdown ? stripMarkdown : (value) => value
  const heading = truncate(clean(title), config.titleMaxChars)
  const text = truncate(clean(body), config.bodyMaxChars)
  appendLog(config, `manual test :: ${heading} :: ${text}`)
  await deliverOsascript(config, heading, text, (line) => appendLog(config, `manual test :: ${line}`))
}

/**
 * Host body: watch the "a human is needed / the work is done" events, queue a
 * banner event for the page, and serve the two same-origin routes the client
 * half long-polls.
 * @param ctx - host root context.
 * @param config - the row's resolved configuration.
 */
export function apply(ctx, config) {
  let disposed = false
  /** Monotonic banner sequence; the client's cursor. */
  let nextSeq = 0
  /** Ring buffer of undelivered/just-delivered banner events. */
  const queue = []
  /** Per-host-run identity: a client that sees a new epoch restarts from "now". */
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  /** Pending long-poll responses. */
  const waiters = new Set()
  let lastKey = ''
  let lastAt = 0
  /** sessionId -> epoch ms when its current turn started running. */
  const turnStarted = new Map()
  /** sessionId -> pending idle timer. */
  const idleTimers = new Map()
  /** Pending "is it still waiting?" delay cancellers, cleared on dispose. */
  const pendingDelays = new Set()
  /** sessionId -> epoch ms of the last announced error. */
  const lastErrorAt = new Map()
  /** sessionId -> the agent has been observed running at least once. */
  const everRan = new Set()
  /** sessionId -> { title, at } folded from the session log. */
  const titleCache = new Map()
  /** The conversation the user touched (or ran) most recently. */
  let lastActiveSessionId = ''

  /** The configuration the page needs for each banner it shows. */
  const clientConfig = () => {
    const cfg = resolveConfig(config)
    return {
      enabled: cfg.enabled,
      onlyWhenUnfocused: cfg.onlyWhenUnfocused,
      silent: cfg.silent,
      delivery: cfg.delivery,
    }
  }

  /** Events strictly after `after` (the client's cursor), bounded per response. */
  const snapshot = (after) => {
    const events = queue.filter((event) => event.seq > after).slice(-MAX_EVENTS_PER_RESPONSE)
    return { epoch, cursor: nextSeq, events, config: clientConfig() }
  }

  /** Answer every pending long poll whose cursor is behind the queue. */
  const flushWaiters = () => {
    for (const waiter of [...waiters]) {
      const payload = snapshot(waiter.after)
      if (payload.events.length === 0) continue
      waiter.settle(payload)
    }
  }

  /** Remember a conversation id so session-less events still lead with a name. */
  const rememberSession = (...candidates) => {
    const id = pickSessionId(...candidates)
    if (id !== '') lastActiveSessionId = id
    return id
  }

  /**
   * Raise one banner event and/or one osascript banner.
   * @param kind - stable event kind, useful in diagnostics (`complete`, `approval`, …).
   * @param sessionId - the conversation the banner belongs to ('' when unknown).
   * @param title - banner title (the conversation name).
   * @param body - banner body (what happened).
   * @returns whether a banner was raised.
   */
  const fire = (kind, sessionId, title, body) => {
    if (disposed) return false
    const cfg = resolveConfig(config)
    if (!cfg.enabled) return false
    const clean = cfg.stripMarkdown ? stripMarkdown : (value) => value
    const heading = truncate(clean(title), cfg.titleMaxChars)
    const text = truncate(clean(body), cfg.bodyMaxChars)
    const key = `${kind}\u0000${sessionId ?? ''}\u0000${heading}\u0000${text}`
    const now = Date.now()
    if (key === lastKey && now - lastAt < cfg.dedupeWindowMs) return false
    lastKey = key
    lastAt = now
    appendLog(cfg, `banner :: ${heading} :: ${text}`)
    if (cfg.delivery === 'osascript' || cfg.delivery === 'both') {
      void deliverOsascript(cfg, heading, text, (line) => appendLog(cfg, `  ${line}`))
    }
    if (cfg.delivery === 'client' || cfg.delivery === 'both') {
      nextSeq += 1
      queue.push({
        seq: nextSeq,
        kind,
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        title: heading,
        body: text,
        time: now,
      })
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
      flushWaiters()
    }
    return true
  }

  /**
   * Fold one session's latest title out of its log. Cached for a short TTL, and
   * every failure degrades to "no title" rather than to a lost banner.
   * @returns the title, or '' when the log has none / cannot be read.
   */
  const sessionTitle = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    const cfg = resolveConfig(config)
    if (!cfg.useSessionTitle) return ''
    const cached = titleCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < cfg.titleCacheTtlMs) return cached.title
    let title = ''
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.readTitle === 'function') {
        const result = await query.readTitle(sessionId)
        if (typeof result?.title === 'string') title = result.title.trim()
      }
    } catch {
      title = ''
    }
    titleCache.set(sessionId, { title, at: Date.now() })
    return title
  }

  /**
   * The newest conversation in the corpus, used only when neither the event nor
   * the activity feed named one (a sign-in prompt, the mount check, ...).
   */
  const newestSessionId = async () => {
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.listSessions === 'function') {
        const records = await query.listSessions()
        if (Array.isArray(records) && records.length > 0) {
          const id = records[0]?.header?.id
          if (typeof id === 'string' && id !== '') return id
        }
      }
    } catch {
      /* fall through to the app-name heading */
    }
    return ''
  }

  /**
   * Fire a banner whose title is always a conversation name: the event's own
   * session when it has one, otherwise the last conversation in use, and finally
   * the newest conversation in the corpus. Only when no title can be folded at
   * all does it fall back to the app name.
   */
  const fireFor = (kind, sessionId, body) => {
    void (async () => {
      let title = await sessionTitle(sessionId)
      if (title === '' && lastActiveSessionId !== '' && lastActiveSessionId !== sessionId) {
        title = await sessionTitle(lastActiveSessionId)
      }
      if (title === '') {
        const newest = await newestSessionId()
        if (newest !== '' && newest !== sessionId) title = await sessionTitle(newest)
      }
      fire(kind, sessionId, title === '' ? 'DeepSeek Harness' : title, body)
    })().catch(() => {
      /* a notification must never surface an error into the host */
    })
  }

  /** Whether this session is a root session (not a delegated child). */
  const isRootSession = (agent) => {
    const id = agent?.id
    if (typeof id !== 'string' || id === '') return true
    let agents
    try {
      agents = ctx.get('agents')
    } catch {
      return true
    }
    if (agents === undefined || typeof agents.roots !== 'function') return true
    try {
      return agents.roots().some((candidate) => candidate?.id === id)
    } catch {
      return true
    }
  }

  /** Whether a Web carrier route may accept this request (Host/Origin/auth gate). */
  const rejected = (req, res) => {
    let connection
    try {
      connection = ctx.get('connection')
    } catch {
      connection = undefined
    }
    // Fail closed: a Web route that cannot authenticate must not answer.
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      res.statusCode = 503
      res.end()
      return true
    }
    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch {
      // A carrier that cannot evaluate trust must not leave the response hanging.
      rejection = 503
    }
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** GET long poll: answer at once when the cursor is behind, else wait for the next banner. */
  const handleEvents = async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    const url = new URL(String(req.url), 'http://localhost')
    const after = queryInt(url.searchParams.get('after'), -1, -1, Number.MAX_SAFE_INTEGER)
    const wait = queryInt(url.searchParams.get('wait'), 0, 0, MAX_WAIT_MS)
    // `after=-1` means "start from now": answer with the cursor and no history.
    if (after < 0 || wait === 0) {
      sendJson(res, 200, after < 0 ? { ...snapshot(Number.MAX_SAFE_INTEGER), events: [] } : snapshot(after))
      return
    }
    const payload = snapshot(after)
    if (payload.events.length > 0) {
      sendJson(res, 200, payload)
      return
    }
    let settled = false
    const waiter = {
      after,
      settle: (body) => {
        if (settled) return
        settled = true
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, body)
      },
    }
    waiter.timer = setTimeout(() => waiter.settle(snapshot(after)), wait)
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
    waiters.add(waiter)
    res.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
    })
  }

  /** POST diagnostics: the client reports its boot state and each banner outcome. */
  const handleReport = async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }
    let text
    try {
      text = await readBoundedBody(req, MAX_REPORT_BYTES)
    } catch {
      text = null
    }
    if (text === null) {
      sendJson(res, 413, { code: 'payload-too-large', message: 'report body too large' })
      return
    }
    let report
    try {
      report = JSON.parse(text)
    } catch {
      sendJson(res, 400, { code: 'bad-request', message: 'report body must be JSON' })
      return
    }
    const cfg = resolveConfig(config)
    const rawType = typeof report?.type === 'string' ? report.type : 'unknown'
    const type = rawType.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'unknown'
    const detail = truncate(
      Object.entries(report ?? {})
        .filter(([key]) => key !== 'type')
        .map(([key, value]) => `${key}=${typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`)
        .join(' '),
      300,
    )
    appendLog(cfg, `client :: ${type} :: ${detail}`)
    sendJson(res, 200, { ok: true })
  }

  // The two routes exist only where a Web carrier exists; other profiles keep
  // the event-detection half (osascript lane) working on their own.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: EVENTS_ROUTE, handler: handleEvents }), `native-notifications: GET ${EVENTS_ROUTE}`)
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: REPORT_ROUTE, handler: handleReport }), `native-notifications: POST ${REPORT_ROUTE}`)
    appendLog(resolveConfig(config), `routes registered :: GET ${EVENTS_ROUTE} :: POST ${REPORT_ROUTE}`)
  })

  /** Run `action` after `delay` ms unless the waiter is cancelled. */
  const later = (delay, action) => {
    const cancel = () => {
      clearTimeout(timer)
      pendingDelays.delete(cancel)
    }
    const timer = setTimeout(() => {
      pendingDelays.delete(cancel)
      action()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    pendingDelays.add(cancel)
    return cancel
  }

  /**
   * Subscribe to a "a human must answer this" waterfall event.
   *
   * These are claimed by whichever listener answers first, so this listener is
   * PREPENDED: it must be reached before the composed answerer (the web client)
   * claims the request. It always delegates with `next()` and never lets its own
   * failure break the request.
   *
   * The banner is delayed (config) and only fires while the request is STILL
   * pending: an approval the automatic reviewer already settled, or one the user
   * answered immediately, must not ring.
   */
  const onWaiting = (event, delayOf, topic, describe) => {
    const listener = (payload, next) => {
      let settleWait
      try {
        const cfg = resolveConfig(config)
        const enabled =
          (event === 'approval/request' && cfg.notifyApproval) ||
          (event === 'user-questions/request' && cfg.notifyQuestion)
        if (cfg.enabled && enabled) {
          const sessionId = rememberSession(payload?.agent)
          const body = `${topic} · ${describe(payload)}`
          let settled = false
          const cancel = later(Math.max(0, delayOf(cfg)), () => {
            if (!settled) fireFor(event === 'approval/request' ? 'approval' : 'question', sessionId, body)
          })
          settleWait = () => {
            settled = true
            cancel()
          }
        }
      } catch {
        /* never break the request */
      }
      const outcome = next()
      if (settleWait !== undefined) {
        Promise.resolve(outcome).then(settleWait, settleWait)
      }
      return outcome
    }
    try {
      ctx.on(event, listener, { prepend: true })
    } catch {
      try {
        ctx.on(event, listener, true)
      } catch {
        ctx.on(event, listener)
      }
    }
  }

  onWaiting(
    'approval/request',
    (cfg) => cfg.approvalDelayMs,
    '需要你确认权限',
    (req) => {
      const tool = typeof req?.toolName === 'string' && req.toolName !== '' ? req.toolName : '未知工具'
      const reason = approvalReason(req)
      return reason === '' ? tool : `${tool} · ${reason}`
    },
  )

  onWaiting(
    'user-questions/request',
    (cfg) => cfg.questionDelayMs,
    '正在等待你的选择',
    (request) => {
      const questions = Array.isArray(request?.questions) ? request.questions : []
      const first = questions[0]
      const head = typeof first?.header === 'string' && first.header !== '' ? `${first.header}：` : ''
      const text = typeof first?.question === 'string' ? first.question : '有一条待回答的问题'
      const more = questions.length > 1 ? `（共 ${questions.length} 项）` : ''
      return `${head}${text}${more}`
    },
  )

  // Remember which conversation the user is working in, so events that carry no
  // session of their own still lead with a conversation name.
  ctx.on('api-session/activity', (sessionId) => {
    rememberSession(sessionId)
  })

  ctx.on('agent/status', (payload) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyComplete) return
    const agent = payload?.agent
    const id = agent?.id
    if (typeof id !== 'string' || id === '') return
    const status = payload?.status

    if (status === 'running') {
      const stale = idleTimers.get(id)
      if (stale !== undefined) clearTimeout(stale)
      idleTimers.delete(id)
      everRan.add(id)
      turnStarted.set(id, Date.now())
      rememberSession(id)
      return
    }
    if (status !== 'idle') return
    rememberSession(id)
    if (!everRan.has(id)) return
    if (cfg.onlyRootSessions && !isRootSession(agent)) return

    const stale = idleTimers.get(id)
    if (stale !== undefined) clearTimeout(stale)
    const timer = setTimeout(() => {
      idleTimers.delete(id)
      const started = turnStarted.get(id)
      turnStarted.delete(id)
      const errorAt = lastErrorAt.get(id)
      if (typeof errorAt === 'number' && cfg.errorSuppressMs > 0 && Date.now() - errorAt < cfg.errorSuppressMs) return
      const elapsed = typeof started === 'number' ? ` · 用时 ${formatDuration(Date.now() - started)}` : ''
      fireFor('complete', id, `任务完成${elapsed}，可以回来查看结果了。`)
    }, cfg.idleGraceMs)
    if (typeof timer.unref === 'function') timer.unref()
    idleTimers.set(id, timer)
  })

  ctx.on('agent/error', (payload) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyError) return
    const id = rememberSession(payload?.agent)
    if (typeof id === 'string' && id !== '') lastErrorAt.set(id, Date.now())
    const message = truncate(errorMessage(payload?.error), 120)
    fireFor('error', id, `执行出错 · ${message === '' ? '有一轮执行失败，请查看会话详情。' : message}`)
  })

  ctx.on('deepseek-account/model-sign-in-required', () => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyAccount) return
    fireFor('account', lastActiveSessionId, '需要登录 · 模型请求需要登录 DeepSeek 账号。')
  })

  ctx.on('deepseek-account/session-expired', () => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyAccount) return
    fireFor('account', lastActiveSessionId, '登录已过期 · 请重新登录 DeepSeek 账号。')
  })

  ctx.on('subagent/end', (info, parent) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifySubagent) return
    // dsh >= 0.2.2 also dispatches the delegating parent Agent, so the banner can
    // lead with the parent conversation; older runtimes pass only the child info.
    const id = rememberSession(parent?.id, info?.id)
    const label = typeof info?.provider === 'string' && info.provider !== '' ? info.provider : '子任务'
    const reason = typeof info?.stopReason === 'string' && info.stopReason !== '' ? `（${info.stopReason}）` : ''
    fireFor('subagent', id, `子任务 ${label} 已结束${reason}。`)
  })

  ctx.on('workflow/end', (info, result) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled || !cfg.notifyWorkflow) return
    // WorkflowRunInfo carries only the run id and its meta block, no Session id.
    const title = typeof info?.meta?.name === 'string' && info.meta.name !== '' ? `工作流「${info.meta.name}」` : '工作流运行'
    const reason = typeof result?.stopReason === 'string' && result.stopReason !== '' ? `（${result.stopReason}）` : ''
    fireFor('workflow', lastActiveSessionId, `${title}已结束${reason}。`)
  })

  ctx.effect(() => {
    const cfg = resolveConfig(config)
    appendLog(
      cfg,
      `mounted :: pid=${process.pid} :: delivery=${cfg.delivery} :: epoch=${epoch} :: platform=${process.platform}`,
    )
    if (cfg.notifyOnMount) {
      fireFor('mount', lastActiveSessionId, '桌面通知已就绪 · 需要你操作或任务完成时，会弹出原生通知。')
    }
    return () => {
      disposed = true
      for (const timer of idleTimers.values()) clearTimeout(timer)
      idleTimers.clear()
      for (const waiter of [...waiters]) waiter.settle({ epoch, cursor: nextSeq, events: [], config: clientConfig() })
      waiters.clear()
      for (const cancel of [...pendingDelays]) cancel()
      turnStarted.clear()
      everRan.clear()
      titleCache.clear()
      lastErrorAt.clear()
    }
  }, 'dsh-native-notifications: runtime')
}
