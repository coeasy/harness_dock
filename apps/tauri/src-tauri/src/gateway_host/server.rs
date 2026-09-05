//! The live Gateway process: loopback listener handle, generation binding,
//! status snapshot and shutdown.


// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;


pub(crate) struct NativeGateway {
    pub stop: Arc<AtomicBool>,
    pub local_addr: SocketAddr,
    pub local_url: String,
    pub public_url: String,
    pub runtime_generation: u64,
    pub shared: Arc<GatewayShared>,
    pub thread: Option<thread::JoinHandle<()>>,
}

impl NativeGateway {
    pub fn is_finished(&self) -> bool {
        self.thread
            .as_ref()
            .map(std::thread::JoinHandle::is_finished)
            .unwrap_or(true)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.local_addr, Duration::from_millis(150));
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        shutdown_active_connections(&self.shared);
        join_connection_workers(&self.shared);
    }

    pub fn status(&self) -> GatewayHostStatus {
        let devices = self
            .shared
            .registry
            .lock()
            .map(|mut registry| {
                prune_registry(&mut registry);
                registry
                    .sessions
                    .values()
                    .map(device_info)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        GatewayHostStatus {
            running: true,
            local_url: Some(self.local_url.clone()),
            public_url: Some(self.public_url.clone()),
            devices,
            runtime_generation: Some(self.runtime_generation),
        }
    }
}

impl Drop for NativeGateway {
    fn drop(&mut self) {
        self.stop();
    }
}
