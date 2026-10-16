import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, SessionMessage } from 'claude-code'

import { GUIDE, hasSections, needsRecap, turnWork } from '../hooks/register'

const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const CATCHUP = { command: 'catchup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const RECAP = '**In short:** You asked to fix login; it is fixed.\n**Done**\n- Fixed `src/auth.ts`'
const LONG = 'The login fails because the session cookie is set without the secure flag, so the browser drops it on the redirect back from the identity provider. I will change the cookie options next.'

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const said = (text: string, tools = 0): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses: Array.from({ length: tools }, (_, i) => ({ tool_use_id: `t${i}`, tool: 'Bash', input: {} })),
})

// Stands in for the engine beneath the plugin: a transcript, a model, a prompt log.
function fakeEngine(on: On, opts: { fork?: ModelForkResult } = {}) {
  const rows: SessionMessage[] = []
  const forked: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  on('session.messages', () => ({ value: rows }))
  on('model.fork', ($, e) => {
    forked.push(e.prompt)
    return { value: opts.fork ?? { isAnswered: true, text: RECAP, usage: ZERO } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  return { rows, forked, contexts }
}

// Runs one main-thread turn: earlier rows stay before its start.
async function turn($: Engine, rows: SessionMessage[], made: SessionMessage[], answer: string, agentId?: string) {
  await $.turn.start({ text: 'go', turnId: 'turn-1', ...(agentId ? { agentId } : {}) })
  rows.push(user('go'), ...made)
  return $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'turn-1', reason: 'answer', ...(agentId ? { agentId } : {}) })
}

test('the guide rides beside a prompt, after any context already there', async ($, on) => {
  const engine = fakeEngine(on)
  await $.prompt.submit({ text: 'fix login', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'and the tests', wait: false, origin: { kind: 'composer' }, context: ['from below'] })
  expect(engine.contexts[0]).toEqual([GUIDE])
  expect(engine.contexts[1]).toEqual(['from below', GUIDE])
})

test('a skill or prompt command goes without the guide', async ($, on) => {
  const engine = fakeEngine(on)
  await $.prompt.submit({ text: '/simplify', wait: false, origin: { kind: 'composer' }, command: { name: 'simplify', args: '' } })
  expect(engine.contexts[0]).toBeUndefined()
})

test('a work turn that ends without the sections gets a recap beneath it', async ($, on) => {
  const engine = fakeEngine(on)
  const done = await turn($, engine.rows, [said(LONG, 1), said('', 2), said('All fixed.')], 'All fixed.')
  expect(done.text.startsWith('📋 **Recap**')).toBe(true)
  expect(done.text).toContain(RECAP)
  expect(engine.forked[0]).toContain('<final_reply>\nAll fixed.\n</final_reply>')
})

test('a quick answer is left alone, whatever earlier turns did', async ($, on) => {
  const engine = fakeEngine(on)
  engine.rows.push(user('before'), said(LONG, 5))
  const done = await turn($, engine.rows, [said('', 1), said('It reads the token from the header.')], 'It reads the token from the header.')
  expect(done.text).toBe('It reads the token from the header.')
  expect(engine.forked).toEqual([])
})

test('an answer that already has the sections is left alone', async ($, on) => {
  const engine = fakeEngine(on)
  const answer = 'Fixed the login.\n\n**Done**\n- Cookie flag set\n\n**Not done**\n- Nothing\n\n**Next steps**\n- You: deploy'
  const done = await turn($, engine.rows, [said(LONG, 3), said(answer)], answer)
  expect(done.text).toBe(answer)
  expect(engine.forked).toEqual([])
})

test('when the model cannot recap, the buried text is collected instead', async ($, on) => {
  const engine = fakeEngine(on, { fork: { isAnswered: false, reason: 'empty-reply', usage: ZERO } })
  const done = await turn($, engine.rows, [said(LONG, 1), said('Done.')], 'Done.')
  expect(done.text).toContain('**Said during this turn** (no recap: empty-reply)')
  expect(done.text).toContain('- The login fails because the session cookie')
})

test('Esc while the recap is written leaves the answer alone', async ($, on) => {
  const engine = fakeEngine(on, { fork: { isAnswered: false, reason: 'aborted', usage: ZERO } })
  const done = await turn($, engine.rows, [said(LONG, 1), said('Done.')], 'Done.')
  expect(done.text).toBe('Done.')
})

test("a subagent's turn is left alone", async ($, on) => {
  const engine = fakeEngine(on)
  const done = await turn($, engine.rows, [said(LONG, 4)], 'Report.', 'agent-1')
  expect(done.text).toBe('Report.')
  expect(engine.forked).toEqual([])
})

test('/catchup recaps the session, or says there is nothing yet', async ($, on) => {
  fakeEngine(on)
  const ran = await $.command.run(CATCHUP)
  expect(ran.text).toBe(RECAP)
})

test('/catchup in a fresh session', async ($, on) => {
  fakeEngine(on, { fork: { isAnswered: false, reason: 'nothing-to-fork' } })
  const ran = await $.command.run(CATCHUP)
  expect(ran.text).toBe('Nothing to recap yet.')
})

test('the sections are found in common markdown forms, and work is weighed', () => {
  expect(hasSections('x\n**Done**\n- a\n**Not done**\n- b\n**Next steps**\n- You: c')).toBe(true)
  expect(hasSections('x\n## Done\n- a\n## Next steps\n- Claude: c')).toBe(true)
  expect(hasSections('x\n**Not done**\n- b\n**Next steps**\n- c')).toBe(false)
  expect(hasSections('All done, next steps are yours.')).toBe(false)
  expect(needsRecap('ok', turnWork([said('short', 2), said('ok')], 'ok'))).toBe(false)
  expect(needsRecap('ok', turnWork([said('', 3), said('ok')], 'ok'))).toBe(true)
})
