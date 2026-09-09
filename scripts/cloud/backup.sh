#!/usr/bin/env bash
set -euo pipefail
umask 077
state=/var/lib/conductor-telegram
snapshot="$state/backups/backup-$(date -u +%Y%m%dT%H%M%SZ)"
args=(backup --db "$state/conductor-telegram.db" --out "$snapshot")
for name in attachments downloads; do
  if [ -d "$state/$name" ]; then args+=(--files "$state/$name"); fi
done
python3 /opt/conductor-telegram/scripts/cloud/state.py "${args[@]}"
# Only delete our own older, verified backup directories after the new backup passes.
python3 - "$state/backups" <<'PY'
import sys, re, shutil, json
from pathlib import Path
root=Path(sys.argv[1])
backups=sorted((p for p in root.iterdir() if re.fullmatch(r'backup-\d{8}T\d{6}Z',p.name) and p.is_dir() and not p.is_symlink()), reverse=True)
for old in backups[7:]:
    manifest=old/'manifest.json'
    if manifest.is_file() and json.loads(manifest.read_text()).get('format')==1:
        shutil.rmtree(old)
PY
