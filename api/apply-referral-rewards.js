'use strict';
// Appele par le site quand un parrain a des jours "en attente de prolongation".
// Ne prend aucun parametre : le parrain est l'utilisateur connecte.
const Stripe = require('stripe');
const { requireIdentity, sendError } = require('./_auth');
const { applyPendingRewards } = require('./_referral');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    if (!process.env.STRIPE_SECRET_KEY) { const e = new Error('Stripe non configuré'); e.status = 503; throw e; }
    const { user, admin } = await requireIdentity(req);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const out = await applyPendingRewards(stripe, admin, user.id);
    return res.status(200).json(out);
  } catch (error) {
    return sendError(res, error);
  }
};
