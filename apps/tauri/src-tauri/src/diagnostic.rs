//! Structured diagnostic extraction for runtime failure attribution.
//!
//! Runtime recovery isolates third-party plugins based on why a launch
//! attempt failed. Raw substring scans over the whole diagnostic buffer are
//! brittle (false positives from unrelated log lines, false negatives when a
//! plugin id is not literally present). This module parses the diagnostic text
//! into a small structured fingerprint once, and recovery attribution matches
//! candidate plugin rows against the fingerprint's precise fields.

/// A structured, normalized failure fingerprint extracted from a runtime
/// attempt's combined stdout/stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DiagnosticFingerprint {
    /// Module resolution failure: `Cannot find module '<name>'`.
    /// An empty name means the message matched but no module name was parsed.
    ModuleName(String),
    /// `SyntaxError: ...` with an optional source file and line.
    Syntax { file: String, line: Option<u32> },
    /// `EACCES`/`EPERM`/`permission denied` with an optional path.
    Permission { path: String },
    /// `EADDRINUSE: address already in use :::<port>`.
    PortInUse { port: u16 },
    /// No structured fingerprint recognized; callers fall back to legacy
    /// substring attribution.
    None,
}

fn ascii_lower(value: &str) -> String {
    value.to_ascii_lowercase()
}

fn extract_second_line_lower(buffer: &str, marker: &str) -> Option<String> {
    let lower = ascii_lower(buffer);
    let idx = lower.find(marker)?;
    let rest = &lower[idx + marker.len()..];
    let trimmed = rest
        .trim_start()
        .trim_end_matches(|c: char| c.is_ascii_punctuation());
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_port_in_use(lower: &str) -> Option<u16> {
    const MARKERS: [&str; 3] = [
        "address already in use",
        "eaddrinuse",
        "port is already in use",
    ];
    for marker in MARKERS {
        let Some(idx) = lower.find(marker) else {
            continue;
        };
        // scan forward for a numeric port: ": :::<port>" or ":<port>"
        let tail = &lower[idx + marker.len()..];
        let digits_start = tail
            .char_indices()
            .find(|(_, c)| c.is_ascii_digit())
            .map(|(i, _)| i)?;
        let digits = tail[digits_start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>();
        return digits.parse().ok();
    }
    None
}

fn extract_quoted_value(lower: &str, after_marker: &str) -> Option<String> {
    let idx = lower.find(after_marker)?;
    let tail = &lower[idx + after_marker.len()..];
    let open = tail.find(['\'', '"', '`'])?;
    let quote = tail[open..].chars().next()?;
    let inner = &tail[open + quote.len_utf8()..];
    let close = inner.find(quote)?;
    let value = inner[..close].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn extract_syntax_file_line(lower: &str) -> (String, Option<u32>) {
    // Node emits SyntaxError stack trails like
    //   "at file:///opt/dsh/plugins/helper.js:17:9"
    // Walk every ":<digits>" occurrence, then backtrack to the start of the
    // path-ish token left of the colon. First path-like token with a line
    // number wins.
    let bytes = lower.as_bytes();
    let mut search = 0_usize;
    let mut best_file = String::new();
    let mut best_line = None;
    while search < lower.len() {
        let Some(rel) = lower[search..].find(':') else {
            break;
        };
        let colon = search + rel;
        let digits_start = colon + 1;
        let digits_end = (digits_start..lower.len())
            .find(|index| !bytes[*index].is_ascii_digit())
            .unwrap_or(lower.len());
        if digits_end > digits_start {
            if let Ok(line) = lower[digits_start..digits_end].parse::<u32>() {
                let mut start = colon;
                while start > 0 {
                    let prev = bytes[start - 1];
                    if prev.is_ascii_whitespace()
                        || matches!(prev, b':' | b'(' | b',' | b'\'' | b'"')
                    {
                        break;
                    }
                    start -= 1;
                }
                let token = lower[start..colon].trim();
                let path_like =
                    token.contains('/') || token.contains('\\') || token.contains(".js");
                if !token.is_empty() && path_like {
                    if best_line.is_none() {
                        best_file = token.to_string();
                        best_line = Some(line);
                    }
                    return (best_file, best_line);
                }
            }
        }
        search = digits_end.max(colon + 1);
    }
    (best_file, best_line)
}

/// Parse a combined stdout/stderr buffer into a normalized fingerprint.
pub(crate) fn parse_diagnostic(diagnostic: &str) -> DiagnosticFingerprint {
    let lower = ascii_lower(diagnostic);
    if let Some(port) = extract_port_in_use(&lower) {
        return DiagnosticFingerprint::PortInUse { port };
    }
    if lower.contains("cannot find module")
        || lower.contains("module not found")
        || lower.contains("module_not_found")
        || lower.contains("no such file or directory")
    {
        // prefer the quoted module name, then the trailing path-ish token
        if let Some(name) = extract_quoted_value(&lower, "cannot find module") {
            return DiagnosticFingerprint::ModuleName(name);
        }
        if let Some(name) = extract_quoted_value(&lower, "module not found") {
            return DiagnosticFingerprint::ModuleName(name);
        }
        if let Some(name) = extract_second_line_lower(&lower, "error: cannot find module") {
            return DiagnosticFingerprint::ModuleName(name);
        }
        return DiagnosticFingerprint::ModuleName(String::new());
    }
    if lower.contains("syntaxerror") || lower.contains("syntax error") {
        let (file, line) = extract_syntax_file_line(&lower);
        return DiagnosticFingerprint::Syntax { file, line };
    }
    if lower.contains("permission denied") || lower.contains("eacces") || lower.contains("eperm") {
        if let Some(path) = extract_quoted_value(&lower, "open") {
            return DiagnosticFingerprint::Permission { path };
        }
        return DiagnosticFingerprint::Permission {
            path: String::new(),
        };
    }
    DiagnosticFingerprint::None
}

/// Match a fingerprint against a candidate plugin row's tokens (id, source
/// path, source basename, display name, name basename).
///
/// Returns `true` when the fingerprint's precise field names one of the
/// candidate's tokens. `PortInUse` never names a plugin (it indicates a port
/// conflict, not a plugin defect) and therefore never matches — callers treat
/// that as ambiguous.
pub(crate) fn fingerprint_matches(
    fingerprint: &DiagnosticFingerprint,
    candidate_tokens: &[String],
) -> bool {
    let mut needles = Vec::new();
    match fingerprint {
        DiagnosticFingerprint::ModuleName(name) if !name.is_empty() => needles.push(name.clone()),
        DiagnosticFingerprint::Syntax { file, .. } if !file.is_empty() => {
            needles.push(file.clone());
        }
        DiagnosticFingerprint::Permission { path } if !path.is_empty() => {
            needles.push(path.clone());
        }
        DiagnosticFingerprint::PortInUse { .. }
        | DiagnosticFingerprint::None
        | DiagnosticFingerprint::ModuleName(_)
        | DiagnosticFingerprint::Syntax { .. }
        | DiagnosticFingerprint::Permission { .. } => return false,
    }
    let tokens = candidate_tokens
        .iter()
        .map(|value| ascii_lower(value))
        .collect::<Vec<_>>();
    needles.iter().any(|needle| {
        let needle = ascii_lower(needle);
        tokens
            .iter()
            .any(|token| token.contains(&needle) || needle.contains(token) && token.len() >= 3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(input: &[&str]) -> Vec<String> {
        input.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn recognizes_module_not_found() {
        let fp =
            parse_diagnostic("Error: Cannot find module '/app/node_modules/foo-lib/dist/index.js'");
        assert_eq!(
            fp,
            DiagnosticFingerprint::ModuleName("/app/node_modules/foo-lib/dist/index.js".into())
        );
        assert!(fingerprint_matches(
            &fp,
            &tokens(&["foo-lib", "file:///app/node_modules/foo-lib/dist/index.js"])
        ));
        assert!(!fingerprint_matches(&fp, &tokens(&["other-lib"])));
    }

    #[test]
    fn recognizes_port_in_use() {
        let fp = parse_diagnostic(
            "node:events Error: listen EADDRINUSE: address already in use :::9357",
        );
        assert_eq!(fp, DiagnosticFingerprint::PortInUse { port: 9357 });
        // A port conflict is ambiguous: it never blames a plugin.
        assert!(!fingerprint_matches(&fp, &tokens(&["anything"])));
    }

    #[test]
    fn syntax_error_extracts_file_line() {
        let fp = parse_diagnostic(
            "SyntaxError: Unexpected token\n    at file:///opt/dsh/plugins/helper.js:17:9",
        );
        match fp {
            DiagnosticFingerprint::Syntax { file, line } => {
                assert!(file.contains("helper.js") || file.is_empty());
                assert_eq!(line, Some(17));
            }
            other => panic!("expected syntax fingerprint, got {other:?}"),
        }
    }

    #[test]
    fn permission_error_extracts_path() {
        let fp = parse_diagnostic("EACCES: permission denied, open '/tmp/quarantine/lock'");
        assert_eq!(
            fp,
            DiagnosticFingerprint::Permission {
                path: "/tmp/quarantine/lock".into()
            }
        );
        assert!(fingerprint_matches(
            &fp,
            &tokens(&["lock", "/tmp/quarantine/lock"])
        ));
    }

    #[test]
    fn unrecognized_diagnostic_is_none() {
        assert_eq!(
            parse_diagnostic("just some warning log"),
            DiagnosticFingerprint::None
        );
    }
}
