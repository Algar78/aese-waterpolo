"""Offline publication gate regressions, including stale successful metadata."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('gate', Path('scripts/validate_actawp_export.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class PublicationGateTests(unittest.TestCase):
    def test_gate_accepts_only_current_complete_validated_export_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            names = ['actawp_matches.json', 'actawp_export_status.json', 'actawp_last_attempt.json']
            for name in names[:2]:
                (data / name).write_bytes((Path('data') / name).read_bytes())
            # The current attempt must equal the validated successful status.
            status = json.loads((data / names[1]).read_text(encoding='utf-8'))
            (data / names[2]).write_text(json.dumps(status), encoding='utf-8')
            baseline = {name: (data / name).read_bytes() for name in names}
            gate.validate(root, 'true')
            for outcome in ('false', '', 'TRUE'):
                with self.subTest(outcome=outcome), self.assertRaises(ValueError):
                    gate.validate(root, outcome)
            self.assertEqual(baseline, {name: (data / name).read_bytes() for name in names})
            for mutation in ('incomplete', 'errors', 'mismatch', 'hash', 'counts', 'missing'):
                for name, raw in baseline.items():
                    (data / name).write_bytes(raw)
                changed = copy.deepcopy(status)
                if mutation == 'incomplete': changed['complete'] = False
                if mutation == 'errors': changed['errors'] = ['HTTP 429']
                if mutation == 'hash': changed['snapshot_sha256'] = 'invalid'
                if mutation == 'counts': changed['total_matches_found'] += 1
                if mutation == 'mismatch': changed['attempted_at'] = 'stale'
                (data / names[2]).write_text(json.dumps(changed), encoding='utf-8')
                if mutation != 'mismatch':
                    (data / names[1]).write_text(json.dumps(changed), encoding='utf-8')
                if mutation == 'missing': (data / names[2]).unlink()
                with self.subTest(mutation=mutation), self.assertRaises((ValueError, FileNotFoundError)):
                    gate.validate(root, 'true')

    def test_workflow_validates_before_any_commit_and_alerts_on_failure(self):
        workflow = Path('.github/workflows/actawp-export.yml').read_text(encoding='utf-8')
        gate_step = workflow.index('- name: Confirm complete export')
        publish = workflow.index('- name: Publish JSON snapshot')
        self.assertLess(gate_step, publish)
        self.assertLess(publish, workflow.index('git add -A data/'))
        self.assertIn("run: python scripts/validate_actawp_export.py '${{ steps.fetch.outputs.complete }}'", workflow)
        self.assertIn("if: steps.fetch.outputs.complete == 'true'", workflow[publish:])
        self.assertNotIn('continue-on-error', workflow)
        self.assertIn('::error::', Path('scripts/validate_actawp_export.py').read_text(encoding='utf-8'))
