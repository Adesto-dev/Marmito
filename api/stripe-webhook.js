const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const getRawBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const userId = event.data.object.metadata?.supabase_user_id;
  console.log('[Webhook] event type:', event.type, '| userId:', userId);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (userId) {
      const { error } = await supabase.from('profiles').upsert({
        id: userId,
        plan: 'pro',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
      });
      if (error) {
        console.error('[Webhook] Supabase upsert error:', JSON.stringify(error));
      } else {
        console.log('[Webhook] Supabase updated to PRO for user:', userId);
      }
    } else {
      console.error('[Webhook] userId manquant dans metadata!');
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const { data, error: selectError } = await supabase.from('profiles').select('id').eq('stripe_subscription_id', sub.id).single();
    if (selectError) console.error('[Webhook] Select error:', JSON.stringify(selectError));
    if (data) {
      const { error: updateError } = await supabase.from('profiles').update({ plan: 'free' }).eq('id', data.id);
      if (updateError) console.error('[Webhook] Update error:', JSON.stringify(updateError));
      else console.log('[Webhook] Supabase updated to FREE for user:', data.id);
    }
  }

  res.status(200).json({ received: true });
};
