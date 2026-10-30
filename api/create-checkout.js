const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, email, plan, referredBy } = req.body;
    if (!userId || !email) return res.status(400).json({ error: 'userId and email required' });

    let priceId;
    if (plan === 'chef') {
      priceId = process.env.STRIPE_PRICE_ID_CHEF;
    } else if (plan === 'saveur') {
      priceId = process.env.STRIPE_PRICE_ID_SAVEUR;
    } else {
      priceId = process.env.STRIPE_PRICE_ID;
    }
    if (!priceId) return res.status(500).json({ error: 'Price ID not configured for plan: ' + plan });

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.SITE_URL || 'https://marmito-one.vercel.app'}/?upgraded=1`,
      cancel_url: `${process.env.SITE_URL || 'https://marmito-one.vercel.app'}/?cancelled=1`,
      metadata: {
        supabase_user_id: userId,
        plan: plan || 'saveur',
        referred_by: referredBy || '',
      },
    };

    if (referredBy && process.env.STRIPE_COUPON_REFERRAL) {
      sessionParams.discounts = [{ coupon: process.env.STRIPE_COUPON_REFERRAL }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
