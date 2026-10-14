// Index into $.session.messages() where the main thread's current turn starts.
export type TurnStart = number

declare module 'claude-code' {
  interface PluginState {
    'plain-answers': {
      turnStart: TurnStart
    }
  }
}
