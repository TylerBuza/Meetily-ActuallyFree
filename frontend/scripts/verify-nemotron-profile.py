"""Assert actual kernel placement, not just provider availability/session creation."""
import argparse
from collections import Counter
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('profile', type=Path)
parser.add_argument('--provider', choices=['directml', 'cpu'], required=True)
args = parser.parse_args()
events = json.loads(args.profile.read_text(encoding='utf-8'))
kernels = [e['args'] for e in events if e.get('args', {}).get('provider')]
counts = Counter(e['provider'] for e in kernels)
assert kernels, 'No profiled execution nodes: inference was not verified'
if args.provider == 'directml':
    assert any(e['provider'] == 'DmlExecutionProvider' and e.get('op_name') == 'MatMul'
               for e in kernels), 'Nemotron attention/matrix work did not execute on DirectML'
else:
    assert set(counts) == {'CPUExecutionProvider'}, f'Expected CPU-only fallback, got {counts}'
print(json.dumps({'verified': args.provider, 'kernel_events': counts}, indent=2))
