use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    process,
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

const WINDOWS_X64_TARGET: &str = "x86_64-pc-windows-msvc";
const ARCHIVE_URL: &str = "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/1.22.0/microsoft.ml.onnxruntime.directml.1.22.0.nupkg";
const ARCHIVE_SHA256: &str = "29f9872d786236b79aa83f94482f3a17c14297e4833768d6d0ed4883ee732e60";
const ARCHIVE_SIZE: u64 = 17_898_472;

const DML_ARCHIVE_URL: &str = "https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg";
const DML_ARCHIVE_SHA256: &str = "4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9";
const DML_ARCHIVE_SIZE: u64 = 202_292_617;

struct Artifact {
    archive_path: &'static str,
    output_name: &'static str,
    size: u64,
    sha256: &'static str,
    is_dml_archive: bool,
}

const ARTIFACTS: [Artifact; 4] = [
    Artifact {
        archive_path: "runtimes/win-x64/native/onnxruntime.dll",
        output_name: "onnxruntime.dll",
        size: 16_471_584,
        sha256: "95366724919f4e95ecc60010912ed538ad9804b6683fbd0aad389749102834b9",
        is_dml_archive: false,
    },
    Artifact {
        archive_path: "runtimes/win-x64/native/onnxruntime_providers_shared.dll",
        output_name: "onnxruntime_providers_shared.dll",
        size: 22_048,
        sha256: "dea79756b1ef0deb317115aa5da45eca8946eafcf1be2dbd9fa3b309551faae5",
        is_dml_archive: false,
    },
    Artifact {
        archive_path: "bin/x64-win/DirectML.dll",
        output_name: "DirectML.dll",
        size: 18_527_776,
        sha256: "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
        is_dml_archive: true,
    },
    Artifact {
        archive_path: "LICENSE",
        output_name: "onnxruntime-LICENSE.txt",
        size: 1_094,
        sha256: "c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674",
        is_dml_archive: false,
    },
];

pub fn ensure_onnxruntime_runtime() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    println!("cargo:rerun-if-changed=binaries/onnxruntime");

    let target = env::var("TARGET").expect("TARGET environment variable not set");
    if target != WINDOWS_X64_TARGET {
        panic!("ONNX Runtime is bundled only for {WINDOWS_X64_TARGET}; got {target}");
    }

    let manifest_dir =
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR environment variable not set");
    let destination = Path::new(&manifest_dir)
        .join("binaries")
        .join("onnxruntime");

    match verify_staged_runtime(&destination) {
        Ok(()) => {
            println!(
                "cargo:warning=Using verified bundled ONNX Runtime from {}",
                destination.display()
            );
            stage_development_runtime(&destination);
            return;
        }
        Err(verification_error) => match fs::symlink_metadata(&destination) {
            Ok(metadata) if is_link_or_reparse_point(&metadata) => {
                panic!(
                    "Refusing to replace linked or reparse-point ONNX Runtime stage at {}: {verification_error}",
                    destination.display()
                );
            }
            Ok(metadata) if metadata.is_dir() => {
                println!(
                    "cargo:warning=Replacing invalid bundled ONNX Runtime: {verification_error}"
                );
                fs::remove_dir_all(&destination).unwrap_or_else(|remove_error| {
                    panic!(
                        "Failed to remove invalid ONNX Runtime directory at {}: {remove_error}",
                        destination.display()
                    )
                });
            }
            Ok(metadata) if metadata.is_file() => {
                println!(
                    "cargo:warning=Replacing invalid bundled ONNX Runtime: {verification_error}"
                );
                fs::remove_file(&destination).unwrap_or_else(|remove_error| {
                    panic!(
                        "Failed to remove invalid ONNX Runtime file at {}: {remove_error}",
                        destination.display()
                    )
                });
            }
            Ok(_) => {
                panic!(
                    "Refusing to replace special ONNX Runtime stage at {}: {verification_error}",
                    destination.display()
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                panic!(
                    "Failed to inspect invalid ONNX Runtime stage at {}: {error}",
                    destination.display()
                );
            }
        },
    }

    fs::create_dir_all(
        destination
            .parent()
            .expect("ONNX Runtime destination has no parent"),
    )
    .expect("Failed to create ONNX Runtime binaries directory");

    let temporary_archive = env::temp_dir().join(format!(
        "meetily-onnxruntime-{}-{}.zip",
        process::id(),
        target
    ));
    let temporary_dml_archive = env::temp_dir().join(format!(
        "meetily-directml-{}-{}.zip",
        process::id(),
        target
    ));
    let temporary_destination =
        destination.with_file_name(format!(".onnxruntime-{}-{}", process::id(), target));
    let _ = fs::remove_file(&temporary_archive);
    let _ = fs::remove_file(&temporary_dml_archive);
    let _ = fs::remove_dir_all(&temporary_destination);

    let result = stage_runtime(&temporary_archive, &temporary_dml_archive, &temporary_destination);
    let _ = fs::remove_file(&temporary_archive);
    let _ = fs::remove_file(&temporary_dml_archive);

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary_destination);
        panic!("Failed to stage bundled ONNX Runtime: {error}");
    }

    fs::rename(&temporary_destination, &destination).unwrap_or_else(|error| {
        let _ = fs::remove_dir_all(&temporary_destination);
        panic!(
            "Failed to finalize bundled ONNX Runtime at {}: {error}",
            destination.display()
        );
    });

    verify_staged_runtime(&destination).unwrap_or_else(|error| {
        panic!("Bundled ONNX Runtime verification failed after staging: {error}")
    });
    println!(
        "cargo:warning=Bundled verified ONNX Runtime at {}",
        destination.display()
    );
    stage_development_runtime(&destination);
}

// Plain cargo builds must be runnable too; Tauri's installer stages resources
// separately. OUT_DIR is <profile>/build/<package>/out, not the executable dir.
fn stage_development_runtime(source: &Path) {
    let out_dir = std::path::PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let profile = out_dir.ancestors().nth(3).expect("Cargo profile directory");
    let target = profile.join("binaries/onnxruntime");
    if verify_staged_runtime(&target).is_ok() { return; }
    if fs::symlink_metadata(&target).is_ok_and(|metadata| is_link_or_reparse_point(&metadata)) {
        panic!("Refusing linked development runtime directory");
    }
    fs::create_dir_all(&target).expect("create development runtime directory");
    for artifact in ARTIFACTS {
        let file = target.join(artifact.output_name);
        if fs::symlink_metadata(&file).is_ok_and(|metadata| is_link_or_reparse_point(&metadata)) {
            panic!("Refusing linked development runtime file");
        }
        fs::copy(source.join(artifact.output_name), file).expect("stage development ONNX Runtime");
    }
    verify_staged_runtime(&target).expect("verify development ONNX Runtime");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_runtime_copy_rejects_short_and_overlong_input() {
        for input in [b"ab".as_slice(), b"abcd".as_slice()] {
            let mut output = Vec::new();
            assert!(copy_exact(&mut std::io::Cursor::new(input), &mut output, 3).is_err());
            assert!(output.len() <= 3);
        }
        let mut output = Vec::new();
        copy_exact(&mut std::io::Cursor::new(b"abc"), &mut output, 3).unwrap();
        assert_eq!(output, b"abc");
    }

    #[test]
    fn staged_runtime_is_exact_and_rejects_extras() {
        let stage = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/onnxruntime");
        verify_staged_runtime(&stage).expect("build must stage verified runtime");
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("extra")).unwrap();
        assert!(verify_staged_runtime(dir.path()).is_err());
    }
}

fn stage_runtime(
    archive_path: &Path,
    dml_archive_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    download_archive(ARCHIVE_URL, ARCHIVE_SIZE, archive_path)?;
    verify_file(archive_path, ARCHIVE_URL, ARCHIVE_SIZE, ARCHIVE_SHA256)?;

    download_archive(DML_ARCHIVE_URL, DML_ARCHIVE_SIZE, dml_archive_path)?;
    verify_file(dml_archive_path, DML_ARCHIVE_URL, DML_ARCHIVE_SIZE, DML_ARCHIVE_SHA256)?;

    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;

    let archive_file = File::open(archive_path)
        .map_err(|error| format!("failed to open {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("failed to read ONNX Runtime archive: {error}"))?;

    let dml_archive_file = File::open(dml_archive_path)
        .map_err(|error| format!("failed to open {}: {error}", dml_archive_path.display()))?;
    let mut dml_archive = zip::ZipArchive::new(dml_archive_file)
        .map_err(|error| format!("failed to read DirectML archive: {error}"))?;

    for artifact in ARTIFACTS {
        let output = destination.join(artifact.output_name);
        let mut file = File::create(&output)
            .map_err(|error| format!("failed to create {}: {error}", output.display()))?;
        if artifact.is_dml_archive {
            let mut source = dml_archive.by_name(artifact.archive_path).map_err(|error| {
                format!(
                    "missing {} in DirectML archive: {error}",
                    artifact.archive_path
                )
            })?;
            std::io::copy(&mut source, &mut file)
                .map_err(|error| format!("failed to extract {}: {error}", artifact.archive_path))?;
        } else {
            let mut source = archive.by_name(artifact.archive_path).map_err(|error| {
                format!(
                    "missing {} in ONNX Runtime archive: {error}",
                    artifact.archive_path
                )
            })?;
            std::io::copy(&mut source, &mut file)
                .map_err(|error| format!("failed to extract {}: {error}", artifact.archive_path))?;
        }
        verify_file(
            &output,
            artifact.output_name,
            artifact.size,
            artifact.sha256,
        )?;
    }

    Ok(())
}

fn download_archive(url: &str, expected_size: u64, destination: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|error| format!("failed to create download client: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("failed to download archive from {url}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("archive download failed: {error}"))?;
    let mut file = File::create(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    copy_exact(&mut response, &mut file, expected_size)
}

fn copy_exact<R: Read, W: Write>(
    source: &mut R,
    destination: &mut W,
    expected_size: u64,
) -> Result<(), String> {
    let copied = std::io::copy(
        &mut source.by_ref().take(expected_size),
        destination,
    )
    .map_err(|error| format!("failed to copy ONNX Runtime download: {error}"))?;
    if copied != expected_size {
        return Err(format!(
            "downloaded ONNX Runtime archive has size {copied}, expected {expected_size}"
        ));
    }

    let mut probe = [0_u8; 1];
    if source
        .read(&mut probe)
        .map_err(|error| format!("failed to copy ONNX Runtime download: {error}"))?
        != 0
    {
        return Err(format!(
            "downloaded ONNX Runtime archive exceeds expected size {expected_size}"
        ));
    }

    Ok(())
}

fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        return metadata.file_attributes() & 0x0000_0400 != 0;
    }

    #[cfg(not(windows))]
    false
}

fn verify_staged_runtime(destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(destination)
        .map_err(|error| format!("failed to inspect runtime stage: {error}"))?;
    if is_link_or_reparse_point(&metadata) {
        return Err("runtime stage is a link or reparse point".to_string());
    }
    if !metadata.file_type().is_dir() {
        return Err("runtime stage is not a directory".to_string());
    }

    let entries = fs::read_dir(destination)
        .map_err(|error| format!("failed to enumerate runtime stage: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to enumerate runtime stage entry: {error}"))?;
        let entry_metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!(
                "failed to inspect runtime stage entry {}: {error}",
                entry.path().display()
            )
        })?;
        if is_link_or_reparse_point(&entry_metadata) {
            return Err(format!(
                "runtime stage entry {} is a link or reparse point",
                entry.path().display()
            ));
        }
        if !entry_metadata.file_type().is_file() {
            return Err(format!(
                "runtime stage entry {} is not a regular file",
                entry.path().display()
            ));
        }

        let name = entry.file_name();
        if !ARTIFACTS
            .iter()
            .any(|artifact| name.as_os_str() == artifact.output_name)
        {
            return Err(format!(
                "runtime stage contains undeclared entry {}",
                entry.path().display()
            ));
        }
    }

    for artifact in ARTIFACTS {
        verify_file(
            &destination.join(artifact.output_name),
            artifact.output_name,
            artifact.size,
            artifact.sha256,
        )?;
    }
    Ok(())
}

fn verify_file(
    path: &Path,
    name: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("failed to inspect {name}: {error}"))?;
    if metadata.len() != expected_size {
        return Err(format!(
            "{name} has size {}, expected {expected_size}",
            metadata.len()
        ));
    }

    let mut file = File::open(path).map_err(|error| format!("failed to open {name}: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash {name}: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(format!(
            "{name} has SHA-256 {actual_sha256}, expected {expected_sha256}"
        ));
    }

    Ok(())
}
