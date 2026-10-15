// Context tokens at the last reminder this session; 0 when none is owed a step.
export type LastWarnedTokens = number

// The live window as the meter last read it; tokens absent before a response.
export type Meter = { tokens?: number; window: number }

// Context tokens when the person hid the band; it comes back a step later. 0: not hidden.
export type BandHiddenAt = number

// Where the handoff pane stands: being written, saved and shown, or failed with the reason.
export type Handoff =
  | { phase: 'idle' }
  | { phase: 'writing' }
  | { phase: 'ready'; path: string; doc: string }
  | { phase: 'failed'; reason: string }
  | { phase: 'clear-failed'; path: string; reason: string }

// A saved handoff waiting to be fed into the conversation that follows /clear, once.
// Held in a module variable (it must outlive /clear's new session), not in $.state.
export type PendingHandoff = { path: string; doc: string } | null

declare module 'claude-code' {
  interface PluginState {
    'context-steward': {
      lastWarnedTokens: LastWarnedTokens
      meter: Meter
      bandHiddenAt: BandHiddenAt
      handoff: Handoff
    }
  }
}
