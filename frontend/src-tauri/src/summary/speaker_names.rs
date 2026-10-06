//! Opt-in summary-derived display suggestions, independent of contact/voice identity.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
fn path() -> std::path::PathBuf {
    crate::paths::install_data_root().join("summary_speaker_names_enabled.txt")
}
fn flag() -> &'static AtomicBool {
    ENABLED.get_or_init(|| {
        AtomicBool::new(
            std::fs::read_to_string(path())
                .map(|s| s.trim() == "true")
                .unwrap_or(false),
        )
    })
}
#[tauri::command]
pub fn get_summary_speaker_names_enabled() -> bool {
    flag().load(Ordering::Relaxed)
}
#[tauri::command]
pub fn set_summary_speaker_names_enabled(value: bool) -> Result<(), String> {
    let file = path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(file, if value { "true" } else { "false" }).map_err(|e| e.to_string())?;
    flag().store(value, Ordering::Relaxed);
    Ok(())
}
/// Called with the option snapshotted at summary start; no extra inference job,
/// transcript write, contact link or voice enrollment is introduced.
pub(super) fn prompt(base: String, enabled: bool) -> String {
    if !enabled {
        return base;
    }
    format!("{base}\n\nOptional AI speaker-name suggestions: Preserve original anonymous Speaker N labels when summarizing. Only suggest a name when a self-introduction or explicit speaker identification in the source directly supports it. A person merely mentioned, addressed, or assigned an action is not evidence of the current speaker's identity. Never infer You/microphone identity, never overwrite a named speaker, and omit disputed or unknown mappings. Preserve supported mappings through intermediate summaries. At the end of the report, if any are supported, add a section titled 'AI speaker suggestions (unverified)' with one standalone bullet per mapping in the exact format '- Tony (Speaker 7)'. Use actual names and actual source speaker numbers, never the example unless supported. Keep literal Speaker N labels unchanged in every language. These are uncertain display suggestions, not saved contacts or verified identities.")
}
#[cfg(test)]
mod tests {
    #[test]
    fn disabled_prompt_is_unchanged_and_enabled_prompt_requires_source_evidence() {
        assert_eq!(super::prompt("template".into(), false), "template");
        let prompt = super::prompt("template".into(), true);
        assert!(prompt.starts_with("template"));
        assert!(prompt.contains("self-introduction"));
        assert!(prompt.contains("not evidence"));
        assert!(prompt.contains("unverified"));
        assert!(prompt.contains("never overwrite a named speaker"));
    }
}
