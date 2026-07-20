import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS'
};

export function jsonResponse(body: unknown, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers:{ ...corsHeaders, 'Content-Type':'application/json; charset=utf-8' }
  });
}

export function serverConfig(){
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!supabaseUrl || !anonKey || !serviceRoleKey) return null;
  return { supabaseUrl, anonKey, serviceRoleKey };
}

export async function authenticatedClients(request: Request){
  const config = serverConfig();
  const authHeader = request.headers.get('Authorization');
  if(!config || !authHeader) return null;

  const userClient = createClient(config.supabaseUrl, config.anonKey, {
    global:{ headers:{ Authorization:authHeader } },
    auth:{ persistSession:false }
  });
  const serviceClient = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth:{ persistSession:false }
  });
  const { data:{ user }, error } = await userClient.auth.getUser();
  if(error || !user) return null;
  return { user, userClient, serviceClient };
}

export function serviceClient(){
  const config = serverConfig();
  if(!config) return null;
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth:{ persistSession:false }
  });
}

export function planDetails(plan: string){
  if(plan === 'monthly'){
    return { plan, amount:5900, orderName:'D-CHAL Plus 월간 이용권', flow:'billing' };
  }
  if(plan === 'annual'){
    return { plan, amount:49000, orderName:'D-CHAL Plus 연간 이용권', flow:'payment' };
  }
  return null;
}

export function newOrderId(plan: string){
  return `DCHAL-${plan.toUpperCase()}-${crypto.randomUUID().replaceAll('-', '')}`;
}

export function tossBasicAuth(secretKey: string){
  return `Basic ${btoa(`${secretKey}:`)}`;
}

export async function tossPost(
  path: string,
  secretKey: string,
  body: Record<string, unknown>,
  idempotencyKey: string
){
  const response = await fetch(`https://api.tosspayments.com${path}`, {
    method:'POST',
    headers:{
      'Authorization':tossBasicAuth(secretKey),
      'Content-Type':'application/json',
      'Idempotency-Key':idempotencyKey
    },
    body:JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({
    code:'INVALID_TOSS_RESPONSE',
    message:'토스페이먼츠 응답을 확인할 수 없어요.'
  }));
  return { response, payload };
}

export async function tossDelete(path: string, secretKey: string){
  const response = await fetch(`https://api.tosspayments.com${path}`, {
    method:'DELETE',
    headers:{ 'Authorization':tossBasicAuth(secretKey) }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function bytesToBase64(bytes: Uint8Array){
  let binary = '';
  for(const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string){
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function encryptionKey(){
  const encodedKey = Deno.env.get('TOSS_BILLING_ENCRYPTION_KEY');
  if(!encodedKey) throw new Error('BILLING_ENCRYPTION_KEY_REQUIRED');
  const keyBytes = base64ToBytes(encodedKey);
  if(keyBytes.length !== 32) throw new Error('BILLING_ENCRYPTION_KEY_MUST_BE_32_BYTES');
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptBillingKey(billingKey: string){
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name:'AES-GCM', iv },
    key,
    new TextEncoder().encode(billingKey)
  );
  return {
    encryptedBillingKey:bytesToBase64(new Uint8Array(encrypted)),
    billingKeyIv:bytesToBase64(iv)
  };
}

export async function decryptBillingKey(encryptedBillingKey: string, billingKeyIv: string){
  const key = await encryptionKey();
  const decrypted = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv:base64ToBytes(billingKeyIv) },
    key,
    base64ToBytes(encryptedBillingKey)
  );
  return new TextDecoder().decode(decrypted);
}

export function publicTossError(payload: Record<string, unknown>){
  const code = typeof payload.code === 'string' ? payload.code : 'PAYMENT_FAILED';
  const message = typeof payload.message === 'string'
    ? payload.message
    : '결제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
  return { code, message };
}

