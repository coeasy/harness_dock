//! Accept loop and connection bookkeeping: registration, per-peer rate
//! limiting tables and worker join on shutdown.


// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;


pub struct ActiveConnectionGuard {
    pub id: usize,
    pub shared: Arc<GatewayShared>,
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.shared.connection_streams.lock() {
            streams.remove(&self.id);
        }
        self.shared
            .active_connections
            .fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn register_connection_stream(
    shared: &GatewayShared,
    id: usize,
    stream: &TcpStream,
) -> Result<(), String> {
    let shutdown_stream = stream.try_clone().map_err(|error| error.to_string())?;
    let mut streams = shared
        .connection_streams
        .lock()
        .map_err(|_| lock_err("GatewayConnectionRegistry"))?;
    if shared.stop.load(Ordering::Acquire) {
        let _ = shutdown_stream.shutdown(Shutdown::Both);
        return Err("Native Gateway is stopping".into());
    }
    streams.entry(id).or_default().push(shutdown_stream);
    Ok(())
}

pub fn shutdown_active_connections(shared: &GatewayShared) {
    let streams = shared
        .connection_streams
        .lock()
        .map(|mut registry| {
            registry
                .drain()
                .flat_map(|(_, streams)| streams)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for stream in streams {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

pub fn reap_finished_connection_workers(shared: &GatewayShared) {
    let finished = shared
        .connection_workers
        .lock()
        .map(|mut workers| {
            let mut finished = Vec::new();
            let mut index = 0;
            while index < workers.len() {
                if workers[index].is_finished() {
                    finished.push(workers.swap_remove(index));
                } else {
                    index += 1;
                }
            }
            finished
        })
        .unwrap_or_default();
    for worker in finished {
        let _ = worker.join();
    }
}

pub fn join_connection_workers(shared: &GatewayShared) {
    let workers = shared
        .connection_workers
        .lock()
        .map(|mut workers| workers.drain(..).collect::<Vec<_>>())
        .unwrap_or_default();
    for worker in workers {
        let _ = worker.join();
    }
}

pub fn gateway_accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, shared: Arc<GatewayShared>) {
    while !stop.load(Ordering::Acquire) {
        reap_finished_connection_workers(&shared);
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if stop.load(Ordering::Acquire) {
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                }
                if let Err(error) = stream.set_write_timeout(Some(GATEWAY_HANDSHAKE_TIMEOUT)) {
                    let _ = stream.shutdown(Shutdown::Both);
                    eprintln!("Native Gateway connection timeout setup failed: {error}");
                    continue;
                }
                let active = shared.active_connections.fetch_add(1, Ordering::AcqRel);
                if active >= MAX_GATEWAY_CONNECTIONS {
                    shared.active_connections.fetch_sub(1, Ordering::AcqRel);
                    let _ = write_status(
                        &mut stream,
                        503,
                        "Service Unavailable",
                        b"gateway connection limit reached",
                    );
                    continue;
                }
                let connection_id = shared.next_connection_id.fetch_add(1, Ordering::AcqRel);
                if let Err(error) = register_connection_stream(&shared, connection_id, &stream) {
                    shared.active_connections.fetch_sub(1, Ordering::AcqRel);
                    eprintln!("Native Gateway connection registration failed: {error}");
                    continue;
                }
                let connection_shared = Arc::clone(&shared);
                let spawned = thread::Builder::new()
                    .name("harnessdock-gateway-connection".into())
                    .spawn(move || {
                        let _guard = ActiveConnectionGuard {
                            id: connection_id,
                            shared: Arc::clone(&connection_shared),
                        };
                        if let Err(error) = handle_connection(
                            stream,
                            peer,
                            connection_id,
                            Arc::clone(&connection_shared),
                        ) {
                            eprintln!("Native Gateway connection failed: {error}");
                        }
                    });
                match spawned {
                    Ok(worker) => {
                        if let Ok(mut workers) = shared.connection_workers.lock() {
                            workers.push(worker);
                        } else {
                            let _ = worker.join();
                        }
                    }
                    Err(error) => {
                        if let Ok(mut streams) = shared.connection_streams.lock() {
                            streams.remove(&connection_id);
                        }
                        shared.active_connections.fetch_sub(1, Ordering::AcqRel);
                        eprintln!("Native Gateway connection thread failed: {error}");
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => {
                eprintln!("Native Gateway accept failed: {error}");
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    shutdown_active_connections(&shared);
    join_connection_workers(&shared);
}
