export type EnhanceStatus = 'idle' | 'working' | 'ready' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': {
      status: EnhanceStatus
      original: string | null
      message: string | null
    }
  }
}
