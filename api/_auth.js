'use strict';
const { createClient } = require('@supabase/supabase-js');
function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return match && match[1];
}
async function requireIdentity(req) {
  const token = bearer(req);
  if (!token) { const e = new Error('Authentification requise'); e.status = 401; throw e; }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const e = new Error('Configuration Supabase incomplète'); e.status = 503; throw e;
  }
  const publicClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await publicClient.auth.getUser(token);
  if (error || !data?.user?.id || !data.user.email) { const e = new Error('Session invalide'); e.status = 401; throw e; }
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return { user: data.user, admin };
}
function sendError(res, error) {
  console.error('[Marmito API]', error);
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur serveur. Réessaie plus tard.' });
}
module.exports = { requireIdentity, sendError };
