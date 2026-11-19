'use strict';
// Prolongation Stripe des recompenses de parrainage (en JOURS, pas en argent).
// Le parrain garde son forfait. La prochaine facture est repoussee avec trial_end
// (proration_behavior 'none' : aucun credit, aucun remboursement, aucune facture).
// Une recompense passe a 'applied' seulement apres confirmation de Stripe.
// Idempotence : la cle marmito_ref_<id> est ecrite dans les metadonnees de l'abonnement
// DANS LE MEME appel que trial_end. Si le serveur plante apres Stripe mais avant Supabase,
// le prochain essai voit la cle et confirme sans prolonger une deuxieme fois.

const DAY = 86400;

async function applyPendingRewards(stripe, sb, sponsorId) {
  const result = { applied: 0, days: 0, pending: 0, skipped: null };
  const { data: profile, error: pErr } = await sb.from('profiles')
    .select('stripe_subscription_id').eq('id', sponsorId).single();
  if (pErr || !profile) throw pErr || new Error('Profil introuvable');

  // Reservation des recompenses (Gratuit : donnees en bonus interne par la fonction SQL).
  const { data: claimed, error: cErr } = await sb.rpc('marmito_claim_referral_rewards', { p_sponsor: sponsorId });
  if (cErr) throw cErr;
  const rewards = (claimed || []).map(r => ({ id: Number(r.reward_id), days: Number(r.days) }));
  if (!rewards.length) return result;

  const release = async (id) => { try { await sb.rpc('marmito_release_referral_reward', { p_reward_id: id }); } catch (e) { console.error('[Marmito referral] release', id, e); } };
  const releaseAll = async (list) => { for (const r of list) await release(r.id); };

  if (!profile.stripe_subscription_id) {
    // Pas d'abonnement connu : les jours restent en attente (rien n'est perdu).
    await releaseAll(rewards);
    result.pending = rewards.reduce((s, r) => s + r.days, 0);
    result.skipped = 'no_subscription';
    return result;
  }

  let sub;
  try { sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id); }
  catch (e) { await releaseAll(rewards); throw e; }
  if (!sub || sub.metadata?.supabase_user_id !== sponsorId || !['active', 'trialing'].includes(sub.status) || sub.cancel_at_period_end) {
    await releaseAll(rewards);
    result.pending = rewards.reduce((s, r) => s + r.days, 0);
    result.skipped = 'subscription_not_extendable';
    return result;
  }

  for (let i = 0; i < rewards.length; i++) {
    const r = rewards[i];
    const key = 'marmito_ref_' + r.id;
    try {
      if (sub.metadata && sub.metadata[key]) {
        // Deja prolonge par Stripe lors d'un essai precedent : on confirme seulement.
        const { error } = await sb.rpc('marmito_confirm_referral_reward', { p_reward_id: r.id });
        if (error) throw error;
        result.applied += 1; result.days += r.days;
        continue;
      }
      const now = Math.floor(Date.now() / 1000);
      const base = Math.max(sub.trial_end && sub.trial_end > now ? sub.trial_end : 0, sub.current_period_end || 0, now);
      const target = base + r.days * DAY;
      const updated = await stripe.subscriptions.update(sub.id, {
        trial_end: target,
        proration_behavior: 'none',
        metadata: { [key]: String(r.days) }
      }, { idempotencyKey: 'marmito-ref-' + r.id });
      // Verification : Stripe doit avoir pris la nouvelle date et la cle.
      if (!updated || updated.trial_end !== target || updated.metadata?.[key] !== String(r.days)) {
        throw new Error('Stripe n\'a pas confirme la prolongation');
      }
      const { error } = await sb.rpc('marmito_confirm_referral_reward', { p_reward_id: r.id });
      if (error) throw error;
      sub = updated;
      result.applied += 1; result.days += r.days;
    } catch (e) {
      console.error('[Marmito referral] echec prolongation', r.id, e);
      // La recompense reste pending_billing et sera retentee. Les suivantes sont liberees.
      await releaseAll(rewards.slice(i));
      result.pending = rewards.slice(i).reduce((s, x) => s + x.days, 0);
      result.skipped = 'stripe_error';
      return result;
    }
  }
  return result;
}

module.exports = { applyPendingRewards };
