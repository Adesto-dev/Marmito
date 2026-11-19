'use strict';
// V69 staging: Stripe events -> Supabase. Requires the accompanying SQL and webhook configuration.
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { applyPendingRewards } = require('./_referral');

// Vercel Node function: preserve the raw body for Stripe signature verification.
const config = { api: { bodyParser: false } };

// Reconcile from Stripe's CURRENT customer subscriptions, not the order in which
// webhook notifications arrive. Reject ambiguous overlapping paid subscriptions.
async function reconcileCustomer(stripe, sb, customerId, uid) {
  const { data: profile, error: lookupError } = await sb.from('profiles')
    .select('stripe_customer_id,stripe_subscription_id').eq('id', uid).single();
  if (lookupError || !profile) throw lookupError || new Error('Missing profile');
  if (profile.stripe_customer_id && profile.stripe_customer_id !== customerId)
    throw new Error('Customer mismatch');
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  if (subs.has_more) throw new Error('Too many subscriptions to reconcile safely');
  const owned = subs.data.filter(s => s.metadata?.supabase_user_id === uid);
  const active = owned.filter(s => ['active','trialing'].includes(s.status));
  if (active.length > 1) throw new Error('Multiple active subscriptions; manual resolution required');
  const winner = active[0] || null;
  let plan = 'free';
  if (winner) {
    const priceId = winner.items?.data?.[0]?.price?.id;
    plan = priceId === process.env.STRIPE_PRICE_ID_CHEF ? 'chef'
      : priceId === process.env.STRIPE_PRICE_ID_SAVEUR ? 'saveur' : null;
    if (!plan) throw new Error('Unrecognized Stripe price; refusing plan change');
  }
  const changes = { stripe_customer_id: customerId,
    stripe_subscription_id: winner?.id || null, plan };
  const { error } = await sb.from('profiles').update(changes).eq('id', uid);
  if (error) throw error;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store');
  const needed = ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
  if (needed.some(k => !process.env[k])) return res.status(503).json({error:'Webhook not configured'});
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
  let event;
  try {
    // Vercel may provide Buffer or unparsed string. Parsed JSON is NOT signature-verifiable.
    let raw = req.rawBody;
    if (!raw && (Buffer.isBuffer(req.body) || typeof req.body === 'string')) raw = req.body;
    if (!raw && typeof req[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      raw = Buffer.concat(chunks);
    }
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') throw new Error('Raw Stripe request body required');
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Marmito webhook] invalid signature/raw body', err.message);
    return res.status(400).json({error:'Invalid Stripe signature or raw body'});
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.client_reference_id && session.customer) {
        const {error} = await sb.from('profiles').update({stripe_customer_id:String(session.customer)})
          .eq('id',session.client_reference_id);
        if (error) throw error;
      }
    }
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      // Versions recentes de l'API Stripe : invoice.subscription est deplace dans invoice.parent.subscription_details.subscription.
      const invoiceSubId = invoice.subscription || invoice.parent?.subscription_details?.subscription;
      if (invoice.billing_reason === 'subscription_create' && invoiceSubId && invoice.amount_paid > 0) {
        const subscription = await stripe.subscriptions.retrieve(String(typeof invoiceSubId === 'object' ? invoiceSubId.id : invoiceSubId));
        const uid = subscription.metadata?.supabase_user_id;
        if (uid && String(subscription.customer) === String(invoice.customer)) {
          // A first paid invoice is the trigger, even if the customer later cancels.
          // The SQL unique(child_id,event_type) constraint ensures one award only.
          await reconcileCustomer(stripe, sb, String(subscription.customer), uid);
          const { data: reward, error: rewardError } = await sb.rpc('marmito_grant_first_paid_reward', { p_child: uid });
          if (rewardError) throw rewardError;
          // Parrain Saveur/Chef : la ligne est en attente, on la prolonge via Stripe.
          // Un echec Stripe ne bloque pas ce webhook : la ligne reste en attente et sera retentee
          // (appel du parrain depuis le site, ou nouvel envoi de cet evenement par Stripe).
          if (reward && reward.sponsor_id && reward.status === 'pending_billing') {
            try { await applyPendingRewards(stripe, sb, reward.sponsor_id); }
            catch (e) { console.error('[Marmito webhook] prolongation parrain en attente', e); }
          }
        }
      }
    }
    if (['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)) {
      const eventSub = event.data.object;
      const uid = eventSub.metadata?.supabase_user_id;
      if (uid && eventSub.customer) {
        await reconcileCustomer(stripe, sb, String(eventSub.customer), uid);
      }
    }
    return res.status(200).json({received:true});
  } catch(err) {
    console.error('[Marmito webhook] processing failed',event.id,event.type,err);
    // Retryable failure: do not acknowledge unprocessed events.
    return res.status(500).json({error:'Webhook processing failed'});
  }
};

module.exports.config = config;
