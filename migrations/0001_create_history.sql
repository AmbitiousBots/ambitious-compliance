CREATE TABLE history (
  seq INTEGER PRIMARY KEY CHECK (seq > 0),
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  entity TEXT NOT NULL CHECK (entity IN ('program', 'control', 'evidence', 'attestation', 'document')),
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create', 'update', 'retire')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
) STRICT;

CREATE TRIGGER history_no_update BEFORE UPDATE ON history BEGIN
  SELECT RAISE(ABORT, 'History cannot be updated. Append a new change.');
END;

CREATE TRIGGER history_no_delete BEFORE DELETE ON history BEGIN
  SELECT RAISE(ABORT, 'History cannot be deleted.');
END;

CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  framework TEXT NOT NULL
) STRICT;

CREATE TABLE controls (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id),
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  cadence_days INTEGER NOT NULL CHECK (cadence_days > 0)
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  control_id TEXT NOT NULL REFERENCES controls(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  page_id TEXT,
  page_version INTEGER,
  page_sha256 TEXT,
  collected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > collected_at),
  CHECK (
    (page_id IS NULL AND page_version IS NULL AND page_sha256 IS NULL) OR
    (page_id IS NOT NULL AND page_version IS NOT NULL AND page_version > 0 AND page_sha256 IS NOT NULL AND length(page_sha256) = 64)
  )
) STRICT;

CREATE TABLE attestations (
  id TEXT PRIMARY KEY,
  control_id TEXT NOT NULL REFERENCES controls(id),
  "by" TEXT NOT NULL,
  statement TEXT NOT NULL,
  at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > at)
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id),
  title TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_version INTEGER NOT NULL CHECK (page_version > 0),
  page_sha256 TEXT NOT NULL CHECK (length(page_sha256) = 64)
) STRICT;

CREATE INDEX controls_by_program ON controls(program_id, id);
CREATE INDEX evidence_by_control ON evidence(control_id, id);
CREATE INDEX attestations_by_control ON attestations(control_id, id);
CREATE INDEX documents_by_program ON documents(program_id, id);
CREATE INDEX history_by_entity ON history(entity, entity_id, seq);
