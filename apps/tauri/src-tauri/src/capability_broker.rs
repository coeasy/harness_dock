use crate::{
    host_protocol::{Capability, HostCommand, SubjectKind},
    runtime_actor::RuntimeLease,
    surface_actor::SurfaceKind,
};

#[derive(Debug, Clone)]
pub(crate) struct AuthorizationRequest<'a> {
    pub subject: SubjectKind,
    pub surface: SurfaceKind,
    pub origin: Option<&'a str>,
    pub runtime_generation: Option<u64>,
    pub capability: Capability,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decision {
    Allow,
    Deny(&'static str),
}

pub(crate) fn capability_for(command: &HostCommand) -> Capability {
    match command {
        HostCommand::RefreshHarness => Capability::WebReload,
        HostCommand::RestartRuntime => Capability::RuntimeRestart,
        HostCommand::StartSafeMode => Capability::RuntimeSafeMode,
        HostCommand::ClearQuarantine => Capability::RuntimeClearQuarantine,
        HostCommand::ShowGateway => Capability::GatewayManage,
        HostCommand::ShowDiagnostics => Capability::DiagnosticsRead,
        HostCommand::InstallUpdate => Capability::UpdateInstall,
        HostCommand::Quit => Capability::AppQuit,
    }
}

pub(crate) fn authorize(request: &AuthorizationRequest<'_>, lease: Option<&RuntimeLease>) -> Decision {
    if request.subject == SubjectKind::HarnessWeb {
        let Some(lease) = lease else {
            return Decision::Deny("harness-web-without-runtime-lease");
        };
        if request.surface != SurfaceKind::Harness {
            return Decision::Deny("harness-web-wrong-surface");
        }
        if request.runtime_generation != Some(lease.generation.id) {
            return Decision::Deny("harness-web-stale-runtime-generation");
        }
        if request.origin != Some(lease.origin.as_str()) {
            return Decision::Deny("harness-web-origin-mismatch");
        }
        return match request.capability {
            Capability::WindowControl
            | Capability::WebReload
            | Capability::RuntimeRestart
            | Capability::RuntimeSafeMode
            | Capability::RuntimeClearQuarantine
            | Capability::GatewayManage
            | Capability::DiagnosticsRead => Decision::Allow,
            Capability::UpdateCheck | Capability::UpdateInstall | Capability::AppQuit => {
                Decision::Deny("remote-harness-cannot-own-host-update-or-exit")
            }
        };
    }

    match request.subject {
        SubjectKind::NativeMenu | SubjectKind::Tray | SubjectKind::DesktopShell => Decision::Allow,
        SubjectKind::Diagnostics => match request.capability {
            Capability::DiagnosticsRead
            | Capability::RuntimeRestart
            | Capability::RuntimeSafeMode
            | Capability::RuntimeClearQuarantine => Decision::Allow,
            _ => Decision::Deny("diagnostics-surface-capability-denied"),
        },
        SubjectKind::Mobile => match request.capability {
            Capability::GatewayManage => Decision::Allow,
            _ => Decision::Deny("mobile-local-host-capability-denied"),
        },
        SubjectKind::HarnessWeb => unreachable!("handled above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_actor::{RuntimeGeneration, RuntimeMode};

    fn lease() -> RuntimeLease {
        RuntimeLease {
            generation: RuntimeGeneration {
                id: 7,
                nonce: "nonce".into(),
                image_identity: "sha256:test".into(),
                mode: RuntimeMode::Normal,
            },
            pid: 42,
            origin: "http://127.0.0.1:43123".into(),
            launch_url: "http://127.0.0.1:43123/?token=x".into(),
            dsh_version: "0.1.2".into(),
        }
    }

    #[test]
    fn harness_web_requires_exact_generation_and_origin() {
        let lease = lease();
        let request = AuthorizationRequest {
            subject: SubjectKind::HarnessWeb,
            surface: SurfaceKind::Harness,
            origin: Some("http://127.0.0.1:43123"),
            runtime_generation: Some(7),
            capability: Capability::WebReload,
        };
        assert_eq!(authorize(&request, Some(&lease)), Decision::Allow);
        let stale = AuthorizationRequest {
            runtime_generation: Some(6),
            ..request.clone()
        };
        assert!(matches!(authorize(&stale, Some(&lease)), Decision::Deny(_)));
    }

    #[test]
    fn harness_web_never_gets_update_or_exit_authority() {
        let lease = lease();
        for capability in [Capability::UpdateInstall, Capability::AppQuit] {
            let request = AuthorizationRequest {
                subject: SubjectKind::HarnessWeb,
                surface: SurfaceKind::Harness,
                origin: Some(&lease.origin),
                runtime_generation: Some(lease.generation.id),
                capability,
            };
            assert!(matches!(authorize(&request, Some(&lease)), Decision::Deny(_)));
        }
    }
}
