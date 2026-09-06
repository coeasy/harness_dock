export type RuntimeProgressEvent =
  | { stage: 'resolve'; done?: number; total?: number }
  | {
      stage: 'fetch'
      name: string
      done: number
      total: number
      /** cumulative bytes downloaded across the whole closure (this run) */
      bytes: number
      /** overall completion 0-100 */
      percent?: number
    }
  | { stage: 'done'; root: string }
