import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/error';

const router = Router();

const ratingSchema = z.object({
  score:   z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

// ─── POST /shifts/:shiftId/ratings — noter après un shift ────────────────────

router.post(
  '/:shiftId/ratings',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { score, comment } = ratingSchema.parse(req.body);
      const { userId, role } = req.user!;

      const shift = await prisma.shift.findUnique({
        where: { id: req.params.shiftId },
        include: {
          restaurant: { include: { user: true } },
          applications: { where: { status: 'ACCEPTED' }, include: { worker: { include: { user: true } } } },
        },
      });

      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.status !== 'COMPLETED') throw new AppError('Le shift doit être terminé pour laisser une note', 400);

      let toUserId: string;

      if (role === 'RESTAURANT') {
        // Restaurant note le worker
        if (shift.restaurant.userId !== userId) throw new AppError('Accès refusé', 403);
        const acceptedApp = shift.applications[0];
        if (!acceptedApp) throw new AppError('Aucun worker assigné', 404);
        toUserId = acceptedApp.worker.userId;
      } else if (role === 'WORKER') {
        // Worker note le restaurant
        const worker = await prisma.worker.findUnique({ where: { userId } });
        if (!worker) throw new AppError('Profil worker introuvable', 404);
        const assignedApp = shift.applications.find((a) => a.workerId === worker.id);
        if (!assignedApp) throw new AppError('Tu n\'étais pas assigné à ce shift', 403);
        toUserId = shift.restaurant.userId;
      } else {
        throw new AppError('Seuls les restaurants et workers peuvent noter', 403);
      }

      const rating = await prisma.rating.create({
        data: { fromUserId: userId, toUserId, shiftId: shift.id, score, comment },
      });

      // Recalculer le score de fiabilité du worker si c'est le restaurant qui note
      if (role === 'RESTAURANT') {
        const worker = await prisma.worker.findUnique({
          where: { userId: toUserId },
          include: { applications: { where: { status: 'ACCEPTED' } } },
        });
        if (worker) {
          const ratings = await prisma.rating.findMany({ where: { toUserId } });
          const avg = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
          await prisma.worker.update({
            where: { id: worker.id },
            data:  { reliabilityScore: parseFloat(avg.toFixed(2)) },
          });
        }
      }

      res.status(201).json(rating);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /shifts/:shiftId/ratings — voir les notes d'un shift ────────────────

router.get(
  '/:shiftId/ratings',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ratings = await prisma.rating.findMany({
        where: { shiftId: req.params.shiftId },
        include: {
          fromUser: { select: { id: true, role: true } },
          toUser:   { select: { id: true, role: true } },
        },
      });
      res.json(ratings);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
