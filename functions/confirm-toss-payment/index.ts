import {
  authenticatedClients,
  corsHeaders,
  jsonResponse,
  publicTossError,
  tossPost
} from '../_shared/payments.ts';

Deno.serve(async request => {
  if(request.method === 'OPTIONS') return new Response('ok', { headers:corsHeaders });
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const clients = await authenticatedClients(request);
  if(!clients) return jsonResponse({ error:'AUTH_REQUIRED' }, 401);

  let body: { paymentKey?:string; orderId?:string; amount?:number|string };
  try{
    body = await request.json();
  }catch{
    return jsonResponse({ error:'INVALID_JSON' }, 400);
  }

  const amount = Number(body.amount);
  if(!body.paymentKey || !body.orderId || !Number.isInteger(amount)){
    return jsonResponse({ error:'PAYMENT_RESULT_REQUIRED' }, 400);
  }

  const { user, serviceClient } = clients;
  const { data:order, error:orderError } = await serviceClient
    .from('dchal_payment_orders')
    .select('*')
    .eq('order_id', body.orderId)
    .eq('user_id', user.id)
    .single();

  if(orderError || !order) return jsonResponse({ error:'PAYMENT_ORDER_NOT_FOUND' }, 404);
  if(order.plan !== 'annual' || order.amount !== amount){
    return jsonResponse({ error:'PAYMENT_AMOUNT_MISMATCH', message:'결제금액 검증에 실패했어요.' }, 409);
  }
  if(order.status === 'DONE'){
    return jsonResponse({ ok:true, alreadyConfirmed:true, benefitEndsAt:order.approved_at });
  }

  const secretKey = Deno.env.get('TOSS_PAYMENT_SECRET_KEY');
  if(!secretKey) return jsonResponse({ error:'TOSS_PAYMENT_SECRET_KEY_REQUIRED' }, 503);

  await serviceClient
    .from('dchal_payment_orders')
    .update({ status:'CONFIRMING' })
    .eq('id', order.id);

  const { response, payload } = await tossPost(
    '/v1/payments/confirm',
    secretKey,
    { paymentKey:body.paymentKey, orderId:body.orderId, amount },
    order.id
  );

  if(!response.ok){
    const publicError = publicTossError(payload);
    await serviceClient
      .from('dchal_payment_orders')
      .update({
        status:'FAILED',
        error_code:publicError.code,
        error_message:publicError.message,
        provider_payload:payload
      })
      .eq('id', order.id);
    return jsonResponse({ error:publicError.code, message:publicError.message }, 400);
  }

  if(payload.orderId !== body.orderId || payload.totalAmount !== amount || payload.status !== 'DONE'){
    return jsonResponse({ error:'INVALID_PAYMENT_CONFIRMATION' }, 502);
  }

  await serviceClient
    .from('dchal_payment_orders')
    .update({
      payment_key:body.paymentKey,
      receipt_url:payload.receipt?.url || null,
      provider_payload:payload
    })
    .eq('id', order.id);

  const { data:finalized, error:finalizeError } = await serviceClient.rpc('finalize_dchal_payment', {
    p_user_id:user.id,
    p_order_id:body.orderId,
    p_payment_key:body.paymentKey,
    p_plan:'annual',
    p_amount:amount,
    p_receipt_url:payload.receipt?.url || null,
    p_provider_payload:payload
  });

  if(finalizeError) return jsonResponse({ error:'PAYMENT_SAVE_FAILED' }, 500);
  return jsonResponse({ ok:true, ...finalized });
});
