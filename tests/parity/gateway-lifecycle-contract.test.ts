import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('Gateway lifecycle admission contract', () => {
  it('serializes start/stop through the GatewayActor generation state machine', () => {
    const source = readFileSync(
      path.join(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs'),
      'utf8',
    )

    expect(source).toContain('pub enum GatewayPhase')
    expect(source).toContain('pub(crate) struct GatewayActorState')
    expect(source).toContain('fn begin_start(&mut self) -> Result<u64, String>')
    expect(source).toContain('self.generation = self.generation.saturating_add(1)')
    expect(source).toContain('self.phase = GatewayPhase::Starting')
    expect(source).toContain('self.phase != GatewayPhase::Starting || self.generation != generation')
    expect(source).toContain('fn begin_stop(&mut self) -> Option<NativeGateway>')
    expect(source).toContain('self.phase = GatewayPhase::Stopping')
    expect(source).toContain('self.server.take()')
    expect(source).toContain('actor.settle_stopped()')
    expect(source).toContain('ensure_current_runtime(&*state, lease.generation.id)')
    expect(source).not.toContain('state.gateway_starting')
    expect(source).not.toContain('fn claim_gateway_start')
    expect(source).not.toContain('fn claim_gateway_stop')
  })

  it('drops the actor lock before blocking server shutdown', () => {
    const source = readFileSync(
      path.join(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs'),
      'utf8',
    )
    const stop = source.slice(source.indexOf('fn stop_managed_inner'))
    const take = stop.indexOf('actor.begin_stop()')
    const stopServer = stop.indexOf('server.stop()')
    const settle = stop.indexOf('actor.settle_stopped()')
    expect(take).toBeGreaterThanOrEqual(0)
    expect(stopServer).toBeGreaterThan(take)
    expect(settle).toBeGreaterThan(stopServer)
  })

  it('owns and drains active native proxy connections during shutdown', () => {
    const source = readFileSync(
      path.join(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs'),
      'utf8',
    )
    expect(source).toContain('connection_streams: Mutex<HashMap<usize, Vec<TcpStream>>>')
    expect(source).toContain('connection_workers: Mutex<Vec<thread::JoinHandle<()>>>')
    expect(source).toContain('shutdown_active_connections(&self.shared)')
    expect(source).toContain('join_connection_workers(&self.shared)')
    expect(source).toContain('TcpStream::connect_timeout')
    expect(source).toContain('GATEWAY_UPSTREAM_CONNECT_TIMEOUT')
    expect(source).toContain('set_read_timeout(None)')
  })
})
