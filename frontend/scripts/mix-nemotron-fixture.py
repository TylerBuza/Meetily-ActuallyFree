"""Mix Windows TTS voices into a labeled return/overlap integration fixture."""
import array
import json
from pathlib import Path
import sys
import wave

root = Path(sys.argv[1])


def read(name):
    with wave.open(str(root / (name + '.wav')), 'rb') as wav:
        assert wav.getparams()[:3] == (1, 2, 16000)
        return array.array('h', wav.readframes(wav.getnframes()))


david, zira = read('David'), read('Zira')
samples = array.array('h')
expected = []


def add(voice, audio):
    start = len(samples) / 16000
    samples.extend(audio)
    expected.append({'voice': voice, 'start': start, 'end': len(samples) / 16000})
    samples.extend([0] * 16000)


add('David', david)
for _ in range(3):
    add('Zira', zira)
add('David', david)
both = array.array('h', (
    int((david[i] if i < len(david) else 0) * 0.5
        + (zira[i] if i < len(zira) else 0) * 0.5)
    for i in range(max(len(david), len(zira)))
))
add('overlap', both)
with wave.open(str(root / 'conversation.wav'), 'wb') as wav:
    wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
    wav.writeframes(samples.tobytes())
(root / 'expected.json').write_text(json.dumps(expected, indent=2), encoding='utf-8')
print(f'Synthetic two-voice fixture: {len(samples) / 16000} seconds; {root}')
