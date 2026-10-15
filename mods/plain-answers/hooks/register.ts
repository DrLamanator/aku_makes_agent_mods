import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const turnStart = atom({ plugin: 'plain-answers', key: 'turnStart' } as const, 0)

// A turn counts as work (and so owes Done / Not done / Next steps) when it made
// this many tool calls, or wrote at least one real paragraph between them.
const MIN_TOOLS = 3
const MIN_INTERIM_CHARS = 160
const MAX_SAID_CHARS = 300

// Rides beside every prompt as context the model reads and the person never
// sees. A prompt.compose section would not reach the model under
// organization-managed settings; this does.
export const GUIDE = `How to write your replies (from the plain-answers mod). The person runs several Claude Code sessions at once and reads each reply cold, often after switching in from another session.

- Plain language: short sentences, everyday words. Explain a technical term in a few words the first time, or use a plainer one. Keep exact names (files, commands, functions, branches, links) exact, in backticks.
- Between tool calls, write at most one short line. Keep findings for the final reply.
- Make the final reply self-contained: open with one line on what was asked and how it ended. Repeat anything from earlier in the turn that still matters (findings, decisions, caveats, numbers, links); never point back ("as above", "see earlier").
- After a turn that did work (changed files, ran commands, researched), end the final reply with three short sections, keeping these English labels in any language:
  **Done**: what is finished, and how you checked it.
  **Not done**: what was skipped, failed or is unchecked, and why ("Nothing" if so).
  **Next steps**: one per line, each starting "You:" (for the person) or "Claude:" (for Claude Code).
- A quick question gets a quick answer, with no sections.`

const FORMAT = `Plain language, no jargon; keep exact names (files, commands, branches, links) in backticks. Write in the language of the conversation. Output only this, at most 12 bullets in all:

**In short:** one or two sentences: what was asked and how it ended.
**Done**
- ...
**Not done**
- ... ("Nothing" if so)
**Next steps**
- You: ...
- Claude: ...`

export function turnRecapRequest(answer: string): string {
  return `Write a recap of the turn that just ended, for the person. They run several Claude Code sessions at once and may not have read anything above.

Your final reply in that turn was:
<final_reply>
${answer}
</final_reply>

Base the recap on what actually happened in the turn (tool results, errors, test output), not only on what you said, and include anything that still matters from text you wrote between tool calls.

${FORMAT}`
}

const SESSION_RECAP = `Recap this whole session so far for the person, who is switching in from another session and remembers nothing of it. Cover the goal, what was decided, and where things stand now, based on what actually happened (tool results, errors), not only on what was said.

${FORMAT}`

// True when a reply already ends in the three sections.
export function hasSections(text: string): boolean {
  return /^[\s#*_>-]*done\b/im.test(text) && /^[\s#*_>-]*next steps\b/im.test(text)
}

// What the turn did: its tool calls, and the substantial text written between them.
export function turnWork(rows: readonly SessionMessage[], answer: string): { tools: number; said: string[] } {
  const replies = rows.filter(r => r.role === 'assistant')
  const tools = replies.reduce((n, r) => n + r.toolUses.length, 0)
  const final = answer.trim()
  const said = replies
    .map(r => r.text.trim())
    .filter(t => t.length >= MIN_INTERIM_CHARS && t !== final && !final.includes(t))
  return { tools, said }
}

export function needsRecap(answer: string, work: { tools: number; said: readonly string[] }): boolean {
  if (hasSections(answer)) return false
  return work.tools >= MIN_TOOLS || work.said.length > 0
}

// Used when the model could not write a recap: the buried text, collected.
export function saidList(said: readonly string[], reason: string): string {
  const cut = (t: string) => (t.length > MAX_SAID_CHARS ? `${t.slice(0, MAX_SAID_CHARS).trimEnd()}…` : t)
  return [`**Said during this turn** (no recap: ${reason})`, ...said.map(t => `- ${cut(t).replace(/\s*\n\s*/g, ' ')}`)].join('\n')
}

async function rowsSince($: EngineInterface, start: number): Promise<SessionMessage[]> {
  const all = await $.session.messages()
  // A compaction mid-turn shortens the list: everything left is recent.
  return all.slice(start <= all.length ? start : 0)
}

async function recap($: EngineInterface, prompt: string): Promise<{ isOk: true; text: string } | { isOk: false; reason: string }> {
  const forked = await $.model.fork({ prompt })
  if (!forked.isAnswered) {
    return { isOk: false, reason: forked.reason === 'api-error' ? `API error (${forked.error})` : forked.reason }
  }
  const text = forked.text.trim()
  return text === '' ? { isOk: false, reason: 'empty reply' } : { isOk: true, text }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'catchup',
      description: 'Catch up on this session in plain words: goal, done, not done, next steps',
    })
    return next(e)
  })

  // A slash command never comes through here: it runs as command.run instead.
  on('prompt.submit', ($, e, next) => next({ ...e, context: [...(e.context ?? []), GUIDE] }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const count = (await $.session.messages()).length
      await update($, turnStart, () => count)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || e.isAborted || hasSections(e.answer)) return done

    const work = turnWork(await rowsSince($, await read($, turnStart)), e.answer)
    if (!needsRecap(e.answer, work)) return done

    $.ui.status('Writing a recap…')
    let made: Awaited<ReturnType<typeof recap>>
    try {
      made = await recap($, turnRecapRequest(e.answer))
    } finally {
      $.ui.status(undefined)
    }

    let shown: string
    if (made.isOk) shown = `📋 **Recap**\n\n${made.text}`
    // Esc while the recap was being written: the person wants it gone.
    else if (made.reason !== 'aborted' && work.said.length > 0) shown = saidList(work.said, made.reason)
    else return done

    // Another plugin may have put its own text beneath the answer already.
    return { ...done, text: done.text === e.answer ? shown : `${done.text}\n\n${shown}` }
  })

  on('command.run', { command: 'catchup' }, async $ => {
    const made = await recap($, SESSION_RECAP)
    if (made.isOk) return { text: made.text }
    return { text: made.reason === 'nothing-to-fork' ? 'Nothing to recap yet.' : `Could not write a recap: ${made.reason}.` }
  })
}
