# aku_makes_agent_mods

Claude Code mods (function-hook plugins).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-enhancer --marketplace drlamanator/aku_makes_agent_mods
```

From a shell:

```
claude plugin install prompt-enhancer --marketplace drlamanator/aku_makes_agent_mods
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

## Develop

```
claude plugin validate mods/prompt-enhancer
claude plugin test mods/prompt-enhancer
claude --plugin-dir mods/prompt-enhancer   # run it from this folder
```
