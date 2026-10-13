ALTER TABLE xray_instances ADD COLUMN diagnostics JSON NULL;
ALTER TABLE xray_instances ADD COLUMN diagnosed_at DATETIME(3) NULL;
ALTER TABLE nodes ADD COLUMN diagnostics JSON NULL;
ALTER TABLE nodes ADD COLUMN observed_state VARCHAR(16) NOT NULL DEFAULT 'unknown';
ALTER TABLE nodes ADD COLUMN last_seen_at DATETIME(3) NULL;
ALTER TABLE credential_runtime ADD COLUMN traffic_available BOOLEAN NULL;
ALTER TABLE credential_runtime ADD COLUMN online_available BOOLEAN NULL;
