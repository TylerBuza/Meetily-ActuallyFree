"""Compare retained mic/system timing locally. Requires ffmpeg on PATH and numpy."""
import argparse
from contextlib import contextmanager
from pathlib import Path
import subprocess

import numpy as np


@contextmanager
def decoded(path, rate):
    # ffmpeg streams one mono float per sample. Nothing is written to the meeting.
    p = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0",
         "-ar", str(rate), "-ac", "1", "-f", "f32le", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    try:
        def read(size):
            block = p.stdout.read(size)
            if len(block) < size and p.wait() != 0:
                raise RuntimeError(f"FFmpeg decoding failed for {path.name}")
            return block
        yield read
    finally:
        p.stdout.close()
        if p.poll() is None:
            p.terminate()
        p.wait()


def delay(mic, system, rate):
    """Positive lag means the same sound reaches mic later. Require a distinct peak."""
    n = min(len(mic), len(system))
    radius = rate // 2
    if n < 2 * radius + rate // 2:
        return None
    # Keep the same comparison length at every lag; center both signals and
    # normalize for gain differences. Squared prefix sums give each lag's norm.
    a = mic[:n].astype(np.float64)
    b = system[radius:n-radius].astype(np.float64)
    b -= b.mean()
    length = len(b)
    energy = np.dot(b, b)
    if not np.isfinite(energy) or energy < length * 1e-10:
        return None
    fft_size = 1 << (n + length - 2).bit_length()
    cross = np.fft.irfft(np.fft.rfft(a, fft_size) * np.fft.rfft(b[::-1], fft_size), fft_size)
    sums = np.r_[0., a.cumsum()]
    squares = np.r_[0., (a*a).cumsum()]
    variance = squares[length:] - squares[:-length] - (sums[length:] - sums[:-length])**2 / length
    scores = np.abs(cross[length-1:n]) / np.sqrt(energy * np.maximum(variance, length * 1e-10))
    i = int(scores.argmax())
    peak = scores[i]
    scores[max(0, i-rate//250):i+rate//250+1] = 0
    if not np.isfinite(peak) or peak < .45 or scores.max() > .9 * peak:
        return None
    return (i - radius) * 1000 / rate, peak


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Meeting folder containing mic.mp4 and system.mp4")
    args = parser.parse_args()
    rate = 8000
    paths = [args.folder / f"{track}.mp4" for track in ("mic", "system")]
    if not all(path.is_file() for path in paths):
        parser.error("Both mic.mp4 and system.mp4 are required")
    print("start_s,mic_lag_ms,correlation")
    with decoded(paths[0], rate) as mic, decoded(paths[1], rate) as system:
        start = 0
        while True:
            m, s = [np.frombuffer(read(2 * rate * 4), dtype="<f4") for read in (mic, system)]
            if not min(len(m), len(s)):
                break
            match = delay(m, s, rate)
            print(f"{start},{match[0]:.3f},{match[1]:.3f}" if match else f"{start},,")
            start += 2


if __name__ == "__main__":
    main()
