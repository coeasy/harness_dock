declare module 'perry/ui' {
  export type Widget = number

  export interface State<T> {
    readonly value: T
    get(): T
    set(value: T): void
    text(): Widget
  }

  export function state<T>(initial: T): State<T>
  export function App(config: {
    title: string
    width: number
    height: number
    icon?: string
    body: Widget
    windowState?: 'normal' | 'maximized' | 'fullscreen'
  }): void
  export function VStack(children: Widget[]): Widget
  export function VStack(spacing: number, children: Widget[]): Widget
  export function Text(content: string, id?: string): Widget
  export function Button(label: string, onPress: () => void): Widget
  export function TextField(placeholder: string, onChange: (value: string) => void): Widget
  export function SecureField(placeholder: string, onChange: (value: string) => void): Widget
  export function NavStack(active: State<string>, routes: { name: string; body: Widget }[]): Widget
  export function WebView(options: {
    url: string
    allowedDomains?: string[]
    userAgent?: string
    ephemeral?: boolean
    onShouldNavigate?: (url: string) => boolean | void
    onLoaded?: (url: string) => void
    onError?: (code: number, message: string) => void
    width?: number
    height?: number
  }): Widget
  export function webviewLoadUrl(handle: Widget, url: string): void
  export function webviewReload(handle: Widget): void
  export function webviewClearCookies(handle: Widget): void
}
