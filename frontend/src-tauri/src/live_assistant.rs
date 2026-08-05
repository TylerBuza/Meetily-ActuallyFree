//! Live AI Assistant
//!
//! Answers ad-hoc questions during an active meeting using the live transcript as
//! context. Reuses the user's configured model provider — local Ollama, the bundled
//! local model (BuiltInAI), or any BYOK cloud provider (OpenAI / Claude / Groq /
//! OpenRouter / custom OpenAI-compatible endpoints such as Gemini).
//!
//! This is a *consensual* meeting-assistant feature: it operates on the transcript the
//! app is already capturing for the user's own meeting notes. It does not hide itself
//! from other participants or screen shares.

use crate::database::repositories::setting::SettingsRepository;
use crate::summary::llm_client::{generate_summary, LLMProvider};
use tauri::{AppHandle, Runtime, State};
use tracing::info;

/// Ask the live assistant a question, grounded in the recent meeting transcript.
///
/// # Arguments
/// * `question` - The user's question.
/// * `transcript_context` - Recent transcript text to ground the answer (may be truncated by the caller).
/// * `persona` - Optional extra system-prompt guidance (e.g. a persona/mode preset).
///
/// # Returns
/// The assistant's answer as Markdown text.
#[tauri::command]
pub async fn ask_live_assistant<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, crate::state::AppState>,
    question: String,
    transcript_context: String,
    persona: Option<String>,
) -> Result<String, String> {
    if question.trim().is_empty() {
        return Err("Question is empty".to_string());
    }

    let pool = state.db_manager.pool();

    // Resolve the configured provider/model (same config the summary feature uses)
    let config = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|e| format!("Failed to load model config: {}", e))?
        .ok_or_else(|| "No AI model configured. Choose one in Model Settings first.".to_string())?;

    let model_provider = config.provider.clone();
    let model_name = config.model.clone();
    let provider = LLMProvider::from_str(&model_provider)?;

    // API key (Ollama / BuiltInAI / CustomOpenAI don't use the standard key column)
    let api_key = if provider == LLMProvider::Ollama
        || provider == LLMProvider::BuiltInAI
        || provider == LLMProvider::CustomOpenAI
    {
        String::new()
    } else {
        SettingsRepository::get_api_key(pool, &model_provider)
            .await
            .map_err(|e| format!("Failed to get API key: {}", e))?
            .filter(|k| !k.is_empty())
            .ok_or_else(|| format!("API key not found for {}", model_provider))?
    };

    // Ollama custom endpoint (if any)
    let ollama_endpoint = if provider == LLMProvider::Ollama {
        config.ollama_endpoint.clone()
    } else {
        None
    };

    // Custom OpenAI-compatible config (endpoint/key/params) — used for Gemini-via-proxy etc.
    let (
        custom_openai_endpoint,
        custom_openai_api_key,
        custom_openai_max_tokens,
        custom_openai_temperature,
        custom_openai_top_p,
    ) = if provider == LLMProvider::CustomOpenAI {
        match SettingsRepository::get_custom_openai_config(pool).await {
            Ok(Some(c)) => (
                Some(c.endpoint),
                c.api_key,
                c.max_tokens.map(|t| t as u32),
                c.temperature,
                c.top_p,
            ),
            Ok(None) => {
                return Err("Custom OpenAI provider selected but not configured".to_string())
            }
            Err(e) => return Err(format!("Failed to read custom OpenAI config: {}", e)),
        }
    } else {
        (None, None, None, None, None)
    };

    let final_api_key = if provider == LLMProvider::CustomOpenAI {
        custom_openai_api_key.unwrap_or_default()
    } else {
        api_key
    };

    // Install-local data dir for the BuiltInAI (local sidecar) provider (portable build)
    let _ = &app;
    let app_data_dir = Some(crate::paths::install_data_root());

    let persona_extra = persona.unwrap_or_default();
    let system_prompt = format!(
        "You are a fast, concise real-time meeting assistant. Use the provided live meeting \
transcript as your primary context to answer the user's question. If the transcript does not \
contain the answer, answer from general knowledge and note that briefly. Keep answers short and \
skimmable; use Markdown (bullets, short paragraphs, code blocks when relevant).{}{}",
        if persona_extra.trim().is_empty() { "" } else { "\n\nAdditional guidance:\n" },
        persona_extra.trim()
    );

    let user_prompt = format!(
        "LIVE MEETING TRANSCRIPT (context):\n\"\"\"\n{}\n\"\"\"\n\nQUESTION: {}",
        transcript_context.trim(),
        question.trim()
    );

    let client = reqwest::Client::new();
    let answer = generate_summary(
        &client,
        &provider,
        &model_name,
        &final_api_key,
        &system_prompt,
        &user_prompt,
        ollama_endpoint.as_deref(),
        custom_openai_endpoint.as_deref(),
        custom_openai_max_tokens.or(Some(1024)),
        custom_openai_temperature.or(Some(0.4)),
        custom_openai_top_p,
        app_data_dir.as_ref(),
        None,
    )
    .await?;

    info!(
        "Live assistant answered via {} ({} chars)",
        model_provider,
        answer.len()
    );
    Ok(answer)
}

#[derive(serde::Deserialize)]
struct OllamaEmbeddingResponse {
    embedding: Vec<f32>,
}

/// Generate embeddings for a batch of texts via a local Ollama server.
///
/// Used by the (optional) RAG feature to embed transcript chunks + the question so the
/// frontend can rank chunks by similarity. Requires Ollama running with an embedding
/// model pulled (default: `nomic-embed-text`).
#[tauri::command]
pub async fn ollama_embed(
    texts: Vec<String>,
    model: Option<String>,
    endpoint: Option<String>,
) -> Result<Vec<Vec<f32>>, String> {
    let endpoint = endpoint
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let endpoint = endpoint.trim_end_matches('/').to_string();
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "nomic-embed-text".to_string());

    let client = reqwest::Client::new();
    let mut out = Vec::with_capacity(texts.len());
    for t in texts {
        if t.trim().is_empty() {
            out.push(Vec::new());
            continue;
        }
        let resp = client
            .post(format!("{}/api/embeddings", endpoint))
            .json(&serde_json::json!({ "model": model, "prompt": t }))
            .send()
            .await
            .map_err(|e| format!("Ollama embeddings request failed (is Ollama running?): {}", e))?;
        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Ollama embeddings error {} (pull the model with `ollama pull {}`): {}",
                code, model, body
            ));
        }
        let parsed: OllamaEmbeddingResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Ollama embeddings response: {}", e))?;
        out.push(parsed.embedding);
    }
    Ok(out)
}
