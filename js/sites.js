// sites.js — STEP 6A. gnmap_v2_sites 조회 + 검색/정렬 파생 처리.
import { sb } from './api.js';
import { state } from './state.js';

const SITE_COLUMNS = 'id, company_name, site_name, address, lat, lng, dong, amount, status, is_active, location_quality, period_start, period_end, supervision_count, accident_report_count';

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

// 사용자 요청: "관할" 필터를 복수 선택으로 바꾼다. selectedDongs가 빈 배열이면 전체(필터 없음).
function matchesDongs(site, selectedDongs) {
  if (!Array.isArray(selectedDongs) || selectedDongs.length === 0) return true;
  if (site.dong === null || site.dong === undefined) return false;
  const siteDong = typeof site.dong === 'string' ? site.dong.trim() : site.dong;
  return selectedDongs.some(d => (typeof d === 'string' ? d.trim() : d) === siteDong);
}

// 금액 구간 경계(원 단위). 1억=100000000, 50억=5000000000, 120억=12000000000.
// 사용자 요청: 기존 5구간(1억/10억/50억/120억)을 50억/120억 기준 3구간으로 단순화.
const AMOUNT_RANGES = {
  'under-5b': { min: -Infinity, max: 5000000000 },   // 50억 미만
  '5b-12b': { min: 5000000000, max: 12000000000 },    // 50억 이상 ~ 120억 미만
  'over-12b': { min: 12000000000, max: Infinity }      // 120억 이상
};

// amount가 숫자로 변환 불가능하거나 비어있으면 '전체'가 아닌 구간 선택 시 결과에서 제외한다.
function matchesAmount(site, amountFilter) {
  if (!amountFilter || amountFilter === 'all') return true;
  const raw = site.amount;
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return false;
  const range = AMOUNT_RANGES[amountFilter];
  if (!range) return true;
  return n >= range.min && n < range.max;
}

function toSafeAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// period_end가 없는 사업장은 Infinity로 취급해 오름차순 정렬 시 항상 맨 뒤로 밀린다(상단에 오지 않도록).
function toSortableEndTime(v) {
  if (!v) return Infinity;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : Infinity;
}

// 사용자 요청: "점검"(gnmap_v2_sites.supervision_count) / "산재표"(accident_report_count)
// 유/무 필터. 값이 1 이상이면 "유", null/0/미확정이면 "무"로 판정한다 — DB 값 자체는 읽기만
// 하고 절대 수정하지 않는다.
function hasCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function matchesInspectionFilter(site, filter) {
  if (!filter || filter === 'all') return true;
  const has = hasCount(site.supervision_count);
  return filter === 'yes' ? has : !has;
}

function matchesAccidentReportFilter(site, filter) {
  if (!filter || filter === 'all') return true;
  const has = hasCount(site.accident_report_count);
  return filter === 'yes' ? has : !has;
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
    case 'deadline': // 공사기간 임박순 — period_end 오름차순, 없는 값은 맨 뒤로.
      return toSortableEndTime(a.period_end) - toSortableEndTime(b.period_end);
    case 'favorite': { // 즐겨찾기 우선 — 현재 사용자의 favoriteSiteIds 기준.
      const fa = state.favoriteSiteIds.has(a.id) ? 0 : 1;
      const fb = state.favoriteSiteIds.has(b.id) ? 0 : 1;
      return fa - fb;
    }
    default:
      return 0; // 'default': Supabase 조회 결과 순서 유지 (sort 비교 없음)
  }
}

// state.sites에 실제 존재하는 dong 값만 중복 제거 + 정렬해서 반환한다. select 옵션 채우기용.
export function getDongOptions() {
  const dongs = state.sites
    .map(s => (typeof s.dong === 'string' ? s.dong.trim() : s.dong))
    .filter(d => d !== null && d !== undefined && d !== '');
  const unique = [...new Set(dongs)];
  return unique.sort((a, b) => a.localeCompare(b, 'ko'));
}

// state.sites를 원본 그대로 두고, 복사본에서 검색 → 관할(동) → 금액 → 점검 → 산재표 →
// 즐겨찾기 → 정렬을 순서대로 적용해 반환한다. UI/marker는 이 파생 배열만 받아서 렌더한다.
export function getFilteredSortedSites() {
  const query = (state.searchQuery || '').trim();

  let result = state.sites
    .filter(site => matchesQuery(site, query))
    .filter(site => matchesDongs(site, state.selectedDongs))
    .filter(site => matchesAmount(site, state.amountFilter))
    .filter(site => matchesInspectionFilter(site, state.siteInspectionFilter))
    .filter(site => matchesAccidentReportFilter(site, state.siteAccidentReportFilter))
    .filter(site => !state.favoriteOnly || state.favoriteSiteIds.has(site.id));

  if (state.sortMode === 'default') return result;

  return [...result].sort((a, b) => compareBySort(a, b, state.sortMode));
}
