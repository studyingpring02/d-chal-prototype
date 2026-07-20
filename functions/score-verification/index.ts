import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type ScoreResult = {
  valid: boolean;
  score: number;
  confidence: number;
  activity_match: number;
  evidence_completeness: number;
  fresh_capture_proof: number;
  reason_codes: string[];
  manual_review_required: boolean;
  user_message: string;
  meal_health_score: number | null;
  meal_character_tier: 'alert' | 'caution' | 'good' | null;
  meal_feedback: string | null;
  meal_mode: 'regular' | 'dining' | null;
};

function jsonResponse(body: unknown, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers:{ ...corsHeaders, 'Content-Type':'application/json; charset=utf-8' }
  });
}

function clamp(value: unknown, min: number, max: number){
  const number = Number(value);
  if(!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function bytesToBase64(bytes: Uint8Array){
  let binary = '';
  const chunkSize = 0x8000;
  for(let offset = 0; offset < bytes.length; offset += chunkSize){
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function readOutputText(response: Record<string, unknown>){
  const output = Array.isArray(response.output) ? response.output : [];
  for(const item of output){
    if(!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?:unknown[] }).content)
      ? (item as { content:unknown[] }).content
      : [];
    for(const part of content){
      if(
        part
        && typeof part === 'object'
        && (part as { type?:string }).type === 'output_text'
        && typeof (part as { text?:unknown }).text === 'string'
      ){
        return (part as { text:string }).text;
      }
    }
  }
  return '';
}

Deno.serve(async request => {
  if(request.method === 'OPTIONS') return new Response('ok', { headers:corsHeaders });
  if(request.method !== 'POST') return jsonResponse({ error:'METHOD_NOT_ALLOWED' }, 405);

  const authHeader = request.headers.get('Authorization');
  if(!authHeader) return jsonResponse({ error:'AUTH_REQUIRED' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  const visionModel = Deno.env.get('OPENAI_VISION_MODEL');

  if(!supabaseUrl || !anonKey || !serviceRoleKey){
    return jsonResponse({ error:'SUPABASE_SERVER_CONFIG_MISSING' }, 500);
  }
  if(!openAiKey || !visionModel){
    return jsonResponse({
      error:'AI_CONFIG_REQUIRED',
      message:'OPENAI_API_KEY와 OPENAI_VISION_MODEL을 Supabase Edge Function Secret에 설정해주세요.'
    }, 503);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global:{ headers:{ Authorization:authHeader } },
    auth:{ persistSession:false }
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth:{ persistSession:false }
  });

  const { data:{ user }, error:userError } = await userClient.auth.getUser();
  if(userError || !user) return jsonResponse({ error:'INVALID_SESSION' }, 401);

  let requestBody: {
    submission_id?:string;
    meal_mode?:string | null;
    menu_name?:string | null;
    health_choices?:unknown;
    dining_type?:string | null;
  };
  try{
    requestBody = await request.json();
  }catch{
    return jsonResponse({ error:'INVALID_JSON' }, 400);
  }
  if(!requestBody.submission_id) return jsonResponse({ error:'SUBMISSION_ID_REQUIRED' }, 400);
  const mealMode = requestBody.meal_mode === 'dining' ? 'dining' : 'regular';
  const menuName = typeof requestBody.menu_name === 'string'
    ? requestBody.menu_name.trim().slice(0, 80)
    : '';
  const healthChoices = Array.isArray(requestBody.health_choices)
    ? requestBody.health_choices.filter(item => typeof item === 'string').slice(0, 8)
    : [];
  const diningType = typeof requestBody.dining_type === 'string'
    ? requestBody.dining_type.trim().slice(0, 40)
    : '';

  const { data:submission, error:submissionError } = await serviceClient
    .from('photo_submissions')
    .select(`
      id,
      user_id,
      private_image_path,
      captured_at,
      ai_result_json,
      verification_windows!inner (
        id,
        user_id,
        challenge_type,
        random_code,
        scheduled_at,
        expires_at,
        status
      )
    `)
    .eq('id', requestBody.submission_id)
    .single();

  if(submissionError || !submission) return jsonResponse({ error:'SUBMISSION_NOT_FOUND' }, 404);
  if(submission.user_id !== user.id) return jsonResponse({ error:'FORBIDDEN' }, 403);
  if(submission.ai_result_json){
    return jsonResponse({ result:submission.ai_result_json, cached:true });
  }

  const joinedWindow = Array.isArray(submission.verification_windows)
    ? submission.verification_windows[0]
    : submission.verification_windows;
  if(!joinedWindow || joinedWindow.user_id !== user.id){
    return jsonResponse({ error:'VERIFICATION_WINDOW_NOT_FOUND' }, 404);
  }

  const capturedAt = new Date(submission.captured_at).getTime();
  const scheduledAt = new Date(joinedWindow.scheduled_at).getTime();
  const expiresAt = new Date(joinedWindow.expires_at).getTime();
  if(!Number.isFinite(capturedAt) || capturedAt < scheduledAt - 60_000 || capturedAt > expiresAt + 60_000){
    return jsonResponse({ error:'CAPTURE_OUTSIDE_WINDOW' }, 409);
  }

  const { data:imageBlob, error:downloadError } = await serviceClient.storage
    .from('verification-photos')
    .download(submission.private_image_path);
  if(downloadError || !imageBlob) return jsonResponse({ error:'IMAGE_DOWNLOAD_FAILED' }, 500);
  if(imageBlob.size > 6 * 1024 * 1024) return jsonResponse({ error:'IMAGE_TOO_LARGE' }, 413);

  const imageBytes = new Uint8Array(await imageBlob.arrayBuffer());
  const mediaType = imageBlob.type || 'image/jpeg';
  const dataUrl = `data:${mediaType};base64,${bytesToBase64(imageBytes)}`;
  const isMeal = joinedWindow.challenge_type === 'meal';
  const challengeLabel = isMeal ? '식단' : '운동';
  const mealScoringGuide = isMeal
    ? [
        `식단 방식: ${mealMode === 'dining' ? '외식 식단' : '일반 식단'}`,
        `사용자 입력 메뉴명: ${menuName || '미입력'}`,
        `사용자 체크 항목: ${healthChoices.join(', ') || '없음'}`,
        `외식 유형: ${diningType || '해당 없음'}`,
        'meal_health_score는 사진에 실제로 보이는 식단을 중심으로 0~100점으로 평가한다.',
        '평가 기준: 채소·식이섬유 25점, 단백질 25점, 조리법·소스 20점, 탄수화물·양의 균형 20점, 식품 다양성 10점.',
        '사용자 입력은 참고만 하고 사진과 충돌하면 사진을 우선한다.',
        '50점 이하는 빨강, 51~69점은 경계, 70점 이상은 초록 기준이다.',
        'meal_feedback은 비난 없이 다음 끼니에 적용할 수 있는 짧은 한국어 한두 문장으로 쓴다.'
      ].join('\n')
    : '운동 인증이므로 meal_health_score와 meal_feedback은 null이어야 한다.';

  const aiResponse = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{
      'Authorization':`Bearer ${openAiKey}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:visionModel,
      store:false,
      instructions:[
        '당신은 D-CHAL 다이어트 챌린지의 사진 인증 판정기다.',
        '사진에 실제 식단 또는 운동 맥락이 보이는지와 D-CHAL 워터마크의 랜덤 코드를 확인한다.',
        '사람의 체형, 체중, 질병, 건강상태를 추측하지 않는다.',
        '식단의 정확한 칼로리를 추정하지 않는다.',
        '식단 점수는 의학적 평가가 아니라 사진에서 보이는 한 끼의 구성 균형에 대한 코칭 점수다.',
        '운동 사진 한 장으로 시간, 반복 횟수, 소모 칼로리를 추정하지 않는다.',
        '애매하면 confidence를 낮추고 manual_review_required를 true로 한다.',
        'user_message는 비난 없이 짧은 한국어로 작성한다.'
      ].join('\n'),
      input:[{
        role:'user',
        content:[
          {
            type:'input_text',
            text:[
              `인증 종류: ${challengeLabel}`,
              `서버가 발급한 오늘의 코드: ${joinedWindow.random_code}`,
              '배점: 활동 일치 0~40, 증거 완성도 0~40, 실시간 코드 증거 0~20.',
              'score는 세 항목 점수의 합계여야 한다.',
              '코드가 보이지 않거나 다르면 fresh_capture_proof는 0이고 valid는 false다.',
              '사진이 인증 종류와 명확히 맞지 않으면 valid는 false다.',
              mealScoringGuide
            ].join('\n')
          },
          {
            type:'input_image',
            image_url:dataUrl,
            detail:'low'
          }
        ]
      }],
      text:{
        format:{
          type:'json_schema',
          name:'dchal_verification_score',
          strict:true,
          schema:{
            type:'object',
            additionalProperties:false,
            properties:{
              valid:{ type:'boolean' },
              score:{ type:'integer', minimum:0, maximum:100 },
              confidence:{ type:'number', minimum:0, maximum:1 },
              activity_match:{ type:'integer', minimum:0, maximum:40 },
              evidence_completeness:{ type:'integer', minimum:0, maximum:40 },
              fresh_capture_proof:{ type:'integer', minimum:0, maximum:20 },
              reason_codes:{
                type:'array',
                maxItems:8,
                items:{ type:'string' }
              },
              manual_review_required:{ type:'boolean' },
              user_message:{ type:'string', maxLength:160 },
              meal_health_score:{ type:['integer','null'], minimum:0, maximum:100 },
              meal_feedback:{ type:['string','null'], maxLength:200 }
            },
            required:[
              'valid',
              'score',
              'confidence',
              'activity_match',
              'evidence_completeness',
              'fresh_capture_proof',
              'reason_codes',
              'manual_review_required',
              'user_message',
              'meal_health_score',
              'meal_feedback'
            ]
          }
        }
      }
    })
  });

  const aiPayload = await aiResponse.json();
  if(!aiResponse.ok){
    console.error('Vision API failed', aiResponse.status, aiPayload?.error?.code || 'unknown');
    return jsonResponse({ error:'AI_REQUEST_FAILED' }, 502);
  }

  const outputText = readOutputText(aiPayload);
  if(!outputText) return jsonResponse({ error:'AI_EMPTY_RESULT' }, 502);

  let rawResult: Record<string, unknown>;
  try{
    rawResult = JSON.parse(outputText);
  }catch{
    return jsonResponse({ error:'AI_INVALID_RESULT' }, 502);
  }

  const activityMatch = Math.round(clamp(rawResult.activity_match, 0, 40));
  const evidenceCompleteness = Math.round(clamp(rawResult.evidence_completeness, 0, 40));
  const freshCaptureProof = Math.round(clamp(rawResult.fresh_capture_proof, 0, 20));
  const score = activityMatch + evidenceCompleteness + freshCaptureProof;
  const confidence = clamp(rawResult.confidence, 0, 1);
  const valid = Boolean(rawResult.valid) && freshCaptureProof > 0;
  const manualReviewRequired = Boolean(rawResult.manual_review_required)
    || confidence < 0.8
    || !valid
    || Math.abs(score - 60) <= 5;
  const mealHealthScore = isMeal
    ? Math.round(clamp(rawResult.meal_health_score, 0, 100))
    : null;
  const mealCharacterTier = mealHealthScore === null
    ? null
    : mealHealthScore <= 50 ? 'alert' : mealHealthScore >= 70 ? 'good' : 'caution';

  const result: ScoreResult = {
    valid,
    score,
    confidence,
    activity_match:activityMatch,
    evidence_completeness:evidenceCompleteness,
    fresh_capture_proof:freshCaptureProof,
    reason_codes:Array.isArray(rawResult.reason_codes)
      ? rawResult.reason_codes.filter(code => typeof code === 'string').slice(0, 8)
      : [],
    manual_review_required:manualReviewRequired,
    user_message:typeof rawResult.user_message === 'string'
      ? rawResult.user_message.slice(0, 160)
      : '인증 사진 확인이 완료됐어요.',
    meal_health_score:mealHealthScore,
    meal_character_tier:mealCharacterTier,
    meal_feedback:isMeal && typeof rawResult.meal_feedback === 'string'
      ? rawResult.meal_feedback.slice(0, 200)
      : null,
    meal_mode:isMeal ? mealMode : null
  };

  const { error:updateError } = await serviceClient
    .from('photo_submissions')
    .update({
      ai_valid:result.valid,
      ai_score:result.score,
      ai_confidence:result.confidence,
      ai_result_json:result,
      review_status:result.valid && !result.manual_review_required ? 'approved' : 'pending',
      reviewed_at:result.valid && !result.manual_review_required ? new Date().toISOString() : null
    })
    .eq('id', submission.id);
  if(updateError) return jsonResponse({ error:'RESULT_SAVE_FAILED' }, 500);

  if(isMeal && result.valid && result.meal_health_score !== null && result.meal_character_tier){
    const { error:mealScoreError } = await serviceClient
      .from('meal_challenge_scores')
      .upsert({
        user_id:user.id,
        submission_id:submission.id,
        meal_mode:mealMode,
        health_score:result.meal_health_score,
        character_tier:result.meal_character_tier,
        menu_name:menuName || null,
        scored_at:new Date().toISOString()
      }, { onConflict:'submission_id' });
    if(mealScoreError) console.warn('MEAL_SCORE_SAVE_FAILED', mealScoreError.message);
  }

  await serviceClient
    .from('verification_windows')
    .update({ status:'submitted', submitted_at:new Date().toISOString() })
    .eq('id', joinedWindow.id)
    .eq('user_id', user.id);

  return jsonResponse({ result });
});
