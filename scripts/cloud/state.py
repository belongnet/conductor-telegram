#!/usr/bin/env python3
"""Consistent SQLite/attachment backups and lossless, explicit-identity migration.

Never replaces an existing destination. Run final backup only after all old
consumers, watchdogs and updaters have been stopped and independently verified.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
from datetime import datetime, timezone

os.umask(0o077)


def connect(filename):
    return sqlite3.connect(Path(filename).resolve().as_uri() + '?mode=ro', uri=True)


def digest(filename):
    result = hashlib.sha256()
    with open(filename, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def value(item):
    return {'bytes': base64.b64encode(item).decode()} if isinstance(item, bytes) else item


def tables(db):
    result = {}
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        quoted = '"' + name.replace('"', '""') + '"'
        rows = sorted(json.dumps([value(v) for v in row], separators=(',', ':'), ensure_ascii=True)
                      for row in db.execute('SELECT * FROM ' + quoted))
        result[name] = {'rows': len(rows), 'sha256': hashlib.sha256('\n'.join(rows).encode()).hexdigest()}
    return result


def safe_copy_tree(source, destination):
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Attachment root must be a readable directory: ' + str(source))
    for filename in source.rglob('*'):
        target = destination / filename.relative_to(source)
        if filename.is_symlink():
            raise ValueError('Symlink in attachment snapshot: ' + str(filename))
        if filename.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif filename.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(filename, target)
        else:
            raise ValueError('Unsupported attachment entry: ' + str(filename))


def verify(snapshot):
    root = Path(snapshot).resolve()
    report = json.loads((root / 'manifest.json').read_text())
    for relative, expected in report['files'].items():
        filename = (root / relative).resolve()
        if root not in filename.parents or filename.is_symlink() or digest(filename) != expected:
            raise ValueError('Backup checksum mismatch: ' + relative)
    with connect(root / 'conductor-telegram.db') as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or tables(db) != report['tables']:
            raise ValueError('Backup database verification failed')
    db.close()
    return report


def backup(args):
    root = Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    with connect(args.db) as source, sqlite3.connect(root / 'conductor-telegram.db') as target:
        source.backup(target)
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database integrity check failed')
        fingerprints = tables(target)
        target.execute('PRAGMA journal_mode=DELETE')
    target.close()
    source.close()
    # A copied WAL-mode header can leave a disposable shared-memory sidecar.
    # The standalone backup is now DELETE mode; never ship these lock bytes.
    (root / 'conductor-telegram.db-shm').unlink(missing_ok=True)
    wal = root / 'conductor-telegram.db-wal'
    if wal.exists() and wal.stat().st_size:
        raise ValueError('Backup unexpectedly retains an uncheckpointed WAL')
    wal.unlink(missing_ok=True)
    attachments = {}
    for directory in args.files:
        name = Path(directory).name
        if name in attachments or name in ['manifest.json', 'conductor-telegram.db']:
            raise ValueError('Attachment roots must have unique names')
        safe_copy_tree(directory, root / name)
        attachments[name] = str(Path(directory).resolve())
    report = {'format': 1, 'at': datetime.now(timezone.utc).isoformat(), 'tables': fingerprints,
              'sourceDatabase': str(Path(args.db).resolve()), 'attachmentRoots': attachments,
              'files': {str(p.relative_to(root)): digest(p) for p in root.rglob('*') if p.is_file()}}
    (root / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    verify(root)
    print(json.dumps({'snapshot': str(root), 'tables': {k: v['rows'] for k, v in fingerprints.items()},
                      'files': len(report['files']), 'verified': True}))


def canonical(remote):
    match = re.fullmatch(r'(?:https://|ssh://git@|git@)github\.com[/:]([^/\s]+/[^/\s]+?)(?:\.git)?/?', remote or '', re.I)
    return 'github.com/' + match[1].lower() if match else None


def migrate(args):
    source = Path(args.snapshot).resolve()
    manifest = verify(source)
    target = Path(args.out).resolve()
    target.mkdir(parents=True, exist_ok=False)
    for entry in source.iterdir():
        if entry.is_dir():
            safe_copy_tree(entry, target / entry.name)
        elif entry.name != 'manifest.json':
            shutil.copyfile(entry, target / entry.name)
    identities = json.loads(Path(args.identities).read_text()) if args.identities else {'projects': [], 'repositories': []}
    remotes = {r['path']: canonical(r['remote']) for r in identities['repositories'] if r.get('verifiedBy') == 'git-remote'}
    mappings, unresolved = [], []
    with sqlite3.connect(target / 'conductor-telegram.db') as db:
        before = tables(db)
        db.execute('CREATE TABLE IF NOT EXISTS gateway_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        put = lambda key, val: db.execute('INSERT INTO gateway_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(val)))
        # Historical event delivery was acknowledged by the old bot. Reconcile
        # unanswered questions separately rather than replaying the entire history.
        if 'gateway_state' not in before:
            put('event-cursor', db.execute('SELECT coalesce(max(id),0) FROM events').fetchone()[0])
        for chat, repo, thread in db.execute('SELECT chat_id,repo_path,telegram_thread_id FROM repo_topics'):
            remote = remotes.get(repo)
            matches = [p for p in identities['projects'] if remote and canonical(p['gitRemote']) == remote]
            if len(matches) == 1:
                put('repo-topic-project:' + str(chat) + ':' + str(thread), matches[0]['id'])
                mappings.append({'chatId': chat, 'threadId': thread, 'projectId': matches[0]['id'], 'repository': remote})
            else:
                unresolved.append({'chatId': chat, 'threadId': thread, 'reason': 'No unique verified canonical project match'})
        # Existing native file references point to the same transferred bytes at
        # the container's stable mount. Other historical tables are untouched.
        file_relocations = []
        if 'gateway_files' in before:
            for file_id, filename in db.execute('SELECT id,path FROM gateway_files').fetchall():
                candidates = [target / name / file_id for name in manifest['attachmentRoots'] if Path(filename).parent == Path(manifest['attachmentRoots'][name])]
                if len(candidates) != 1 or not candidates[0].is_file():
                    raise ValueError('Missing native attachment bytes: ' + file_id)
                relocated = str(Path(args.runtime_root) / candidates[0].relative_to(target))
                db.execute('UPDATE gateway_files SET path=? WHERE id=?', (relocated, file_id))
                file_relocations.append(file_id)
        db.commit()
        after = tables(db)
        changed = [name for name in before if before[name] != after[name] and name not in ['gateway_state', 'gateway_files']]
        if changed:
            raise ValueError('Migration changed historical data: ' + ','.join(changed))
        cloud_without_binding = []
        for tracked_id, backend in db.execute('SELECT id,conductor_backend_kind FROM workspaces'):
            if backend == 'cloud-api' and ('gateway_bindings' not in after or not db.execute('SELECT 1 FROM gateway_bindings WHERE workspace_id=?', (tracked_id,)).fetchone()):
                cloud_without_binding.append(tracked_id)
        unresolved_operations = []
        for key, raw in db.execute("SELECT key,value FROM meta WHERE key LIKE 'pending-cloud-launch:%'"):
            if json.loads(raw or 'null'):
                unresolved_operations.append(key)
        report = {'format': 1, 'source': manifest['sourceDatabase'], 'at': datetime.now(timezone.utc).isoformat(),
                  'preservedTables': {name: before[name] for name in before if name not in ['gateway_state', 'gateway_files']},
                  'mappedTopics': mappings, 'unresolvedTopics': unresolved, 'relocatedFiles': file_relocations,
                  'unresolvedCloudBindings': cloud_without_binding, 'historicalRowsRetained': True,
                  'unresolvedCreationIntents': unresolved_operations,
                  'cutoverReady': not unresolved and not cloud_without_binding and not unresolved_operations,
                  'note': 'Run preflight and complete the live acceptance gates. This report does not authorize concurrent consumers.'}
        (target / 'migration-report.json').write_text(json.dumps(report, indent=2) + '\n')
    db.close()
    print(json.dumps({'report': str(target / 'migration-report.json'), 'cutoverReady': report['cutoverReady'],
                      'workspaces': before['workspaces']['rows'], 'repoTopics': before['repo_topics']['rows'], 'unresolvedTopics': len(unresolved)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    snap = commands.add_parser('backup'); snap.add_argument('--db', required=True); snap.add_argument('--out', required=True)
    snap.add_argument('--files', action='append', default=[])
    check = commands.add_parser('verify'); check.add_argument('snapshot')
    migration = commands.add_parser('migrate'); migration.add_argument('--snapshot', required=True); migration.add_argument('--out', required=True)
    migration.add_argument('--identities'); migration.add_argument('--runtime-root', default='/var/lib/conductor-telegram')
    args = parser.parse_args()
    if args.command == 'backup': backup(args)
    elif args.command == 'verify': verify(args.snapshot); print('Backup verified')
    else: migrate(args)


if __name__ == '__main__':
    main()
