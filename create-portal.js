'use strict';
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireIdentity, sendError } = require('./_auth');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const { user, admin } = await requireIdentity(req);
    const { data: profile, error } = await admin.from('profiles')
      .select('stripe_customer_id').eq('id', user.id).single();
    if (error || !profile?.stripe_customer_id) return res.status(404).json({ error: 'Aucun abonnement Stripe associé à ce compte' });
    const origin = process.env.SITE_URL;
    if (!origin || !/^https:\/\//.test(origin)) return res.status(503).json({ error: 'SITE_URL HTTPS requis' });
    const session = await stripe.billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: origin.replace(/\/$/, '') });
    return res.status(200).json({ url: session.url });
  } catch (error) { return sendError(res, error); }
};
