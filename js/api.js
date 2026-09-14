// api.js — STEP 3. Supabase 클라이언트 초기화 및 공통 호출 래퍼.
// createClient는 index.html에서 로드된 supabase-js 전역을 사용한다 (STEP 1 골격 유지, CDN 스크립트는 index.html에서 추가).
import { CONFIG } from './config.js';

export const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
