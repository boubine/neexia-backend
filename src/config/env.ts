import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const env = {
  DATABASE_URL:           required('DATABASE_URL'),
  JWT_SECRET:             required('JWT_SECRET'),
  JWT_EXPIRES_IN:         process.env.JWT_EXPIRES_IN ?? '7d',
  STRIPE_SECRET_KEY:      required('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET:  process.env.STRIPE_WEBHOOK_SECRET ?? '',
  PORT:                   parseInt(process.env.PORT ?? '3000', 10),
  NODE_ENV:               process.env.NODE_ENV ?? 'development',
  NEEXIA_COMMISSION_RATE: parseFloat(process.env.NEEXIA_COMMISSION_RATE ?? '0.15'),
};
