// config.js — STEP 3. 공개 가능한 환경 설정.
export const CONFIG = {
  SUPABASE_URL: 'https://kuphyemtyamglvyjpvwh.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_eOUPEa1xtZP5FbOoEuiWUw_2M1_Q5c5',
  KAKAO_JS_KEY: '120b5bb6ea3f8f79aa298231e1a6c04e',
  // 모바일 "더보기 > 버전 정보"에 표시할 값. sw.js의 CACHE_VERSION과 같은 값을 쓴다
  // (자동 동기화는 아님 — sw.js CACHE_VERSION을 올릴 때 이 값도 함께 수정해야 한다).
  // TARGET 목업의 "v1.0.0"을 그대로 하드코딩하지 않기 위해 실제 배포 버전 표기를 재사용한다.
  APP_VERSION: 'v6'
};
