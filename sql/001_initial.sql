CREATE TABLE IF NOT EXISTS vps_servers (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(100) NOT NULL, ssh_host VARCHAR(255) NOT NULL,
 ssh_port SMALLINT UNSIGNED NOT NULL DEFAULT 22, ssh_user VARCHAR(64) NOT NULL,
 ssh_key_ref VARCHAR(512) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 UNIQUE KEY uq_ssh (ssh_host,ssh_port,ssh_user)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS xray_instances (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, server_id BIGINT UNSIGNED NOT NULL,
 service_name VARCHAR(128) NOT NULL, config_path VARCHAR(512) NOT NULL,
 binary_path VARCHAR(512) NOT NULL DEFAULT '/usr/local/bin/xray', api_address VARCHAR(255) NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE, allow_write BOOLEAN NOT NULL DEFAULT FALSE,
 version VARCHAR(255), service_state VARCHAR(32) NOT NULL DEFAULT 'unknown',
 api_state VARCHAR(32) NOT NULL DEFAULT 'unknown', epoch_id VARCHAR(128), service_started_at VARCHAR(100),
 last_success_at DATETIME(3), last_error VARCHAR(512), config_hash CHAR(64),
 UNIQUE KEY uq_service (server_id,service_name), FOREIGN KEY (server_id) REFERENCES vps_servers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS nodes (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, instance_id BIGINT UNSIGNED NOT NULL,
 name VARCHAR(100) NOT NULL, inbound_tag VARCHAR(128) NOT NULL,
 public_host VARCHAR(255) NOT NULL, port SMALLINT UNSIGNED NOT NULL,
 protocol VARCHAR(32) NOT NULL, transport VARCHAR(32) NOT NULL, security VARCHAR(32) NOT NULL,
 sni VARCHAR(255) NOT NULL DEFAULT '', public_key VARCHAR(255) NOT NULL DEFAULT '',
 short_id VARCHAR(32) NOT NULL DEFAULT '', fingerprint VARCHAR(32) NOT NULL DEFAULT 'chrome',
 UNIQUE KEY uq_inbound (instance_id,inbound_tag), UNIQUE KEY uq_node_instance (id,instance_id),
 FOREIGN KEY (instance_id) REFERENCES xray_instances(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS devices (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(30) NOT NULL,
 note VARCHAR(60) NOT NULL DEFAULT '', kind VARCHAR(32) NOT NULL DEFAULT 'desktop',
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 archived_at DATETIME(3), KEY ix_name(name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS device_credentials (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, device_id BIGINT UNSIGNED NOT NULL,
 node_id BIGINT UNSIGNED NOT NULL, instance_id BIGINT UNSIGNED NOT NULL,
 uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 xray_email VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin,
 flow VARCHAR(64) NOT NULL DEFAULT '', level INT UNSIGNED NOT NULL DEFAULT 0,
 desired_enabled BOOLEAN NOT NULL DEFAULT TRUE, applied_enabled BOOLEAN,
 sync_status VARCHAR(16) NOT NULL DEFAULT 'synced', revision INT UNSIGNED NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), archived_at DATETIME(3),
 UNIQUE KEY uq_uuid(uuid), UNIQUE KEY uq_device_node(device_id,node_id),
 UNIQUE KEY uq_email(instance_id,xray_email),
 FOREIGN KEY (device_id) REFERENCES devices(id),
 FOREIGN KEY (node_id,instance_id) REFERENCES nodes(id,instance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS collection_runs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, instance_id BIGINT UNSIGNED NOT NULL,
 started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), finished_at DATETIME(3),
 epoch_id VARCHAR(128), status VARCHAR(16) NOT NULL DEFAULT 'running', error_code VARCHAR(128),
 error_summary VARCHAR(512), KEY ix_run_time(started_at),
 FOREIGN KEY (instance_id) REFERENCES xray_instances(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credential_runtime (
 credential_id BIGINT UNSIGNED PRIMARY KEY, online_state VARCHAR(16) NOT NULL DEFAULT 'unknown',
 online_ip_count INT UNSIGNED, last_seen_at DATETIME(3), last_success_at DATETIME(3),
 last_run_id BIGINT UNSIGNED, epoch_id VARCHAR(128),
 last_uplink_bytes BIGINT UNSIGNED, last_downlink_bytes BIGINT UNSIGNED,
 total_uplink_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
 total_downlink_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
 tracking_started_at DATETIME(3), counter_sampled_at DATETIME(3),
 FOREIGN KEY (credential_id) REFERENCES device_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credential_ips (
 credential_id BIGINT UNSIGNED NOT NULL, ip VARBINARY(16) NOT NULL,
 first_seen_at DATETIME(3) NOT NULL, last_seen_at DATETIME(3) NOT NULL,
 last_observed_run_id BIGINT UNSIGNED NOT NULL, present_in_last_sample BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY(credential_id,ip), KEY ix_ip(ip,last_seen_at), KEY ix_ip_time(last_seen_at),
 FOREIGN KEY (credential_id) REFERENCES device_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS traffic_samples (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, run_id BIGINT UNSIGNED NOT NULL,
 credential_id BIGINT UNSIGNED NOT NULL, sampled_at DATETIME(3) NOT NULL,
 interval_start_at DATETIME(3) NOT NULL, raw_uplink_bytes BIGINT UNSIGNED NOT NULL,
 raw_downlink_bytes BIGINT UNSIGNED NOT NULL, delta_uplink_bytes BIGINT UNSIGNED NOT NULL,
 delta_downlink_bytes BIGINT UNSIGNED NOT NULL, quality VARCHAR(32) NOT NULL,
 UNIQUE KEY uq_sample(run_id,credential_id), KEY ix_credential_time(credential_id,sampled_at),
 KEY ix_sample_time(sampled_at), FOREIGN KEY (run_id) REFERENCES collection_runs(id),
 FOREIGN KEY (credential_id) REFERENCES device_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS traffic_daily (
 credential_id BIGINT UNSIGNED NOT NULL, stat_date DATE NOT NULL,
 uplink_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0, downlink_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
 sample_count INT UNSIGNED NOT NULL DEFAULT 0, estimated_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
 has_gap BOOLEAN NOT NULL DEFAULT FALSE,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(credential_id,stat_date), KEY ix_date(stat_date),
 FOREIGN KEY (credential_id) REFERENCES device_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS management_operations (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 instance_id BIGINT UNSIGNED, credential_id BIGINT UNSIGNED,
 action VARCHAR(32) NOT NULL, target_revision INT UNSIGNED NOT NULL DEFAULT 0,
 desired_enabled BOOLEAN, status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INT UNSIGNED NOT NULL DEFAULT 0,
 backup_path VARCHAR(512), changes JSON, error_summary VARCHAR(512),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), finished_at DATETIME(3),
 UNIQUE KEY uq_idempotency(idempotency_key), KEY ix_pending(status,created_at),
 FOREIGN KEY (instance_id) REFERENCES xray_instances(id),
 FOREIGN KEY (credential_id) REFERENCES device_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
