(() => {
  'use strict';

  const state = {
    stream: null,
    photoBlob: null,
    previewUrl: '',
    verificationWindow: null,
    countdownTimer: null,
    submitting: false,
    submissionId: '',
    serviceWorkerRegistration: null,
    mealMode: window.DchalSelectedMealMode || '',
    mealMetadata: null
  };

  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));

  function getSupabaseClient(){
    try{
      return typeof dchalSupabase !== 'undefined' ? dchalSupabase : null;
    }catch{
      return null;
    }
  }

  async function waitForSupabaseClient(timeoutMs = 2200){
    const startedAt = Date.now();
    while(Date.now() - startedAt < timeoutMs){
      const client = getSupabaseClient();
      if(client) return client;
      await wait(80);
    }
    return null;
  }

  function setCameraStatus(message, type = ''){
    const el = $('cameraStatus');
    if(!el) return;
    el.textContent = message;
    el.className = 'camera-status' + (type ? ' ' + type : '');
  }

  function setPushStatus(message, type = ''){
    const el = $('pushPermissionStatus');
    if(!el) return;
    el.textContent = message;
    el.className = 'alarm-permission-status' + (type ? ' ' + type : '');
  }

  function makeLocalVerificationWindow(){
    const now = new Date();
    const storedKey = `dchal-demo-code-${now.toISOString().slice(0, 10)}`;
    let randomCode = localStorage.getItem(storedKey);
    if(!randomCode){
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      randomCode = 'D' + Array.from({ length:4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
      localStorage.setItem(storedKey, randomCode);
    }
    return {
      id: '',
      challenge_type: state.mealMode ? 'meal' : 'workout',
      random_code: randomCode,
      scheduled_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      status: 'opened',
      is_demo: true
    };
  }

  async function loadVerificationWindow(){
    const params = new URLSearchParams(location.search);
    const requestedId = params.get('verification');
    const client = await waitForSupabaseClient();

    if(client){
      const { data:{ user } } = await client.auth.getUser();
      if(user){
        let query = client
          .from('verification_windows')
          .select('id, challenge_type, random_code, scheduled_at, expires_at, status');

        if(requestedId){
          query = query.eq('id', requestedId);
        }else{
          query = query
            .in('status', ['scheduled', 'opened'])
            .lte('scheduled_at', new Date().toISOString())
            .gte('expires_at', new Date().toISOString())
            .order('scheduled_at', { ascending:false });
        }

        const { data, error } = await query.limit(1).maybeSingle();
        if(!error && data){
          state.verificationWindow = { ...data, is_demo:false };
          if(data.status === 'scheduled'){
            await client
              .from('verification_windows')
              .update({ status:'opened', opened_at:new Date().toISOString() })
              .eq('id', data.id)
              .eq('user_id', user.id);
            state.verificationWindow.status = 'opened';
          }
          return state.verificationWindow;
        }
      }
    }

    state.verificationWindow = makeLocalVerificationWindow();
    return state.verificationWindow;
  }

  function applyVerificationWindow(windowData){
    const isMeal = windowData.challenge_type === 'meal';
    const mealLabel = state.mealMode === 'dining' ? '🥢 외식 식단 인증' : '🍱 일반 식단 인증';
    $('verificationTypeLabel').textContent = isMeal ? mealLabel : '🏋️ 운동 인증';
    $('verificationCode').textContent = windowData.random_code || 'DCHAL';
    $('cameraHelp').textContent = isMeal
      ? `${state.mealMode === 'dining' ? '외식 메뉴' : '식단'}과 그릇 전체가 프레임 안에 보이게 찍어주세요.`
      : '운동 중인 모습이나 운동 도구가 프레임 안에 보이게 찍어주세요.';
    startCountdown(new Date(windowData.expires_at).getTime());
  }

  function startCountdown(deadline){
    window.clearInterval(state.countdownTimer);

    const render = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const totalSeconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const el = $('verificationCountdown');
      if(!el) return;
      el.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      el.classList.toggle('urgent', remaining > 0 && remaining <= 2 * 60 * 1000);
      if(remaining <= 0){
        window.clearInterval(state.countdownTimer);
        setCameraStatus('인증 시간이 끝났어요. 제출하지 않았다면 미완주로 기록됩니다.', 'error');
        $('submitPhotoBtn')?.setAttribute('disabled', 'disabled');
      }
    };

    render();
    state.countdownTimer = window.setInterval(render, 1000);
  }

  function resetCaptureUi(){
    state.photoBlob = null;
    if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = '';
    $('verificationPreview')?.removeAttribute('src');
    $('cameraStage')?.classList.remove('has-preview');
    $('cameraReviewActions').hidden = true;
    $('capturePhotoBtn').hidden = true;
    $('startCameraBtn').hidden = false;
    $('startCameraBtn').disabled = false;
    $('startCameraBtn').textContent = '카메라 허용하고 인증하기';
    $('cameraFileFallback').hidden = true;
    setCameraStatus('');
  }

  function stopCamera(){
    if(state.stream){
      state.stream.getTracks().forEach(track => track.stop());
      state.stream = null;
    }
    const video = $('verificationVideo');
    if(video) video.srcObject = null;
    $('cameraStage')?.classList.remove('is-live');
  }

  function pauseCamera(){
    if(!state.submitting) stopCamera();
  }

  async function open(){
    if(state.submitting) return;
    if(!state.verificationWindow){
      const verificationWindow = await loadVerificationWindow();
      applyVerificationWindow(verificationWindow);
    }else{
      applyVerificationWindow(state.verificationWindow);
    }

    if(state.photoBlob) return;

    if(!window.isSecureContext && location.hostname !== 'localhost'){
      setCameraStatus('카메라는 HTTPS로 배포한 주소에서만 사용할 수 있어요.', 'error');
      $('cameraFileFallback').hidden = false;
      return;
    }

    try{
      if(navigator.permissions?.query){
        const permission = await navigator.permissions.query({ name:'camera' });
        if(permission.state === 'granted') await startCamera();
      }
    }catch{
      // Safari does not expose camera through the Permissions API.
    }
  }

  async function startCamera(){
    if(!navigator.mediaDevices?.getUserMedia){
      setCameraStatus('이 브라우저는 실시간 카메라를 지원하지 않아요. 카메라 앱을 사용해주세요.', 'error');
      $('cameraFileFallback').hidden = false;
      return;
    }

    const button = $('startCameraBtn');
    button.disabled = true;
    button.textContent = '카메라 여는 중…';
    setCameraStatus('카메라 권한을 확인하고 있어요.');
    stopCamera();

    try{
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio:false,
        video:{
          facingMode:{ ideal:'environment' },
          width:{ ideal:1280 },
          height:{ ideal:1280 }
        }
      });
      const video = $('verificationVideo');
      video.srcObject = state.stream;
      await video.play();
      $('cameraStage').classList.add('is-live');
      $('cameraStage').classList.remove('has-preview');
      button.hidden = true;
      $('capturePhotoBtn').hidden = false;
      $('cameraFileFallback').hidden = true;
      setCameraStatus('프레임을 맞춘 뒤 동그란 버튼을 눌러주세요.');
    }catch(error){
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setCameraStatus(
        denied
          ? '카메라 권한이 꺼져 있어요. 브라우저 설정에서 카메라를 허용해주세요.'
          : '카메라를 열지 못했어요. 아래 카메라 앱 촬영을 이용해주세요.',
        'error'
      );
      button.hidden = false;
      button.disabled = false;
      button.textContent = '카메라 다시 열기';
      $('cameraFileFallback').hidden = false;
    }
  }

  function drawWatermark(ctx, width, height){
    const code = state.verificationWindow?.random_code || 'DCHAL';
    const capturedAt = new Intl.DateTimeFormat('ko-KR', {
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      second:'2-digit',
      hour12:false
    }).format(new Date());
    const stripHeight = Math.max(92, Math.round(height * .09));

    ctx.save();
    ctx.fillStyle = 'rgba(30, 22, 25, .76)';
    ctx.fillRect(0, height - stripHeight, width, stripHeight);
    ctx.fillStyle = '#FFC857';
    ctx.font = `800 ${Math.max(24, Math.round(width * .034))}px sans-serif`;
    ctx.fillText(`D-CHAL  ${code}`, Math.round(width * .035), height - Math.round(stripHeight * .52));
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 ${Math.max(16, Math.round(width * .021))}px sans-serif`;
    ctx.fillText(capturedAt, Math.round(width * .035), height - Math.round(stripHeight * .2));
    ctx.restore();
  }

  async function canvasToBlob(canvas){
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if(blob) resolve(blob);
        else reject(new Error('PHOTO_ENCODING_FAILED'));
      }, 'image/jpeg', .86);
    });
  }

  async function setCapturedCanvas(canvas){
    state.photoBlob = await canvasToBlob(canvas);
    if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(state.photoBlob);
    $('verificationPreview').src = state.previewUrl;
    $('cameraStage').classList.remove('is-live');
    $('cameraStage').classList.add('has-preview');
    $('capturePhotoBtn').hidden = true;
    $('startCameraBtn').hidden = true;
    $('cameraFileFallback').hidden = true;
    $('cameraReviewActions').hidden = false;
    setCameraStatus('사진을 확인한 뒤 AI 판정을 시작해주세요.');
    stopCamera();
  }

  async function capturePhoto(){
    const video = $('verificationVideo');
    if(!video?.videoWidth || !video?.videoHeight){
      setCameraStatus('카메라 화면이 준비될 때까지 잠시 기다려주세요.', 'error');
      return;
    }

    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = $('verificationCanvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d', { alpha:false });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawWatermark(ctx, canvas.width, canvas.height);
    await setCapturedCanvas(canvas);
  }

  async function useCameraFile(file){
    if(!file) return;
    if(!file.type.startsWith('image/')){
      setCameraStatus('사진 파일만 사용할 수 있어요.', 'error');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try{
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = objectUrl;
      });
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = $('verificationCanvas');
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext('2d', { alpha:false });
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      drawWatermark(ctx, canvas.width, canvas.height);
      await setCapturedCanvas(canvas);
    }catch{
      setCameraStatus('사진을 불러오지 못했어요. 다시 촬영해주세요.', 'error');
    }finally{
      URL.revokeObjectURL(objectUrl);
      $('cameraFileInput').value = '';
    }
  }

  async function retakePhoto(){
    resetCaptureUi();
    await startCamera();
  }

  function mealTier(score){
    if(score <= 50) return 'alert';
    if(score >= 70) return 'good';
    return 'caution';
  }

  function demoMealHealthScore(metadata){
    const choices = Array.isArray(metadata?.choices) ? metadata.choices : [];
    const menuName = String(metadata?.menuName || '');
    const healthyWords = ['채소','샐러드','두부','닭','생선','계란','달걀','구이','찜','현미','비빔'];
    const cautionWords = ['튀김','라면','크림','치즈','버터','케이크','탄산','달콤'];
    const healthyHits = healthyWords.filter(word => menuName.includes(word)).length;
    const cautionHits = cautionWords.filter(word => menuName.includes(word)).length;
    const signal = [...menuName].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7 - 3;
    return Math.max(20, Math.min(96, 30 + choices.length * 12 + Math.min(2, healthyHits) * 5 - Math.min(2, cautionHits) * 6 + signal));
  }

  function demoScore(metadata = state.mealMetadata){
    const isMeal = state.verificationWindow?.challenge_type === 'meal';
    const mealHealthScore = isMeal ? demoMealHealthScore(metadata) : null;
    const tier = isMeal ? mealTier(mealHealthScore) : null;
    return {
      valid:true,
      score:isMeal ? 84 : 82,
      confidence:.74,
      activity_match:isMeal ? 35 : 33,
      evidence_completeness:isMeal ? 32 : 31,
      fresh_capture_proof:17,
      reason_codes:['DEMO_MODE', 'FRESH_CODE_VISIBLE'],
      manual_review_required:true,
      user_message:isMeal
        ? '식단과 오늘의 인증 코드가 확인됐어요.'
        : '운동 인증 장면과 오늘의 코드가 확인됐어요.',
      meal_health_score:mealHealthScore,
      meal_character_tier:tier,
      meal_feedback:isMeal
        ? tier === 'good'
          ? '채소·단백질·양의 균형이 잘 보여요.'
          : tier === 'caution'
            ? '기본 균형은 좋아요. 채소나 단백질을 하나 더해보세요.'
            : '건강선택을 충분히 찾지 못했어요. 다음 끼니에 한 가지만 더해봐요.'
        : null,
      demo:true
    };
  }

  async function submitToBackend(metadata = state.mealMetadata){
    const client = await waitForSupabaseClient();
    if(!client) throw new Error('BACKEND_NOT_CONNECTED');

    const { data:{ user }, error:userError } = await client.auth.getUser();
    if(userError || !user) throw new Error('AUTH_REQUIRED');

    if(!state.verificationWindow?.id || state.verificationWindow.is_demo){
      if(state.mealMode) throw new Error('NO_ACTIVE_MEAL_WINDOW');
      state.verificationWindow = null;
      const activeWindow = await loadVerificationWindow();
      if(!activeWindow.id || activeWindow.is_demo) throw new Error('NO_ACTIVE_WINDOW');
      applyVerificationWindow(activeWindow);
    }

    const photoPath = `${user.id}/${state.verificationWindow.id}/${Date.now()}.jpg`;
    const { error:uploadError } = await client.storage
      .from('verification-photos')
      .upload(photoPath, state.photoBlob, {
        contentType:'image/jpeg',
        cacheControl:'3600',
        upsert:false
      });
    if(uploadError) throw uploadError;

    const { data:submission, error:insertError } = await client
      .from('photo_submissions')
      .insert({
        verification_window_id:state.verificationWindow.id,
        user_id:user.id,
        private_image_path:photoPath,
        captured_at:new Date().toISOString()
      })
      .select('id')
      .single();

    if(insertError){
      await client.storage.from('verification-photos').remove([photoPath]);
      throw insertError;
    }

    state.submissionId = submission.id;
    const { data, error } = await client.functions.invoke('score-verification', {
      body:{
        submission_id:submission.id,
        meal_mode:state.mealMode || null,
        menu_name:metadata?.menuName || null,
        health_choices:Array.isArray(metadata?.choices) ? metadata.choices : [],
        dining_type:metadata?.diningType || null
      }
    });
    if(error) throw error;
    if(!data?.result) throw new Error(data?.message || 'AI_RESULT_MISSING');
    return { ...data.result, demo:false };
  }

  function animateScore(target){
    const el = $('aiScore');
    const safeTarget = Math.max(0, Math.min(100, Number(target) || 0));
    const startedAt = performance.now();
    const duration = 700;
    const tick = now => {
      const progress = Math.min(1, (now - startedAt) / duration);
      el.textContent = Math.round(safeTarget * (1 - Math.pow(1 - progress, 3)));
      if(progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function renderResult(result){
    const valid = Boolean(result.valid);
    const isMeal = state.verificationWindow?.challenge_type === 'meal'
      || Number.isFinite(Number(result.meal_health_score));
    const healthScore = isMeal
      ? Math.max(0, Math.min(100, Number(result.meal_health_score) || 0))
      : Number(result.score) || 0;
    const tier = isMeal ? (result.meal_character_tier || mealTier(healthScore)) : '';
    const tierConfig = {
      alert:{ label:'빨강 · 균형을 더해봐요', image:'dining-character-alert.webp' },
      caution:{ label:'경계 · 한 가지만 더', image:'dining-character-caution.webp' },
      good:{ label:'초록 · 균형 잡힌 선택', image:'dining-character-good.webp' }
    };
    $('aiProcessing').hidden = true;
    $('aiResultCard').hidden = false;
    $('aiResultBadge').className = 'ai-result-badge';
    if(isMeal){
      const config = tierConfig[tier] || tierConfig.caution;
      $('aiMetricList').hidden = true;
      if(valid){
        $('aiResultBadge').textContent = config.label;
        $('aiResultBadge').classList.add(`tier-${tier}`);
        $('aiMealCharacterWrap').hidden = false;
        $('aiMealCharacter').src = config.image;
        $('aiMealCharacter').alt = `${config.label} 식단 챌린지 캐릭터`;
        $('aiResultTitle').textContent = 'AI 식단 분석 완료';
        $('aiResultMessage').textContent = result.meal_feedback || result.user_message || '오늘의 식단 점수를 확인했어요.';
        const mealScore = document.querySelector('.sc-meal');
        const mealFill = document.querySelector('.score-fill.meal');
        const mealNote = document.querySelector('.score-card .score-note');
        if(mealScore) mealScore.textContent = `${Math.round(healthScore)}점`;
        if(mealFill) mealFill.style.width = `${healthScore}%`;
        if(mealNote) mealNote.textContent = config.label;
      }else{
        $('aiResultBadge').textContent = '사진 확인 필요';
        $('aiResultBadge').classList.add('invalid');
        $('aiMealCharacterWrap').hidden = true;
        $('aiResultTitle').textContent = '사진을 한 번 더 확인해주세요';
        $('aiResultMessage').textContent = result.user_message || '식단 전체가 보이는 사진으로 다시 인증해주세요.';
      }
    }else{
      $('aiResultBadge').textContent = valid ? '인증 완료' : '확인 필요';
      $('aiResultBadge').classList.toggle('invalid', !valid);
      $('aiMealCharacterWrap').hidden = true;
      $('aiResultTitle').textContent = valid ? '오늘도 해냈어요!' : '사진을 한 번 더 확인해주세요';
      $('aiResultMessage').textContent = result.user_message || '인증 결과를 확인했어요.';
      $('aiMetricList').hidden = false;
    }
    $('aiActivityScore').textContent = `${result.activity_match ?? 0}/40`;
    $('aiEvidenceScore').textContent = `${result.evidence_completeness ?? 0}/40`;
    $('aiFreshScore').textContent = `${result.fresh_capture_proof ?? 0}/20`;
    $('aiConfidence').textContent = `AI 신뢰도 ${Math.round((Number(result.confidence) || 0) * 100)}%`;
    $('aiDemoNote').hidden = !result.demo;
    $('aiAppealBtn').hidden = !result.manual_review_required || result.demo;
    animateScore(valid ? healthScore : 0);
  }

  async function submitPhoto(metadata = state.mealMetadata){
    if(!state.photoBlob || state.submitting) return;
    state.submitting = true;
    $('submitPhotoBtn').disabled = true;
    $('submitPhotoBtn').textContent = '업로드 중…';
    stopCamera();
    go('s3d');
    $('aiProcessing').hidden = false;
    $('aiResultCard').hidden = true;

    const startedAt = Date.now();
    let result;
    try{
      result = await submitToBackend(metadata);
    }catch(error){
      console.warn('D-CHAL verification backend fallback:', error);
      result = demoScore(metadata);
      const reason = String(error?.message || '');
      if(reason.includes('AUTH_REQUIRED')){
        result.user_message = '휴대폰 인증 후 실제 AI 판정을 사용할 수 있어요. 지금은 체험 결과예요.';
      }else if(reason.includes('NO_ACTIVE_WINDOW')){
        result.user_message = '현재 열린 서버 인증 시간이 없어 체험 결과로 보여드려요.';
      }
    }

    const remainingDelay = Math.max(0, 1450 - (Date.now() - startedAt));
    await wait(remainingDelay);
    renderResult(result);
    state.submitting = false;
    return result;
  }

  async function requestAppeal(){
    if(!state.submissionId) return;
    const client = getSupabaseClient();
    if(!client) return;
    const button = $('aiAppealBtn');
    button.disabled = true;
    button.textContent = '요청 중…';
    const { error } = await client
      .from('photo_submissions')
      .update({ review_status:'appealed', appealed_at:new Date().toISOString() })
      .eq('id', state.submissionId);
    button.textContent = error ? '요청 실패 · 다시 누르기' : '재심 요청됨';
    button.disabled = !error;
  }

  function urlBase64ToUint8Array(base64String){
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  }

  async function registerServiceWorker(){
    if(!('serviceWorker' in navigator) || (!window.isSecureContext && location.hostname !== 'localhost')){
      return null;
    }
    try{
      state.serviceWorkerRegistration = await navigator.serviceWorker.register('./sw.js');
      return state.serviceWorkerRegistration;
    }catch(error){
      console.warn('D-CHAL service worker registration failed:', error);
      return null;
    }
  }

  async function enablePushNotifications(){
    const button = $('enablePushBtn');
    if(!('Notification' in window)){
      setPushStatus('이 브라우저는 푸시 알림을 지원하지 않아요.', 'error');
      return;
    }
    if(!window.isSecureContext && location.hostname !== 'localhost'){
      setPushStatus('알림은 HTTPS 배포 주소에서만 켤 수 있어요.', 'error');
      return;
    }

    button.disabled = true;
    setPushStatus('알림 권한을 요청하고 있어요.');
    const permission = await Notification.requestPermission();
    if(permission !== 'granted'){
      button.disabled = false;
      setPushStatus('알림이 차단됐어요. 브라우저 설정에서 알림을 허용해주세요.', 'error');
      return;
    }

    const registration = state.serviceWorkerRegistration || await registerServiceWorker();
    if(!registration){
      button.disabled = false;
      setPushStatus('알림 서비스를 준비하지 못했어요. 배포 후 다시 시도해주세요.', 'error');
      return;
    }

    const vapidPublicKey = window.DCHAL_SUPABASE_CONFIG?.vapidPublicKey;
    if(!vapidPublicKey){
      button.textContent = '권한 허용됨';
      setPushStatus('브라우저 알림 권한은 켜졌어요. 서버 푸시 키를 연결하면 시간 알림이 활성화돼요.', 'success');
      return;
    }

    try{
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:urlBase64ToUint8Array(vapidPublicKey)
      });
      const json = subscription.toJSON();
      const client = await waitForSupabaseClient();
      const { data:{ user } } = client ? await client.auth.getUser() : { data:{ user:null } };
      if(!client || !user) throw new Error('AUTH_REQUIRED');

      const { error } = await client.from('push_subscriptions').upsert({
        user_id:user.id,
        endpoint:json.endpoint,
        p256dh:json.keys?.p256dh,
        auth:json.keys?.auth,
        user_agent:navigator.userAgent,
        updated_at:new Date().toISOString()
      }, { onConflict:'endpoint' });
      if(error) throw error;

      button.textContent = '알림 켜짐';
      setPushStatus('정해진 인증 시간에 이 기기로 알려드릴게요.', 'success');
    }catch(error){
      button.disabled = false;
      setPushStatus(
        String(error?.message).includes('AUTH_REQUIRED')
          ? '휴대폰 인증을 완료한 뒤 서버 시간 알림을 켤 수 있어요.'
          : '푸시 알림 연결에 실패했어요. 잠시 후 다시 시도해주세요.',
        'error'
      );
    }
  }

  function syncPushPermissionUi(){
    if(!('Notification' in window)) return;
    if(Notification.permission === 'granted'){
      $('enablePushBtn').textContent = '알림 권한 허용됨';
      setPushStatus('서버 푸시 연결 상태를 확인할 수 있어요.', 'success');
    }else if(Notification.permission === 'denied'){
      $('enablePushBtn').textContent = '알림 차단됨';
      setPushStatus('브라우저 설정에서 알림을 허용해주세요.', 'error');
    }
  }

  function collectVerificationSchedules(){
    const schedules = [];
    const visibleMealList = [...document.querySelectorAll('.meal-slots')]
      .find(list => getComputedStyle(list).display !== 'none');

    visibleMealList?.querySelectorAll('.slot-row').forEach((row, index) => {
      const time = row.querySelector('.slot-time-input')?.value;
      if(!time) return;
      schedules.push({
        challenge_type:'meal',
        label:row.querySelector('.slot-name')?.textContent?.trim() || `식사 ${index + 1}`,
        local_time:time,
        timezone:'Asia/Seoul',
        days_of_week:[1, 2, 3, 4, 5, 6, 7],
        window_minutes:10
      });
    });

    const workoutGroup = [...document.querySelectorAll('.field-group')]
      .find(group => group.querySelector('.field-label')?.textContent?.includes('운동 인증 시간'));
    const workoutTime = workoutGroup?.querySelector('.slot-time-input')?.value;
    if(workoutTime){
      schedules.push({
        challenge_type:'workout',
        label:'운동',
        local_time:workoutTime,
        timezone:'Asia/Seoul',
        days_of_week:[1, 2, 3, 4, 5, 6, 7],
        window_minutes:10
      });
    }
    return schedules;
  }

  async function syncPendingSchedules(){
    let schedules;
    try{
      schedules = JSON.parse(localStorage.getItem('dchal-pending-schedules') || '[]');
    }catch{
      schedules = [];
    }
    if(!Array.isArray(schedules) || schedules.length === 0) return false;

    const client = await waitForSupabaseClient();
    if(!client) return false;
    const { data:{ user } } = await client.auth.getUser();
    if(!user) return false;

    const { error } = await client.rpc('replace_my_verification_schedules', {
      p_schedules:schedules
    });
    if(error){
      console.warn('D-CHAL schedule sync failed:', error.message);
      return false;
    }

    localStorage.removeItem('dchal-pending-schedules');
    localStorage.setItem('dchal-schedules-synced-at', new Date().toISOString());
    return true;
  }

  async function saveSchedulesAndContinue(){
    const button = document.querySelector('#s1 .cta-fixed .btn-primary');
    const schedules = collectVerificationSchedules();
    localStorage.setItem('dchal-pending-schedules', JSON.stringify(schedules));
    window.saveMatchPreferences?.();

    if(button){
      button.disabled = true;
      button.textContent = '인증 시간 저장 중…';
    }

    // 서버 연결이 느려도 화면 이동을 막지 않습니다. 설정은 이미 기기에
    // 저장됐고, 로그인된 경우에만 백그라운드에서 Supabase와 동기화합니다.
    go('s2');
    Promise.race([
      syncPendingSchedules(),
      wait(4500).then(() => false)
    ]).catch(error => {
      console.warn('D-CHAL background schedule sync failed:', error);
    }).finally(() => {
      if(button){
        button.disabled = false;
        button.textContent = '인증 시간 저장하고 상대 찾기 →';
      }
    });
  }

  function setMealMode(mode){
    state.mealMode = mode === 'dining' ? 'dining' : 'regular';
    window.DchalSelectedMealMode = state.mealMode;
    if(state.verificationWindow?.is_demo){
      state.verificationWindow.challenge_type = 'meal';
    }
  }

  async function submitMealForm(file, mode, metadata){
    if(!file || !file.type?.startsWith('image/')) throw new Error('MEAL_PHOTO_REQUIRED');
    setMealMode(mode);
    state.mealMetadata = {
      menuName:String(metadata?.menuName || '').slice(0, 80),
      choices:Array.isArray(metadata?.choices) ? metadata.choices.slice(0, 8) : [],
      diningType:String(metadata?.diningType || '').slice(0, 40)
    };
    if(!state.verificationWindow || state.verificationWindow.challenge_type !== 'meal'){
      state.verificationWindow = null;
      const client = await waitForSupabaseClient();
      const authResult = client ? await client.auth.getUser() : null;
      const user = authResult?.data?.user || null;
      if(client && user){
        const { data, error } = await client.rpc('open_my_meal_verification_window');
        const openedWindow = Array.isArray(data) ? data[0] : data;
        if(!error && openedWindow) state.verificationWindow = openedWindow;
        else if(error) console.warn('Meal verification window open failed:', error);
      }
      if(!state.verificationWindow) state.verificationWindow = makeLocalVerificationWindow();
    }
    applyVerificationWindow(state.verificationWindow);
    await useCameraFile(file);
    if(!state.photoBlob) throw new Error('MEAL_PHOTO_PREPARATION_FAILED');
    const result = await submitPhoto(state.mealMetadata);
    state.verificationWindow = null;
    return result;
  }

  function openFromDeepLink(){
    const params = new URLSearchParams(location.search);
    if(params.has('verification')){
      window.setTimeout(() => go('s3'), 120);
    }
  }

  $('cameraFileInput')?.addEventListener('change', event => useCameraFile(event.target.files?.[0]));
  $('aiAppealBtn')?.addEventListener('click', requestAppeal);
  document.addEventListener('visibilitychange', () => {
    if(document.hidden) pauseCamera();
  });
  window.addEventListener('beforeunload', stopCamera);

  window.DchalVerification = {
    open,
    pauseCamera,
    startCamera,
    capturePhoto,
    retakePhoto,
    submitPhoto,
    submitMealForm,
    setMealMode,
    enablePushNotifications,
    syncPendingSchedules,
    saveSchedulesAndContinue
  };

  resetCaptureUi();
  registerServiceWorker();
  syncPushPermissionUi();
  openFromDeepLink();
})();
