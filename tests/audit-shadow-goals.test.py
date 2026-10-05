import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zstandard

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'scripts/egress-feasibility/audit-shadow-goals.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuditTests(unittest.TestCase):
    def test_readonly_shadow_missing_and_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'storages').mkdir()
            database = home / 'storages/src-sessions.db'
            rows = [{'sessionId': name, 'target': 'private.invalid', 'objective': 'DO_NOT_PRINT', 'authorization': 'SECRET'} for name in ['root', 'child', 'missing']]
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE u_src_goals (key TEXT, value TEXT)')
                db.executemany('INSERT INTO u_src_goals VALUES (?,?)', [(row['sessionId'], json.dumps(row)) for row in rows])
            before = database.read_bytes()
            for name, parent in [('root', None), ('child', 'root')]:
                path = home / 'sessions/work' / name / 'session.jsonl.zstd'
                path.parent.mkdir(parents=True)
                # Invalid transcript demonstrates the audit reads only the header.
                path.write_bytes(zstandard.ZstdCompressor().compress((json.dumps({'type': 'session', 'id': name, 'parentSession': parent}) + '\nNOT_JSON_SECRET\n').encode()))
            result = module.audit(home)
            self.assertEqual(database.read_bytes(), before)
            self.assertEqual(result['sources']['sqlite']['missingHeaders'], ['missing'])
            self.assertEqual(result['sources']['sqlite']['delegatedGoals'], [{'sessionId':'child','parentSession':'root','ancestorGoalSession':'root','incompleteLineage':False,'sameTargetAsAncestor':True}])
            for secret in ['private.invalid', 'DO_NOT_PRINT', 'SECRET']:
                self.assertNotIn(secret, json.dumps(result))

    def test_corrupt_header_does_not_become_clean_root(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sessions/work/bad/session.jsonl.zstd'
            path.parent.mkdir(parents=True)
            path.write_bytes(b'not zstd')
            result = module.audit(directory)
            self.assertEqual(result['unreadableHeaders'], ['bad'])
            self.assertEqual(result['headerCount'], 0)


if __name__ == '__main__':
    unittest.main()
