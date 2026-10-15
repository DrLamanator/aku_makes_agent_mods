import type { SessionMessage } from 'claude-code'

// Kept through every compaction, the button's and the engine's own alike.
export const KEEP = `Keep what a handoff needs: the goal, the evidence found, decisions and their reasons, the files changed, which results were verified and which were not, open items, and the one concrete next step.`

const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

// The files this conversation changed, read from its tool calls rather than the model's memory.
export function changedFiles(rows: readonly SessionMessage[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    for (const use of row.toolUses) {
      const field = EDIT_TOOLS[use.tool]
      const path = field === undefined ? undefined : use.input[field]
      if (typeof path === 'string' && path !== '' && use.isError !== true) seen.add(path)
    }
  }
  return [...seen]
}

const SECRETS: readonly RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)["']?[^\s"']{6,}/gi,
]

// Strips what looks like a credential; the handoff points at files instead of copying them.
export function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, (m, lead: string) => (m.startsWith(lead) && lead !== m ? `${lead}[redacted]` : '[redacted]')), text)
}

export const HANDOFF_PROMPT = `Write a handoff of this conversation so a fresh conversation can continue the work after /clear. Write it in the language of the conversation, as Markdown, with exactly these sections and nothing before them:

## Goal
## Evidence
## Decisions and reasons
## Verified
Only results a tool output in this conversation showed (test runs, command output, file reads); name the evidence.
## Not verified
Claims, assumptions and work not checked by a tool output.
## Open items
## Next step
Exactly one concrete action.
## Suggested skills
Recurring corrections or procedures worth capturing as a skill; "None" if none.

Rules: be brief. Refer to artifacts by path or link instead of copying them. Never include secrets, tokens, passwords or keys. Do not list changed files: they are added from the tool calls.`

export function handoffDoc(text: string, files: readonly string[], when: string): string {
  const list = files.length === 0 ? '- None' : files.map(f => `- \`${f}\``).join('\n')
  return `# Handoff (${when})\n\n${redact(text.trim())}\n\n## Changed files\nRead from this conversation's Edit, Write and NotebookEdit calls.\n\n${list}\n`
}

export function handoffBlock(path: string, doc: string): string {
  return `A handoff from the previous conversation, written before /clear by the context-steward mod and saved at ${path}. Read it before continuing; the "Not verified" items are unchecked.\n\n${doc}`
}

// A file-name-safe stamp: 2026-10-15T22-41-07.
export const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-')
