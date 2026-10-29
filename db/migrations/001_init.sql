-- Watchtower schema (architecture §3). Times are UTC DATETIME(3). Applied once by lib/db-migrate.ts.
-- Never edit this file after it has been applied: add 002_*.sql instead.

CREATE TABLE incidents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL,
  title VARCHAR(300) NOT NULL,
  kind ENUM('error','health','db','slow_query') NOT NULL,
  severity ENUM('critical','high','medium','low') NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  first_seen DATETIME(3) NOT NULL,
  last_seen DATETIME(3) NOT NULL,
  event_count INT UNSIGNED NOT NULL DEFAULT 0,
  route VARCHAR(200) NULL,
  regression_of INT UNSIGNED NULL,
  deploy_id_at_open VARCHAR(64) NULL,
  seeded TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  open_fingerprint CHAR(64) GENERATED ALWAYS AS (IF(status IN ('verified','dismissed','rolled_back'), NULL, fingerprint)) STORED,
  UNIQUE KEY uq_incidents_open_fingerprint (open_fingerprint),
  KEY ix_incidents_fingerprint (fingerprint),
  KEY ix_incidents_status_last_seen (status, last_seen),
  CONSTRAINT ck_incidents_status CHECK (status IN ('new','diagnosed','fix_approved','pr_open','ci_passed','merged','deployed','verified','regression','rolled_back','failed','dismissed')),
  CONSTRAINT fk_incidents_regression_of FOREIGN KEY (regression_of) REFERENCES incidents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE raw_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source ENUM('render_log','health','sentry','deploy') NOT NULL,
  external_id VARCHAR(191) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  level ENUM('info','warn','error') NOT NULL,
  kind ENUM('error','health','db','slow_query') NULL,
  title VARCHAR(300) NOT NULL,
  message_scrubbed VARCHAR(2000) NOT NULL,
  stack_scrubbed TEXT NULL,
  route VARCHAR(200) NULL,
  event_count INT UNSIGNED NOT NULL DEFAULT 1,
  fingerprint CHAR(64) NULL,
  incident_id INT UNSIGNED NULL,
  seeded TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_raw_events_source_external (source, external_id),
  KEY ix_raw_events_fingerprint_time (fingerprint, occurred_at),
  KEY ix_raw_events_time (occurred_at),
  KEY ix_raw_events_incident_time (incident_id, occurred_at),
  CONSTRAINT fk_raw_events_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE diagnoses (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  model VARCHAR(64) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  status ENUM('ok','failed') NOT NULL,
  result_json JSON NULL,
  confidence DECIMAL(4,3) NULL,
  owner_notes TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_diagnoses_incident (incident_id, created_at),
  KEY ix_diagnoses_input (input_hash),
  CONSTRAINT fk_diagnoses_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE approvals (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  action ENUM('approve_fix','dismiss','rediagnose','recommend_rollback') NOT NULL,
  actor VARCHAR(64) NOT NULL,
  reason VARCHAR(1000) NULL,
  diagnosis_id INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_approvals_incident (incident_id, created_at),
  CONSTRAINT fk_approvals_incident FOREIGN KEY (incident_id) REFERENCES incidents (id),
  CONSTRAINT fk_approvals_diagnosis FOREIGN KEY (diagnosis_id) REFERENCES diagnoses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A dispatch_fix action can only exist with the approval that unlocked it (guardrail 8).
CREATE TABLE actions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NULL,
  approval_id INT UNSIGNED NULL,
  type ENUM('dispatch_fix','run_worker','rediagnose') NOT NULL,
  request_ref VARCHAR(191) NULL,
  status ENUM('requested','running','succeeded','failed') NOT NULL DEFAULT 'requested',
  error VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_actions_approval (approval_id),
  KEY ix_actions_incident (incident_id, created_at),
  CONSTRAINT ck_actions_dispatch_needs_approval CHECK (type <> 'dispatch_fix' OR approval_id IS NOT NULL),
  CONSTRAINT fk_actions_incident FOREIGN KEY (incident_id) REFERENCES incidents (id),
  CONSTRAINT fk_actions_approval FOREIGN KEY (approval_id) REFERENCES approvals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only. No foreign key on incident_id so the trail survives any cleanup.
CREATE TABLE audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor ENUM('worker','admin','system') NOT NULL,
  action VARCHAR(64) NOT NULL,
  incident_id INT UNSIGNED NULL,
  detail_json JSON NULL,
  outcome ENUM('ok','error','skipped','denied') NOT NULL,
  KEY ix_audit_at (at),
  KEY ix_audit_incident (incident_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE settings (
  name VARCHAR(64) NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE api_usage (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  incident_id INT UNSIGNED NULL,
  model VARCHAR(64) NOT NULL,
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cache_read_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cache_write_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0,
  KEY ix_api_usage_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admin_sessions (
  id_hash CHAR(64) NOT NULL PRIMARY KEY,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_admin_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
