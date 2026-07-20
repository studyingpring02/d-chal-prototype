import {
  authenticatedClients,
  corsHeaders,
  decryptBillingKey,
  jsonResponse,
  tossDelete
} from '../_shared/payments.ts';

Deno.serve(async request => {
  if(request.method === 'OPTIONS') return new Response('ok', { headers:corsHeaders });
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const clients = await authenticatedClients(request);
  if(!clients) return jsonResponse({ error:'AUTH_REQUIRED' }, 401);

  const { user, serviceClient } = clients;
  const { data:subscription, error:subscriptionError } = await serviceClient
    .from('dchal_subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .eq('plan', 'monthly')
    .single();

  if(subscriptionError || !subscription){
    return jsonResponse({ error:'MONTHLY_SUBSCRIPTION_NOT_FOUND' }, 404);
  }

  const { error:updateError } = await serviceClient
    .from('dchal_subscriptions')
    .update({
      cancel_at_period_end:true,
      next_billing_at:null,
      billing_claimed_at:null,
      updated_at:new Date().toISOString()
    })
    .eq('user_id', user.id);
  if(updateError) return jsonResponse({ error:'SUBSCRIPTION_CANCEL_FAILED' }, 500);

  const { data:billingMethod } = await serviceClient
    .from('dchal_billing_methods')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  let billingKeyDeleted = false;
  if(billingMethod){
    try{
      const billingKey = await decryptBillingKey(
        billingMethod.encrypted_billing_key,
        billingMethod.billing_key_iv
      );
      const secretKey = Deno.env.get('TOSS_BILLING_SECRET_KEY');
      if(secretKey){
        const deleted = await tossDelete(`/v1/billing/${encodeURIComponent(billingKey)}`, secretKey);
        billingKeyDeleted = deleted.response.ok;
      }
      if(billingKeyDeleted){
        await serviceClient.from('dchal_billing_methods').delete().eq('user_id', user.id);
      }
    }catch(error){
      console.error('Billing key cleanup failed', error instanceof Error ? error.message : 'unknown');
    }
  }

  return jsonResponse({
    ok:true,
    billingKeyDeleted,
    benefitEndsAt:subscription.current_period_end
  });
});

