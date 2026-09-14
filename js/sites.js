// sites.js — STEP 5A. gnmap_v2_sites 조회. RLS가 approved 사용자만 select를 허용한다.
// 마커 생성/지도 조작은 map.js 책임, 여기서는 데이터 조회만 담당.
import { sb } from './api.js';

const SITE_COLUMNS = 'id, company_name, site_name, address, lat, lng, dong, amount, status, is_active';

// is_active=true이고 lat/lng가 모두 있는 사업장만 조회한다.
// 실패 시 예외를 던지지 않고 빈 배열을 반환해 앱 전체가 죽지 않도록 한다 (호출부 app.js에서 재확인).
export async function loadActiveSites() {
  const { data, error } = await sb
    .from('gnmap_v2_sites')
    .select(SITE_COLUMNS)
    .eq('is_active', true)
    .not('lat', 'is', null)
    .not('lng', 'is', null);

  if (error) {
    console.error('사업장 조회 실패:', error);
    return [];
  }
  return data || [];
}
