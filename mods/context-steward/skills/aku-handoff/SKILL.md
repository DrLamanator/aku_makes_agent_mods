---
name: aku-handoff
description: Write a handoff file of the current conversation so the work can continue after /clear. Use when the person asks for a handoff, when the context-steward mod's Handoff + clear could not write one, or before clearing a long session by hand.
---

# aku-handoff

The fallback for the context-steward mod's **Handoff + clear** button: the same handoff, written by the main conversation's model, with a tool to check facts. The person runs `/clear` themselves afterwards.

## Steps

1. Find the files this conversation changed from your own Edit, Write and NotebookEdit calls. Do not guess; if unsure, run `git status` / `git diff --stat` where the work is in a repository.
2. Write the handoff with exactly these sections, in the conversation's language:
   - **Goal**
   - **Evidence**
   - **Decisions and reasons**
   - **Changed files** (from step 1, as paths)
   - **Verified**: only results a tool output showed (tests, command output, file reads); name the evidence.
   - **Not verified**: claims, assumptions and work no tool output checked.
   - **Open items**
   - **Next step**: exactly one concrete action.
   - **Suggested skills**: recurring corrections or procedures worth capturing; "None" if none.
3. Never include secrets, tokens, passwords or keys. Refer to artifacts by path or link instead of copying them.
4. Save it as `~/.claude/context-steward/handoffs/<session id>/handoff-<UTC time, e.g. 2026-10-15T22-41-07>.md` and tell the person the path.
5. Tell the person to run `/clear` and then start the new conversation with: `Continue from the handoff at <path>.` Do not run `/clear` yourself and do not claim the session was cleared.

If the context-steward mod is loaded, `/steward-handoff` (or its Handoff + clear button) does steps 1–4 itself and shows the file before anything is cleared; use this skill when that path failed.
