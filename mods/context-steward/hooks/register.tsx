import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { BandHiddenAt, Handoff, LastWarnedTokens, Meter, PendingHandoff } from '../types'
import { HANDOFF_PROMPT, KEEP, changedFiles, handoffBlock, handoffDoc, stamp } from './handoff'

const lastWarned = atom({ plugin: 'context-steward', key: 'lastWarnedTokens' } as const, 0 as LastWarnedTokens)
const meter = atom({ plugin: 'context-steward', key: 'meter' } as const, { window: 0 } as Meter)
const bandHiddenAt = atom({ plugin: 'context-steward', key: 'bandHiddenAt' } as const, 0 as BandHiddenAt)
const handoff = atom({ plugin: 'context-steward', key: 'handoff' } as const, { phase: 'idle' } as Handoff)
// A module variable, not $.state: /clear starts a new session id and $.state with it (live test,
// 2.1.295), while the module lives on. Lost only if the module reloads between the press and /clear.
let pending: PendingHandoff = null

const PANE = 'context-steward-handoff'

export type Limits = { threshold: number; step: number }

const DEFAULTS: Limits = { threshold: 160_000, step: 40_000 }

export function limitsFrom(options: Readonly<Record<string, unknown>>): Limits {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  return { threshold: num(options.thresholdTokens, DEFAULTS.threshold), step: num(options.stepTokens, DEFAULTS.step) }
}

const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

// The meter under the prompt: "ctx 142k / 200k · 71 %", flagged past the threshold.
// The engine already puts a ⚠ and the plugin's name before every plugin status line.
export function statusText(ctx: SessionContextUsage, limits: Limits): string {
  if (ctx.tokens === undefined) return 'ctx –'
  const percent = ctx.percent ?? Math.round((ctx.tokens / ctx.window) * 100)
  const meter = `ctx ${k(ctx.tokens)} / ${k(ctx.window)} · ${percent} %`
  return ctx.tokens >= limits.threshold ? `${meter} · over ${k(limits.threshold)}: /compact or handoff` : meter
}

// A reminder is due at the threshold, then again only after another step of growth.
export function isReminderDue(tokens: number | undefined, warned: number, limits: Limits): boolean {
  if (tokens === undefined || tokens < limits.threshold) return false
  return warned === 0 || tokens >= warned + limits.step
}

// The band shows past the threshold, unless hidden less than a step ago.
export function isBandDue(tokens: number | undefined, hiddenAt: number, limits: Limits): boolean {
  if (tokens === undefined || tokens < limits.threshold) return false
  return hiddenAt === 0 || tokens >= hiddenAt + limits.step
}

export function reminderText(ctx: SessionContextUsage): string {
  const percent = ctx.percent ?? Math.round(((ctx.tokens ?? 0) / ctx.window) * 100)
  return `Context note (from the context-steward mod): this conversation's context is at ${k(ctx.tokens ?? 0)} tokens (${percent} % of ${k(ctx.window)}). Large contexts cost more on every turn. When the current step is done, briefly suggest to the person that they run /compact, or write a handoff and start fresh with /clear. Say it once; do not repeat it.`
}

async function show($: EngineInterface, ctx: SessionContextUsage, limits: Limits): Promise<void> {
  $.ui.status(statusText(ctx, limits))
  await update($, meter, () => ({ tokens: ctx.tokens, window: ctx.window }))
  // Back under the threshold (after /compact): the next crossing reminds again. A missing figure
  // (a reload, a fresh start) is no reading and resets nothing; /clear resets in session.end.
  if (ctx.tokens !== undefined && ctx.tokens < limits.threshold) {
    if ((await read($, lastWarned)) !== 0) await update($, lastWarned, () => 0)
    if ((await read($, bandHiddenAt)) !== 0) await update($, bandHiddenAt, () => 0)
  }
}

async function handoffDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = home === undefined ? `${await $.session.cwd()}/.claude` : `${home}/.claude`
  return `${base}/context-steward/handoffs/${await $.session.id()}`.replace(/\\/g, '/')
}

// Writes the handoff from the session's own transcript, saves it, and shows it in the pane.
// Nothing is cleared here: only the pane's [Clear ja jatka] does that, once the file is saved.
export async function writeHandoff($: EngineInterface): Promise<void> {
  if ((await read($, handoff)).phase === 'writing') return
  await update($, handoff, (): Handoff => ({ phase: 'writing' }))
  void $.ui.open({ id: PANE, title: 'Handoff', focus: true })
  try {
    const files = changedFiles(await $.session.messages())
    const forked = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!forked.isAnswered || forked.text.trim() === '') {
      const reason = !forked.isAnswered ? (forked.reason === 'api-error' ? `api-error ${forked.status ?? ''}`.trim() : forked.reason) : 'empty-reply'
      await update($, handoff, (): Handoff => ({ phase: 'failed', reason }))
      return
    }
    const now = await $.clock.now()
    const doc = handoffDoc(forked.text, files, `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
    const path = `${await handoffDir($)}/handoff-${stamp(now)}.md`
    await $.fs.write(path, doc)
    await update($, handoff, (): Handoff => ({ phase: 'ready', path, doc }))
  } catch (err) {
    await update($, handoff, (): Handoff => ({ phase: 'failed', reason: err instanceof Error ? err.message : String(err) }))
  }
}

// The saved handoff waits for the next conversation; then /clear runs, once the session is idle.
export async function clearAndContinue($: EngineInterface): Promise<string> {
  const state = await read($, handoff)
  if (state.phase !== 'ready') return 'No saved handoff to continue from. Run /steward-handoff first.'
  pending = { path: state.path, doc: state.doc }
  await update($, handoff, (): Handoff => ({ phase: 'idle' }))
  await $.ui.close({ id: PANE })
  // Run off this dispatch, on a timer: a /clear asked for inside a command or press
  // dispatch never ran in the live test (2.1.295), while one from a timer did.
  $.clock.after(0, () => {
    $.command.run({ command: 'clear' }).catch(async (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err)
      $.ui.log(`/clear did not run: ${reason}`)
      await update($, handoff, (): Handoff => ({ phase: 'clear-failed', path: state.path, reason }))
      void $.ui.open({ id: PANE, title: 'Handoff', focus: true })
    })
  })
  return `Handoff saved at ${state.path}. Clearing; the new conversation starts from it.`
}

export async function cancelHandoff($: EngineInterface): Promise<string> {
  const state = await read($, handoff)
  await update($, handoff, (): Handoff => ({ phase: 'idle' }))
  await $.ui.close({ id: PANE })
  return state.phase === 'ready' ? `Handoff cancelled; nothing was cleared. The file stays at ${state.path}.` : 'Handoff cancelled; nothing was cleared.'
}

export async function compactNow($: EngineInterface): Promise<void> {
  try {
    const done = await $.session.compact({ instructions: KEEP })
    if ('skip' in done && typeof done.skip === 'string') $.ui.toast(`Compact skipped: ${done.skip}`)
  } catch (err) {
    $.ui.toast(`Compact failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const register: Register = (on, options) => {
  const limits = limitsFrom(options)

  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await show($, (await $.session.usage()).context, limits)
    try {
      await $.command.register({
        // Not /handoff: a person's own skill may hold that name, and theirs wins.
        name: 'steward-handoff',
        description: 'Write a handoff of this conversation, then clear and continue from it (args: clear, cancel)',
        argumentHint: '[clear|cancel]',
      })
    } catch (err) {
      $.ui.log(`/steward-handoff not registered: ${err instanceof Error ? err.message : String(err)}`)
    }
    return done
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await show($, e.context, limits)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Slash commands are not turns for the model. 2.1.295 drops `command` from the input
    // (commands go through command.run); 2.1.299 brings it back for skill and prompt commands.
    if ('command' in e && e.command !== undefined) return next(e)
    if (e.text.trimStart().startsWith('/')) return next(e)
    const { context } = await $.session.usage()
    if (!isReminderDue(context.tokens, await read($, lastWarned), limits)) return next(e)
    await update($, lastWarned, () => context.tokens ?? 0)
    return next({ ...e, context: [...(e.context ?? []), reminderText(context)] })
  })

  // The engine's own compactions keep the handoff fields too; the button passes KEEP itself,
  // since a mod's own $.session.compact skips the calling hook.
  on('session.compact', ($, e, next) => {
    if (e.instructions?.includes(KEEP)) return next(e)
    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${KEEP}` : KEEP })
  })

  // The conversation after a [Clear ja jatka] starts from the saved handoff, once.
  on('prompt.context', async ($, e, next) => {
    const done = await next(e)
    const waiting = pending
    if (waiting === null) return done
    pending = null
    return { ...done, blocks: [...done.blocks, { name: 'handoff', text: handoffBlock(waiting.path, waiting.doc) }] }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, lastWarned, () => 0)
      await update($, bandHiddenAt, () => 0)
    }
    return next(e)
  })

  on('command.run', { command: 'steward-handoff' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'clear') return { text: await clearAndContinue($) }
    if (arg === 'cancel') return { text: await cancelHandoff($) }
    if ((await read($, handoff)).phase === 'writing') return { text: 'A handoff is already being written.' }
    // Started off this dispatch: the fork can outlast a hook's budget.
    $.clock.after(0, () => void writeHandoff($))
    return { text: 'Writing a handoff; it opens in a pane for you to check before anything is cleared.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const m = await read($, meter)
    if (!isBandDue(m.tokens, await read($, bandHiddenAt), limits)) return next(e)
    if ((await read($, handoff)).phase !== 'idle') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>Context {k(m.tokens ?? 0)} / {k(m.window)} </Text>
        <Button key="compact" label="Compact" onPress={() => void $.clock.after(0, () => void compactNow($))} />
        <Button key="handoff" label="Handoff + clear" variant="primary" onPress={() => void $.clock.after(0, () => void writeHandoff($))} />
        <Button key="hide" label="Hide" dimColor onPress={() => update($, bandHiddenAt, () => m.tokens ?? 0)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const state = await read($, handoff)
    if (state.phase === 'writing') return <Text dimColor>Kirjoitetaan handoffia keskustelun omasta transkriptista…</Text>
    if (state.phase === 'ready') {
      return (
        <Box flexDirection="column">
          <Text dimColor>Tallennettu: {state.path}</Text>
          <Markdown text={state.doc} />
          <Box>
            <Button key="clear" label="Clear ja jatka" hotkey="c" variant="primary" onPress={() => void clearAndContinue($)} />
            <Button key="cancel" label="Peru" hotkey="p" onPress={() => void cancelHandoff($)} />
          </Box>
        </Box>
      )
    }
    if (state.phase === 'failed' || state.phase === 'clear-failed') {
      const text =
        state.phase === 'failed'
          ? `Handoffia ei saatu kirjoitettua (${state.reason}). Mitään ei tyhjennetty. Varapolku: pyydä Claudea kirjoittamaan handoff aku-handoff-taidolla ja aja sitten /clear itse.`
          : `/clear ei käynnistynyt (${state.reason}). Handoff on tallessa: ${state.path}. Aja /clear itse; uusi keskustelu saa handoffin silti.`
      return (
        <Box flexDirection="column">
          <Text>{text}</Text>
          <Button key="close" label="Sulje" hotkey="s" onPress={() => void cancelHandoff($)} />
        </Box>
      )
    }
    return <Text dimColor>Ei handoffia. Aja /steward-handoff tai paina Handoff + clear.</Text>
  })
}
