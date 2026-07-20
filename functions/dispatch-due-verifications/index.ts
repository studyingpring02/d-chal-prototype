import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

function jsonResponse(body: unknown, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers:{ 'Content-Type':'application/json; charset=utf-8' }
  });
}

Deno.serve(async request => {
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const expectedSecret = Deno.env.get('DCHAL_CRON_SECRET');
  const receivedSecret = request.headers.get('x-dchal-cron-secret');
  if(!expectedSecret || receivedSecret !== expectedSecret){
    return jsonResponse({ error:'UNAUTHORIZED_SCHEDULER' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@d-chal.app';

  if(!supabaseUrl || !serviceRoleKey){
    return jsonResponse({ error:'SUPABASE_SERVER_CONFIG_MISSING' }, 500);
  }
  if(!vapidPublicKey || !vapidPrivateKey){
    return jsonResponse({ error:'VAPID_CONFIG_REQUIRED' }, 503);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth:{ persistSession:false }
  });

  await serviceClient.rpc('materialize_due_verification_windows');
  await serviceClient.rpc('mark_expired_verification_windows');
  const { data:dueWindows, error:claimError } = await serviceClient
    .rpc('claim_due_verification_windows', { p_limit:100 });

  if(claimError){
    console.error('Unable to claim due windows', claimError.code);
    return jsonResponse({ error:'WINDOW_CLAIM_FAILED' }, 500);
  }
  if(!dueWindows?.length) return jsonResponse({ sent:0, windows:0 });

  let sentCount = 0;
  let failedCount = 0;

  for(const window of dueWindows){
    const { data:subscriptions, error:subscriptionError } = await serviceClient
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', window.user_id);

    if(subscriptionError || !subscriptions?.length){
      failedCount += 1;
      await serviceClient
        .from('verification_windows')
        .update({
          notified_at:null,
          notification_error:subscriptionError ? 'SUBSCRIPTION_QUERY_FAILED' : 'NO_PUSH_SUBSCRIPTION'
        })
        .eq('id', window.id)
        .lt('notification_attempts', 3);
      continue;
    }

    const minutesLeft = Math.max(
      1,
      Math.ceil((new Date(window.expires_at).getTime() - Date.now()) / 60000)
    );
    const title = window.challenge_type === 'meal'
      ? '🍚 D-CHAL 식단 인증 시간!'
      : '🏋️ D-CHAL 운동 인증 시간!';
    const payload = JSON.stringify({
      title,
      body:`지금부터 ${minutesLeft}분 안에 사진을 찍어주세요. 오늘의 코드는 ${window.random_code}예요.`,
      verification_id:window.id
    });

    const sendResults = await Promise.allSettled(subscriptions.map(async subscription => {
      try{
        await webpush.sendNotification({
          endpoint:subscription.endpoint,
          keys:{
            p256dh:subscription.p256dh,
            auth:subscription.auth
          }
        }, payload, {
          TTL:Math.max(60, minutesLeft * 60),
          urgency:'high'
        });
        sentCount += 1;
      }catch(error){
        const statusCode = Number((error as { statusCode?:number }).statusCode || 0);
        if(statusCode === 404 || statusCode === 410){
          await serviceClient.from('push_subscriptions').delete().eq('id', subscription.id);
        }
        throw error;
      }
    }));

    const successful = sendResults.filter(result => result.status === 'fulfilled').length;
    if(successful === 0){
      failedCount += 1;
      await serviceClient
        .from('verification_windows')
        .update({
          notified_at:null,
          notification_error:'PUSH_DELIVERY_FAILED'
        })
        .eq('id', window.id)
        .lt('notification_attempts', 3);
    }
  }

  return jsonResponse({
    windows:dueWindows.length,
    sent:sentCount,
    failed:failedCount
  });
});
