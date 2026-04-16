import './config/env'; // valider les variables d'env en premier
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import { errorHandler } from './middleware/error';

import authRoutes        from './routes/auth';
import shiftsRoutes      from './routes/shifts';
import applicationsRoutes from './routes/applications';
import ratingsRoutes     from './routes/ratings';
import paymentsRoutes    from './routes/payments';

const app = express();

// ─── Sécurité & parsing ───────────────────────────────────────────────────────

app.use(helmet());
app.use(cors());

// Corps brut pour le webhook Stripe (doit être avant express.json)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Rate limiting : 100 requêtes / 15 min par IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

app.use('/api/auth',         authRoutes);
app.use('/api/shifts',       shiftsRoutes);
app.use('/api/shifts',       applicationsRoutes);
app.use('/api/shifts',       ratingsRoutes);
app.use('/api/payments',     paymentsRoutes);

// ─── Gestion des erreurs ──────────────────────────────────────────────────────

app.use(errorHandler);

// ─── Démarrage ────────────────────────────────────────────────────────────────

app.listen(env.PORT, () => {
  console.log(`Neexia API démarrée sur le port ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
