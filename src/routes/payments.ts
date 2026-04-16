import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { audit } from '../services/audit.service';

const router = Router();
const stripe = new Stripe(env.STRIPE_SECRET_KEY);

// ─── POST /payments/shifts/:shiftId/intent ────────────────────────────────────
// Le restaurant crée un PaymentIntent pour payer un shift (après avoir accepté un worker)

router.post(
  '/shifts/:shiftId/intent',
  authenticate,
  requireRole('RESTAURANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restaurant = await prisma.restaurant.findUnique({ where: { userId: req.user!.userId } });
      if (!restaurant) throw new AppError('Profil restaurant introuvable', 404);

      const shift = await prisma.shift.findUnique({
        where: { id: req.params.shiftId },
        include: { applications: { where: { status: 'ACCEPTED' }, include: { worker: true } } },
      });
      if (!shift) throw new AppError('Shift introuvable', 404);
      if (shift.restaurantId !== restaurant.id) throw new AppError('Accès refusé', 403);
      if (shift.status !== 'FILLED') throw new AppError('Le shift doit être pourvu avant paiement', 400);
      if (shift.applications.length === 0) throw new AppError('Aucun worker assigné', 400);

      // Calculer le montant : durée en heures × tarif horaire
      const hours = (new Date(shift.endTime).getTime() - new Date(shift.startTime).getTime()) / 3_600_000;
      const totalAmount = Math.round(shift.payRate * hours * 100); // en centimes
      const commission  = Math.round(totalAmount * env.NEEXIA_COMMISSION_RATE);
      const workerPayout = totalAmount - commission;

      const worker = shift.applications[0].worker;
      if (!worker.stripeAccountId) throw new AppError('Le worker n\'a pas encore configuré son compte de paiement', 400);

      // Créer un PaymentIntent avec transfer_data pour le modèle marketplace
      const paymentIntent = await stripe.paymentIntents.create({
        amount:   totalAmount,
        currency: 'eur',
        application_fee_amount: commission,
        transfer_data: { destination: worker.stripeAccountId },
        metadata: {
          shiftId:      shift.id,
          restaurantId: restaurant.id,
          workerId:     worker.id,
        },
      });

      // Sauvegarder le paiement en base
      const payment = await prisma.payment.create({
        data: {
          shiftId:             shift.id,
          restaurantId:        restaurant.id,
          amount:              totalAmount / 100,
          commission:          commission / 100,
          stripePaymentIntent: paymentIntent.id,
          status:              'PENDING',
        },
      });

      // Créer le payout en attente
      await prisma.payout.create({
        data: {
          workerId:  worker.id,
          paymentId: payment.id,
          amount:    workerPayout / 100,
          status:    'PENDING',
        },
      });

      await audit({
        entityType: 'payment',
        entityId:   payment.id,
        eventType:  'payment.intent_created',
        userId:     req.user!.userId,
        payload:    { stripePaymentIntent: paymentIntent.id, amount: totalAmount / 100 },
      });

      res.json({ clientSecret: paymentIntent.client_secret, paymentId: payment.id });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /payments/webhook — webhook Stripe ──────────────────────────────────
// Stripe notifie Neexia quand le paiement est capturé

router.post(
  '/webhook',
  // Corps brut nécessaire pour vérifier la signature Stripe
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string;
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      res.status(400).send('Webhook signature invalide');
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;

      const payment = await prisma.payment.findFirst({
        where: { stripePaymentIntent: pi.id },
        include: { payout: true },
      });

      if (payment) {
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'CAPTURED' } });

        if (payment.payout) {
          await prisma.payout.update({ where: { id: payment.payout.id }, data: { status: 'PAID' } });
        }

        await audit({
          entityType: 'payment',
          entityId:   payment.id,
          eventType:  'payment.captured',
          payload:    { stripePaymentIntent: pi.id, amount: pi.amount / 100 },
        });
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const payment = await prisma.payment.findFirst({ where: { stripePaymentIntent: pi.id } });
      if (payment) {
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
        await audit({
          entityType: 'payment',
          entityId:   payment.id,
          eventType:  'payment.failed',
          payload:    { stripePaymentIntent: pi.id },
        });
      }
    }

    res.json({ received: true });
  },
);

// ─── POST /payments/onboard/worker — créer un Stripe Express account pour le worker

router.post(
  '/onboard/worker',
  authenticate,
  requireRole('WORKER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const worker = await prisma.worker.findUnique({ where: { userId: req.user!.userId } });
      if (!worker) throw new AppError('Profil worker introuvable', 404);

      let accountId = worker.stripeAccountId;

      if (!accountId) {
        const account = await stripe.accounts.create({
          type:    'express',
          country: 'FR',
          capabilities: { transfers: { requested: true } },
        });
        accountId = account.id;
        await prisma.worker.update({
          where: { id: worker.id },
          data:  { stripeAccountId: account.id },
        });
      }

      const accountLink = await stripe.accountLinks.create({
        account:     accountId,
        refresh_url: `${process.env.APP_URL}/onboarding/refresh`,
        return_url:  `${process.env.APP_URL}/onboarding/complete`,
        type:        'account_onboarding',
      });

      res.json({ url: accountLink.url });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
