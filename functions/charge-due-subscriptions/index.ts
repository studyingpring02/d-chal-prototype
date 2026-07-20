import {
  decryptBillingKey,
  jsonResponse,
  newOrderId,
  publicTossError,
  serviceClient,
  tossPost
} from '../_shared/payments.ts';

Deno.serve(async request => {
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const expectedSecret = Deno.env.get('DCHAL_CRON_SECRET');
  const receivedSecret = request.headers.get('x-dchal-cron-secret');
  if(!expectedSecret || receivedSecret !== expectedSecret){
    return jsonResponse({ error:'UNAUTHORIZED_SCHEDULER' }, 401);
  }

  const client = serviceClient();
  const secretKey = Deno.env.get('TOSS_BILLING_SECRET_KEY');
  if(!client) return jsonResponse({ error:'SUPABASE_SERVER_CONFIG_MISSING' }, 500);
  if(!secretKey) return jsonResponse({ error:'TOSS_BILLING_SECRET_KEY_REQUIRED' }, 503);

  const { data:subscriptions, error:claimError } = await client
    .rpc('claim_due_dchal_subscriptions', { p_limit:20 });
  if(claimError) return jsonResponse({ error:'SUBSCRIPTION_CLAIM_FAILED' }, 500);
  if(!subscriptions?.length) return jsonResponse({ charged:0, failed:0 });

  const results = await Promise.allSettled(subscriptions.map(async subscription => {
    const { data:recoverableOrder } = await client
      .from('dchal_payment_orders')
      .select('*')
      .eq('user_id', subscription.user_id)
      .eq('plan', 'monthly')
      .eq('status', 'CONFIRMING')
      .not('payment_key', 'is', null)
      .order('created_at', { ascending:false })
      .limit(1)
      .maybeSingle();

    if(recoverableOrder){
      const { error:recoveryError } = await client.rpc('finalize_dchal_payment', {
        p_user_id:subscription.user_id,
        p_order_id:recoverableOrder.order_id,
        p_payment_key:recoverableOrder.payment_key,
        p_plan:'monthly',
        p_amount:5900,
        p_receipt_url:recoverableOrder.receipt_url,
        p_provider_payload:recoverableOrder.provider_payload
      });
      if(recoveryError) throw new Error('PAYMENT_RECOVERY_FAILED');
      return recoverableOrder.order_id;
    }

    const [{ data:customer }, { data:billingMethod }] = await Promise.all([
      client
        .from('dchal_payment_customers')
        .select('customer_key')
        .eq('user_id', subscription.user_id)
        .single(),
      client
        .from('dchal_billing_methods')
        .select('*')
        .eq('user_id', subscription.user_id)
        .single()
    ]);

    if(!customer || !billingMethod) throw new Error('BILLING_METHOD_NOT_FOUND');
    if(customer.customer_key !== billingMethod.customer_key){
      throw new Error('BILLING_CUSTOMER_MISMATCH');
    }

    const orderId = newOrderId('monthly');
    const { data:order, error:orderError } = await client
      .from('dchal_payment_orders')
      .insert({
        order_id:orderId,
        user_id:subscription.user_id,
        plan:'monthly',
        amount:5900,
        status:'CONFIRMING'
      })
      .select('id')
      .single();
    if(orderError || !order) throw new Error('PAYMENT_ORDER_CREATE_FAILED');

    const billingKey = await decryptBillingKey(
      billingMethod.encrypted_billing_key,
      billingMethod.billing_key_iv
    );
    const charged = await tossPost(
      `/v1/billing/${encodeURIComponent(billingKey)}`,
      secretKey,
      {
        amount:5900,
        customerKey:customer.customer_key,
        orderId,
        orderName:'D-CHAL Plus 월간 이용권'
      },
      order.id
    );

    if(!charged.response.ok){
      const publicError = publicTossError(charged.payload);
      await Promise.all([
        client
          .from('dchal_payment_orders')
          .update({
            status:'FAILED',
            error_code:publicError.code,
            error_message:publicError.message,
            provider_payload:charged.payload
          })
          .eq('id', order.id),
        client
          .from('dchal_subscriptions')
          .update({
            status:'past_due',
            next_billing_at:new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            billing_claimed_at:null,
            last_billing_error:`${publicError.code}: ${publicError.message}`,
            updated_at:new Date().toISOString()
          })
          .eq('user_id', subscription.user_id)
      ]);
      throw new Error(publicError.code);
    }

    if(charged.payload.orderId !== orderId || charged.payload.totalAmount !== 5900 || charged.payload.status !== 'DONE'){
      throw new Error('INVALID_BILLING_CONFIRMATION');
    }

    await client
      .from('dchal_payment_orders')
      .update({
        payment_key:charged.payload.paymentKey,
        receipt_url:charged.payload.receipt?.url || null,
        provider_payload:charged.payload
      })
      .eq('id', order.id);

    const { error:finalizeError } = await client.rpc('finalize_dchal_payment', {
      p_user_id:subscription.user_id,
      p_order_id:orderId,
      p_payment_key:charged.payload.paymentKey,
      p_plan:'monthly',
      p_amount:5900,
      p_receipt_url:charged.payload.receipt?.url || null,
      p_provider_payload:charged.payload
    });
    if(finalizeError) throw new Error('PAYMENT_SAVE_FAILED');
    return orderId;
  }));

  const charged = results.filter(result => result.status === 'fulfilled').length;
  const failed = results.length - charged;

  for(let index = 0; index < results.length; index += 1){
    if(results[index].status === 'fulfilled') continue;
    await client
      .from('dchal_subscriptions')
      .update({ billing_claimed_at:null, updated_at:new Date().toISOString() })
      .eq('user_id', subscriptions[index].user_id);
  }

  return jsonResponse({ charged, failed, total:results.length });
});
