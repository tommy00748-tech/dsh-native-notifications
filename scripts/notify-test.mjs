#!/usr/bin/env node
/**
 * Fire one banner through the optional osascript lane, without waiting for a
 * session event. Useful as a local install check on macOS.
 *
 *   node scripts/notify-test.mjs
 *   node scripts/notify-test.mjs "Custom title" "Custom body"
 */
import { notifyTest } from '../index.js'

const [title, body] = process.argv.slice(2)
await notifyTest(title ?? 'DSH notification test', body ?? 'The osascript delivery lane works.')
