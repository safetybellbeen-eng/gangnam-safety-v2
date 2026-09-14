// sites.js — STEP 6A. gnmap_v2_sites 조회 + 검색/정렬 파생 처리.
import { sb } from './api.js';
import { state } from './state.js';

const SITE_COLUMNS = 'id, company_name, site_name, address, lat, lng, dong, amount, status, is_active';

// is_active=true인 사업장을 전부 조회한다. 좌표 유무로 조회 자체를 제한하지 않는다 —
// 좌표 없는 사업장도 목록에는 표시되어야 하며, 마커 생성 여부만 map.js의 좌표 검증이 담당한다.
export async function loadActiveSites() {
  const { data, error } = await sb
    .from('gnmap_v2_sites')
    .select(SITE_COLUMNS)
    .eq('is_active', true);

  if (error) {
    console.error('사업장 조회 실패:', error);
    return [];
  }
  return data || [];
}

function matchesQuery(site, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const fields = [site.site_name, site.company_name, site.address, site.dong];
  return fields.some(f => (f || '').toString().toLowerCase().includes(q));
}

function toSafeAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function compareBySort(a, b, sortMode) {
  switch (sortMode) {
    case 'name-asc':
      return (a.site_name || '').localeCompare(b.site_name || '', 'ko');
    case 'company-asc':
      return (a.company_name || '').localeCompare(b.company_name || '', 'ko');
    case 'amount-desc':
      return toSafeAmount(b.amount) - toSafeAmount(a.amount);
    case 'amount-asc':
      return toSafeAmount(a.amount) - toSafeAmount(b.amount);
    default:
      return 0; // 'default': Supabase 조회 결과 순서 유지 (sort 비교 없음)
  }
}

// state.sites를 원본 그대로 두고, 복사본에서 검색 필터 → 정렬을 적용해 반환한다.
// UI/marker는 이 파생 배열만 받아서 렌더한다.
export function getFilteredSortedSites() {
  const query = (state.searchQuery || '').trim();
  const filtered = state.sites.filter(site => matchesQuery(site, query));

  if (state.sortMode === 'default') return filtered;

  return [...filtered].sort((a, b) => compareBySort(a, b, state.sortMode));
}
