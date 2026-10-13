ALTER TABLE vps_servers ADD COLUMN bandwidth_provider VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT '套餐流量来源：manual 或 kiwivm';
ALTER TABLE vps_servers ADD COLUMN kiwivm_veid VARCHAR(32) NULL DEFAULT NULL COMMENT 'KiwiVM 单台 VPS 的 VEID，不包含 API Key';
ALTER TABLE vps_servers ADD COLUMN kiwivm_api_key_ref VARCHAR(255) NULL DEFAULT NULL COMMENT 'KiwiVM API Key 在本机受控目录中的相对引用';
ALTER TABLE vps_servers ADD COLUMN provider_usage_source VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT '当前服务商用量快照来源：manual 或 kiwivm';
ALTER TABLE vps_servers ADD COLUMN provider_sync_status VARCHAR(16) NOT NULL DEFAULT 'unconfigured' COMMENT 'KiwiVM 同步状态：unconfigured、syncing、ok、error';
ALTER TABLE vps_servers ADD COLUMN provider_synced_at DATETIME(3) NULL DEFAULT NULL COMMENT '最近一次 KiwiVM 成功同步时间（UTC）';
ALTER TABLE vps_servers ADD COLUMN provider_sync_error VARCHAR(512) NULL DEFAULT NULL COMMENT '最近一次 KiwiVM 同步错误摘要';
ALTER TABLE vps_servers ADD COLUMN provider_traffic_reset_at DATETIME(3) NULL DEFAULT NULL COMMENT 'KiwiVM 套餐流量下次重置时间（UTC）';
ALTER TABLE vps_servers ADD COLUMN provider_traffic_multiplier DECIMAL(10,4) NULL DEFAULT NULL COMMENT 'KiwiVM 返回的流量计费倍率';
