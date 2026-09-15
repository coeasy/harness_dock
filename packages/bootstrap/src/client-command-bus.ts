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
  | 'auth.callback'
  | 'diagnostics.export'

export type ClientCommandSource = 'ui' | 'cli' | 'deep-link' | 'system' | 'update'

export interface ClientCommandEnvelope<TPayload = unknown> {
  id: string
  name: ClientCommandName
  source: ClientCommandSource
  payload: TPayload
  issuedAt: string
  /** Cooperative cancellation signal. Host adapters should forward it to cancellable work. */
  signal?: AbortSignal
}

export type ClientCommandHandler<TPayload = unknown, TResult = unknown> = (
  command: ClientCommandEnvelope<TPayload>,
) => Promise<TResult> | TResult

export type ClientCommandValidator<TPayload = unknown> = (payload: TPayload) => boolean | void

export interface ClientCommandRegistrationOptions<TPayload = unknown> {
  validate?: ClientCommandValidator<TPayload>
  timeoutMs?: number
}

export interface ClientCommandDispatchInput<TPayload = unknown> {
  name: ClientCommandName
  payload: TPayload
  source: ClientCommandSource
  id?: string
  issuedAt?: string
  signal?: AbortSignal
  /** Overrides the handler registration timeout for this dispatch only. */
  timeoutMs?: number
}

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

export class ClientCommandValidationError extends Error {
  constructor(
    readonly command: ClientCommandName,
    readonly detail = 'payload validation failed',
  ) {
    super(`Invalid payload for ${command}: ${detail}`)
    this.name = 'ClientCommandValidationError'
  }
}

export class ClientCommandTimeoutError extends Error {
  constructor(
    readonly command: ClientCommandName,
    readonly timeoutMs: number,
  ) {
    super(`Client command ${command} timed out after ${timeoutMs}ms`)
    this.name = 'ClientCommandTimeoutError'
  }
}

export class ClientCommandAbortedError extends Error {
  constructor(readonly command: ClientCommandName) {
    super(`Client command ${command} was aborted`)
    this.name = 'ClientCommandAbortedError'
  }
}

interface ClientCommandRegistration {
  handler: ClientCommandHandler
  validate?: ClientCommandValidator
  timeoutMs?: number
}

function normalizeTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Client command timeout must be a finite positive number')
  }
  return timeoutMs
}

function validatePayload(
  command: ClientCommandName,
  validator: ClientCommandValidator | undefined,
  payload: unknown,
): void {
  if (!validator) return
  try {
    if (validator(payload) === false) throw new ClientCommandValidationError(command)
  } catch (error) {
    if (error instanceof ClientCommandValidationError) throw error
    throw new ClientCommandValidationError(
      command,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export class ClientCommandBus {
  private readonly handlers = new Map<ClientCommandName, ClientCommandRegistration>()
  private sequence = 0

  register<TPayload = unknown, TResult = unknown>(
    name: ClientCommandName,
    handler: ClientCommandHandler<TPayload, TResult>,
    options: ClientCommandRegistrationOptions<TPayload> = {},
  ): () => void {
    if (this.handlers.has(name)) throw new ClientCommandHandlerConflictError(name)
    const registration: ClientCommandRegistration = {
      handler: handler as ClientCommandHandler,
      ...(options.validate ? { validate: options.validate as ClientCommandValidator } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: normalizeTimeout(options.timeoutMs) }),
    }
    this.handlers.set(name, registration)
    return () => {
      if (this.handlers.get(name) === registration) this.handlers.delete(name)
    }
  }

  has(name: ClientCommandName): boolean {
    return this.handlers.has(name)
  }

  async dispatch<TPayload = unknown, TResult = unknown>(
    input: ClientCommandDispatchInput<TPayload>,
  ): Promise<TResult> {
    const registration = this.handlers.get(input.name)
    if (!registration) throw new UnsupportedClientCommandError(input.name)

    validatePayload(input.name, registration.validate, input.payload)
    if (input.signal?.aborted) throw new ClientCommandAbortedError(input.name)

    const issuedAt = input.issuedAt ?? new Date().toISOString()
    this.sequence += 1
    const controller = new AbortController()
    const timeoutMs = normalizeTimeout(input.timeoutMs ?? registration.timeoutMs)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const forwardAbort = () => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }

    const command: ClientCommandEnvelope<TPayload> = {
      id: input.id ?? `${issuedAt}:${this.sequence}`,
      name: input.name,
      source: input.source,
      payload: input.payload,
      issuedAt,
      signal: controller.signal,
    }

    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        controller.signal.removeEventListener('abort', onAbort)
        reject(
          timedOut && timeoutMs !== undefined
            ? new ClientCommandTimeoutError(input.name, timeoutMs)
            : new ClientCommandAbortedError(input.name),
        )
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      return (await Promise.race([
        Promise.resolve(registration.handler(command)),
        abortPromise,
      ])) as TResult
    } finally {
      if (timer) clearTimeout(timer)
      input.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
