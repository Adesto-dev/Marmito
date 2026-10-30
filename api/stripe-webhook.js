const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.mode !== 'subscription') return res.status(200).end();

    const referredBy = session.metadata?.referred_by;
    const subscriberUserId = session.metadata?.supabase_user_id;

    if (!referredBy || !subscriberUserId) return res.status(200).end();

    try {
      const { data: subscriber } = await sb
        .from('profiles')
        .select('referral_applied')
        .eq('id', subscriberUserId)
        .single();

      if (!subscriber || subscriber.referral_applied) return res.status(200).end();

      const { data: referrer } = await sb
        .from('profiles')
        .select('id, bonus_expires_at')
        .eq('referral_code', referredBy)
        .neq('id', subscriberUserId)
        .single();

      if (!referrer) return res.status(200).end();

      await sb.from('profiles').update({ referral_applied: true }).eq('id', subscriberUserId);

      const MAX_BONUS_DAYS = 90;
      const now = new Date();
      let newExpires;

      if (!referrer.bonus_expires_at || new Date(referrer.bonus_expires_at) < now) {
        newExpires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      } else {
        const current = new Date(referrer.bonus_expires_at);
        const extended = new Date(current.getTime() + 30 * 24 * 60 * 60 * 1000);
        const maxDate = new Date(now.getTime() + MAX_BONUS_DAYS * 24 * 60 * 60 * 1000);
        newExpires = extended < maxDate ? extended : maxDate;
      }

      await sb.from('profiles').update({
        bonus_plan: 'saveur',
        bonus_expires_at: newExpires.toISOString(),
      }).eq('id', referrer.id);

    } catch (err) {
      console.error('[Marmito] Webhook referral error:', err);
    }
  }

  res.status(200).json({ received: true });
};
