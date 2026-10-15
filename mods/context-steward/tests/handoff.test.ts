import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, RenderElement, SessionMessage } from 'claude-code'

import { KEEP, changedFiles, handoffDoc, redact } from '../hooks/handoff'

const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const DRAFT = '## Goal\nShip the meter.\n## Verified\n- `claude plugin test`: 8 pass\n## Not verified\n- Desktop'
const HOME = 'C:\\Users\\tester'
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
} as const
const PANE = {
  title: 'Handoff',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const SURFACES = ['terminal', 'desktop'] as const

const said = (uses: { tool: string; input: Record<string, unknown>; isError?: true }[]): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: uses.map((u, i) => ({ tool_use_id: `t${i}`, ...u })),
})

const ROWS: SessionMessage[] = [
  { role: 'user', text: 'build it', toolUses: [] },
  said([
    { tool: 'Read', input: { file_path: 'a.ts' } },
    { tool: 'Edit', input: { file_path: 'src/meter.ts' } },
    { tool: 'Write', input: { file_path: 'src/new.ts' } },
    { tool: 'Edit', input: { file_path: 'src/broken.ts' }, isError: true },
  ]),
  said([
    { tool: 'Edit', input: { file_path: 'src/meter.ts' } },
    { tool: 'NotebookEdit', input: { notebook_path: 'nb.ipynb' } },
  ]),
]

// Stands in for the engine beneath the plugin: a long context, a transcript, a model,
// a disk, panes, and the /clear command.
function fakeEngine(on: On, opts: { fork?: ModelForkResult; clearFails?: boolean } = {}) {
  const log = {
    writes: [] as { path: string; text: string }[],
    forks: 0,
    commands: [] as string[],
    opened: [] as string[],
    closed: [] as string[],
    compactions: [] as (string | undefined)[],
    toasts: [] as string[],
  }
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 22, 41, 7) })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.messages', () => ({ value: ROWS }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:\\work' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('model.fork', () => {
    log.forks++
    return { value: opts.fork ?? { isAnswered: true, text: DRAFT, usage: ZERO } }
  })
  on('fs.write', ($, e) => {
    log.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    log.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    log.closed.push(e.id)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', ($, e) => {
    log.commands.push(e.command)
    if (e.command === 'clear' && opts.clearFails) throw new Error('clear refused')
    return { text: '' }
  })
  on('session.compact', ($, e) => {
    log.compactions.push(e.instructions)
    return { messages: [SUMMARY] }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  // The engine's own drawing beneath: nothing to show.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)
  return { log, clock }
}

const SUMMARY: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }
const CORE_BLOCKS = [{ name: 'currentDate', text: 'Today is 2026-10-15.' }]

// Measures the long context so the band shows, then presses Handoff + clear and lets the fork run.
async function handoffFrom($: Engine, clock: { advance: (ms: number) => Promise<void> }, surface: (typeof SURFACES)[number]) {
  await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] })
  const band = await $.ui.mount({ plugin: 'context-steward', surface, component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['compact', 'handoff', 'hide'])
  await band.press({ key: 'handoff' })
  await clock.advance(1)
  return $.ui.mount({ plugin: 'context-steward', surface, component: 'Pane', props: PANE, requestId: 'context-steward-handoff' })
}

for (const surface of SURFACES) {
  test(`${surface}: handoff is written, saved and shown; Clear ja jatka clears and feeds it once`, async ($, on) => {
    const { log, clock } = fakeEngine(on)
    const pane = await handoffFrom($, clock, surface)

    expect(log.forks).toBe(1)
    expect(log.writes).toHaveLength(1)
    const saved = log.writes[0]!
    // The engine writes with the platform's separators.
    expect(saved.path.replace(/\\/g, '/')).toBe('C:/Users/tester/.claude/context-steward/handoffs/sess-1/handoff-2026-10-15T22-41-07.md')
    expect(saved.text).toContain('Ship the meter.')
    expect(saved.text).toContain('- `src/meter.ts`\n- `src/new.ts`\n- `nb.ipynb`')
    expect(log.commands).toEqual([])
    expect((await pane.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['clear', 'cancel'])

    await pane.press({ key: 'clear' })
    expect(log.commands).toEqual([])
    await clock.advance(1)
    expect(log.commands).toEqual(['clear'])
    expect(log.closed).toEqual(['context-steward-handoff'])

    // The conversation after /clear starts from the handoff; a later re-read does not repeat it.
    const first = await $.prompt.context({ blocks: CORE_BLOCKS })
    expect(first.blocks.map(b => b.name)).toEqual(['currentDate', 'handoff'])
    expect(first.blocks[1]!.text).toContain('sess-1/handoff-2026-10-15T22-41-07.md')
    expect(first.blocks[1]!.text).toContain('Ship the meter.')
    const again = await $.prompt.context({ blocks: CORE_BLOCKS })
    expect(again.blocks.map(b => b.name)).toEqual(['currentDate'])
  })

  test(`${surface}: Peru leaves the session as it was`, async ($, on) => {
    const { log, clock } = fakeEngine(on)
    const pane = await handoffFrom($, clock, surface)
    await pane.press({ key: 'cancel' })
    expect(log.commands).toEqual([])
    expect(log.closed).toEqual(['context-steward-handoff'])
    const next = await $.prompt.context({ blocks: CORE_BLOCKS })
    expect(next.blocks.map(b => b.name)).toEqual(['currentDate'])
  })

  test(`${surface}: when the fork gives no text, nothing is saved or cleared and the fallback is shown`, async ($, on) => {
    const { log, clock } = fakeEngine(on, { fork: { isAnswered: false, reason: 'nothing-to-fork' } })
    const pane = await handoffFrom($, clock, surface)
    expect(log.writes).toEqual([])
    expect(log.commands).toEqual([])
    expect((await pane.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['close'])
    const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(text).toContain('nothing-to-fork')
    expect(text).toContain('aku-handoff')
  })

  test(`${surface}: an API error is a failure too`, async ($, on) => {
    const { log, clock } = fakeEngine(on, { fork: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO } })
    const pane = await handoffFrom($, clock, surface)
    expect(log.writes).toEqual([])
    const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(text).toContain('api-error 529')
  })
}

test('when /clear cannot run, the handoff still waits for the next conversation', async ($, on) => {
  const { log, clock } = fakeEngine(on, { clearFails: true })
  const pane = await handoffFrom($, clock, 'terminal')
  await pane.press({ key: 'clear' })
  await clock.advance(1)
  expect(log.commands).toEqual(['clear'])
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  expect(text).toContain('Aja /clear itse')
  const next = await $.prompt.context({ blocks: CORE_BLOCKS })
  expect(next.blocks.map(b => b.name)).toEqual(['currentDate', 'handoff'])
})

test('/steward-handoff writes one; cancel and clear answer in words', async ($, on) => {
  const { log, clock } = fakeEngine(on)
  const run = (args: string) =>
    $.command.run({ command: 'steward-handoff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect((await run('clear')).text).toContain('No saved handoff')
  expect((await run('')).text).toContain('Writing a handoff')
  await clock.advance(1)
  expect(log.writes).toHaveLength(1)
  expect((await run('cancel')).text).toContain('nothing was cleared')
  // The plugin answers its own command: nothing beneath it ran.
  expect(log.commands).toEqual([])
})

test('Compact passes the keep instructions itself; the engine own compactions get them too', async ($, on) => {
  const { log, clock } = fakeEngine(on)
  await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] })
  const band = await $.ui.mount({ plugin: 'context-steward', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'compact' })
  await clock.advance(1)
  expect(log.compactions).toEqual([KEEP])
  await $.session.compact({ trigger: 'manual', instructions: 'focus on the tests', messages: ROWS })
  expect(log.compactions[1]).toBe(`focus on the tests\n\n${KEEP}`)
})

test('the band stays away below the threshold, while a turn runs, and for a step after Hide', async ($, on) => {
  fakeEngine(on)
  const measure = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 200_000, percent: Math.round(tokens / 2000) }, rateLimits: [], changed: ['context'] })
  const buttons = async (props: typeof BAND | { [K in keyof typeof BAND]: K extends 'isWorking' ? boolean : (typeof BAND)[K] }) => {
    const band = await $.ui.mount({ plugin: 'context-steward', surface: 'terminal', component: 'AbovePrompt', props })
    return { band, keys: (await band.findAll({ type: 'Button' })).map(b => b.key) }
  }
  await measure(100_000)
  expect((await buttons(BAND)).keys).toEqual([])
  await measure(170_000)
  expect((await buttons({ ...BAND, isWorking: true })).keys).toEqual([])
  const shown = await buttons(BAND)
  expect(shown.keys).toEqual(['compact', 'handoff', 'hide'])
  await shown.band.press({ key: 'hide' })
  await measure(190_000)
  expect((await buttons(BAND)).keys).toEqual([])
  await measure(210_000)
  expect((await buttons(BAND)).keys).toEqual(['compact', 'handoff', 'hide'])
})

test('changed files come from the tool calls; secrets are stripped', () => {
  expect(changedFiles(ROWS)).toEqual(['src/meter.ts', 'src/new.ts', 'nb.ipynb'])
  expect(redact('key sk-abcdefghijklmnopqrstuv and Bearer abcdefghijklmnopqrstu and password=hunter2hunter')).toBe(
    'key [redacted] and Bearer [redacted] and password=[redacted]',
  )
  expect(handoffDoc('## Goal\nx', [], '2026-10-15 22:41')).toContain('## Changed files\nRead from')
  expect(handoffDoc('## Goal\nx', [], '2026-10-15 22:41')).toContain('- None')
})
