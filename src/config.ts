import 'dotenv/config'

export const config = {
  PORT: parseInt(process.env.PORT || '3001', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://rob@localhost:5432/forum',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  MEILI_HOST: process.env.MEILI_HOST || 'http://localhost:7700',
  MEILI_MASTER_KEY: process.env.MEILI_MASTER_KEY || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
} as const
