export type ClientCommandName =
  | 'app.focus'
  | 'app.quit'
  | 'app.relaunch'
  | 'runtime.restart'
  | 'runtime.stop'
  | 'update.check'
  | 'update.install'
  | 'session.open'
  | 'workspace.open'
  | 'plugin.install'
  | 'mcp.install'
  | 'device.pair'
  | 'diagnostics.export'

export type ClientCommandSource = 'ui' | 'cli' | 'deep-link' | 'system' | 'update'

export interface ClientCommandEnvelope<TPayload = unknown> {
  id: string
  name: ClientCommandName
  source: ClientCommandSource
  payload: TPayload
  issuedAt: string
}

export type ClientCommandHandler<TPayload = unknown, TResult = unknown> = (
  command: ClientCommandEnvelope<TPayload>,
) => Promise<TResult> | TResult

export class UnsupportedClientCommandError extends Error {
  constructor(readonly command: ClientCommandName) {
    super(`No client command handler is registered for ${command}`)
    this.name = 'UnsupportedClientCommandError'
  }
}

export class ClientCommandHandlerConflictError extends Error {
  constructor(readonly command: ClientCommandName) {
    super(`A client command handler is already registered for ${command}`)
    this.name = 'ClientCommandHandlerConflictError'
  }
}

export class ClientCommandBus {
  private readonly handlers = new Map<ClientCommandName, ClientCommandHandler>()
  private sequence = 0

  register<TPayload = unknown, TResult = unknown>(
    name: ClientCommandName,
    handler: ClientCommandHandler<TPayload, TResult>,
  ): () => void {
    if (this.handlers.has(name)) throw new ClientCommandHandlerConflictError(name)
    this.handlers.set(name, handler as ClientCommandHandler)
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name)
    }
  }

  has(name: ClientCommandName): boolean {
    return this.handlers.has(name)
  }

  async dispatch<TPayload = unknown, TResult = unknown>(input: {
    name: ClientCommandName
    payload: TPayload
    source: ClientCommandSource
    id?: string
    issuedAt?: string
  }): Promise<TResult> {
    const handler = this.handlers.get(input.name)
    if (!handler) throw new UnsupportedClientCommandError(input.name)

    const issuedAt = input.issuedAt ?? new Date().toISOString()
    this.sequence += 1
    const command: ClientCommandEnvelope<TPayload> = {
      id: input.id ?? `${issuedAt}:${this.sequence}`,
      name: input.name,
      source: input.source,
      payload: input.payload,
      issuedAt,
    }

    return (await handler(command)) as TResult
  }
}
