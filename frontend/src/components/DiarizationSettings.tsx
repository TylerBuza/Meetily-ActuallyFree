"use client"

import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Users, CheckCircle2, AlertCircle, FolderOpen } from "lucide-react"

/**
 * Speaker diarization status panel. Diarization ("who spoke when") runs fully
 * on-device from local ONNX models; this shows whether they're installed and
 * where to put them.
 */
export function DiarizationSettings() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [dir, setDir] = useState<string>('');

  useEffect(() => {
    invoke<boolean>('diarization_models_available').then(setAvailable).catch(() => setAvailable(false));
    invoke<string>('diarization_model_directory').then(setDir).catch(() => {});
  }, []);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-500" />
            Speaker Identification
          </h3>
          <p className="text-sm text-gray-600">
            Labels your transcript with <strong>Speaker 1/2/3…</strong> by analyzing voices in the
            recording. Runs entirely on-device. Open a meeting and click{' '}
            <strong>Speakers</strong> above the transcript to run it.
          </p>
        </div>
        {available !== null && (
          <span
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
              available ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
            }`}
          >
            {available ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {available ? 'Models installed' : 'Models missing'}
          </span>
        )}
      </div>

      {available === false && (
        <div className="mt-4 rounded-md bg-amber-50 p-3">
          <p className="text-xs text-amber-800">
            To enable speaker identification, place these files in the folder below:
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs text-amber-800 space-y-0.5">
            <li><code>segmentation-3.0-fp16.onnx</code> — pyannote speech segmentation</li>
            <li><code>wespeaker-resnet34-LM.onnx</code> — WeSpeaker speaker embeddings</li>
            <li><code>xvec_transform.npz</code> — x-vector LDA transform</li>
          </ul>
        </div>
      )}

      {dir && (
        <div className="mt-4 p-3 border rounded-lg bg-gray-50">
          <div className="text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" />
            Model folder
          </div>
          <div className="text-xs text-gray-600 break-all font-mono">{dir}</div>
        </div>
      )}
    </div>
  );
}
