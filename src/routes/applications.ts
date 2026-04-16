import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { audit } from '../services/audit.service';

const router = Router();

// ─── POST /shifts/:shiftId/applications — postuler à un shift (worker) ───────

router.post(
  '/:shiftId/applications',
  authenticate,
  requireRole('WORKER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const worker = await prisma.worker.findUnique({ where: { userId: req.user!.userId } });
      if (!worker) throw new AppError('Profil worker introuvable', 404);

      const shift = await prisma.shift.findUnique({ where: { id: req.params.shiftId } });
      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.status !== 'OPEN') throw new AppError('Ce shift n\'accepte plus de candidatures', 400);

      const application = await prisma.application.create({
        data: {
          shiftId:  shift.id,
          workerId: worker.id,
        },
        include: { shift: true, worker: true },
      });

      await audit({
        entityType: 'application',
        entityId:   application.id,
        eventType:  'application.created',
        userId:     req.user!.userId,
        payload:    { after: application },
      });

      res.status(201).json(application);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /shifts/:shiftId/applications — voir les candidatures (restaurant) ──

router.get(
  '/:shiftId/applications',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const shift = await prisma.shift.findUnique({ where: { id: req.params.shiftId } });
      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);

      const applications = await prisma.application.findMany({
        where: { shiftId: shift.id },
        include: {
          worker: {
            include: {
              user: { select: { email: true, phone: true } },
            },
          },
        },
        orderBy: [
          { worker: { reliabilityScore: 'desc' } }, // tri par score de fiabilité
          { appliedAt: 'asc' },
        ],
      });

      res.json(applications);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts/:shiftId/applications/:appId/accept — accepter un worker ──

router.post(
  '/:shiftId/applications/:appId/accept',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const shift = await prisma.shift.findUnique({ where: { id: req.params.shiftId } });
      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);
      if (shift.status !== 'OPEN') throw new AppError('Ce shift est déjà pourvu', 400);

      const application = await prisma.application.findUnique({ where: { id: req.params.appId } });
      if (!application || application.shiftId !== shift.id) throw new AppError('Candidature introuvable', 404);
      if (application.status !== 'APPLIED') throw new AppError('Cette candidature n\'est plus en attente', 400);

      // Transaction : accepter cette candidature + rejeter les autres + passer le shift en FILLED
      const [accepted] = await prisma.$transaction([
        prisma.application.update({
          where: { id: application.id },
          data:  { status: 'ACCEPTED' },
          include: { worker: { include: { user: { select: { email: true } } } } },
        }),
        prisma.application.updateMany({
          where: { shiftId: shift.id, id: { not: application.id }, status: 'APPLIED' },
          data:  { status: 'REJECTED' },
        }),
        prisma.shift.update({
          where: { id: shift.id },
          data:  { status: 'FILLED' },
        }),
      ]);

      await audit({
        entityType: 'application',
        entityId:   application.id,
        eventType:  'application.accepted',
        userId:     req.user!.userId,
        payload:    { shiftId: shift.id, workerId: application.workerId },
      });

      res.json(accepted);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts/:shiftId/applications/:appId/reject — rejeter une candidature

router.post(
  '/:shiftId/applications/:appId/reject',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const application = await prisma.application.findUnique({
        where: { id: req.params.appId },
        include: { shift: true },
      });
      if (!application || application.shiftId !== req.params.shiftId) throw new AppError('Candidature introuvable', 404);
      if (application.shift.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);
      if (application.status !== 'APPLIED') throw new AppError('Candidature déjà traitée', 400);

      const updated = await prisma.application.update({
        where: { id: application.id },
        data:  { status: 'REJECTED' },
      });

      await audit({
        entityType: 'application',
        entityId:   application.id,
        eventType:  'application.rejected',
        userId:     req.user!.userId,
        payload:    { shiftId: req.params.shiftId },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /shifts/:shiftId/applications/:appId/cancel — retirer sa candidature

router.post(
  '/:shiftId/applications/:appId/cancel',
  authenticate,
  requireRole('WORKER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const worker = await prisma.worker.findUnique({ where: { userId: req.user!.userId } });
      if (!worker) throw new AppError('Profil worker introuvable', 404);

      const application = await prisma.application.findUnique({ where: { id: req.params.appId } });
      if (!application || application.workerId !== worker.id) throw new AppError('Candidature introuvable', 404);
      if (application.status === 'ACCEPTED') throw new AppError('Tu ne peux pas annuler une candidature déjà acceptée', 400);

      const updated = await prisma.application.update({
        where: { id: application.id },
        data:  { status: 'CANCELLED' },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
