-- Phase 3: diagnosis.
-- A dashboard "Re-diagnose" is an approvals row (action 'rediagnose', the owner's notes in
-- `reason`, `model` set for a deep re-diagnose). The worker picks up rows with no `handled_at`.
ALTER TABLE approvals
  ADD COLUMN model VARCHAR(64) NULL AFTER reason,
  ADD COLUMN handled_at DATETIME(3) NULL AFTER diagnosis_id,
  ADD KEY ix_approvals_pending (action, handled_at);

-- What each diagnosis cost, and why a failed one failed (scrubbed, shown on the dashboard).
ALTER TABLE diagnoses
  ADD COLUMN cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0 AFTER confidence,
  ADD COLUMN error VARCHAR(500) NULL AFTER owner_notes,
  ADD KEY ix_diagnoses_cache (incident_id, input_hash, model);
