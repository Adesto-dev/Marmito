'use strict';
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireIdentity, sendError } = require('./_auth');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const { user, admin } = await requireIdentity(req);
    const plan = req.body?.plan;
    if (!['saveur', 'chef'].includes(plan)) return res.status(400).json({ error: 'Formule invalide' });
    const priceId = plan === 'chef' ? process.env.STRIPE_PRICE_ID_CHEF : process.env.STRIPE_PRICE_ID_SAVEUR;
    if (!priceId) return res.status(503).json({ error: 'Tarif non configuré' });
    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('referred_by,stripe_customer_id').eq('id', user.id).single();
    if (profileError || !profile) return res.status(409).json({ error: 'Profil introuvable' });
    const origin = process.env.SITE_URL;
    if (!origin || !/^https:\/\//.test(origin)) return res.status(503).json({ error: 'SITE_URL HTTPS requis' });
    const params = {
      mode: 'subscription', payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin.replace(/\/$/, '')}/?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin.replace(/\/$/, '')}/?cancelled=1`,
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id, plan },
      subscription_data: { metadata: { supabase_user_id: user.id, plan } }
    };
    if (profile.stripe_customer_id) params.customer = profile.stripe_customer_id;
    else params.customer_email = user.email;
    // Referral discount only if code belongs to a different existing user.
    let validReferral = false;
    if (profile.referred_by && process.env.STRIPE_COUPON_REFERRAL) {
      const { data: referrer, error: refError } = await admin.from('profiles')
        .select('id').eq('referral_code', profile.referred_by).neq('id', user.id).maybeSingle();
      if (refError) throw refError;
      validReferral = !!referrer;
      if (validReferral) params.metadata.referred_by = profile.referred_by;
    }
    const launchCoupon = plan === 'chef' ? process.env.STRIPE_COUPON_LAUNCH_CHEF : process.env.STRIPE_COUPON_LAUNCH_SAVEUR;
    const coupon = validReferral ? process.env.STRIPE_COUPON_REFERRAL : launchCoupon;
    if (coupon) params.discounts = [{ coupon }];
    const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `marmito-checkout-${user.id}-${plan}-${Math.floor(Date.now()/60000)}` });
    return res.status(200).json({ url: session.url });
  } catch (error) { return sendError(res, error); }
};
