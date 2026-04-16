import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { audit } from '../services/audit.service';

const router = Router();

// ─── Schémas ──────────────────────────────────────────────────────────────────

const baseShiftSchema = z.object({
  role:        z.string().min(2),
  description: z.string().optional(),
  payRate:     z.number().positive(),
  location:    z.string().min(5),
  startTime:   z.string().datetime(),
  endTime:     z.string().datetime(),
});

const createShiftSchema = baseShiftSchema.refine(
  (d) => new Date(d.endTime) > new Date(d.startTime),
  { message: 'endTime doit être après startTime', path: ['endTime'] },
);

const updateShiftSchema = baseShiftSchema.partial();

// ─── GET /shifts — liste des shifts ouverts (workers) ────────────────────────

router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { role, city, from, to, page = '1', limit = '20' } = req.query as Record<string, string>;

    const shifts = await prisma.shift.findMany({
      where: {
        status: 'OPEN',
        ...(role       && { role: { contains: role, mode: 'insensitive' } }),
        ...(city       && { location: { contains: city, mode: 'insensitive' } }),
        ...(from       && { startTime: { gte: new Date(from) } }),
        ...(to         && { endTime:   { lte: new Date(to) } }),
      },
      include: {
        restaurant: { select: { businessName: true, city: true, postalCode: true } },
        _count: { select: { applications: true } },
      },
      orderBy: { startTime: 'asc' },
      skip:  (parseInt(page) - 1) * parseInt(limit),
      take:  parseInt(limit),
    });

    res.json(shifts);
  } catch (err) {
    next(err);
  }
});

// ─── GET /shifts/mine — shifts du restaurant connecté ────────────────────────

router.get(
  '/mine',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({
        where: { userId: req.user!.userId },
      });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const shifts = await prisma.shift.findMany({
        where: { restaurantId: restaurant.id },
        include: {
          applications: {
            include: { worker: { include: { user: { select: { email: true } } } } },
          },
          payment: true,
        },
        orderBy: { startTime: 'desc' },
      });

      res.json(shifts);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts — créer un shift (restaurant) ───────────────────────────────

router.post(
  '/',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createShiftSchema.parse(req.body);

      const restaurant = await prisma.restaurant.findUnique({
        where: { userId: req.user!.userId },
      });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const shift = await prisma.shift.create({
        data: {
          ...data,
          startTime:    new Date(data.startTime),
          endTime:      new Date(data.endTime),
          restaurantId: restaurant.id,
        },
      });

      await audit({
        entityType: 'shift',
        entityId:   shift.id,
        eventType:  'shift.created',
        userId:     req.user!.userId,
        payload:    { after: shift },
      });

      res.status(201).json(shift);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /shifts/:id — détail d'un shift ─────────────────────────────────────

router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shift = await prisma.shift.findUnique({
      where: { id: req.params.id },
      include: {
        restaurant: { select: { businessName: true, address: true, city: true } },
        applications: req.user?.role === 'RESTAURANT'
          ? { include: { worker: { include: { user: { select: { email: true, phone: true } } } } } }
          : false,
        ratings: true,
      },
    });
    if (!shift) throw new AppError('Shift introuvable', 404);

    res.json(shift);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /shifts/:id — mettre à jour (restaurant propriétaire) ──────────────

router.patch(
  '/:id',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateShiftSchema.parse(req.body);

      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const existing = await prisma.shift.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Shift introuvable', 404);
      if (existing.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);
      if (!['OPEN'].includes(existing.status)) throw new AppError('Ce shift ne peut plus être modifié', 400);

      const shift = await prisma.shift.update({
        where: { id: req.params.id },
        data: {
          ...data,
          ...(data.startTime && { startTime: new Date(data.startTime) }),
          ...(data.endTime   && { endTime:   new Date(data.endTime) }),
        },
      });

      await audit({
        entityType: 'shift',
        entityId:   shift.id,
        eventType:  'shift.updated',
        userId:     req.user!.userId,
        payload:    { before: existing, after: shift },
      });

      res.json(shift);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts/:id/cancel — annuler un shift ───────────────────────────────

router.post(
  '/:id/cancel',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const existing = await prisma.shift.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Shift introuvable', 404);
      if (existing.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);
      if (['COMPLETED', 'CANCELLED'].includes(existing.status)) {
        throw new AppError('Ce shift ne peut pas être annulé', 400);
      }

      const shift = await prisma.shift.update({
        where: { id: req.params.id },
        data:  { status: 'CANCELLED' },
      });

      await audit({
        entityType: 'shift',
        entityId:   shift.id,
        eventType:  'shift.cancelled',
        userId:     req.user!.userId,
        payload:    { before: existing, after: shift },
      });

      res.json(shift);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts/:id/complete — confirmer la fin du shift (worker) ───────────

router.post(
  '/:id/complete',
  authenticate,
  requireRole('WORKER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const worker = await prisma.worker.findUnique({ where: { userId: req.user!.userId } });
      if (!worker) throw new AppError('Profil worker introuvable', 404);

      const shift = await prisma.shift.findUnique({
        where: { id: req.params.id },
        include: { applications: { where: { workerId: worker.id, status: 'ACCEPTED' } } },
      });
      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.applications.length === 0) throw new AppError('Tu n\'es pas assigné à ce shift', 403);
      if (shift.status !== 'FILLED') throw new AppError('Ce shift n\'est pas en cours', 400);

      const updated = await prisma.shift.update({
        where: { id: req.params.id },
        data:  { status: 'IN_PROGRESS' },
      });

      await audit({
        entityType: 'shift',
        entityId:   updated.id,
        eventType:  'shift.worker_confirmed_completion',
        userId:     req.user!.userId,
        payload:    { before: shift, after: updated },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts/:id/confirm — confirmer la fin côté restaurant ──────────────

router.post(
  '/:id/confirm',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const shift = await prisma.shift.findUnique({ where: { id: req.params.id } });
      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);
      if (shift.status !== 'IN_PROGRESS') throw new AppError('Le worker n\'a pas encore confirmé', 400);

      const updated = await prisma.shift.update({
        where: { id: req.params.id },
        data:  { status: 'COMPLETED' },
      });

      await audit({
        entityType: 'shift',
        entityId:   updated.id,
        eventType:  'shift.completed',
        userId:     req.user!.userId,
        payload:    { before: shift, after: updated },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
