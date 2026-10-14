import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { feedbackText } from '../hooks/register'

const TOOL = 'mcp__assumption-check__note'
const SITE = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const BAND = { plugin: 'assumption-check', component: 'AbovePrompt', props: SITE } as const
const PANE = {
  plugin: 'assumption-check',
  component: 'Pane',
  requestId: 'assumptions',
  props: { title: 'Assumptions & intent', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// Stands in for the engine beneath the plugin.
function fakeEngine(on: On) {
  const submitted: string[] = []
  const appended: string[] = []
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="engine-band">
        <Text>engine band</Text>
      </Box>
    )
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.append', ($, e, next) => {
    const block = e.message.content[0]
    if (block !== undefined && 'text' in block) appended.push(String(block.text))
    return next(e)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { submitted, appended }
}

const note = ($: Engine, kind: string, text: string, basis?: string) =>
  $.tool.call({ tool: TOOL, tool_use_id: `t-${text}`, kind, text, ...(basis ? { basis } : {}) })

async function buttonKey(ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string, nth = 0) {
  const found = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith(prefix))[nth]
  if (found?.key === undefined) throw new Error(`no button ${prefix}`)
  return found.key
}

test('the tool logs an item and the band counts it, above the engine band', async ($, on) => {
  fakeEngine(on)
  const ran = await note($, 'assumption', 'Use SQLite for storage', 'no database is configured')
  expect(ran.deny).toBeUndefined()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 assumption/ })).toBeDefined()
  expect(await band.find({ key: 'review' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('the band stays out of the way when nothing is logged', async ($, on) => {
  fakeEngine(on)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'review' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('a bad note is not logged', async ($, on) => {
  fakeEngine(on)
  await note($, 'guess', 'something')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'review' })).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`review, correct and send while idle, on ${surface}`, async ($, on) => {
    const engine = fakeEngine(on)
    await note($, 'intent', 'Build a CSV export for the orders page')
    await note($, 'assumption', 'Export only the visible columns')

    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: await buttonKey(pane, 'ok-') })
    await pane.press({ key: await buttonKey(pane, 'no-', 1) })
    const fix = (await pane.findAll({ type: 'Input' }))[0]?.key
    expect(fix).toBeDefined()
    await pane.input({ key: fix ?? '', text: 'Export every column' })
    await pane.press({ key: 'send' })

    expect(engine.submitted.length).toBe(1)
    const sent = engine.submitted[0] ?? ''
    expect(sent).toContain('✓ Intent confirmed: "Build a CSV export for the orders page"')
    expect(sent).toContain('✗ Assumption is WRONG: "Export only the visible columns". Instead: Export every column')
    expect(engine.appended).toEqual([])
    expect(await pane.find({ type: 'Text', text: /sent: Export every column/ })).toBeDefined()
  })
}

test('mid-turn, reviews are appended to the conversation instead of queued', async ($, on) => {
  const engine = fakeEngine(on)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await note($, 'assumption', 'Use the existing auth middleware')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: await buttonKey(pane, 'no-') })
  await pane.press({ key: 'send' })

  expect(engine.submitted).toEqual([])
  expect(engine.appended.length).toBe(1)
  expect(engine.appended[0]).toContain('Stop relying on it and ask me')
})

test('feedback text lists confirmations and corrections', () => {
  const text = feedbackText([
    { id: '1', kind: 'assumption', text: 'A', basis: null, verdict: 'right', correction: '', isSent: false },
    { id: '2', kind: 'assumption', text: 'B', basis: null, verdict: 'wrong', correction: 'C', isSent: false },
  ])
  expect(text).toContain('✓ Assumption confirmed: "A"')
  expect(text).toContain('Instead: C')
  expect(text).toContain('Apply these corrections now')
})
