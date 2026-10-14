# aku_makes_agent_mods

Claude Code mods (function-hook plugins).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-enhancer --marketplace drlamanator/aku_makes_agent_mods
/plugin install assumption-check --marketplace drlamanator/aku_makes_agent_mods
```

From a shell:

```
claude plugin install prompt-enhancer --marketplace drlamanator/aku_makes_agent_mods
claude plugin install assumption-check --marketplace drlamanator/aku_makes_agent_mods
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

## Develop

```
claude plugin validate .
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>   # run it from this folder
```
