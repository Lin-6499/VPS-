ALTER TABLE vps_servers ADD COLUMN provider_traffic_used_gb DECIMAL(14,2) NULL DEFAULT NULL COMMENT '服务商套餐已用流量手动快照，GB，不与 Xray 记录流量相加' CHECK (provider_traffic_used_gb >= 0);
ALTER TABLE vps_servers ADD COLUMN provider_traffic_recorded_at DATETIME(3) NULL DEFAULT NULL COMMENT '服务商用量快照录入时间，UTC，不代表自动采集时间';
