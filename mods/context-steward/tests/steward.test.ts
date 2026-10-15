import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextUsage } from 'claude-code'

import { isReminderDue, statusText } from '../hooks/register'

const WINDOW = 200_000
const LIMITS = { threshold: 160_000, step: 40_000 }

const ctx = (tokens?: number): SessionContextUsage =>
  tokens === undefined ? { window: WINDOW } : { tokens, window: WINDOW, percent: Math.round((tokens / WINDOW) * 100) }

// Stands in for the engine beneath the plugin: a context size, the status line, a prompt log.
function fakeEngine(on: On) {
  const state = { tokens: undefined as number | undefined }
  const statuses: (string | undefined)[] = []
  const contexts: (readonly string[] | undefined)[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: ctx(state.tokens), rateLimits: [] } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return { state, statuses, contexts }
}

const measure = ($: Engine, tokens?: number) => $.session.measure({ context: ctx(tokens), rateLimits: [], changed: ['context'] })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const reminders = (contexts: (readonly string[] | undefined)[]) =>
  contexts.filter(c => (c ?? []).some(t => t.includes('context-steward'))).length

test('the meter shows the fill, a warning past the threshold, and a dash with no figures', async ($, on) => {
  const engine = fakeEngine(on)
  await measure($, 142_000)
  await measure($, 165_000)
  await measure($)
  expect(engine.statuses).toEqual(['ctx 142k / 200k · 71 %', 'ctx 165k / 200k · 83 % · over 160k: /compact or handoff', 'ctx –'])
})

test('a measurement that did not move the context leaves the meter alone', async ($, on) => {
  const engine = fakeEngine(on)
  await $.session.measure({ context: ctx(50_000), rateLimits: [], changed: ['cost'] })
  expect(engine.statuses).toEqual([])
})

test('the reminder rides once at the threshold, then only after another step', async ($, on) => {
  const engine = fakeEngine(on)
  engine.state.tokens = 150_000
  await say($, 'one')
  engine.state.tokens = 161_000
  await say($, 'two')
  engine.state.tokens = 170_000
  await say($, 'three')
  engine.state.tokens = 199_000
  await say($, 'four')
  engine.state.tokens = 201_000
  await say($, 'five')
  expect(engine.contexts.map(c => reminders([c]))).toEqual([0, 1, 0, 0, 1])
  expect(engine.contexts[1]?.[0]).toContain('161k tokens (81 % of 200k)')
})

test('a slash command never carries the reminder', async ($, on) => {
  const engine = fakeEngine(on)
  engine.state.tokens = 180_000
  await say($, '/compact')
  await say($, 'go on')
  expect(engine.contexts.map(c => reminders([c]))).toEqual([0, 1])
})

test('after /compact drops the context, the next crossing reminds again', async ($, on) => {
  const engine = fakeEngine(on)
  engine.state.tokens = 165_000
  await say($, 'a')
  await measure($, 30_000)
  engine.state.tokens = 162_000
  await say($, 'b')
  expect(reminders(engine.contexts)).toBe(2)
})

test('a measurement with no figure (a reload) does not owe a new reminder', async ($, on) => {
  const engine = fakeEngine(on)
  engine.state.tokens = 314_000
  await say($, 'a')
  await measure($)
  engine.state.tokens = 339_000
  await say($, 'b')
  expect(engine.contexts.map(c => reminders([c]))).toEqual([1, 0])
})

test('after /clear the next crossing reminds again', async ($, on) => {
  const engine = fakeEngine(on)
  engine.state.tokens = 165_000
  await say($, 'a')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await say($, 'b')
  expect(reminders(engine.contexts)).toBe(2)
})

test('the threshold and step come from userConfig', { options: { thresholdTokens: 10_000, stepTokens: 5_000 } }, async ($, on) => {
  const engine = fakeEngine(on)
  for (const tokens of [9_000, 12_000, 16_000, 17_000, 18_000]) {
    engine.state.tokens = tokens
    await say($, 'x')
  }
  expect(engine.contexts.map(c => reminders([c]))).toEqual([0, 1, 0, 1, 0])
})

test('the pure rules', () => {
  expect(statusText(ctx(1_000), LIMITS)).toBe('ctx 1k / 200k · 1 %')
  expect(statusText({ tokens: 100_000, window: WINDOW }, LIMITS)).toBe('ctx 100k / 200k · 50 %')
  expect(statusText({ tokens: 34_053, window: 1_000_000, percent: 3 }, LIMITS)).toBe('ctx 34k / 1M · 3 %')
  expect(isReminderDue(undefined, 0, LIMITS)).toBe(false)
  expect(isReminderDue(160_000, 0, LIMITS)).toBe(true)
  expect(isReminderDue(199_999, 160_000, LIMITS)).toBe(false)
  expect(isReminderDue(200_000, 160_000, LIMITS)).toBe(true)
})
