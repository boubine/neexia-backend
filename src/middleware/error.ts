import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Erreur de validation Zod
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Données invalides',
      details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
    return;
  }

  // Violation de contrainte unique Prisma
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'Cette ressource existe déjà' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Ressource introuvable' });
      return;
    }
  }

  // AppError personnalisée
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Erreur inconnue
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
}

export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
