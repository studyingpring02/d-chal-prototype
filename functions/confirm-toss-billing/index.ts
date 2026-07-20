import {
  authenticatedClients,
  corsHeaders,
  decryptBillingKey,
  encryptBillingKey,
  jsonResponse,
  publicTossError,
  tossPost
} from '../_shared/payments.ts';

Deno.serve(async request => {
  if(request.method === 'OPTIONS') return new Response('ok', { headers:corsHeaders });
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const clients = await authenticatedClients(request);
  if(!clients) return jsonResponse({ error:'AUTH_REQUIRED' }, 401);

  let body: { authKey?:string; customerKey?:string; orderId?:string };
  try{
    body = await request.json();
  }catch{
    return jsonResponse({ error:'INVALID_JSON' }, 400);
  }
  if(!body.customerKey || !body.orderId) return jsonResponse({ error:'BILLING_RESULT_REQUIRED' }, 400);

  const { user, serviceClient } = clients;
  const [{ data:customer }, { data:order, error:orderError }] = await Promise.all([
    serviceClient
      .from('dchal_payment_customers')
      .select('customer_key')
      .eq('user_id', user.id)
      .eq('customer_key', body.customerKey)
      .maybeSingle(),
    serviceClient
      .from('dchal_payment_orders')
      .select('*')
      .eq('order_id', body.orderId)
      .eq('user_id', user.id)
      .single()
  ]);

  if(!customer) return jsonResponse({ error:'BILLING_CUSTOMER_MISMATCH' }, 403);
  if(orderError || !order) return jsonResponse({ error:'PAYMENT_ORDER_NOT_FOUND' }, 404);
  if(order.plan !== 'monthly' || order.amount !== 5900){
    return jsonResponse({ error:'PAYMENT_ORDER_MISMATCH' }, 409);
  }
  if(order.status === 'DONE') return jsonResponse({ ok:true, alreadyConfirmed:true });

  const secretKey = Deno.env.get('TOSS_BILLING_SECRET_KEY');
  if(!secretKey) return jsonResponse({ error:'TOSS_BILLING_SECRET_KEY_REQUIRED' }, 503);

  const { data:billingMethod } = await serviceClient
    .from('dchal_billing_methods')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  let billingKey: string;
  if(body.authKey){
    const issued = await tossPost(
      '/v1/billing/authorizations/issue',
      secretKey,
      { authKey:body.authKey, customerKey:body.customerKey },
      `${order.id}-billing-key`
    );
    if(!issued.response.ok){
      const publicError = publicTossError(issued.payload);
      return jsonResponse({ error:publicError.code, message:publicError.message }, 400);
    }

    billingKey = issued.payload.billingKey;
    if(typeof billingKey !== 'string') return jsonResponse({ error:'BILLING_KEY_MISSING' }, 502);
    const encrypted = await encryptBillingKey(billingKey);
    const card = issued.payload.card || {};
    const saveResult = await serviceClient
      .from('dchal_billing_methods')
      .upsert({
        user_id:user.id,
        customer_key:body.customerKey,
        encrypted_billing_key:encrypted.encryptedBillingKey,
        billing_key_iv:encrypted.billingKeyIv,
        card_summary:{
          issuerCode:card.issuerCode || null,
          number:card.number || null,
          cardType:card.cardType || null,
          ownerType:card.ownerType || null
        },
        updated_at:new Date().toISOString()
      }, { onConflict:'user_id' });
    if(saveResult.error) return jsonResponse({ error:'BILLING_KEY_SAVE_FAILED' }, 500);
  }else if(billingMethod){
    if(billingMethod.customer_key !== body.customerKey){
      return jsonResponse({ error:'BILLING_CUSTOMER_MISMATCH' }, 403);
    }
    billingKey = await decryptBillingKey(
      billingMethod.encrypted_billing_key,
      billingMethod.billing_key_iv
    );
  }else{
    return jsonResponse({ error:'BILLING_AUTH_KEY_REQUIRED' }, 400);
  }

  await serviceClient
    .from('dchal_payment_orders')
    .update({ status:'CONFIRMING' })
    .eq('id', order.id);

  const charged = await tossPost(
    `/v1/billing/${encodeURIComponent(billingKey)}`,
    secretKey,
    {
      amount:5900,
      customerKey:body.customerKey,
      orderId:body.orderId,
      orderName:'D-CHAL Plus 월간 이용권'
    },
    order.id
  );

  if(!charged.response.ok){
    const publicError = publicTossError(charged.payload);
    await serviceClient
      .from('dchal_payment_orders')
      .update({
        status:'FAILED',
        error_code:publicError.code,
        error_message:publicError.message,
        provider_payload:charged.payload
      })
      .eq('id', order.id);
    return jsonResponse({ error:publicError.code, message:publicError.message }, 400);
  }

  if(charged.payload.orderId !== body.orderId || charged.payload.totalAmount !== 5900 || charged.payload.status !== 'DONE'){
    return jsonResponse({ error:'INVALID_BILLING_CONFIRMATION' }, 502);
  }

  await serviceClient
    .from('dchal_payment_orders')
    .update({
      payment_key:charged.payload.paymentKey,
      receipt_url:charged.payload.receipt?.url || null,
      provider_payload:charged.payload
    })
    .eq('id', order.id);

  const { data:finalized, error:finalizeError } = await serviceClient.rpc('finalize_dchal_payment', {
    p_user_id:user.id,
    p_order_id:body.orderId,
    p_payment_key:charged.payload.paymentKey,
    p_plan:'monthly',
    p_amount:5900,
    p_receipt_url:charged.payload.receipt?.url || null,
    p_provider_payload:charged.payload
  });

  if(finalizeError) return jsonResponse({ error:'PAYMENT_SAVE_FAILED' }, 500);
  return jsonResponse({ ok:true, ...finalized });
});
