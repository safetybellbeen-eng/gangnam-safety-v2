// sites.js — STEP 6A. gnmap_v2_sites 조회 + 검색/정렬 파생 처리.
import { sb } from './api.js';
import { state } from './state.js';

const SITE_COLUMNS = 'id, company_name, site_name, address, lat, lng, dong, amount, status, is_active, location_quality, period_start, period_end, supervision_count, accident_report_count';

// is_active=true인 사업장을 전부 조회한다. 좌표 유무로 조회 자체를 제한하지 않는다 —
// 좌표 없는 사업장도 목록에는 표시되어야 하며, 마커 생성 여부만 map.js의 좌표 검증이 담당한다.
//
// 지도/검색/필터는 state.sites에 전체 사업장이 올라와 있다는 전제로 동작한다. 다만 Supabase/PostgREST의
// 단일 응답 행 제한에 걸리지 않도록 500건씩 여러 번 조회한 뒤 브라우저에서 하나의 배열로 합친다.
// 이것은 UI 페이지네이션이 아니라 "전체 데이터 로딩을 위한 내부 배치 조회"다.
const SITE_FETCH_PAGE_SIZE = 500;
const SITE_FETCH_SAFETY_MAX = 20000;

export async function loadActiveSites() {
  // 조회 실패를 "등록된 사업장 0건"과 구분한다. 어느 한 페이지라도 실패하면 partial data를
  // 정상 결과처럼 사용하지 않고 전체 조회를 실패 처리한다.
  state.sitesLoadError = false;

  const allSites = [];

  // 성능: 500건씩 순서대로(직렬) 받으면 네트워크 왕복이 쌓여 첫 화면이 느리다. 한 번에 4페이지를
  // 병렬로 요청하고, 결과는 페이지 순서대로 합친다(order('id') 고정이라 순서·내용은 직렬과 동일).
  // 어느 한 페이지라도 실패하면 기존처럼 전체를 실패 처리한다.
  const PARALLEL = 4;
  try {
    const fetchPage = async (from) => {
      const to = Math.min(from + SITE_FETCH_PAGE_SIZE - 1, SITE_FETCH_SAFETY_MAX - 1);
      const { data, error } = await sb
        .from('gnmap_v2_sites')
        .select(SITE_COLUMNS)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to);
      if (error) {
        console.error(`사업장 조회 실패 (${from}~${to}):`, error);
        return null;
      }
      return data || [];
    };

    for (let from = 0; from < SITE_FETCH_SAFETY_MAX; from += SITE_FETCH_PAGE_SIZE * PARALLEL) {
      const starts = [];
      for (let k = 0; k < PARALLEL; k++) {
        const f = from + k * SITE_FETCH_PAGE_SIZE;
        if (f < SITE_FETCH_SAFETY_MAX) starts.push(f);
      }
      const pages = await Promise.all(starts.map(fetchPage));
      if (pages.some(pg => pg === null)) {
        state.sitesLoadError = true;
        return [];
      }
      for (const pg of pages) {
        allSites.push(...pg);
        // 요청 크기보다 적게 온 페이지가 마지막 페이지다(뒤 페이지는 비어 있어 무해).
        if (pg.length < SITE_FETCH_PAGE_SIZE) return allSites;
      }
    }

    // 안전 상한에 정확히 도달한 경우 조용히 일부 데이터만 표시하지 않는다.
    console.error(`사업장 수가 안전 조회 상한(${SITE_FETCH_SAFETY_MAX}건)에 도달했습니다.`);
    state.sitesLoadError = true;
    return [];
  } catch (e) {
    console.error('사업장 조회 예외:', e);
    state.sitesLoadError = true;
    return [];
  }
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

// 사용자 요청(2026-10, PC 전용): 고정 3구간 외에 사용자가 직접 금액 범위(억원 단위)를
// 입력해 조회할 수 있는 "자세히" 옵션. amountFilter === 'custom'일 때 state.customAmountRange
// ({min,max}, 원 단위)를 사용한다. 모바일에는 이 값을 설정할 UI 자체가 없으므로(아래 ui.js/
// index.html 변경은 전부 PC 전용 CSS로 숨김) 기존 모바일 동작에는 영향이 없다.
function matchesAmount(site, amountFilter) {
  if (!amountFilter || amountFilter === 'all') return true;
  const raw = site.amount;
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return false;
  if (amountFilter === 'custom') {
    const range = state.customAmountRange;
    if (!range) return true;
    const min = Number.isFinite(range.min) ? range.min : -Infinity;
    const max = Number.isFinite(range.max) ? range.max : Infinity;
    return n >= min && n <= max;
  }
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

// 공사기간이 없는 사업장은 Infinity로 취급해 오름차순 정렬 시 항상 맨 뒤로 밀린다(toSortableEndTime과 동일한 규칙).
function toSortableStartTime(v) {
  if (!v) return Infinity;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : Infinity;
}

function compareBySort(a, b, sortMode) {
  switch (sortMode) {
    case 'name-asc':
      return (a.site_name || '').localeCompare(b.site_name || '', 'ko');
    // 사용자 요청(2026-10, 현장탭): 표 헤더를 클릭해 오름차순/내림차순을 바로 토글할 수 있게
    // 한다. 기존 "기본순서" 드롭다운 옵션(사업장명/업체명/공사금액/공사기간임박순/즐겨찾기)은
    // 그대로 두고, 헤더 클릭에서만 쓰는 모드(name-desc/address-asc/address-desc/period-asc/
    // period-desc)를 추가한다 — 드롭다운 목록에는 없는 값이라 모바일 UI는 전혀 바뀌지 않는다.
    case 'name-desc':
      return (b.site_name || '').localeCompare(a.site_name || '', 'ko');
    case 'address-asc':
      return (a.address || '').localeCompare(b.address || '', 'ko');
    case 'address-desc':
      return (b.address || '').localeCompare(a.address || '', 'ko');
    case 'company-asc':
      return (a.company_name || '').localeCompare(b.company_name || '', 'ko');
    case 'amount-desc':
      return toSafeAmount(b.amount) - toSafeAmount(a.amount);
    case 'amount-asc':
      return toSafeAmount(a.amount) - toSafeAmount(b.amount);
    case 'period-asc': // 공사기간 열 헤더 클릭(오름차순) — period_start 기준.
      return toSortableStartTime(a.period_start) - toSortableStartTime(b.period_start);
    case 'period-desc':
      return toSortableStartTime(b.period_start) - toSortableStartTime(a.period_start);
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

// STEP16.21: map.js가 강남구 14개 법정동 어디에도 안 들어가는(경계 밖 좌표) 사업장에
// 붙이는 값과 반드시 같은 문자열이어야 한다 — 값만 맞으면 되므로 여기서는 import 없이
// 리터럴로 맞춰 순환참조를 피한다(js/map.js의 OTHER_DONG_LABEL 참고).
const OTHER_DONG_LABEL = '그외';

// state.sites에 실제 존재하는 dong 값만 중복 제거 + 정렬해서 반환한다. select 옵션 채우기용.
// "그외"(관할 밖)는 가나다순에 섞이지 않도록 항상 목록 맨 끝에 붙인다.
export function getDongOptions() {
  const dongs = state.sites
    .map(s => (typeof s.dong === 'string' ? s.dong.trim() : s.dong))
    .filter(d => d !== null && d !== undefined && d !== '');
  const unique = [...new Set(dongs)];
  const real = unique.filter(d => d !== OTHER_DONG_LABEL).sort((a, b) => a.localeCompare(b, 'ko'));
  return unique.includes(OTHER_DONG_LABEL) ? [...real, OTHER_DONG_LABEL] : real;
}

// state.sites를 원본 그대로 두고, 복사본에서 검색 → 관할(동) → 금액 → 점검 → 산재표 →
// 즐겨찾기 → 정렬을 순서대로 적용해 반환한다. UI/marker는 이 파생 배열만 받아서 렌더한다.
export function getFilteredSortedSites(opts = {}) {
  // 사용자 요청: 모바일 "즐겨찾기" 탭은 검색/필터 UI를 전부 없애고, 내부 탭(즐겨찾기 현장/
  // 메모 있는 현장)에 따른 단순 목록만 보여준다. "현장" 탭에 남아있을 수 있는 검색어나
  // 필터가 이 탭의 목록에 영향을 주면 안 되므로, 이 탭일 때는 다른 필터를 전혀 적용하지
  // 않고 favoriteSiteIds 또는 state.siteNotes 기준으로만 거른다(정렬도 적용하지 않음 —
  // 필터 UI 자체가 없으므로 정렬 선택지도 없다).
  if (state.mobileActiveTab === 'favorite') {
    return state.favoriteTabView === 'notes'
      ? state.sites.filter(site => state.siteNotes.has(site.id))
      : state.sites.filter(site => state.favoriteSiteIds.has(site.id));
  }

  // STEP16.32: "주소/장소명" 모드에서는 검색어를 등록 사업장 필터링에 쓰지 않는다(그 검색어는
  // js/ui.js renderAddressSearchResults()의 Kakao 주소/장소 검색 쪽으로만 간다) — 사업장 목록/
  // 지도 마커는 검색 전과 동일하게(관할/금액 등 다른 필터만 적용된 채) 그대로 유지된다.
  const query = state.siteSearchMode === 'address' ? '' : (state.searchQuery || '').trim();

  // 관할 '기본'(시작값): 핀이 너무 많아 혼동되므로, 검색어가 없으면 아무것도 보여주지 않는다.
  // 검색어를 입력하면 그 결과는 보여준다. 경로탭 "전체 현장 핀 표시"는 opts.ignoreDefault로 예외.
  // '기타' 필터(즐겨찾기/메모)를 하나라도 켰다면 사용자가 명시적으로 보려는 것이므로 기본 비움을 적용하지 않는다.
  const etcOn = !!(state.etcFavorite || state.etcNote);
  if (state.dongDefault && !query && !opts.ignoreDefault && !etcOn) return [];

  let result = state.sites
    .filter(site => matchesQuery(site, query))
    .filter(site => matchesDongs(site, state.selectedDongs))
    .filter(site => matchesAmount(site, state.amountFilter))
    .filter(site => matchesInspectionFilter(site, state.siteInspectionFilter))
    .filter(site => matchesAccidentReportFilter(site, state.siteAccidentReportFilter))
    .filter(site => !state.favoriteOnly || state.favoriteSiteIds.has(site.id))
    // 기타 필터: 체크한 항목 중 하나라도 해당하면 표시(즐겨찾기 또는 메모).
    .filter(site => !etcOn || (state.etcFavorite && state.favoriteSiteIds.has(site.id)) || (state.etcNote && state.siteNotes.has(site.id)));

  if (state.sortMode === 'default') return result;

  return [...result].sort((a, b) => compareBySort(a, b, state.sortMode));
}
