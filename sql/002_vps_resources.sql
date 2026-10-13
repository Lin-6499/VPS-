ALTER TABLE vps_servers ADD COLUMN memory_gb DECIMAL(10,2) NULL DEFAULT NULL COMMENT '内存容量，GB，NULL 表示未填写' CHECK (memory_gb >= 0);
ALTER TABLE vps_servers ADD COLUMN system_disk_gb DECIMAL(10,2) NULL DEFAULT NULL COMMENT '系统盘容量，GB，NULL 表示未填写' CHECK (system_disk_gb >= 0);
ALTER TABLE vps_servers ADD COLUMN traffic_quota_gb DECIMAL(14,2) NULL DEFAULT NULL COMMENT '套餐流量额度，GB，不是已用流量，NULL 表示未填写' CHECK (traffic_quota_gb >= 0);
ALTER TABLE vps_servers ADD COLUMN official_url VARCHAR(2048) NULL DEFAULT NULL COMMENT 'VPS 服务商官方链接，NULL 表示未填写';
