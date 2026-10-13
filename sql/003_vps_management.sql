ALTER TABLE vps_servers ADD COLUMN expires_on DATE NULL DEFAULT NULL COMMENT 'VPS 到期日期（按用户所在时区展示）';
ALTER TABLE vps_servers ADD COLUMN ssh_key_original_name VARCHAR(255) NULL DEFAULT NULL COMMENT '上传时的私钥文件名，仅用于审计展示';
ALTER TABLE vps_servers ADD COLUMN ssh_key_fingerprint VARCHAR(128) NULL DEFAULT NULL COMMENT 'SSH 私钥对应公钥的 SHA256 指纹';
ALTER TABLE vps_servers ADD COLUMN ssh_host_key TEXT NULL DEFAULT NULL COMMENT '已信任的 SSH 主机公钥记录';
ALTER TABLE vps_servers ADD COLUMN ssh_check_status VARCHAR(24) NOT NULL DEFAULT 'untested' COMMENT 'untested/checking/awaiting_trust/online/failed/host_key_changed';
ALTER TABLE vps_servers ADD COLUMN ssh_checked_at DATETIME(3) NULL DEFAULT NULL COMMENT '最近一次 SSH 检测时间（UTC）';
ALTER TABLE vps_servers ADD COLUMN ssh_check_error VARCHAR(512) NULL DEFAULT NULL COMMENT '最近一次 SSH 检测的安全错误摘要';
