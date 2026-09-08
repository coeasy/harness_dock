//! OS-backed randomness shared by the Gateway pairing flow and Runtime
//! generation ids.
//!
//! `secure_random` used to exist twice — once in `gateway_host.rs` and once in
//! `runtime_actor.rs`. The two copies were byte-identical on Windows and only
//! differed in their error strings on Unix, so a fix to one (for example the
//! `u32::try_from` length guard) silently did not reach the other.

/// Fills `buffer` with bytes from the operating system CSPRNG.
#[cfg(unix)]
pub(crate) fn secure_random(buffer: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(buffer))
        .map_err(|error| format!("OS random source unavailable: {error}"))
}

/// Fills `buffer` with bytes from the operating system CSPRNG.
///
/// `RtlGenRandom` takes a `u32` length, so an oversized request on a 64-bit
/// host must be rejected rather than silently truncated by a `as u32` cast.
#[cfg(windows)]
pub(crate) fn secure_random(buffer: &mut [u8]) -> Result<(), String> {
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buffer: *mut u8, length: u32) -> u8;
    }
    let length = u32::try_from(buffer.len())
        .map_err(|_| "Random request is too large for the Windows CSPRNG".to_string())?;
    let ok = unsafe { rtl_gen_random(buffer.as_mut_ptr(), length) };
    if ok == 0 {
        Err("Windows cryptographic random source unavailable".into())
    } else {
        Ok(())
    }
}

/// Returns `bytes` random bytes rendered as lowercase hex.
pub(crate) fn random_hex(bytes: usize) -> Result<String, String> {
    let mut data = vec![0_u8; bytes];
    secure_random(&mut data)?;
    Ok(data.iter().map(|value| format!("{value:02x}")).collect())
}

/// Returns an 8-digit zero-padded pairing code.
pub(crate) fn pairing_code() -> Result<String, String> {
    let mut data = [0_u8; 4];
    secure_random(&mut data)?;
    let value = u32::from_le_bytes(data) % 100_000_000;
    Ok(format!("{value:08}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_hex_length_and_charset() {
        let value = random_hex(16).expect("CSPRNG must be available");
        assert_eq!(value.len(), 32);
        assert!(value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn random_hex_zero_bytes_is_empty() {
        assert_eq!(random_hex(0).expect("CSPRNG must be available"), "");
    }

    #[test]
    fn random_hex_differs_between_calls() {
        let first = random_hex(32).expect("CSPRNG must be available");
        let second = random_hex(32).expect("CSPRNG must be available");
        assert_ne!(first, second);
    }

    #[test]
    fn pairing_code_is_eight_digits() {
        for _ in 0..32 {
            let code = pairing_code().expect("CSPRNG must be available");
            assert_eq!(code.len(), 8);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn pairing_code_has_entropy() {
        // 32 draws from a 100M space: a constant generator would fail this.
        let distinct = (0..32)
            .map(|_| pairing_code().expect("CSPRNG must be available"))
            .collect::<std::collections::HashSet<_>>();
        assert!(
            distinct.len() > 24,
            "expected a high-entropy generator, got {} distinct codes out of 32",
            distinct.len()
        );
    }
}
