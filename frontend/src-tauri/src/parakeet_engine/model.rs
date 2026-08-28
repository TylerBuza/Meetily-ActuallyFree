use ndarray::{Array, Array1, Array2, Array3, ArrayD, ArrayViewD, IxDyn};
use once_cell::sync::Lazy;
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use regex::Regex;

use std::fs;
use std::path::Path;

pub type DecoderState = (Array3<f32>, Array3<f32>);

const SUBSAMPLING_FACTOR: usize = 8;
const WINDOW_SIZE: f32 = 0.01;
const MAX_TOKENS_PER_STEP: usize = 3;
const TDT_DURATIONS: [usize; 5] = [0, 1, 2, 3, 4];

// Conservative token-logit boosts. The score grows only after the decoder has
// followed a glossary phrase, reducing false starts while strongly preferring
// completion of an already-recognized name or technical term.
const VOCABULARY_ROOT_BOOST: f32 = 1.0;
const VOCABULARY_COMPLETION_BOOST: f32 = 3.0;
const MIN_VOCABULARY_TERM_CHARS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
struct BiasPhrase {
    tokens: Vec<i32>,
    start_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GlossaryTerm {
    canonical: String,
    normalized: String,
    word_count: usize,
}

#[derive(Debug)]
struct VocabularyBias {
    phrases: Vec<BiasPhrase>,
    terms: Vec<GlossaryTerm>,
    scores: Vec<f32>,
    touched: Vec<usize>,
}

impl VocabularyBias {
    fn compile(source: &str, vocab: &[String]) -> Self {
        let mut terms = Vec::new();
        let mut phrases = Vec::new();

        for term in source
            .split([',', '\n', '\r'])
            .map(str::trim)
            .filter(|term| term.chars().count() >= MIN_VOCABULARY_TERM_CHARS)
        {
            let normalized = normalize_phrase(term);
            let word_count = word_spans(term).len();
            if normalized.chars().count() < MIN_VOCABULARY_TERM_CHARS
                || word_count == 0
                || terms
                    .iter()
                    .any(|existing: &GlossaryTerm| existing.normalized == normalized)
            {
                continue;
            }

            for spelling in [term.to_string(), term.to_lowercase()] {
                for (text, start_only) in
                    [(format!(" {spelling}"), false), (spelling.clone(), true)]
                {
                    let Some(tokens) = Self::tokenize(&text, vocab) else {
                        log::warn!("Parakeet vocabulary term cannot be tokenized: '{spelling}'");
                        continue;
                    };
                    let phrase = BiasPhrase { tokens, start_only };
                    if !phrases.contains(&phrase) {
                        phrases.push(phrase);
                    }
                }
            }

            terms.push(GlossaryTerm {
                canonical: term.to_string(),
                normalized,
                word_count,
            });
        }

        Self {
            terms,
            phrases,
            scores: vec![0.0; vocab.len()],
            touched: Vec::new(),
        }
    }

    /// Tokenize a phrase into the fewest available model tokens.
    ///
    /// The exported ONNX bundle contains only `vocab.txt`, not the original
    /// SentencePiece model. Minimum-token dynamic programming gives the decoder
    /// a valid, stable path while preserving exact spelling and capitalization.
    fn tokenize(text: &str, vocab: &[String]) -> Option<Vec<i32>> {
        let mut best = vec![usize::MAX; text.len() + 1];
        let mut previous: Vec<Option<(usize, i32)>> = vec![None; text.len() + 1];
        best[0] = 0;

        for position in 0..text.len() {
            if best[position] == usize::MAX || !text.is_char_boundary(position) {
                continue;
            }
            let remaining = &text[position..];
            for (token_id, token) in vocab.iter().enumerate() {
                if token.is_empty() || token.starts_with('<') || !remaining.starts_with(token) {
                    continue;
                }
                let next = position + token.len();
                let token_count = best[position] + 1;
                if token_count < best[next] {
                    best[next] = token_count;
                    previous[next] = Some((position, token_id as i32));
                }
            }
        }

        if best[text.len()] == usize::MAX {
            return None;
        }

        let mut tokens = Vec::with_capacity(best[text.len()]);
        let mut position = text.len();
        while position > 0 {
            let (previous_position, token_id) = previous[position]?;
            tokens.push(token_id);
            position = previous_position;
        }
        tokens.reverse();
        Some(tokens)
    }

    fn matched_prefix_len(history: &[i32], phrase: &[i32]) -> usize {
        let max_len = history.len().min(phrase.len().saturating_sub(1));
        (1..=max_len)
            .rev()
            .find(|&len| history[history.len() - len..] == phrase[..len])
            .unwrap_or(0)
    }

    fn select_token(&mut self, history: &[i32], logits: &[f32], fallback: i32) -> i32 {
        let (mut best_token, mut best_score) = argmax(logits, fallback);

        for token_id in self.touched.drain(..) {
            self.scores[token_id] = 0.0;
        }

        for phrase in &self.phrases {
            let matched = Self::matched_prefix_len(history, &phrase.tokens);
            if matched == 0 && phrase.start_only && !history.is_empty() {
                continue;
            }

            let Some(&next_token) = phrase.tokens.get(matched) else {
                continue;
            };
            let token_id = next_token as usize;
            if token_id >= logits.len() {
                continue;
            }

            let progress = (matched + 1) as f32 / phrase.tokens.len() as f32;
            let boost = VOCABULARY_ROOT_BOOST
                + (VOCABULARY_COMPLETION_BOOST - VOCABULARY_ROOT_BOOST) * progress;
            if self.scores[token_id] == 0.0 {
                self.touched.push(token_id);
            }
            self.scores[token_id] = self.scores[token_id].max(boost);
        }

        for &token_id in &self.touched {
            let score = logits[token_id] + self.scores[token_id];
            if score > best_score {
                best_token = token_id as i32;
                best_score = score;
            }
        }

        best_token
    }

    /// Canonicalize words that remain phonetically close to explicit glossary
    /// entries after decoding. This complements greedy token boosting, which
    /// cannot retain an alternate hypothesis when the first uncommon subword
    /// loses by a wide acoustic margin.
    fn correct_text(&self, text: &str) -> String {
        let spans = word_spans(text);
        if spans.is_empty() || self.terms.is_empty() {
            return text.to_string();
        }

        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        let mut position = 0;

        while position < spans.len() {
            let mut best_match: Option<(usize, usize, usize, usize)> = None;

            for (term_index, term) in self.terms.iter().enumerate() {
                let minimum_words = term.word_count.saturating_sub(1).max(1);
                let maximum_words = (term.word_count + 1).min(spans.len() - position);
                for word_count in minimum_words..=maximum_words {
                    let start = spans[position].0;
                    let end = spans[position + word_count - 1].1;
                    let candidate = normalize_phrase(&text[start..end]);
                    let distance = levenshtein(&candidate, &term.normalized);
                    let same_edges = candidate.chars().next() == term.normalized.chars().next()
                        && candidate.chars().last() == term.normalized.chars().last();
                    if distance > allowed_vocabulary_distance(term.normalized.chars().count())
                        || (distance > 1 && !same_edges)
                    {
                        continue;
                    }
                    let denominator = candidate
                        .chars()
                        .count()
                        .max(term.normalized.chars().count())
                        .max(1);
                    let ratio = distance * 1000 / denominator;
                    let is_better = match best_match {
                        None => true,
                        Some((best_ratio, best_distance, best_term, _)) => {
                            ratio < best_ratio
                                || (ratio == best_ratio && distance < best_distance)
                                || (ratio == best_ratio
                                    && distance == best_distance
                                    && term.normalized.len()
                                        > self.terms[best_term].normalized.len())
                        }
                    };
                    if is_better {
                        best_match = Some((ratio, distance, term_index, word_count));
                    }
                }
            }

            if let Some((_, _, term_index, word_count)) = best_match {
                let start = spans[position].0;
                let end = spans[position + word_count - 1].1;
                output.push_str(&text[cursor..start]);
                output.push_str(&self.terms[term_index].canonical);
                cursor = end;
                position += word_count;
            } else {
                position += 1;
            }
        }

        output.push_str(&text[cursor..]);
        output
    }
}

fn argmax(logits: &[f32], fallback: i32) -> (i32, f32) {
    logits
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(index, &score)| (index as i32, score))
        .unwrap_or((fallback, f32::NEG_INFINITY))
}

fn word_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = None;

    for (index, character) in text.char_indices() {
        if character.is_alphanumeric() {
            start.get_or_insert(index);
        } else if let Some(word_start) = start.take() {
            spans.push((word_start, index));
        }
    }
    if let Some(word_start) = start {
        spans.push((word_start, text.len()));
    }

    spans
}

fn normalize_phrase(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn allowed_vocabulary_distance(term_len: usize) -> usize {
    if term_len <= 3 {
        0
    } else {
        (term_len * 2 / 5).clamp(1, 3)
    }
}

fn levenshtein(left: &str, right: &str) -> usize {
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    let mut current = vec![0; right_chars.len() + 1];

    for (left_index, left_char) in left.chars().enumerate() {
        current[0] = left_index + 1;
        for (right_index, &right_char) in right_chars.iter().enumerate() {
            let substitution = previous[right_index] + usize::from(left_char != right_char);
            current[right_index + 1] = (current[right_index] + 1)
                .min(previous[right_index + 1] + 1)
                .min(substitution);
        }
        std::mem::swap(&mut previous, &mut current);
    }

    previous[right_chars.len()]
}

static DECODE_SPACE_RE: Lazy<Result<Regex, regex::Error>> =
    Lazy::new(|| Regex::new(r"\A\s|\s\B|(\s)\b"));

#[derive(Debug, Clone)]
pub struct TimestampedResult {
    pub text: String,
    pub timestamps: Vec<f32>,
    pub tokens: Vec<String>,
}

#[derive(thiserror::Error, Debug)]
pub enum ParakeetError {
    #[error("ORT error")]
    Ort(#[from] ort::Error),
    #[error("I/O error")]
    Io(#[from] std::io::Error),
    #[error("ndarray shape error")]
    Shape(#[from] ndarray::ShapeError),
    #[error("Model input not found: {0}")]
    InputNotFound(String),
    #[error("Model output not found: {0}")]
    OutputNotFound(String),
    #[error("Failed to get tensor shape for input: {0}")]
    TensorShape(String),
}

pub struct ParakeetModel {
    encoder: Session,
    decoder_joint: Session,
    preprocessor: Session,
    vocab: Vec<String>,
    blank_idx: i32,
    vocab_size: usize,
    vocabulary_source: Option<String>,
    vocabulary_bias: Option<VocabularyBias>,
}

impl Drop for ParakeetModel {
    fn drop(&mut self) {
        log::debug!(
            "Dropping ParakeetModel with {} vocab tokens",
            self.vocab.len()
        );
    }
}

impl ParakeetModel {
    pub fn new<P: AsRef<Path>>(model_dir: P, quantized: bool) -> Result<Self, ParakeetError> {
        let encoder = Self::init_session(&model_dir, "encoder-model", None, quantized)?;
        let decoder_joint = Self::init_session(&model_dir, "decoder_joint-model", None, quantized)?;
        let preprocessor = Self::init_session(&model_dir, "nemo128", None, false)?;

        let (vocab, blank_idx) = Self::load_vocab(&model_dir)?;
        let vocab_size = vocab.len();

        log::info!(
            "Loaded Parakeet vocabulary with {} tokens, blank_idx={}",
            vocab_size,
            blank_idx
        );

        Ok(Self {
            encoder,
            decoder_joint,
            preprocessor,
            vocab,
            blank_idx,
            vocab_size,
            vocabulary_source: None,
            vocabulary_bias: None,
        })
    }

    fn configure_vocabulary(&mut self, vocabulary: Option<&str>) {
        let source = vocabulary
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if self.vocabulary_source == source {
            return;
        }

        self.vocabulary_bias = source.as_deref().and_then(|value| {
            let bias = VocabularyBias::compile(value, &self.vocab);
            log::info!(
                "Configured Parakeet vocabulary boosting with {} token paths",
                bias.phrases.len()
            );
            (!bias.phrases.is_empty()).then_some(bias)
        });
        self.vocabulary_source = source;
    }

    fn init_session<P: AsRef<Path>>(
        model_dir: P,
        model_name: &str,
        intra_threads: Option<usize>,
        try_quantized: bool,
    ) -> Result<Session, ParakeetError> {
        let providers = vec![CPUExecutionProvider::default().build()];

        // Try quantized version first if requested, fallback to regular version
        let model_filename = if try_quantized {
            let quantized_name = format!("{}.int8.onnx", model_name);
            let quantized_path = model_dir.as_ref().join(&quantized_name);
            if quantized_path.exists() {
                log::info!(
                    "Loading quantized Parakeet model from {}...",
                    quantized_name
                );
                quantized_name
            } else {
                let regular_name = format!("{}.onnx", model_name);
                log::info!(
                    "Quantized model not found, loading regular Parakeet model from {}...",
                    regular_name
                );
                regular_name
            }
        } else {
            let regular_name = format!("{}.onnx", model_name);
            log::info!("Loading Parakeet model from {}...", regular_name);
            regular_name
        };

        let mut builder = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers)?
            .with_parallel_execution(true)?;

        if let Some(threads) = intra_threads {
            builder = builder
                .with_intra_threads(threads)?
                .with_inter_threads(threads)?;
        }

        let session = builder.commit_from_file(model_dir.as_ref().join(&model_filename))?;

        for input in &session.inputs {
            log::info!(
                "Parakeet Model '{}' input: name={}, type={:?}",
                model_filename,
                input.name,
                input.input_type
            );
        }

        Ok(session)
    }

    fn load_vocab<P: AsRef<Path>>(model_dir: P) -> Result<(Vec<String>, i32), ParakeetError> {
        let vocab_path = model_dir.as_ref().join("vocab.txt");
        let content = fs::read_to_string(vocab_path)?;

        let mut max_id = 0;
        let mut tokens_with_ids: Vec<(String, usize)> = Vec::new();
        let mut blank_idx: Option<usize> = None;

        for line in content.lines() {
            let parts: Vec<&str> = line.trim_end().split(' ').collect();
            if parts.len() >= 2 {
                let token = parts[0].to_string();
                if let Ok(id) = parts[1].parse::<usize>() {
                    if token == "<blk>" {
                        blank_idx = Some(id);
                    }
                    tokens_with_ids.push((token, id));
                    max_id = max_id.max(id);
                }
            }
        }

        // Create vocab vector with \u2581 replaced with space
        let mut vocab = vec![String::new(); max_id + 1];
        for (token, id) in tokens_with_ids {
            vocab[id] = token.replace('\u{2581}', " ");
        }

        let blank_idx = blank_idx.ok_or_else(|| {
            ParakeetError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Missing <blk> token in vocabulary",
            ))
        })? as i32;

        Ok((vocab, blank_idx))
    }

    pub fn preprocess(
        &mut self,
        waveforms: &ArrayViewD<f32>,
        waveforms_lens: &ArrayViewD<i64>,
    ) -> Result<(ArrayD<f32>, ArrayD<i64>), ParakeetError> {
        log::trace!("Running Parakeet preprocessor inference...");
        let inputs = inputs![
            "waveforms" => TensorRef::from_array_view(waveforms.view())?,
            "waveforms_lens" => TensorRef::from_array_view(waveforms_lens.view())?,
        ];
        let outputs = self.preprocessor.run(inputs)?;

        let features = outputs
            .get("features")
            .ok_or_else(|| ParakeetError::OutputNotFound("features".to_string()))?
            .try_extract_array()?;
        let features_lens = outputs
            .get("features_lens")
            .ok_or_else(|| ParakeetError::OutputNotFound("features_lens".to_string()))?
            .try_extract_array()?;

        Ok((features.to_owned(), features_lens.to_owned()))
    }

    pub fn encode(
        &mut self,
        audio_signal: &ArrayViewD<f32>,
        length: &ArrayViewD<i64>,
    ) -> Result<(ArrayD<f32>, ArrayD<i64>), ParakeetError> {
        log::trace!("Running Parakeet encoder inference...");
        let inputs = inputs![
            "audio_signal" => TensorRef::from_array_view(audio_signal.view())?,
            "length" => TensorRef::from_array_view(length.view())?,
        ];
        let outputs = self.encoder.run(inputs)?;

        let encoder_output = outputs
            .get("outputs")
            .ok_or_else(|| ParakeetError::OutputNotFound("outputs".to_string()))?
            .try_extract_array()?;
        let encoded_lengths = outputs
            .get("encoded_lengths")
            .ok_or_else(|| ParakeetError::OutputNotFound("encoded_lengths".to_string()))?
            .try_extract_array()?;

        let encoder_output = encoder_output.permuted_axes(IxDyn(&[0, 2, 1]));

        Ok((encoder_output.to_owned(), encoded_lengths.to_owned()))
    }

    pub fn create_decoder_state(&self) -> Result<DecoderState, ParakeetError> {
        // Get input shapes from decoder model
        let inputs = &self.decoder_joint.inputs;

        let state1_shape = inputs
            .iter()
            .find(|input| input.name == "input_states_1")
            .ok_or_else(|| ParakeetError::InputNotFound("input_states_1".to_string()))?
            .input_type
            .tensor_shape()
            .ok_or_else(|| ParakeetError::TensorShape("input_states_1".to_string()))?;

        let state2_shape = inputs
            .iter()
            .find(|input| input.name == "input_states_2")
            .ok_or_else(|| ParakeetError::InputNotFound("input_states_2".to_string()))?
            .input_type
            .tensor_shape()
            .ok_or_else(|| ParakeetError::TensorShape("input_states_2".to_string()))?;

        // Create zero states with batch_size=1
        // Shape is [2, -1, 640] so we use [2, 1, 640] for batch_size=1
        let state1 = Array::zeros((
            state1_shape[0] as usize,
            1, // batch_size = 1
            state1_shape[2] as usize,
        ));

        let state2 = Array::zeros((
            state2_shape[0] as usize,
            1, // batch_size = 1
            state2_shape[2] as usize,
        ));

        Ok((state1, state2))
    }

    pub fn decode_step(
        &mut self,
        prev_tokens: &[i32],
        prev_state: &DecoderState,
        encoder_out: &ArrayViewD<f32>, // [time_steps, 1024]
    ) -> Result<(ArrayD<f32>, DecoderState), ParakeetError> {
        log::trace!("Running Parakeet decoder inference...");

        // Get last token or blank_idx if empty
        let target_token = prev_tokens.last().copied().unwrap_or(self.blank_idx);

        // Prepare inputs matching Python: encoder_out[None, :, None] -> [1, time_steps, 1]
        let encoder_outputs = encoder_out
            .to_owned()
            .insert_axis(ndarray::Axis(0))
            .insert_axis(ndarray::Axis(2));
        let targets = Array2::from_shape_vec((1, 1), vec![target_token])?;
        let target_length = Array1::from_vec(vec![1]);

        let inputs = inputs![
            "encoder_outputs" => TensorRef::from_array_view(encoder_outputs.view())?,
            "targets" => TensorRef::from_array_view(targets.view())?,
            "target_length" => TensorRef::from_array_view(target_length.view())?,
            "input_states_1" => TensorRef::from_array_view(prev_state.0.view())?,
            "input_states_2" => TensorRef::from_array_view(prev_state.1.view())?,
        ];

        let outputs = self.decoder_joint.run(inputs)?;

        let logits = outputs
            .get("outputs")
            .ok_or_else(|| ParakeetError::OutputNotFound("outputs".to_string()))?
            .try_extract_array()?;
        log::trace!(
            "Parakeet Logits shape: {:?}, vocab_size: {}",
            logits.shape(),
            self.vocab_size
        );
        let state1 = outputs
            .get("output_states_1")
            .ok_or_else(|| ParakeetError::OutputNotFound("output_states_1".to_string()))?
            .try_extract_array()?;
        let state2 = outputs
            .get("output_states_2")
            .ok_or_else(|| ParakeetError::OutputNotFound("output_states_2".to_string()))?
            .try_extract_array()?;

        // Squeeze outputs like Python (remove batch dimension)
        let logits = logits.remove_axis(ndarray::Axis(0));

        // Convert ArrayD back to Array3 to match expected return type
        let state1_3d = state1.to_owned().into_dimensionality::<ndarray::Ix3>()?;
        let state2_3d = state2.to_owned().into_dimensionality::<ndarray::Ix3>()?;

        Ok((logits.to_owned(), (state1_3d, state2_3d)))
    }

    pub fn recognize_batch(
        &mut self,
        waveforms: &ArrayViewD<f32>,
        waveforms_len: &ArrayViewD<i64>,
    ) -> Result<Vec<TimestampedResult>, ParakeetError> {
        // Preprocess and encode
        let (features, features_lens) = self.preprocess(waveforms, waveforms_len)?;
        let (encoder_out, encoder_out_lens) =
            self.encode(&features.view(), &features_lens.view())?;

        // Decode for each batch item
        let mut results = Vec::new();
        for (encodings, &encodings_len) in encoder_out.outer_iter().zip(encoder_out_lens.iter()) {
            let (tokens, timestamps) =
                self.decode_sequence(&encodings.view(), encodings_len as usize)?;
            let result = self.decode_tokens(tokens, timestamps);
            results.push(result);
        }

        Ok(results)
    }

    fn decode_sequence(
        &mut self,
        encodings: &ArrayViewD<f32>, // [time_steps, 1024]
        encodings_len: usize,
    ) -> Result<(Vec<i32>, Vec<usize>), ParakeetError> {
        let mut prev_state = self.create_decoder_state()?;
        let mut tokens = Vec::new();
        let mut timestamps = Vec::new();

        let mut t = 0;
        let mut emitted_tokens = 0;

        while t < encodings_len {
            let encoder_step = encodings.slice(ndarray::s![t, ..]);
            // Convert to dynamic dimension to match decode_step parameter type
            let encoder_step_dyn = encoder_step.to_owned().into_dyn();
            let (probs, new_state) =
                self.decode_step(&tokens, &prev_state, &encoder_step_dyn.view())?;

            // For TDT models, split output into vocab logits and duration logits
            // output[:vocab_size] = vocabulary logits
            // output[vocab_size:] = duration logits
            let vocab_logits_slice = probs.as_slice().ok_or_else(|| {
                ParakeetError::Shape(ndarray::ShapeError::from_kind(
                    ndarray::ErrorKind::IncompatibleShape,
                ))
            })?;

            let is_tdt = probs.len() > self.vocab_size;
            let (vocab_logits, duration_logits) = if is_tdt {
                let (v, d) = vocab_logits_slice.split_at(self.vocab_size);
                (v, Some(d))
            } else {
                (vocab_logits_slice, None)
            };

            // Apply glossary phrase boosting before choosing the vocabulary token.
            let token = if let Some(bias) = self.vocabulary_bias.as_mut() {
                bias.select_token(&tokens, vocab_logits, self.blank_idx)
            } else {
                argmax(vocab_logits, self.blank_idx).0
            };

            if token != self.blank_idx {
                prev_state = new_state;
                tokens.push(token);
                timestamps.push(t);
                emitted_tokens += 1;
            }

            if let Some(duration_logits) = duration_logits {
                // TDT: advance by the model's predicted duration (frames to skip).
                let dur_idx = duration_logits
                    .iter()
                    .enumerate()
                    .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|(idx, _)| idx)
                    .unwrap_or(0);
                let mut skip = TDT_DURATIONS.get(dur_idx).copied().unwrap_or(1);

                // Ensure forward progress on blank-with-zero-duration, and cap
                // same-frame emissions to avoid runaway repetition.
                if skip == 0 && (token == self.blank_idx || emitted_tokens >= MAX_TOKENS_PER_STEP) {
                    skip = 1;
                }
                if skip > 0 {
                    t += skip;
                    emitted_tokens = 0;
                }
            } else {
                // RNN-T greedy: advance one frame on blank or after emission cap.
                if token == self.blank_idx || emitted_tokens >= MAX_TOKENS_PER_STEP {
                    t += 1;
                    emitted_tokens = 0;
                }
            }
        }

        // NEW: Log if no tokens were decoded (helps debugging empty transcriptions)
        if tokens.is_empty() {
            log::debug!(
                "Parakeet decoded zero tokens (all blank) for audio with {} encoding timesteps - audio may be too short or low energy",
                encodings_len
            );
        }

        Ok((tokens, timestamps))
    }

    fn decode_tokens(&self, ids: Vec<i32>, timestamps: Vec<usize>) -> TimestampedResult {
        let tokens: Vec<String> = ids
            .iter()
            .filter_map(|&id| {
                let idx = id as usize;
                if idx < self.vocab.len() {
                    Some(self.vocab[idx].clone())
                } else {
                    None
                }
            })
            .collect();

        let text = match &*DECODE_SPACE_RE {
            Ok(regex) => regex
                .replace_all(&tokens.join(""), |caps: &regex::Captures| {
                    if caps.get(1).is_some() {
                        " "
                    } else {
                        ""
                    }
                })
                .to_string(),
            Err(_) => tokens.join(""), // Fallback if regex failed to compile
        };
        let text = match &self.vocabulary_bias {
            Some(bias) => bias.correct_text(&text),
            None => text,
        };

        let float_timestamps: Vec<f32> = timestamps
            .iter()
            .map(|&t| WINDOW_SIZE * SUBSAMPLING_FACTOR as f32 * t as f32)
            .collect();

        TimestampedResult {
            text,
            timestamps: float_timestamps,
            tokens,
        }
    }

    pub fn transcribe_samples(
        &mut self,
        samples: Vec<f32>,
        vocabulary: Option<&str>,
    ) -> Result<TimestampedResult, ParakeetError> {
        self.configure_vocabulary(vocabulary);
        let batch_size = 1;
        let samples_len = samples.len();

        // Create waveforms array [batch_size, samples_len]
        let waveforms = Array2::from_shape_vec((batch_size, samples_len), samples)?.into_dyn();

        // Create waveforms_lens array [batch_size] with the actual length
        let waveforms_lens = Array1::from_vec(vec![samples_len as i64]).into_dyn();

        // Run recognition to get detailed results
        let results = self.recognize_batch(&waveforms.view(), &waveforms_lens.view())?;

        // Extract the first (and only) result
        let timestamped_result = results.into_iter().next().ok_or_else(|| {
            ParakeetError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "No transcription result returned",
            ))
        })?;

        Ok(timestamped_result)
    }
}

#[cfg(test)]
mod vocabulary_bias_tests {
    use super::*;

    fn vocab() -> Vec<String> {
        [
            "<unk>", " Meet", "M", "e", "et", "ily", " meeting", " other", "<blk>",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    #[test]
    fn compiles_boundary_and_utterance_start_paths() {
        let bias = VocabularyBias::compile("Meetily", &vocab());

        assert!(bias.phrases.contains(&BiasPhrase {
            tokens: vec![1, 5],
            start_only: false,
        }));
        assert!(bias.phrases.contains(&BiasPhrase {
            tokens: vec![2, 3, 4, 5],
            start_only: true,
        }));
    }

    #[test]
    fn boosts_phrase_start_and_completion() {
        let mut bias = VocabularyBias::compile("Meetily", &vocab());
        let mut logits = vec![-5.0; 9];
        logits[1] = -0.5;
        logits[7] = 0.6;

        assert_eq!(bias.select_token(&[], &logits, 8), 1);

        logits[1] = -5.0;
        logits[5] = -0.5;
        assert_eq!(bias.select_token(&[1], &logits, 8), 5);
    }

    #[test]
    fn does_not_restart_an_utterance_start_path_mid_word() {
        let mut bias = VocabularyBias {
            phrases: vec![BiasPhrase {
                tokens: vec![2, 3],
                start_only: true,
            }],
            terms: Vec::new(),
            scores: vec![0.0; 9],
            touched: Vec::new(),
        };
        let mut logits = vec![-5.0; 9];
        logits[2] = 0.0;
        logits[7] = 0.6;

        assert_eq!(bias.select_token(&[7], &logits, 8), 7);
        assert_eq!(bias.select_token(&[], &logits, 8), 2);
    }

    #[test]
    fn deduplicates_terms_and_ignores_unsafe_single_character_terms() {
        let bias = VocabularyBias::compile("Meetily, Meetily\nA", &vocab());

        assert_eq!(bias.terms.len(), 1);
        assert_eq!(bias.phrases.len(), 2);
    }

    #[test]
    fn canonicalizes_close_glossary_words() {
        let bias = VocabularyBias::compile("Christophe, Meetily, Tauri, ROCm", &vocab());

        assert_eq!(
            bias.correct_text("Christopher uses meetily with Tori and Rocum."),
            "Christophe uses Meetily with Tauri and ROCm."
        );
    }

    #[test]
    fn leaves_distant_or_differently_ended_words_unchanged() {
        let bias = VocabularyBias::compile("Meetily, Tauri", &vocab());

        assert_eq!(
            bias.correct_text("The meeting remains productive."),
            "The meeting remains productive."
        );
    }

    #[test]
    fn empty_glossary_preserves_raw_argmax() {
        let mut bias = VocabularyBias::compile("", &vocab());
        let logits = vec![0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 1.5, -1.0];

        assert_eq!(bias.select_token(&[], &logits, 8), 7);
    }
}
