export type CheckKind = 'assumption' | 'intent'
export type Verdict = 'pending' | 'right' | 'wrong'

export type CheckItem = {
  id: string
  kind: CheckKind
  text: string
  basis: string | null
  verdict: Verdict
  correction: string
  isSent: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'assumption-check': {
      items: CheckItem[]
      isWorking: boolean
    }
  }
}
