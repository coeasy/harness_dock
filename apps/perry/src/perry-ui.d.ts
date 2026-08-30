declare module 'perry/ui' {
  export type Widget = number

  export interface WindowAppConfig {
    title: string
    width: number
    height: number
    icon?: string
    body: Widget
    windowState?: 'normal' | 'maximized' | 'fullscreen'
    frameless?: boolean
  }

  export interface WebViewOptions {
    url: string
    allowedDomains?: string[]
    userAgent?: string
    ephemeral?: boolean
    onShouldNavigate?: (url: string) => boolean | void
    onLoaded?: (url: string) => void
    onError?: (code: number, message: string) => void
    width?: number
    height?: number
  }

  export function App(config: WindowAppConfig): void
  export function VStack(children: Widget[]): Widget
  export function VStack(spacing: number, children: Widget[]): Widget
  export function HStack(children: Widget[]): Widget
  export function HStack(spacing: number, children: Widget[]): Widget
  export function Text(content: string, id?: string): Widget
  export function WebView(options: WebViewOptions): Widget
  export function webviewReload(handle: Widget): void
}
