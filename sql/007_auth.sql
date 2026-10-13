CREATE TABLE IF NOT EXISTS admin_users (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 singleton_key TINYINT UNSIGNED NOT NULL DEFAULT 1,
 username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
 password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 password_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 UNIQUE KEY uq_admin_singleton (singleton_key),
 UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash BINARY(32) PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL,
 csrf_token CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 remember BOOLEAN NOT NULL DEFAULT FALSE,
 ip_address VARCHAR(45),
 user_agent VARCHAR(512),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 expires_at DATETIME(3) NOT NULL,
 revoked_at DATETIME(3),
 KEY ix_auth_session_user (user_id,expires_at),
 KEY ix_auth_session_expiry (expires_at),
 FOREIGN KEY (user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_audit_logs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 user_id BIGINT UNSIGNED,
 username_attempt VARCHAR(64),
 event_type VARCHAR(32) NOT NULL,
 success BOOLEAN NOT NULL,
 ip_address VARCHAR(45),
 user_agent VARCHAR(512),
 details JSON,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 KEY ix_auth_audit_time (created_at),
 KEY ix_auth_audit_user (user_id,created_at),
 FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
