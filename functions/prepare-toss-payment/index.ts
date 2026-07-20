import {
  authenticatedClients,
  corsHeaders,
  jsonResponse,
  newOrderId,
  planDetails
} from '../_shared/payments.ts';

Deno.serve(async request => {
  if(request.method === 'OPTIONS') return new Response('ok', { headers:corsHeaders });
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const clients = await authenticatedClients(request);
  if(!clients) return jsonResponse({ error:'AUTH_REQUIRED', message:'휴대폰 인증 후 결제해 주세요.' }, 401);

  let body: { plan?:string };
  try{
    body = await request.json();
  }catch{
    return jsonResponse({ error:'INVALID_JSON' }, 400);
  }

  const details = planDetails(body.plan || '');
  if(!details) return jsonResponse({ error:'INVALID_PLAN' }, 400);

  const clientKey = details.plan === 'monthly'
    ? Deno.env.get('TOSS_BILLING_CLIENT_KEY')
    : Deno.env.get('TOSS_PAYMENT_CLIENT_KEY');
  if(!clientKey){
    return jsonResponse({
      error:'TOSS_CLIENT_KEY_REQUIRED',
      message:'Supabase Edge Function Secret에 토스페이먼츠 테스트 클라이언트 키를 설정해 주세요.'
    }, 503);
  }

  const { user, serviceClient } = clients;
  let { data:customer, error:customerError } = await serviceClient
    .from('dchal_payment_customers')
    .select('user_id, customer_key')
    .eq('user_id', user.id)
    .maybeSingle();

  if(customerError) return jsonResponse({ error:'PAYMENT_CUSTOMER_LOOKUP_FAILED' }, 500);

  if(!customer){
    const customerKey = `dchal_${crypto.randomUUID()}`;
    const result = await serviceClient
      .from('dchal_payment_customers')
      .insert({ user_id:user.id, customer_key:customerKey })
      .select('user_id, customer_key')
      .single();
    if(result.error || !result.data){
      return jsonResponse({ error:'PAYMENT_CUSTOMER_CREATE_FAILED' }, 500);
    }
    customer = result.data;
  }

  const orderId = newOrderId(details.plan);
  const { data:order, error:orderError } = await serviceClient
    .from('dchal_payment_orders')
    .insert({
      order_id:orderId,
      user_id:user.id,
      plan:details.plan,
      amount:details.amount,
      status:'READY'
    })
    .select('id, order_id')
    .single();

  if(orderError || !order) return jsonResponse({ error:'PAYMENT_ORDER_CREATE_FAILED' }, 500);

  return jsonResponse({
    clientKey,
    customerKey:customer.customer_key,
    orderId:order.order_id,
    plan:details.plan,
    flow:details.flow,
    amount:details.amount,
    orderName:details.orderName
  });
});

