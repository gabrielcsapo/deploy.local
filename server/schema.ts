import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  username: text('username').primaryKey(),
  password: text('password').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    token: text('token').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    usernameIdx: index('idx_sessions_username').on(table.username),
    tokenIdx: index('idx_sessions_token').on(table.token),
  }),
);

export const deployments = sqliteTable(
  'deployments',
  {
    name: text('name').primaryKey(),
    type: text('type'),
    username: text('username').notNull(),
    port: integer('port'),
    containerId: text('container_id'),
    containerName: text('container_name'),
    directory: text('directory'),
    status: text('status').default('stopped'),
    currentBuildLogId: integer('current_build_log_id'),
    extraPorts: text('extra_ports'),
    envVars: text('env_vars'),
    memoryLimit: text('memory_limit'),
    volumes: text('volumes'),
    gpuEnabled: integer('gpu_enabled', { mode: 'boolean' }).default(false),
    autoBackup: integer('auto_backup', { mode: 'boolean' }).default(false),
    discoverable: integer('discoverable', { mode: 'boolean' }).default(false),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (table) => ({
    usernameIdx: index('idx_deployments_username').on(table.username),
  }),
);

export const history = sqliteTable(
  'history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    action: text('action').notNull(),
    username: text('username'),
    type: text('type'),
    port: integer('port'),
    containerId: text('container_id'),
    timestamp: text('timestamp').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_history_deployment').on(table.deploymentName),
  }),
);

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    duration: integer('duration').notNull(),
    timestamp: integer('timestamp').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    referrer: text('referrer'),
    requestSize: integer('request_size'),
    responseSize: integer('response_size'),
    queryParams: text('query_params'),
    username: text('username'),
  },
  (table) => ({
    deploymentIdx: index('idx_request_logs_deployment').on(table.deploymentName),
    timestampIdx: index('idx_request_logs_timestamp').on(table.deploymentName, table.timestamp),
  }),
);

export const resourceMetrics = sqliteTable(
  'resource_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    cpuPercent: real('cpu_percent').notNull(),
    memUsageBytes: integer('mem_usage_bytes').notNull(),
    memLimitBytes: integer('mem_limit_bytes').notNull(),
    memPercent: real('mem_percent').notNull(),
    netRxBytes: integer('net_rx_bytes').notNull(),
    netTxBytes: integer('net_tx_bytes').notNull(),
    blockReadBytes: integer('block_read_bytes').notNull(),
    blockWriteBytes: integer('block_write_bytes').notNull(),
    pids: integer('pids').notNull(),
    timestamp: integer('timestamp').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_resource_metrics_deployment').on(table.deploymentName),
    timestampIdx: index('idx_resource_metrics_timestamp').on(table.deploymentName, table.timestamp),
  }),
);

export const backups = sqliteTable(
  'backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    filename: text('filename').notNull(),
    label: text('label'),
    sizeBytes: integer('size_bytes').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    volumePaths: text('volume_paths').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_backups_deployment').on(table.deploymentName),
    createdIdx: index('idx_backups_created').on(table.deploymentName, table.createdAt),
  }),
);

export const buildLogs = sqliteTable(
  'build_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    output: text('output').notNull(),
    success: integer('success', { mode: 'boolean' }),
    duration: integer('duration'),
    status: text('status').notNull().default('complete'),
    runtimeLogs: text('runtime_logs'),
    timestamp: text('timestamp').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_build_logs_deployment').on(table.deploymentName),
    timestampIdx: index('idx_build_logs_timestamp').on(table.deploymentName, table.timestamp),
  }),
);

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
