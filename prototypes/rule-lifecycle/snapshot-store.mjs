import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openSync, closeSync, statSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class StorageError extends Error {
  constructor(code, cause) { super(code, { cause }); this.name = 'StorageError'; this.code = code; }
}

const digest = payload => createHash('sha256').update(payload).digest('hex');

/** One local SQLite snapshot, one exclusive owner for the connection lifetime. */
export class SnapshotStore {
  #db;
  #path;
  #identity;
  #failed = false;

  constructor(path, { initialize = false, initialState } = {}) {
    if (typeof path !== 'string' || !path) throw new StorageError('INVALID_STORAGE_PATH');
    this.#path = resolve(path);
    try {
      // Creation is a separate explicit action. Never CREATE an absent history on open.
      if (initialize) {
        const fd = openSync(this.#path, 'wx', 0o600);
        closeSync(fd);
      }
      const stat = statSync(this.#path);
      if (!stat.isFile()) throw new Error('Storage must be a regular file');
      this.#identity = { ino: stat.ino, dev: stat.dev };
      this.#db = new DatabaseSync(this.#path);
      this.#db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      if (initialize) {
        this.#db.exec('CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, sha256 TEXT NOT NULL) STRICT;');
        const payload = JSON.stringify(initialState);
        this.#db.prepare('INSERT INTO snapshot VALUES (1, ?, ?)').run(payload, digest(payload));
        // Also persist the explicitly created database filename on supported local filesystems.
        const directory = openSync(dirname(this.#path), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      const checks = this.#db.prepare('PRAGMA integrity_check').all();
      if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
      this.load();
    } catch (cause) {
      try { this.#db?.close(); } catch { /* original error takes priority */ }
      this.#db = undefined;
      const code = cause instanceof StorageError ? cause.code
        : initialize && cause.code === 'EEXIST' ? 'STORAGE_ALREADY_EXISTS'
        : cause.errcode === 5 || cause.errcode === 6 ? 'STORAGE_BUSY' : 'STORAGE_UNAVAILABLE';
      throw new StorageError(code, cause);
    }
  }

  assertAvailable() {
    try {
      if (this.#failed || !this.#db) throw new Error('Storage closed or failed');
      const stat = statSync(this.#path);
      if (stat.ino !== this.#identity.ino || stat.dev !== this.#identity.dev || !stat.isFile()) {
        throw new Error('Storage file was replaced');
      }
    } catch (cause) {
      this.#failed = true;
      throw new StorageError('STORAGE_UNAVAILABLE', cause);
    }
  }

  load() {
    this.assertAvailable();
    try {
      const rows = this.#db.prepare('SELECT id, payload, sha256 FROM snapshot').all();
      if (rows.length !== 1 || rows[0].id !== 1 || digest(rows[0].payload) !== rows[0].sha256) {
        throw new Error('Missing snapshot or checksum mismatch');
      }
      return JSON.parse(rows[0].payload);
    } catch (cause) {
      this.#failed = true;
      throw new StorageError('STORAGE_INVALID', cause);
    }
  }

  save(state, { beforeCommit = () => {} } = {}) {
    this.assertAvailable();
    try {
      const payload = JSON.stringify(state);
      this.#db.exec('BEGIN EXCLUSIVE;');
      const result = this.#db.prepare('UPDATE snapshot SET payload=?, sha256=? WHERE id=1').run(payload, digest(payload));
      if (result.changes !== 1) throw new Error('Snapshot row missing');
      beforeCommit(); // Synchronous local fault-injection seam; no default side effects.
      this.#db.exec('COMMIT;');
    } catch (cause) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* may already be rolled back */ }
      this.#failed = true;
      throw new StorageError('STORAGE_UNAVAILABLE', cause);
    }
  }

  close() { this.#db?.close(); this.#db = undefined; }
}
