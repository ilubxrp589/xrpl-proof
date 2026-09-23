# Render the Proof page's tour narration with Kokoro-82M (Apache-2.0), on CPU.
# usage: python gen.py <voice> [id,id,...] [--speed 0.96]
import sys, json, os, time
import numpy as np, soundfile as sf
from kokoro import KPipeline

args = [a for a in sys.argv[1:] if not a.startswith('--')]
speed = float(next((a.split('=')[1] for a in sys.argv if a.startswith('--speed=')), 0.96))
voice = args[0]
scripts = json.load(open('scripts.json'))
ids = args[1].split(',') if len(args) > 1 else list(scripts)
pipe = KPipeline(lang_code=voice[0], repo_id='hexgrad/Kokoro-82M')
os.makedirs(f'out/{voice}', exist_ok=True)
gap = np.zeros(int(24000 * 0.28), dtype=np.float32)
for sid in ids:
    t0 = time.time(); parts = []
    for gs, ps, audio in pipe(scripts[sid], voice=voice, speed=speed):
        if os.environ.get('PHONEMES'): print(f'  {sid}: {ps}')
        parts += [audio.numpy() if hasattr(audio, 'numpy') else np.asarray(audio), gap]
    a = np.concatenate(parts[:-1]).astype(np.float32)
    a = a / max(1e-6, np.abs(a).max()) * 0.89          # even loudness from stop to stop
    sf.write(f'out/{voice}/{sid}.mp3', a, 24000, format='MP3')
    print(f'{voice} {sid}: {len(a) / 24000:.1f}s audio in {time.time() - t0:.1f}s', flush=True)
