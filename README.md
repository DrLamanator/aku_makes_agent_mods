<img width="1024" height="572" alt="image" src="https://github.com/user-attachments/assets/b6f9f3e9-468b-4a1c-a427-5456db2ba697" />

# aku_makes_agent_mods

Claude Code mods (function-hook plugins).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-enhancer --marketplace drlamanator/aku_makes_agent_mods
/plugin install assumption-check --marketplace drlamanator/aku_makes_agent_mods
/plugin install plain-answers --marketplace drlamanator/aku_makes_agent_mods
/plugin install context-steward --marketplace drlamanator/aku_makes_agent_mods
```

From a shell:

```
claude plugin install prompt-enhancer --marketplace drlamanator/aku_makes_agent_mods
claude plugin install assumption-check --marketplace drlamanator/aku_makes_agent_mods
claude plugin install plain-answers --marketplace drlamanator/aku_makes_agent_mods
claude plugin install context-steward --marketplace drlamanator/aku_makes_agent_mods
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session).

In the desktop app: click + next to the prompt box → Plugins → Add marketplace `drlamanator/aku_makes_agent_mods` → Add plugin.

## Mods

### prompt-enhancer

Turns a vague draft into a specific prompt before you send it.

1. Type a rough prompt in the prompt box.
2. Press **✨ Enhance prompt** in the band above the prompt box (or run `/enhance <draft>`).
3. The draft is replaced with a refined version. Edit it if you like.
4. Press **Send** (or just Enter). **Undo** restores your original draft.

How it gets context:

- **Mid-conversation:** it forks the current session (`$.model.fork`), so the rewrite sees the real system prompt, CLAUDE.md, the installed skills listing and the conversation so far. That prefix is served from the prompt cache, so it is cheap.
- **Fresh session (no response yet):** it reads CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md up the directory tree plus the non-built-in slash commands and skills, and asks `sonnet` directly.

Each enhancement is one extra model call that counts toward your usage.

### assumption-check

Lets you check Claude's assumptions and intent while it works, and correct them mid-task.

1. Claude logs its **intent** when it plans or researches, and each **assumption** it makes while building (via its `note` tool; the tool's description tells it when).
2. A row above the prompt shows how many are waiting: **🧭 To check: 2 assumptions, 1 intent [Review]**.
3. **Review** (or `/assumptions`) opens a side pane listing them. Mark each **✓ Right** or **✗ Wrong**; for a wrong one, type what it should be instead.
4. **Send to Claude**. If Claude is mid-turn, the review is added to the conversation and Claude reads it at its next step, without being interrupted. If Claude is idle, it is sent as a prompt.

Notes:

- How often Claude logs depends on the model following the tool description; it is a nudge, not a guarantee.
- Each logged item is a small tool call (a few dozen tokens).
- On mobile there is no text field in the pane: mark ✗ there and type the correction in the prompt.

### plain-answers

Makes Claude's replies easy to read when you juggle several sessions.

1. With every prompt you send, it adds a short writing guide that Claude reads and you don't see:
   - Use plain words, and explain a technical term the first time it comes up. Exact names (files, commands, branches) stay exact.
   - Write at most one short line between tool calls, and keep findings for the final reply.
   - Make the final reply stand on its own: start with what was asked and how it ended, and repeat anything said earlier in the turn that still matters.
   - After a turn that did work, end with **Done**, **Not done** and **Next steps**. Each next step starts "You:" or "Claude:".
   - A quick question gets a quick answer, with no sections.
2. Sometimes a work turn (three or more tool calls, or a real paragraph written between them) still ends without those sections. Then the mod asks the session's model for a **📋 Recap** in that format and shows it beneath the answer. The recap is built from what actually happened (tool results, errors), not only from what Claude said. If the recap fails, it lists what Claude said during the turn instead.
3. `/catchup` gives a recap of the whole session in the same format, for when you switch back to it. (Claude Code's own `/recap` gives one line.)

Notes:

- The guide adds about 300 tokens to each prompt you send.
- A recap is one extra call on the session's model. Most of the conversation is served from the prompt cache, but you still pay for the output, and the turn ends a few seconds later. It only runs when Claude skipped the sections.
- It is an instruction, not a filter: Claude usually follows it, and the recap covers the times it doesn't.
- Needs Claude Code 2.1.299 or newer: a skill or prompt command (`/simplify`, `/code-review`) goes without the guide, since its own instructions shape that reply.

### context-steward

Keeps an eye on how full the context window is, and helps you start fresh before it gets expensive.

1. A status line under the prompt shows the fill: `ctx 142k / 1M · 14 %`.
2. Past the threshold (default 160k tokens), Claude gets one short note with your next prompt: suggest `/compact` or a handoff when the current step is done. It comes again only after the context grows by another step (default 40k).
3. Past the threshold, a band above the prompt offers **Compact**, **Handoff + clear** and **Hide**.
4. **Handoff + clear** (or `/steward-handoff`) forks the session to write a handoff file (goal, evidence, decisions, changed files, verified / not verified, open items, next step) to `~/.claude/context-steward/handoffs/<session>/`. A pane shows it; **Clear ja jatka** runs `/clear` and feeds the handoff into the next conversation once, **Peru** leaves everything as it was.
5. If the fork cannot write one, the `context-steward:aku-handoff` skill is the fallback: Claude writes the file and you run `/clear` yourself.

Notes:

- Set the threshold and step in the plugin's options (`thresholdTokens`, `stepTokens`).
- **Compact** passes keep instructions so the summary holds the same fields as a handoff; Claude Code's own compactions get them too.
- A handoff is one extra call on the session's model, mostly served from the prompt cache.
- The pane's buttons are in Finnish (Clear ja jatka / Peru / Sulje).

## Develop

```
claude plugin validate .
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>   # run it from this folder
```
