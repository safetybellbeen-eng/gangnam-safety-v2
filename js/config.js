// config.js — STEP 4. 공개 가능한 환경 설정.

// SUPABASE_ANON_KEY는 클라이언트 노출이 설계 전제인 publishable key이며 비밀키가 아니다.

// 실제 값은 V1과 동일한 motorrad-pulse 프로젝트의 URL/anon key를 넣는다 (V2도 같은 프로젝트를 공유하므로).

// KAKAO_JS_KEY는 Kakao Maps JavaScript SDK용 키(도메인 제한으로 보호되는 클라이언트 키)이며,

// REST API Key와는 다른 키다. REST Key는 STEP 4에서 사용하지 않는다(CLAUDE.md: STEP 11 전까지 금지).

export const CONFIG = {
  SUPABASE_URL: 'https://kuphyemtyamglvyjpvwh.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_eOUPEa1xtZP5FbOoEuiWUw_2M1_Q5c5',
  KAKAO_JS_KEY: '120b5bb6ea3f8f79aa298231e1a6c04e'
};
