"""Read-only pre-deployment audit. Never print goal text, targets or credentials."""
import argparse
import io
import json
import sqlite3
from pathlib import Path

import zstandard


def audit(home):
    home = Path(home).resolve()
    headers, unreadable = {}, []
    for path in (home / 'sessions').glob('*/*/session.jsonl.zstd'):
        try:
            with path.open('rb') as source:
                with zstandard.ZstdDecompressor().stream_reader(source) as reader:
                    # Only the first header. Do not scan transcripts or request headers.
                    line = io.TextIOWrapper(reader).readline(65537)
                    if len(line) > 65536:
                        raise ValueError('header limit')
                    header = json.loads(line)
            if header.get('type') != 'session' or not isinstance(header.get('id'), str):
                raise ValueError('invalid header')
            headers[header['id']] = header.get('parentSession')
        except (OSError, ValueError, zstandard.ZstdError):
            unreadable.append(path.parent.name)
    sources = {}
    database = home / 'storages' / 'src-sessions.db'
    if database.exists():
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            sources['sqlite'] = [json.loads(row[0]) for row in db.execute('SELECT value FROM u_src_goals')]
    legacy = home / 'storages' / 'src.json'
    if legacy.exists():
        rows = json.loads(legacy.read_text())['tables']['goals']
        sources['legacyJson'] = list(rows.values()) if isinstance(rows, dict) else rows
    report = {'readOnly': True, 'headerCount': len(headers), 'unreadableHeaders': unreadable, 'sources': {}}
    for name, rows in sources.items():
        goals = {row['sessionId']: row for row in rows}
        ids = set(goals)
        delegated = []
        for session in sorted(ids & headers.keys()):
            parent = headers[session]
            if not parent:
                continue
            seen, ancestor, ancestor_goal, truncated = {session}, parent, None, False
            for _ in range(64):
                if ancestor in seen:
                    truncated = True
                    break
                seen.add(ancestor)
                if ancestor in ids:
                    ancestor_goal = ancestor
                    break
                if ancestor not in headers:
                    truncated = True
                    break
                ancestor = headers[ancestor]
                if not ancestor:
                    break
            else:
                truncated = True
            delegated.append({'sessionId': session, 'parentSession': parent,
                              'ancestorGoalSession': ancestor_goal, 'incompleteLineage': truncated,
                              'sameTargetAsAncestor': None if ancestor_goal is None else goals[session].get('target') == goals[ancestor_goal].get('target')})
        report['sources'][name] = {'goalCount': len(ids), 'delegatedGoals': delegated,
                                  'missingHeaders': sorted(ids - headers.keys())}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.home), ensure_ascii=False, indent=2))
