// config.js — STEP 3. 공개 가능한 환경 설정.
// SUPABASE_ANON_KEY는 클라이언트 노출이 설계 전제인 publishable key이며 비밀키가 아니다.
// 실제 값은 V1과 동일한 motorrad-pulse 프로젝트의 URL/anon key를 넣는다 (V2도 같은 프로젝트를 공유하므로).
export const CONFIG = {
  SUPABASE_URL: 'https://kuphyemtyamglvyjpvwh.supabase.co',       // TODO: motorrad-pulse project URL 입력
  SUPABASE_ANON_KEY: 'sb_publishable_eOUPEa1xtZP5FbOoEuiWUw_2M1_Q5c5'   // TODO: motorrad-pulse anon/publishable key 입력
};
