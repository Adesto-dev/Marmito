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
    // Referral discount is strictly for the first paid month, once per account.
    let validReferral = false;
    if (profile.referred_by && process.env.STRIPE_COUPON_REFERRAL) {
      const { data: referrer, error: refError } = await admin.from('profiles')
        .select('id').eq('referral_code', profile.referred_by).neq('id', user.id).maybeSingle();
      if (refError) throw refError;
      validReferral = !!referrer;
      if (validReferral) params.metadata.referred_by = profile.referred_by;
    }
    const launchCoupon = plan === 'chef' ? process.env.STRIPE_COUPON_LAUNCH_CHEF : process.env.STRIPE_COUPON_LAUNCH_SAVEUR;
    let coupon = launchCoupon;
    if (validReferral) {
      // A new checkout must not re-grant the first-month offer after a previous payment.
      // Check all Stripe customers with this email (not only the currently stored customer).
      const customers = await stripe.customers.list({ email: user.email, limit: 100 });
      if (customers.has_more) throw new Error('Too many Stripe customer records to verify referral eligibility');
      const customerIds = new Set(customers.data.map(c => c.id));
      if (profile.stripe_customer_id) customerIds.add(profile.stripe_customer_id);
      let previouslyPaid = false;
      for (const customerId of customerIds) {
        const invoices = await stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100 });
        if (invoices.has_more) { previouslyPaid = true; break; } // fail closed
        if (invoices.data.some(i => i.amount_paid > 0)) { previouslyPaid = true; break; }
      }
      // Stripe must enforce one-time duration; otherwise fail closed.
      if (!previouslyPaid) {
        const referralCoupon = await stripe.coupons.retrieve(process.env.STRIPE_COUPON_REFERRAL);
        if (referralCoupon.valid && referralCoupon.percent_off === 50 && referralCoupon.duration === 'once') {
          coupon = referralCoupon.id;
          params.metadata.referral_first_month = 'true';
        } else {
          throw new Error('Referral coupon must be 50% and duration once');
        }
      }
    }
    if (coupon) params.discounts = [{ coupon }];
    const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `marmito-checkout-${user.id}-${plan}-${Math.floor(Date.now()/60000)}` });
    return res.status(200).json({ url: session.url });
  } catch (error) { return sendError(res, error); }
};
