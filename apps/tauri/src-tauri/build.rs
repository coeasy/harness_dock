use std::{fs, io, path::PathBuf};

/// Windows resources require an ICO file. Keep the canonical artwork as PNG
/// in source control and generate a deterministic single-image ICO before
/// tauri-build runs. Modern Windows supports PNG-compressed image payloads
/// inside ICO containers, so no image transcoder or extra build dependency is
/// required.
fn ensure_windows_icon() -> io::Result<()> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(io::Error::other)?);
    let png_path = manifest_dir.join("icons/icon.png");
    let ico_path = manifest_dir.join("icons/icon.ico");
    let png = fs::read(&png_path)?;

    // ICONDIR: reserved=0, type=1 (icon), count=1.
    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&0u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());

    // ICONDIRENTRY. Width/height byte 0 encodes 256px. The canonical source
    // is icon-256.png, copied to icons/icon.png by the repository.
    ico.push(0);
    ico.push(0);
    ico.push(0);
    ico.push(0);
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&png);

    fs::write(ico_path, ico)
}

fn main() {
    if let Err(error) = ensure_windows_icon() {
        panic!("failed to generate Windows Tauri icon: {error}");
    }
    tauri_build::build();
}
