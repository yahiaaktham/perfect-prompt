export type Band = {
  verdict: string
  tokens: number
  at: number
}

export type Pending = {
  context: string[]
  original: string
  assembled: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'perfect-prompt': {
      band: Band | null
      isOff: boolean
      isHidden: boolean
      pending: Pending | null
    }
  }
}
