use log::{info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

use crate::database::models::{Setting, Transcript};
use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::llm_client::{generate_summary, LLMProvider};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranslation {
    pub meeting_id: String,
    pub target_language: String,
    pub translated_at: String,
    pub segments: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TranslationSegmentItem {
    id: String,
    #[serde(default)]
    speaker: Option<String>,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TranslationResultItem {
    id: String,
    text: String,
}

fn clean_json_codeblock(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_prefix("```json") {
        if let Some(end) = stripped.rfind("```") {
            return stripped[..end].trim();
        }
        return stripped.trim();
    }
    if let Some(stripped) = trimmed.strip_prefix("```") {
        if let Some(end) = stripped.rfind("```") {
            return stripped[..end].trim();
        }
        return stripped.trim();
    }
    trimmed
}

fn get_translations_dir(folder_path: &str) -> PathBuf {
    PathBuf::from(folder_path).join("translations")
}

fn sanitize_lang_filename(lang: &str) -> String {
    lang.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect()
}

/// Retrieve any previously saved translations for a meeting
#[tauri::command]
pub async fn api_get_meeting_translations<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<MeetingTranslation>, String> {
    let pool = state.db_manager.pool();
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(&meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Database error: {}", e))?
        .flatten();

    let Some(folder) = folder else {
        return Ok(Vec::new());
    };

    let trans_dir = get_translations_dir(&folder);
    if !trans_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    if let Ok(entries) = std::fs::read_dir(trans_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    if let Ok(trans) = serde_json::from_str::<MeetingTranslation>(&content) {
                        results.push(trans);
                    }
                }
            }
        }
    }

    Ok(results)
}

/// Translate the transcript of a meeting into the requested target language using LLM
#[tauri::command]
pub async fn api_translate_meeting_transcript<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    target_language: String,
) -> Result<MeetingTranslation, String> {
    info!(
        "🌐 Translating transcript for meeting {} into {}",
        meeting_id, target_language
    );

    let pool = state.db_manager.pool();
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(&meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Database error: {}", e))?
        .flatten();

    // Fetch meeting transcripts directly from transcripts table
    let transcripts: Vec<Transcript> = sqlx::query_as::<_, Transcript>(
        "SELECT id, meeting_id, transcript, timestamp, summary, action_items, key_points, audio_start_time, audio_end_time, duration, speaker, words \
         FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time ASC, timestamp ASC"
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to load transcripts: {}", e))?;

    if transcripts.is_empty() {
        return Err("No transcript segments found for this meeting".to_string());
    }

    // Load active LLM settings
    let setting: Setting = SettingsRepository::get_model_config(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| Setting {
            id: "default".to_string(),
            provider: "ollama".to_string(),
            model: "llama3.2".to_string(),
            whisper_model: "base".to_string(),
            groq_api_key: None,
            openai_api_key: None,
            anthropic_api_key: None,
            ollama_api_key: None,
            open_router_api_key: None,
            ollama_endpoint: Some("http://localhost:11434".to_string()),
            custom_openai_config: None,
            summary_max_tokens: None,
            claude_cli_path: None,
        });

    let provider = LLMProvider::from_str(&setting.provider).unwrap_or(LLMProvider::Ollama);
    let custom_config = setting.get_custom_openai_config();

    let api_key = match provider {
        LLMProvider::OpenAI => setting.openai_api_key.as_deref().unwrap_or(""),
        LLMProvider::Groq => setting.groq_api_key.as_deref().unwrap_or(""),
        LLMProvider::Claude => setting.anthropic_api_key.as_deref().unwrap_or(""),
        LLMProvider::OpenRouter => setting.open_router_api_key.as_deref().unwrap_or(""),
        LLMProvider::CustomOpenAI => {
            custom_config
                .as_ref()
                .and_then(|c| c.api_key.as_deref())
                .unwrap_or("")
        }
        _ => "",
    };

    let custom_config = setting.get_custom_openai_config();
    let custom_endpoint = custom_config.as_ref().map(|c| c.endpoint.as_str());
    let custom_temp = custom_config.as_ref().and_then(|c| c.temperature);
    let custom_top_p = custom_config.as_ref().and_then(|c| c.top_p);

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let app_data_dir = crate::paths::install_data_root();
    let mut translated_segments: HashMap<String, String> = HashMap::new();

    // Chunk segments into batches of 20
    const BATCH_SIZE: usize = 20;
    for chunk in transcripts.chunks(BATCH_SIZE) {
        let items: Vec<TranslationSegmentItem> = chunk
            .iter()
            .map(|t| TranslationSegmentItem {
                id: t.id.clone(),
                speaker: t.speaker.clone(),
                text: t.transcript.clone(),
            })
            .collect();

        let input_json = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("JSON serialization error: {}", e))?;

        let system_prompt = format!(
            "You are an expert multilingual translator for meeting conversations.\n\
             Translate the spoken dialogue into {}.\n\
             Preserve the original tone, colloquial nuances, and technical terms accurately.\n\
             Do NOT summarize, alter meaning, or add pleasantries.\n\
             Output MUST be a single raw JSON array of objects with 'id' and 'text' fields exactly matching the input items:\n\
             [\n\
               {{\"id\": \"...\", \"text\": \"...translated sentence...\"}}\n\
             ]",
            target_language
        );

        let user_prompt = format!(
            "Translate these dialogue segments into {}:\n\n{}",
            target_language, input_json
        );

        let response = generate_summary(
            &client,
            &provider,
            &setting.model,
            api_key,
            &system_prompt,
            &user_prompt,
            setting.ollama_endpoint.as_deref(),
            custom_endpoint,
            Some(4096),
            custom_temp.or(Some(0.2)),
            custom_top_p,
            Some(&app_data_dir),
            setting.claude_cli_path.as_deref(),
            None,
        )
        .await
        .map_err(|e| format!("LLM translation request failed: {}", e))?;

        let cleaned = clean_json_codeblock(&response);
        if let Ok(parsed) = serde_json::from_str::<Vec<TranslationResultItem>>(cleaned) {
            for item in parsed {
                translated_segments.insert(item.id, item.text);
            }
        } else {
            warn!("Failed to parse JSON response for translation batch: {}", response);
            // Fallback: preserve original text if parsing fails
            for item in items {
                translated_segments.insert(item.id, item.text);
            }
        }
    }

    let translation = MeetingTranslation {
        meeting_id: meeting_id.clone(),
        target_language: target_language.clone(),
        translated_at: chrono::Utc::now().to_rfc3339(),
        segments: translated_segments,
    };

    // Save translation in meeting folder if folder exists
    if let Some(folder_path) = folder {
        let trans_dir = get_translations_dir(&folder_path);
        let _ = std::fs::create_dir_all(&trans_dir);
        let filename = format!("{}.json", sanitize_lang_filename(&target_language));
        let file_path = trans_dir.join(filename);
        if let Ok(json) = serde_json::to_string_pretty(&translation) {
            let _ = std::fs::write(file_path, json);
        }
    }

    Ok(translation)
}
