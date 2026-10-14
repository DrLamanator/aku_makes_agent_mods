import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckItem, CheckKind, Verdict } from '../types'

const items = atom({ plugin: 'assumption-check', key: 'items' } as const, [] as CheckItem[])
const isWorking = atom({ plugin: 'assumption-check', key: 'isWorking' } as const, false)

const PANE = 'assumptions'
const TOOL = 'note'
const MAX_ITEMS = 60

const TOOL_ID = 'mcp__assumption-check__note'

// The model reads this as the tool's description, which reaches it in every
// install (a prompt.compose section would not under organization-managed settings).
const GUIDE = `Log an assumption you are making or your current intent. The user reviews these in a side panel while you work and can correct you mid-task. Returns at once: never wait for a reply.

- kind "intent": when you start planning or researching a task, and again whenever your goal or approach changes, state in one sentence what you are trying to achieve and how. Once per phase, not per step.
- kind "assumption": whenever you choose something the user did not specify and that changes the outcome (scope, interpretation of an ambiguous request, data shape, file or component location, library or approach, naming, edge-case behaviour, what "done" means), state it in one sentence and give a short basis.

Skip choices the codebase or the user's instructions already settle. Never wait for a reply after logging: keep working. When a message reviewing your assumptions or intent arrives, apply its corrections before anything else and redo work that relied on a wrong assumption.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['assumption', 'intent'], description: 'assumption: a choice the user did not specify. intent: what you are trying to achieve and how.' },
    text: { type: 'string', description: 'One sentence.' },
    basis: { type: 'string', description: 'Why you think so, briefly (optional).' },
  },
  required: ['kind', 'text'],
} as const

export function parseNote(input: Record<string, unknown>): { kind: CheckKind; text: string; basis: string | null } | null {
  const kind = input.kind === 'intent' ? 'intent' : input.kind === 'assumption' ? 'assumption' : null
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (kind === null || text === '') return null
  const basis = typeof input.basis === 'string' && input.basis.trim() !== '' ? input.basis.trim() : null
  return { kind, text, basis }
}

export function feedbackText(reviewed: readonly CheckItem[]): string {
  const line = (i: CheckItem) => {
    const label = i.kind === 'intent' ? 'Intent' : 'Assumption'
    if (i.verdict === 'right') return `- ✓ ${label} confirmed: "${i.text}"`
    const fix = i.correction.trim()
    return fix === ''
      ? `- ✗ ${label} is WRONG: "${i.text}". Stop relying on it and ask me what I want here.`
      : `- ✗ ${label} is WRONG: "${i.text}". Instead: ${fix}`
  }
  const wrong = reviewed.filter(i => i.verdict === 'wrong')
  return [
    'Review of your assumptions and intent (from the assumption-check panel):',
    ...reviewed.map(line),
    wrong.length > 0
      ? 'Apply these corrections now, before continuing, and redo any work that relied on the wrong ones.'
      : 'Carry on.',
  ].join('\n')
}

const setItem = ($: EngineInterface, id: string, change: Partial<CheckItem>) =>
  update($, items, list => list.map(i => (i.id === id ? { ...i, ...change } : i)))

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Assumptions & intent' })

async function sendReviews($: EngineInterface) {
  const reviewed = (await read($, items)).filter(i => !i.isSent && i.verdict !== 'pending')
  if (reviewed.length === 0) {
    $.ui.toast('Mark at least one item ✓ or ✗ first.')
    return
  }
  const text = feedbackText(reviewed)

  // Mid-turn: append to the conversation so Claude reads it at its next step.
  // Idle: submit as a prompt so it starts a turn.
  let isDelivered = false
  if (await read($, isWorking)) {
    try {
      const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      isDelivered = !('deny' in appended && appended.deny !== undefined)
    } catch {
      isDelivered = false
    }
  }
  if (!isDelivered) await $.prompt.submit({ text, asUser: true })

  const ids = new Set(reviewed.map(i => i.id))
  await update($, items, list => list.map(i => (ids.has(i.id) ? { ...i, isSent: true } : i)))
  $.ui.toast(`Sent ${reviewed.length} review${reviewed.length === 1 ? '' : 's'} to Claude.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: GUIDE,
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({ name: 'assumptions', description: "Open the panel of Claude's assumptions and intent" })
    return next(e)
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const note = parseNote(e as unknown as Record<string, unknown>)
    if (note === null) return { result: 'Not logged: give kind ("assumption" or "intent") and a one-sentence text.' }

    const item: CheckItem = { id: crypto.randomUUID(), ...note, verdict: 'pending', correction: '', isSent: false }
    let wasEmpty = false
    await update($, items, list => {
      wasEmpty = !list.some(i => i.verdict === 'pending' && !i.isSent)
      return [...list, item].slice(-MAX_ITEMS)
    })
    if (wasEmpty) $.ui.toast(`Claude logged ${note.kind === 'intent' ? 'its intent' : 'an assumption'}: review it above the prompt.`)
    return { result: 'Logged for the user to review. Continue working; corrections, if any, will arrive as a message.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isWorking, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isWorking, () => false)
    return next(e)
  })

  on('command.run', { command: 'assumptions' }, async $ => {
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Assumptions panel opened.' : `Assumptions panel is waiting: ${opened.reason}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, items)
    const pending = list.filter(i => i.verdict === 'pending' && !i.isSent)
    const ready = list.filter(i => i.verdict !== 'pending' && !i.isSent)
    const below = await next(e)
    if (pending.length === 0 && ready.length === 0) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const intents = pending.filter(i => i.kind === 'intent').length
    const summary = [
      pending.length - intents > 0 ? `${pending.length - intents} assumption${pending.length - intents === 1 ? '' : 's'}` : '',
      intents > 0 ? `${intents} intent` : '',
    ].filter(Boolean).join(', ')

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color="yellow">🧭 {summary === '' ? 'Reviews ready to send' : `To check: ${summary}`}</Text>
          <Button key="review" label="Review" onPress={() => void openPane($)} />
          {ready.length > 0 && <Button key="send-band" label={`Send ${ready.length}`} variant="primary" onPress={() => sendReviews($)} />}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Input = 'Input' in t ? t.Input : undefined
    const list = await read($, items)
    const ready = list.filter(i => i.verdict !== 'pending' && !i.isSent).length

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nothing logged yet. Claude adds its intent when it plans or researches, and its assumptions as it builds.</Text>
        </Box>
      )
    }

    const row = (i: CheckItem) => {
      const mark: Record<Verdict, string> = { pending: '•', right: '✓', wrong: '✗' }
      return (
        <Box key={`row-${i.id}`} flexDirection="column" marginBottom={1}>
          <Text dimColor={i.isSent} color={i.verdict === 'wrong' ? 'red' : i.verdict === 'right' ? 'green' : undefined}>
            {mark[i.verdict]} {i.text}
          </Text>
          {i.basis !== null && <Text dimColor>  because: {i.basis}</Text>}
          {i.isSent ? (
            <Text dimColor>  sent{i.correction !== '' ? `: ${i.correction}` : ''}</Text>
          ) : (
            <Box gap={1}>
              <Button key={`ok-${i.id}`} label="✓ Right" {...(i.verdict === 'right' ? { variant: 'primary' as const } : {})} onPress={() => setItem($, i.id, { verdict: 'right', correction: '' })} />
              <Button key={`no-${i.id}`} label="✗ Wrong" {...(i.verdict === 'wrong' ? { variant: 'primary' as const } : {})} onPress={() => setItem($, i.id, { verdict: 'wrong' })} />
            </Box>
          )}
          {!i.isSent && i.verdict === 'wrong' && Input !== undefined && (
            <Input
              key={`fix-${i.id}`}
              placeholder="What should it be instead? (Enter to save)"
              value={i.correction}
              submitLabel="save"
              onSubmit={value => setItem($, i.id, { correction: value.trim() })}
            />
          )}
        </Box>
      )
    }

    const intents = list.filter(i => i.kind === 'intent')
    const assumptions = list.filter(i => i.kind === 'assumption')

    return (
      <Box flexDirection="column">
        {intents.length > 0 && <Text bold>Intent</Text>}
        {intents.slice(-5).map(row)}
        {assumptions.length > 0 && <Text bold>Assumptions</Text>}
        {assumptions.slice(-30).map(row)}
        {e.surface === 'mobile' && <Text dimColor>Mark ✗ here, then type the correction in the prompt.</Text>}
        <Box gap={1}>
          <Button key="send" label={ready > 0 ? `Send ${ready} to Claude` : 'Send to Claude'} variant="primary" onPress={() => sendReviews($)} />
          <Button key="clear" label="Clear sent" onPress={() => update($, items, l => l.filter(i => !i.isSent))} />
        </Box>
      </Box>
    )
  })
}
