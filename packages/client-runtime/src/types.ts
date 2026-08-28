export type RuntimeMode = 'local' | 'download' | 'bundled'

export interface ReadyInfo {
  url: string
  host: string
  port: number
  pid: number
  dshVersion: string
}

export interface ParsedUrl {
  url: string
  host: string
  port: number
}

export interface Killable {
  pid?: number
  kill(signal?: NodeJS.Signals): boolean
}
