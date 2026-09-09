import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
assert.equal(process.platform, 'linux');
assert.equal(process.versions.node.split('.')[0], '22');
const directory = mkdtempSync(path.join(tmpdir(), 'gateway-linux-'));
try {
  const db = new Database(path.join(directory, 'test.db'));
  db.exec('CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES (\'linux\')');
  assert.equal(db.prepare('SELECT value FROM proof').get().value, 'linux'); db.close();
  const voice = path.join(directory, 'silence.ogg');
  const wav = path.join(directory, 'voice.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'libopus', voice]);
  execFileSync('ffmpeg', ['-v', 'error', '-i', voice, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  assert.ok(existsSync(wav));
  execFileSync(process.env.TELEGRAM_WHISPER_BIN, ['-m', process.env.TELEGRAM_WHISPER_MODEL, '-f', wav, '-np', '-nt'], {timeout: 60000, stdio: 'pipe'});
  console.log('Linux Node 22, SQLite, FFmpeg Opus conversion, and Whisper model execution passed.');
} finally { rmSync(directory, {recursive: true, force: true}); }
