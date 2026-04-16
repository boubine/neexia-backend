import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError } from '../middleware/error';

const router = Router();

// ─── Schémas de validation ────────────────────────────────────────────────────

const registerRestaurantSchema = z.object({
  email:        z.string().email(),
  phone:        z.string().optional(),
  password:     z.string().min(8),
  businessName: z.string().min(2),
  siret:        z.string().length(14).optional(),
  address:      z.string().min(5),
  city:         z.string().min(2),
  postalCode:   z.string().length(5),
});

const registerWorkerSchema = z.object({
  email:             z.string().email(),
  phone:             z.string().optional(),
  password:          z.string().min(8),
  firstName:         z.string().min(2),
  lastName:          z.string().min(2),
  skills:            z.array(z.string()).min(1),
  experience:        z.string().optional(),
  availabilityNotes: z.string().optional(),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signToken(userId: string, role: string) {
  return jwt.sign({ userId, role }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

// ─── POST /auth/register/restaurant ──────────────────────────────────────────

router.post(
  '/register/restaurant',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = registerRestaurantSchema.parse(req.body);

      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) throw new AppError('Email déjà utilisé', 409);

      const passwordHash = await bcrypt.hash(data.password, 12);

      const user = await prisma.user.create({
        data: {
          email:        data.email,
          phone:        data.phone,
          passwordHash,
          role:         'RESTAURANT',
          restaurant: {
            create: {
              businessName: data.businessName,
              siret:        data.siret,
              address:      data.address,
              city:         data.city,
              postalCode:   data.postalCode,
            },
          },
        },
        include: { restaurant: true },
      });

      const token = signToken(user.id, user.role);
      res.status(201).json({ token, user: { id: user.id, email: user.email, role: user.role, restaurant: user.restaurant } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /auth/register/worker ──────────────────────────────────────────────

router.post(
  '/register/worker',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = registerWorkerSchema.parse(req.body);

      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) throw new AppError('Email déjà utilisé', 409);

      const passwordHash = await bcrypt.hash(data.password, 12);

      const user = await prisma.user.create({
        data: {
          email:        data.email,
          phone:        data.phone,
          passwordHash,
          role:         'WORKER',
          worker: {
            create: {
              firstName:         data.firstName,
              lastName:          data.lastName,
              skills:            data.skills,
              experience:        data.experience,
              availabilityNotes: data.availabilityNotes,
            },
          },
        },
        include: { worker: true },
      });

      const token = signToken(user.id, user.role);
      res.status(201).json({ token, user: { id: user.id, email: user.email, role: user.role, worker: user.worker } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /auth/login ─────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
      include: { restaurant: true, worker: true },
    });
    if (!user) throw new AppError('Identifiants incorrects', 401);

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError('Identifiants incorrects', 401);

    const token = signToken(user.id, user.role);
    res.json({
      token,
      user: {
        id:         user.id,
        email:      user.email,
        role:       user.role,
        restaurant: user.restaurant,
        worker:     user.worker,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('Token manquant', 401);

    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { restaurant: true, worker: true },
    });
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const { passwordHash: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    next(err);
  }
});

export default router;
