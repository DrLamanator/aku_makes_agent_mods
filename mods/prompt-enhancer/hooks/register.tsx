import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EnhanceStatus } from '../types'

const status = atom({ plugin: 'prompt-enhancer', key: 'status' } as const, 'idle' as EnhanceStatus)
const original = atom({ plugin: 'prompt-enhancer', key: 'original' } as const, null as string | null)
const message = atom({ plugin: 'prompt-enhancer', key: 'message' } as const, null as string | null)

// Used when the session has no response yet to fork from.
const FALLBACK_MODEL = 'sonnet'
const MAX_COMMANDS = 80

const INSTRUCTIONS = `Rewrite the user's draft prompt (inside <draft>) into a clear, specific prompt for Claude Code working in this project.

Use what you know from the project instructions (CLAUDE.md), the available skills and slash commands, and the conversation so far to make implicit things explicit:
- the concrete goal and what "done" looks like
- the files, components or areas involved, when they can be inferred
- constraints and conventions from the project instructions that apply
- the skill or command to use, when one clearly fits
- the expected output (code change, answer, document, etc.)

Rules:
- Do not invent facts. When something important is genuinely unknown, state it as an explicit assumption or a short question inside the prompt.
- Keep the user's intent and language (a Finnish draft stays Finnish).
- Be concise: add what removes ambiguity, nothing more. A short list is fine; no headings for a small task.
- Do not perform the task, call tools or explain your changes.

Output only the rewritten prompt text, with no preamble, quotes or code fences.`

export function buildRequest(draft: string): string {
  return `${INSTRUCTIONS}\n\n<draft>\n${draft}\n</draft>`
}

export function cleanReply(text: string): string {
  let out = text.trim()
  const fenced = out.match(/^```[a-z]*\n([\s\S]*?)\n```$/i)
  if (fenced?.[1] !== undefined) out = fenced[1].trim()
  const tagged = out.match(/^<prompt>\s*([\s\S]*?)\s*<\/prompt>$/i)
  if (tagged?.[1] !== undefined) out = tagged[1].trim()
  return out
}

async function projectContext($: EngineInterface): Promise<string> {
  const parts: string[] = []
  try {
    const files = await $.fs.ancestors({ names: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'] })
    for (const f of files) parts.push(`<instructions path="${f.dir}/${f.name}">\n${f.content}\n</instructions>`)
  } catch {
    // No readable instruction files: enhance without them.
  }
  try {
    const commands = (await $.command.list()).filter(c => c.source !== 'builtin').slice(0, MAX_COMMANDS)
    if (commands.length > 0) {
      parts.push(`<available_skills_and_commands>\n${commands.map(c => `/${c.name}: ${c.description}`).join('\n')}\n</available_skills_and_commands>`)
    }
  } catch {
    // Command list unavailable: enhance without it.
  }
  return parts.join('\n\n')
}

type Enhanced = { isOk: true; text: string } | { isOk: false; reason: string }

export async function enhance($: EngineInterface, draft: string): Promise<Enhanced> {
  const request = buildRequest(draft)

  // Preferred: fork the session itself, so the model sees the real system prompt,
  // CLAUDE.md, skill listing and the conversation, served from the prompt cache.
  const forked = await $.model.fork({ prompt: request })
  if (forked.isAnswered) {
    const text = cleanReply(forked.text)
    if (text !== '') return { isOk: true, text }
  } else if (forked.reason === 'aborted') {
    return { isOk: false, reason: 'cancelled' }
  }

  // Fresh session (nothing to fork) or the fork gave no usable text:
  // gather the project context ourselves.
  const context = await projectContext($)
  const done = await $.model.complete({
    model: FALLBACK_MODEL,
    system: context === '' ? undefined : `Project context for the rewrite:\n\n${context}`,
    prompt: request,
    maxTokens: 2048,
    timeoutMs: 60_000,
  })
  if (!done.isAnswered) {
    return { isOk: false, reason: done.reason === 'api-error' ? `API error (${done.error})` : done.reason }
  }
  const text = cleanReply(done.text)
  return text === '' ? { isOk: false, reason: 'empty reply' } : { isOk: true, text }
}

async function reset($: EngineInterface) {
  await update($, status, () => 'idle' as EnhanceStatus)
  await update($, original, () => null)
  await update($, message, () => null)
}

async function fail($: EngineInterface, reason: string) {
  await update($, status, () => 'error' as EnhanceStatus)
  await update($, message, () => `Could not enhance: ${reason}`)
}

// Enhances `draft` (or the box's current text) and puts the result in the box.
async function run($: EngineInterface, draft?: string) {
  if ((await read($, status)) === 'working') return
  const text = (draft ?? (await $.prompt.read()).text).trim()
  if (text === '') {
    $.ui.toast('Type a draft in the prompt box first.')
    return
  }

  await update($, status, () => 'working' as EnhanceStatus)
  await update($, message, () => null)
  const result = await enhance($, text)
  if (!result.isOk) return fail($, result.reason)

  const filled = await $.prompt.fill({ text: result.text, mode: 'replace' })
  if (!filled.isFilled) return fail($, filled.refusal === 'dialog' ? 'a dialog holds the prompt box' : 'the prompt box is unavailable')

  await update($, original, () => text)
  await update($, status, () => 'ready' as EnhanceStatus)
}

async function send($: EngineInterface) {
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    $.ui.toast('The prompt box is empty.')
    return
  }
  await $.prompt.fill({ text: '', mode: 'replace' })
  await reset($)
  await $.prompt.submit({ text, asUser: true })
}

async function undo($: EngineInterface) {
  const before = await read($, original)
  if (before !== null) await $.prompt.fill({ text: before, mode: 'replace' })
  await reset($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'enhance',
      description: 'Rewrite a vague prompt into a specific one and put it in the prompt box',
      argumentHint: '<draft prompt>',
    })
    return next(e)
  })

  on('command.run', { command: 'enhance' }, async ($, e) => {
    const draft = e.args.trim()
    if (draft === '') return { text: 'Usage: /enhance <draft prompt>, or type a draft and press Enhance above the prompt box.' }
    await run($, draft)
    return { text: (await read($, status)) === 'ready' ? 'Enhanced draft is in the prompt box: edit it, then Send.' : ((await read($, message)) ?? 'Enhance did not finish.') }
  })

  // A prompt sent any other way (Enter) ends the review state.
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, status)) === 'ready') await reset($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, status)

    let row
    if (now === 'working') {
      row = <Text dimColor>✨ Enhancing your prompt…</Text>
    } else if (now === 'ready') {
      row = (
        <Box gap={1}>
          <Text color="green">✨ Enhanced. Review or edit it in the box.</Text>
          <Button key="send" label="Send" variant="primary" onPress={() => send($)} />
          <Button key="undo" label="Undo" onPress={() => undo($)} />
        </Box>
      )
    } else if (now === 'error') {
      row = (
        <Box gap={1}>
          <Text color="red">{(await read($, message)) ?? 'Could not enhance.'}</Text>
          <Button key="retry" label="Retry" onPress={() => run($)} />
          <Button key="dismiss" label="Dismiss" onPress={() => reset($)} />
        </Box>
      )
    } else {
      row = <Button key="enhance" label="✨ Enhance prompt" onPress={() => run($)} />
    }

    // Keep what other mods (and the engine) draw in the band, below this row.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
