import { expect, test } from 'claude-code/testing'
import type { CommandInfo, ModelForkResult, On } from 'claude-code'

const BAND = {
  plugin: 'prompt-enhancer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Stands in for the engine beneath the plugin: a prompt box, a model, a submit log.
function fakeEngine(on: On, opts: { draft: string; fork?: string; complete?: string }) {
  const box = { text: opts.draft }
  const submitted: string[] = []
  const completeSystems: (string | undefined)[] = []

  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="engine-band">
        <Text>engine band</Text>
      </Box>
    )
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('model.fork', () => {
    const value: ModelForkResult =
      opts.fork === undefined
        ? { isAnswered: false, reason: 'nothing-to-fork' }
        : { isAnswered: true, text: opts.fork, usage: ZERO }
    return { value }
  })
  on('model.complete', ($, e) => {
    completeSystems.push(e.system)
    return { value: { isAnswered: true as const, text: opts.complete ?? '', usage: ZERO } }
  })
  on('fs.ancestors', () => ({
    value: [{ dir: '/repo', name: 'CLAUDE.md', content: 'Use pnpm.', parts: [{ path: '/repo/CLAUDE.md', content: 'Use pnpm.' }] }],
  }))
  const commands: CommandInfo[] = [
    { name: 'help', description: 'Help', source: 'builtin' },
    { name: 'deploy', description: 'Deploy the app', source: 'user' },
  ]
  on('command.list', () => ({ value: commands }))

  return { box, submitted, completeSystems }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`enhance, then send, on ${surface}`, async ($, on) => {
    const engine = fakeEngine(on, { draft: 'fix login', fork: '```\nFix the login bug in src/auth.\n```' })

    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'enhance' })

    expect(engine.box.text).toBe('Fix the login bug in src/auth.')
    expect(await ui.find({ key: 'send' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    await ui.press({ key: 'send' })
    expect(engine.submitted).toEqual(['Fix the login bug in src/auth.'])
    expect(engine.box.text).toBe('')
    expect(await ui.find({ key: 'enhance' })).toBeDefined()
  })
}

test('undo restores the original draft', async ($, on) => {
  const engine = fakeEngine(on, { draft: 'fix login', fork: 'Fix the login bug.' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'enhance' })
  await ui.press({ key: 'undo' })

  expect(engine.box.text).toBe('fix login')
  expect(engine.submitted).toEqual([])
})

test('a fresh session falls back to a completion with CLAUDE.md and skills', async ($, on) => {
  const engine = fakeEngine(on, { draft: 'deploy it', complete: 'Run /deploy for production.' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'enhance' })

  expect(engine.box.text).toBe('Run /deploy for production.')
  const system = engine.completeSystems[0] ?? ''
  expect(system).toContain('Use pnpm.')
  expect(system).toContain('/deploy: Deploy the app')
  expect(system).not.toContain('/help')
})

test('an empty box does nothing', async ($, on) => {
  const engine = fakeEngine(on, { draft: '   ', fork: 'should not be used' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'enhance' })

  expect(engine.box.text).toBe('   ')
  expect(await ui.find({ key: 'enhance' })).toBeDefined()
})

test('a model failure shows an error with retry', async ($, on) => {
  fakeEngine(on, { draft: 'fix login', complete: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'enhance' })

  expect((await ui.find({ type: 'Text', text: /Could not enhance/ }))).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()
})
