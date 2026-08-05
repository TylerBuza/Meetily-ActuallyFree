/**
 * Lightweight local RAG (retrieval-augmented generation) over past meetings.
 *
 * Optional feature: when enabled, the user picks which past meetings to consider. We
 * load those transcripts, chunk them, embed chunks + the question via a local Ollama
 * embedding model (`ollama_embed` Tauri command), rank by cosine similarity, and return
 * the top passages to prepend as context. Everything runs locally.
 *
 * Requires Ollama running with an embedding model, e.g.:  `ollama pull nomic-embed-text`
 */

import { invoke } from '@tauri-apps/api/core';

const CHUNK_CHARS = 480;
const MAX_CHUNKS_PER_MEETING = 60;
const MAX_TOTAL_CHUNKS = 150;

interface Chunk {
  text: string;
  meetingTitle: string;
}

function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  // Split on sentence-ish boundaries, then pack up to `size`
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length > size) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = s;
    } else {
      cur = (cur + ' ' + s).trim();
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function loadMeetingText(meetingId: string): Promise<string> {
  try {
    const first = await invoke<{ transcripts: any[]; total_count: number }>('api_get_meeting_transcripts', {
      meetingId, limit: 1, offset: 0,
    });
    const total = first?.total_count ?? 0;
    if (!total) return '';
    const all = await invoke<{ transcripts: any[] }>('api_get_meeting_transcripts', {
      meetingId, limit: total, offset: 0,
    });
    return (all?.transcripts ?? []).map((t) => t?.text ?? '').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

export interface RagOptions {
  topK?: number;
  embedModel?: string;
  ollamaEndpoint?: string | null;
}

export interface RagResult {
  context: string;
  usedChunks: number;
}

/**
 * Retrieve the most relevant passages from the selected past meetings for a question.
 * Returns a formatted context string (empty if nothing relevant / no embeddings).
 */
export async function retrieveContext(
  meetings: Array<{ id: string; title: string }>,
  question: string,
  opts: RagOptions = {},
): Promise<RagResult> {
  const topK = opts.topK ?? 6;
  if (!meetings.length || !question.trim()) return { context: '', usedChunks: 0 };

  // Build chunk list across selected meetings
  const chunks: Chunk[] = [];
  for (const m of meetings) {
    const text = await loadMeetingText(m.id);
    const pieces = chunkText(text).slice(0, MAX_CHUNKS_PER_MEETING);
    for (const p of pieces) chunks.push({ text: p, meetingTitle: m.title || 'Untitled meeting' });
    if (chunks.length >= MAX_TOTAL_CHUNKS) break;
  }
  if (chunks.length === 0) return { context: '', usedChunks: 0 };

  const capped = chunks.slice(0, MAX_TOTAL_CHUNKS);

  // Embed question + all chunks (question first)
  const inputs = [question, ...capped.map((c) => c.text)];
  const vectors = await invoke<number[][]>('ollama_embed', {
    texts: inputs,
    model: opts.embedModel ?? null,
    endpoint: opts.ollamaEndpoint ?? null,
  });
  if (!vectors?.length) return { context: '', usedChunks: 0 };

  const qVec = vectors[0];
  const scored = capped.map((c, i) => ({ chunk: c, score: cosine(qVec, vectors[i + 1]) }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.filter((s) => s.score > 0).slice(0, topK);
  if (!top.length) return { context: '', usedChunks: 0 };

  const context =
    'Relevant excerpts from past meetings:\n\n' +
    top.map((s, i) => `[${i + 1}] (${s.chunk.meetingTitle}) ${s.chunk.text}`).join('\n\n');

  return { context, usedChunks: top.length };
}
