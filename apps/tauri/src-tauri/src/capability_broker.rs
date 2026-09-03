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

pub(crate) const ALL_CAPABILITIES: [Capability; 16] = [
    Capability::WindowControl,
    Capability::WebReload,
    Capability::RuntimeRestart,
    Capability::RuntimeSafeMode,
    Capability::RuntimeQuarantineAdmin,
    Capability::SurfaceOpenGateway,
    Capability::GatewayAdmin,
    Capability::SurfaceOpenDiagnostics,
    Capability::DiagnosticsRead,
    Capability::DiagnosticsExport,
    Capability::PluginAdmin,
    Capability::ProfileAdmin,
    Capability::CliAdmin,
    Capability::UpdateCheck,
    Capability::UpdateInstall,
    Capability::AppQuit,
];

pub(crate) fn capability_for(command: &HostCommand) -> Capability {
    command.capability()
}

pub(crate) fn authorize(
    request: &AuthorizationRequest<'_>,
    lease: Option<&RuntimeLease>,
) -> Decision {
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
            | Capability::SurfaceOpenGateway
            | Capability::SurfaceOpenDiagnostics => Decision::Allow,
            Capability::RuntimeQuarantineAdmin
            | Capability::GatewayAdmin
            | Capability::DiagnosticsRead
            | Capability::DiagnosticsExport
            | Capability::PluginAdmin
            | Capability::ProfileAdmin
            | Capability::CliAdmin
            | Capability::UpdateCheck
            | Capability::UpdateInstall
            | Capability::AppQuit => Decision::Deny("remote-harness-capability-denied"),
        };
    }

    match request.subject {
        SubjectKind::NativeMenu | SubjectKind::Tray | SubjectKind::DesktopShell => Decision::Allow,
        SubjectKind::Diagnostics => match request.capability {
            Capability::SurfaceOpenGateway
            | Capability::GatewayAdmin
            | Capability::SurfaceOpenDiagnostics
            | Capability::DiagnosticsRead
            | Capability::DiagnosticsExport
            | Capability::RuntimeRestart
            | Capability::RuntimeSafeMode
            | Capability::RuntimeQuarantineAdmin
            | Capability::PluginAdmin
            | Capability::ProfileAdmin
            | Capability::CliAdmin
            | Capability::UpdateCheck
            | Capability::UpdateInstall
            | Capability::AppQuit => Decision::Allow,
            Capability::WindowControl | Capability::WebReload => {
                Decision::Deny("diagnostics-surface-capability-denied")
            }
        },
        SubjectKind::Mobile => match request.capability {
            Capability::SurfaceOpenGateway => Decision::Allow,
            _ => Decision::Deny("mobile-local-host-capability-denied"),
        },
        SubjectKind::HarnessWeb => unreachable!("handled above"),
    }
}

pub(crate) fn allowed_capabilities(
    subject: SubjectKind,
    surface: SurfaceKind,
    origin: Option<&str>,
    runtime_generation: Option<u64>,
    lease: Option<&RuntimeLease>,
) -> Vec<Capability> {
    ALL_CAPABILITIES
        .into_iter()
        .filter(|capability| {
            authorize(
                &AuthorizationRequest {
                    subject,
                    surface,
                    origin,
                    runtime_generation,
                    capability: *capability,
                },
                lease,
            ) == Decision::Allow
        })
        .collect()
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
    fn harness_web_can_open_admin_surfaces_but_cannot_admin_them() {
        let lease = lease();
        for capability in [
            Capability::SurfaceOpenGateway,
            Capability::SurfaceOpenDiagnostics,
        ] {
            let request = AuthorizationRequest {
                subject: SubjectKind::HarnessWeb,
                surface: SurfaceKind::Harness,
                origin: Some(&lease.origin),
                runtime_generation: Some(lease.generation.id),
                capability,
            };
            assert_eq!(authorize(&request, Some(&lease)), Decision::Allow);
        }
        for capability in [
            Capability::GatewayAdmin,
            Capability::DiagnosticsRead,
            Capability::RuntimeQuarantineAdmin,
            Capability::UpdateInstall,
            Capability::AppQuit,
        ] {
            let request = AuthorizationRequest {
                subject: SubjectKind::HarnessWeb,
                surface: SurfaceKind::Harness,
                origin: Some(&lease.origin),
                runtime_generation: Some(lease.generation.id),
                capability,
            };
            assert!(matches!(
                authorize(&request, Some(&lease)),
                Decision::Deny(_)
            ));
        }
    }

    #[test]
    fn local_diagnostics_can_manage_privileged_resources() {
        let allowed = allowed_capabilities(
            SubjectKind::Diagnostics,
            SurfaceKind::Diagnostics,
            None,
            None,
            None,
        );
        assert!(allowed.contains(&Capability::GatewayAdmin));
        assert!(allowed.contains(&Capability::DiagnosticsExport));
        assert!(allowed.contains(&Capability::UpdateInstall));
        assert!(allowed.contains(&Capability::AppQuit));
    }
}
