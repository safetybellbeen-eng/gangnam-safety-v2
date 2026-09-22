// ui.js — STEP 6A. 사업장 목록/상세/검색/정렬 렌더링 및 선택 상태 연동.
// XSS 방지: DB 값(site_name/company_name/address 등)은 innerHTML 문자열 조립에 쓰지 않고
// 전부 textContent 또는 createElement 기반 DOM 생성으로만 넣는다.
import { state } from './state.js';
import { panToSite, renderMarkers, centerSiteInVisibleArea } from './map.js';
import { getFilteredSortedSites, getDongOptions, loadActiveSites } from './sites.js';
import { isFavorite, toggleFavorite } from './favorites.js';
import { getNote, saveNote, deleteNote } from './notes.js';
import { loadUsers, setUserStatus, setUserRole } from './admin.js';
import { parseExcelFile } from './excel.js';
import { runGeocodingForParsedRows, runKeywordCandidateSearch, runKakaoLotRecovery, buildLotQueries, runJusoNormalize, buildJusoQuery, runKakaoJusoRecovery, runRoadApproximateRecovery, extractApproximateStructure } from './geocoding.js';
import { importSitesToDatabase, previewImportImpact, loadUploadHistory } from './import.js';
import { loadSupervisions, createSupervision, updateSupervision, deleteSupervision } from './supervision.js';
import { isAdmin } from './auth.js';

function displayValue(v) {
  return (v === null || v === undefined || v === '') ? '-' : v;
}

// STEP16.5-C: 공사금액(site.amount) "표시 전용" 포매터. DB 값/검색/정렬/저장 로직에는
// 전혀 관여하지 않고, 화면에 보여줄 문자열만 만든다(순수 함수, side effect 없음).
// null/undefined/빈 문자열/NaN은 displayValue와 동일하게 '-'로 안전 처리한다.
// 예: 600000000 -> "6억원", 2130916000 -> "21억 3,091만 6,000원", 7450300000 -> "74억 5,030만원".
function formatAmountKRW(raw) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '-';
  if (num === 0) return '0원';

  const sign = num < 0 ? '-' : '';
  const abs = Math.trunc(Math.abs(num));
  const uk = Math.floor(abs / 1e8);
  const afterUk = abs % 1e8;
  const man = Math.floor(afterUk / 1e4);
  const won = afterUk % 1e4;

  const segs = [];
  if (uk > 0) segs.push({ n: uk, u: '억' });
  if (man > 0) segs.push({ n: man, u: '만' });
  if (won > 0) segs.push({ n: won, u: '원' });
  if (segs.length === 0) return `${sign}0원`;

  const text = segs.map((seg, i) => {
    const numText = seg.n.toLocaleString('ko-KR');
    const isLast = i === segs.length - 1;
    if (!isLast) return `${numText}${seg.u}`;
    return seg.u === '원' ? `${numText}원` : `${numText}${seg.u}원`;
  }).join(' ');

  return sign + text;
}

// STEP16.5-C: css/mobile.css와 완전히 동일한 breakpoint(768px)로 모바일 뷰인지 판단한다.
// 이 값에 따라 renderDetail()의 공사금액 표시 문자열만 분기하고, PC(>768px)에서는
// 기존과 동일한 raw 값(displayValue)을 그대로 보여줘 PC 화면을 전혀 바꾸지 않는다.
function isMobileViewport() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

// 사용자 요청: 상세화면 2x2 표(공사금액/공사기간/지도점검/산재표)용 "표시 전용" 포매터.
// DB 값(period_start/period_end/supervision_count/accident_report_count)은 그대로 읽기만
// 하고 검색/정렬/저장 로직에는 전혀 관여하지 않는다. 날짜는 Supabase date 컬럼이 주는
// "YYYY-MM-DD" 형식을 "YYYY.MM.DD"로만 바꿔 보여준다(값 자체는 원본 그대로 사용).
function formatDateKR(d) {
  if (d === null || d === undefined || d === '') return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : String(d);
}

function formatPeriodKR(start, end) {
  const s = formatDateKR(start);
  const e = formatDateKR(end);
  if (!s && !e) return '-';
  if (s && e) return `${s} ~ ${e}`;
  return s ? `${s} ~` : `~ ${e}`;
}

function formatCount(raw, unit) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '-';
  return `${num.toLocaleString('ko-KR')}${unit}`;
}

// 카카오맵 공식 웹 링크 형식(REST API 아님, REST Key 불필요)으로 길찾기 페이지 URL을 만든다.
// 형식: https://map.kakao.com/link/to/{목적지명},{위도},{경도}
// 목적지명에 콤마/특수문자가 있어도 깨지지 않도록 경로 세그먼트를 개별 encodeURIComponent한다.
function buildKakaoDirectionsUrl(name, lat, lng) {
  const safeName = encodeURIComponent(name || '목적지');
  return `https://map.kakao.com/link/to/${safeName},${lat},${lng}`;
}

function isValidSiteCoord(site) {
  const rawLat = site.lat;
  const rawLng = site.lng;
  const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  if (isBlank(rawLat) || isBlank(rawLng)) return false;

  const lat = Number(rawLat);
  const lng = Number(rawLng);
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

// 즐겨찾기 토글 공통 처리. DB 성공 후에만 버튼 표시를 확정 갱신한다(낙관적 갱신 금지).
// 목록의 별표와 상세 패널의 별표(있다면)를 모두 같은 결과로 맞춘다.
async function handleFavoriteToggle(siteId, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;

  const success = await toggleFavorite(siteId);

  if (triggerBtn) triggerBtn.disabled = false;
  if (!success) return; // 실패 시 기존 state/표시 그대로 유지

  const nowFavorite = isFavorite(siteId);
  document.querySelectorAll(`.site-list-item[data-site-id="${siteId}"] .favorite-toggle-btn`)
    .forEach(btn => {
      btn.textContent = nowFavorite ? '★' : '☆';
      btn.classList.toggle('is-favorite', nowFavorite);
    });

  // PC 액션 버튼 행의 기존 즐겨찾기 버튼(모바일에서는 CSS로 숨김).
  const detailFavBtn = document.getElementById('site-detail-favorite-btn');
  if (detailFavBtn && detailFavBtn.dataset.siteId === String(siteId)) {
    detailFavBtn.textContent = nowFavorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가';
  }

  // 사용자 요청: 모바일 상세 패널에서는 사업장명 옆 별표로 즐겨찾기를 토글한다(PC에서는 숨김).
  const heroFavBtn = document.getElementById('site-detail-name-favorite-btn');
  if (heroFavBtn && heroFavBtn.dataset.siteId === String(siteId)) {
    heroFavBtn.textContent = nowFavorite ? '★' : '☆';
    heroFavBtn.classList.toggle('is-favorite', nowFavorite);
    heroFavBtn.setAttribute('aria-label', nowFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가');
  }
}

// 상세 패널에 개인 메모 섹션(제목/textarea/저장/삭제)을 추가한다.
// textarea.value만 사용하므로 XSS 위험이 없다 (innerHTML 미사용).
// STEP16.5-C: id/이벤트/저장·삭제 로직(saveNote/deleteNote)은 그대로 두고, 시각적 구획을 위한
// 클래스만 추가한다(css/mobile.css @media(max-width:768px) 안에서만 스타일링 — PC는 layout.css의
// 기존 #site-note-textarea 규칙만 그대로 적용되어 화면이 바뀌지 않는다).
function renderNoteSection(panel, siteId) {
  const title = document.createElement('h3');
  title.className = 'site-detail-section-title';
  title.textContent = '개인 메모';
  panel.appendChild(title);

  const existing = getNote(siteId);

  const textarea = document.createElement('textarea');
  textarea.id = 'site-note-textarea';
  textarea.className = 'site-detail-note-textarea';
  textarea.value = existing ? existing.content : '';
  panel.appendChild(textarea);

  const noteActions = document.createElement('div');
  noteActions.className = 'site-detail-note-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'site-detail-action-btn site-detail-btn-primary';
  saveBtn.textContent = '저장';

  // STEP16.5-C §12: 코드 확인 결과 이 버튼은 deleteNote(siteId) -> gnmap_v2_site_notes 테이블의
  // 본인 메모 행만 삭제한다(사업장 자체 삭제가 아님). "메모 삭제"로 문구를 명확히 한다(기능/핸들러 동일).
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'site-detail-action-btn site-detail-btn-danger';
  deleteBtn.textContent = '메모 삭제';

  saveBtn.addEventListener('click', async () => {
    if (state.noteInFlight.has(siteId)) return;
    state.noteInFlight.add(siteId);
    saveBtn.disabled = true;
    deleteBtn.disabled = true;

    try {
      const success = await saveNote(siteId, textarea.value);
      if (success) {
        // 저장(또는 빈 값이라 삭제로 위임된 경우 모두) 성공 시 최신 state 기준으로 textarea만 갱신, 화면은 유지.
        const updated = getNote(siteId);
        textarea.value = updated ? updated.content : '';
      }
    } finally {
      state.noteInFlight.delete(siteId);
      saveBtn.disabled = false;
      deleteBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    if (state.noteInFlight.has(siteId)) return;
    state.noteInFlight.add(siteId);
    saveBtn.disabled = true;
    deleteBtn.disabled = true;

    try {
      const success = await deleteNote(siteId);
      if (success) {
        textarea.value = '';
      }
    } finally {
      state.noteInFlight.delete(siteId);
      saveBtn.disabled = false;
      deleteBtn.disabled = false;
    }
  });

  noteActions.appendChild(saveBtn);
  noteActions.appendChild(deleteBtn);
  panel.appendChild(noteActions);
}

// 목록/마커 클릭이 공통으로 호출하는 선택 함수.
// 선택 상태 갱신 → 지도 이동 → 목록 active class 갱신 → scrollIntoView → 상세 패널 렌더까지 한 번에 처리한다.
export function selectSite(siteId) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;

  state.selectedSiteId = siteId;
  panToSite(site);
  updateListActiveState();
  scrollListItemIntoView(siteId);
  renderDetail(site);
}

// STEP15-E.4: 모바일 즐겨찾기 탭 전용 empty state. 새 DB 조회/즐겨찾기 상태를 만들지 않고
// 현재 렌더 결과(visibleSites가 0건)만 보고 판단한다. 아이콘은 하단 네비게이션 "즐겨찾기" 탭과
// 동일한 라인형 별 SVG(index.html의 것과 동일 path)를 재사용해 디자인 언어를 통일한다.
// "현장 둘러보기" 버튼은 새 탭 전환 로직을 만들지 않고, 기존 하단 네비게이션의 "현장" 버튼을
// 그대로 클릭 위임해 app.js의 activateMobileTab 바인딩을 재사용한다.
function buildFavoriteEmptyState(container) {
  const empty = document.createElement('div');
  empty.className = 'mobile-favorite-empty';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'mobile-favorite-empty-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'm12 3 2.5 5.6 6.1.6-4.6 4.1 1.3 6L12 16.3 6.7 19.3l1.3-6-4.6-4.1 6.1-.6L12 3Z');
  svg.appendChild(path);

  const title = document.createElement('p');
  title.className = 'mobile-favorite-empty-title';
  title.textContent = '즐겨찾기한 현장이 없습니다';

  const desc = document.createElement('p');
  desc.className = 'mobile-favorite-empty-desc';
  desc.textContent = '자주 확인하는 현장을 즐겨찾기에 추가하면 여기에서 빠르게 확인할 수 있습니다.';

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'mobile-favorite-empty-btn';
  goBtn.textContent = '현장 둘러보기';
  goBtn.addEventListener('click', () => {
    const siteTabBtn = document.querySelector('.mobile-tab-btn[data-tab="site"]');
    if (siteTabBtn) siteTabBtn.click();
  });

  empty.appendChild(svg);
  empty.appendChild(title);
  empty.appendChild(desc);
  empty.appendChild(goBtn);
  container.appendChild(empty);
}

// 목록 전체를 다시 그린다. 매번 새 DOM을 생성하므로 이전 렌더의 이벤트가 남아 누적되지 않는다.
// 검색/정렬이 적용된 파생 배열(getFilteredSortedSites)만 받아서 렌더한다 — state.sites 원본은 건드리지 않는다.
export function renderSiteList(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const visibleSites = getFilteredSortedSites();

  // 사용자 요청: 필터 옆 결과 건수("N건")와 확인필요 카운트 배지를 화면에서 없앴다
  // (해당 DOM 자체를 index.html에서 제거 — 여기서는 더 이상 채울 대상이 없다).

  if (!visibleSites || visibleSites.length === 0) {
    // STEP15-E.4: 모바일 즐겨찾기 탭(state.favoriteOnly가 그 탭 진입 시에만 true가 되도록
    // app.js의 activateMobileTab이 관리)에서 0건일 때만 전용 empty state를 보여준다.
    // PC의 "즐겨찾기만 보기" 필터나 현장 탭의 일반 검색 결과 0건은 기존 문구를 그대로 유지한다.
    if (state.favoriteOnly && state.mobileActiveTab === 'favorite') {
      buildFavoriteEmptyState(container);
    } else {
      const empty = document.createElement('p');
      empty.textContent = '표시할 사업장이 없습니다.';
      container.appendChild(empty);
    }
  } else {
    visibleSites.forEach(site => {
      const item = document.createElement('div');
      item.className = 'site-list-item';
      item.dataset.siteId = site.id;

      const titleRow = document.createElement('div');
      titleRow.className = 'site-list-title-row';

      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'favorite-toggle-btn';
      // STEP15-E.2: 텍스트(★/☆)는 그대로 두고, 모바일 카드 디자인에서 채워진/빈 별 색을
      // 구분해 보여주기 위한 CSS 훅으로 클래스만 추가한다(즐겨찾기 로직/데이터는 미변경).
      if (isFavorite(site.id)) favBtn.classList.add('is-favorite');
      favBtn.textContent = isFavorite(site.id) ? '★' : '☆';
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 목록 항목 선택 이벤트로 전파되지 않도록 분리
        handleFavoriteToggle(site.id, favBtn);
      });

      const title = document.createElement('div');
      title.className = 'site-list-title';
      title.textContent = site.site_name || site.company_name || '-';

      titleRow.appendChild(favBtn);
      titleRow.appendChild(title);

      const company = document.createElement('div');
      company.className = 'site-list-company';
      company.textContent = displayValue(site.company_name);

      const address = document.createElement('div');
      address.className = 'site-list-address';
      address.textContent = displayValue(site.address);

      item.appendChild(titleRow);
      item.appendChild(company);
      item.appendChild(address);

      // STEP15-E.2: 동/위치확인필요를 "보조정보" 한 줄로 묶는다. 둘 다 없으면 빈 줄을 만들지 않는다.
      // dong은 site.dong 값을 그대로 표시만 하고(별도 가공 없음), PC에서는 css/mobile.css가
      // 이 wrapper 자체를 기본적으로 숨겨 화면에 영향이 없다(기존 site-list-review-badge와 동일 원칙).
      const meta = document.createElement('div');
      meta.className = 'site-list-meta';

      if (site.dong) {
        const dongEl = document.createElement('span');
        dongEl.className = 'site-list-dong';
        dongEl.textContent = site.dong;
        meta.appendChild(dongEl);
      }

      // STEP15-C: location_quality가 APPROXIMATE/UNRESOLVED면 위치 확인이 필요함을 알린다.
      // DB 값은 읽기만 하며 절대 변경하지 않는다. PC에서는 css/mobile.css가 기본적으로 숨겨 화면에 영향 없다.
      if (site.location_quality === 'APPROXIMATE' || site.location_quality === 'UNRESOLVED') {
        const reviewBadge = document.createElement('span');
        reviewBadge.className = 'site-list-review-badge';
        reviewBadge.textContent = '위치확인필요';
        meta.appendChild(reviewBadge);
      }

      if (meta.childNodes.length > 0) item.appendChild(meta);

      item.addEventListener('click', () => selectSite(site.id));

      container.appendChild(item);
    });

    updateListActiveState();
  }

  // 검색/정렬 결과에 맞춰 marker도 다시 그린다.
  renderMarkers(visibleSites, selectSite);

  // 선택된 사업장이 현재 결과에서 사라졌으면 상세를 닫는다.
  if (state.selectedSiteId !== null && !visibleSites.some(s => s.id === state.selectedSiteId)) {
    closeDetail();
  }
}

function updateListActiveState() {
  document.querySelectorAll('.site-list-item').forEach(el => {
    const isActive = String(state.selectedSiteId) === el.dataset.siteId;
    el.classList.toggle('active', isActive);
  });
}

function scrollListItemIntoView(siteId) {
  const el = document.querySelector(`.site-list-item[data-site-id="${siteId}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// 상세 패널 렌더. textContent만 사용해 XSS를 방지한다.
export function renderDetail(site) {
  const panel = document.getElementById('site-detail-panel');
  panel.innerHTML = '';
  panel.style.display = 'block';

  // 사용자 피드백: 지도 탭에서 상세를 열면 검색/필터 바(#site-list-panel)를 숨기고 그만큼
  // 지도를 넓게 쓴다(css/mobile.css의 #app[data-mobile-tab="map"][data-detail-open="true"] 규칙).
  // 지도 재초기화는 하지 않고, 컨테이너 크기가 바뀐 뒤 기존에도 쓰던 relayout()으로 크기만
  // 다시 인식시킨다. 핀을 "보이는" 지도 영역(하단 시트에 가려지지 않는 부분) 가운데로
  // 맞추는 정밀 재중심화는 시트 내용을 다 그린 뒤 실제 높이를 알 수 있을 때(§ 맨 아래)
  // 한 번만 수행한다 — 여기서는 컨테이너 크기 재인식만 한다.
  const appEl = document.getElementById('app');
  if (appEl) appEl.setAttribute('data-detail-open', 'true');
  if (state.mobileActiveTab === 'map' && state.map && typeof state.map.relayout === 'function') {
    state.map.relayout();
  }

  // STEP16.5-C: 모바일 전용 X 닫기 버튼(44px 터치 타겟). closeDetail()을 기존 "닫기" 버튼과
  // 완전히 동일하게 직접 호출한다(새 로직 없음). PC에서는 css/mobile.css @media 밖이라
  // 아무 규칙도 매치되지 않아 기본적으로 보이지 않는다(레이아웃에 영향 없음).
  const closeXBtn = document.createElement('button');
  closeXBtn.type = 'button';
  closeXBtn.className = 'site-detail-close-x';
  closeXBtn.setAttribute('aria-label', '닫기');
  closeXBtn.textContent = '×';
  closeXBtn.addEventListener('click', closeDetail);
  panel.appendChild(closeXBtn);

  // STEP15-E.1/E.1-2: location_quality 값(EXACT/ESTIMATED/APPROXIMATE/MANUAL/UNRESOLVED,
  // supabase/migrations의 check 제약과 동일한 5개)을 그대로 읽기만 해서 작은 배지로 보여준다 —
  // 값 자체나 geocoding/import 로직은 전혀 건드리지 않는다. PC에서는 이 배지를 기본적으로
  // 숨기고(css/mobile.css) 모바일에서만 보이게 해 PC 화면에는 영향이 없다. APPROXIMATE/UNRESOLVED는
  // 기존 needsReview()/site-list-review-badge와 동일하게 "확인필요"로 묶어서 표시한다(의미를 새로
  // 만들지 않음). MANUAL(관리자가 직접 확인한 위치, gnmap_v2_import_sites RPC가 재import 시에도
  // 보호하는 값)은 EXACT와 동일하게 "정확" 그룹으로 표시한다.
  const QUALITY_BADGE_MAP = {
    EXACT: { label: '정확', className: 'site-detail-quality-exact' },
    MANUAL: { label: '정확', className: 'site-detail-quality-exact' },
    ESTIMATED: { label: '추정', className: 'site-detail-quality-estimated' },
    APPROXIMATE: { label: '확인필요', className: 'site-detail-quality-review' },
    UNRESOLVED: { label: '확인필요', className: 'site-detail-quality-review' }
  };
  const qualityInfo = QUALITY_BADGE_MAP[site.location_quality];
  if (qualityInfo) {
    const qualityBadge = document.createElement('span');
    qualityBadge.className = `site-detail-quality-badge ${qualityInfo.className}`;
    qualityBadge.textContent = qualityInfo.label;
    panel.appendChild(qualityBadge);
  }

  // 사용자 요청: "확인필요" 배지로 이미 의미가 전달되므로 별도 경고 문구는 넣지 않는다
  // (기존 STEP12-C의 "⚠ 위치 확인요망..." 문구 제거, 배지 자체는 그대로 유지).

  // STEP16.5-C: 사업장명/업체명/주소를 "hero" 정보로, 행정동/공사금액을 "부가정보"로 분리한다.
  // 두 그룹 모두 여전히 기존 .site-detail-row/.site-detail-label/.site-detail-value 클래스를
  // 그대로 유지해(추가 클래스만 덧붙임) css/layout.css의 PC 스타일이 전혀 바뀌지 않도록 한다.
  // 모바일에서는 css/mobile.css가 추가 클래스만 골라 hero를 크게, label은 숨기는 식으로 override한다.
  const hero = document.createElement('div');
  hero.className = 'site-detail-hero';

  const heroRows = [
    ['사업장명', site.site_name, 'name'],
    ['업체명', site.company_name, 'company'],
    ['주소', site.address, 'address']
  ];
  heroRows.forEach(([label, value, key]) => {
    const row = document.createElement('div');
    row.className = `site-detail-row site-detail-row-${key}`;

    const labelEl = document.createElement('span');
    labelEl.className = `site-detail-label site-detail-label-${key}`;
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = `site-detail-value site-detail-value-${key}`;
    valueEl.textContent = displayValue(value);

    row.appendChild(labelEl);

    // 사용자 요청: 즐겨찾기 별표를 사업장명 "좌측"에 둔다. valueEl(사업장명 텍스트)보다 먼저
    // 추가해 flex 행(.site-detail-row-name)에서 왼쪽에 오도록 한다. 기존 handleFavoriteToggle을
    // 그대로 재사용하고(새 로직 없음), 이 버튼은 모바일에서만 보인다(PC는 css/mobile.css 상단
    // PC-hide 목록에서 기본 숨김 — 기존 액션 버튼 행의 #site-detail-favorite-btn을 그대로
    // 유지해 PC 화면은 바뀌지 않는다).
    if (key === 'name') {
      const nameFavBtn = document.createElement('button');
      nameFavBtn.type = 'button';
      nameFavBtn.id = 'site-detail-name-favorite-btn';
      nameFavBtn.className = 'site-detail-name-favorite-btn';
      nameFavBtn.dataset.siteId = String(site.id);
      const nowFav = isFavorite(site.id);
      nameFavBtn.classList.toggle('is-favorite', nowFav);
      nameFavBtn.textContent = nowFav ? '★' : '☆';
      nameFavBtn.setAttribute('aria-label', nowFav ? '즐겨찾기 해제' : '즐겨찾기 추가');
      nameFavBtn.addEventListener('click', () => handleFavoriteToggle(site.id, nameFavBtn));
      row.appendChild(nameFavBtn);
    }

    row.appendChild(valueEl);

    // 사용자 피드백: 주소 옆에 텍스트를 바로 복사할 수 있는 버튼을 추가한다. 주소 값(site.address)은
    // 그대로 읽기만 하고 저장/검색/정렬 로직에는 전혀 관여하지 않는 순수 UI 기능이다.
    // 값이 없으면('-') 복사할 내용이 없으므로 버튼을 만들지 않는다.
    if (key === 'address' && displayValue(value) !== '-') {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'site-detail-copy-btn';
      copyBtn.setAttribute('aria-label', '주소 복사');
      copyBtn.textContent = '복사';
      copyBtn.addEventListener('click', async () => {
        const text = String(value);
        const original = copyBtn.textContent;
        const showResult = (ok) => {
          copyBtn.textContent = ok ? '복사됨' : '실패';
          copyBtn.disabled = true;
          setTimeout(() => {
            copyBtn.textContent = original;
            copyBtn.disabled = false;
          }, 1400);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            // Clipboard API를 쓸 수 없는 환경(구형 브라우저/비보안 컨텍스트)을 위한 최소 대체 수단.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          showResult(true);
        } catch (err) {
          console.error('주소 복사 실패:', err);
          showResult(false);
        }
      });
      row.appendChild(copyBtn);
    }

    hero.appendChild(row);
  });
  panel.appendChild(hero);

  // 사용자 요청: 행정동은 상세화면에서 뺴고, 공사금액/공사기간/지도점검(횟수)/산재표(제출)
  // 4개를 2x2 표로 보여준다. DOM에 쓰는 순서(공사금액→공사기간→지도점검→산재표) 그대로
  // grid auto-flow에 태우면 1행 "공사금액|공사기간", 2행 "지도점검|산재표"가 된다
  // (css/mobile.css .site-detail-meta { display:grid; grid-template-columns:1fr 1fr }).
  // DB 원본 값(amount/period_start/period_end/supervision_count/accident_report_count)은
  // 그대로 저장/검색/정렬에 쓰이고, 여기서는 "화면 표시용" 문자열만 만든다.
  const meta = document.createElement('div');
  meta.className = 'site-detail-meta';

  const metaRows = [
    // STEP16.5-C §8: 공사금액은 모바일(768px 이하)에서만 formatAmountKRW()로 억/만 단위로
    // 바꿔 보여준다. PC(>768px)는 isMobileViewport()가 false라 기존 displayValue(raw) 그대로.
    ['공사금액', 'amount', () => (isMobileViewport() ? formatAmountKRW(site.amount) : displayValue(site.amount))],
    ['공사기간', 'period', () => formatPeriodKR(site.period_start, site.period_end)],
    ['지도점검', 'supervision', () => formatCount(site.supervision_count, '회')],
    ['산재표', 'accident', () => formatCount(site.accident_report_count, '건')]
  ];
  metaRows.forEach(([label, key, getText]) => {
    const row = document.createElement('div');
    row.className = `site-detail-row site-detail-row-${key}`;

    const labelEl = document.createElement('span');
    labelEl.className = `site-detail-label site-detail-label-${key}`;
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = `site-detail-value site-detail-value-${key}`;
    valueEl.textContent = getText();

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    meta.appendChild(row);
  });
  panel.appendChild(meta);

  // STEP16.5-C §9: 즐겨찾기/길찾기를 action row로 묶는다. id/데이터셋/클릭 핸들러/disabled 조건은
  // 전부 기존 그대로이며, 시각적 클래스만 추가한다.
  const actions = document.createElement('div');
  actions.className = 'site-detail-actions';

  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.id = 'site-detail-favorite-btn';
  favBtn.className = 'site-detail-action-btn site-detail-btn-secondary';
  favBtn.dataset.siteId = String(site.id);
  favBtn.textContent = isFavorite(site.id) ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가';
  favBtn.addEventListener('click', () => handleFavoriteToggle(site.id, favBtn));
  actions.appendChild(favBtn);

  const directionsBtn = document.createElement('button');
  directionsBtn.type = 'button';
  directionsBtn.className = 'site-detail-action-btn site-detail-btn-primary';
  directionsBtn.textContent = '길찾기';
  const hasValidCoord = isValidSiteCoord(site);
  directionsBtn.disabled = !hasValidCoord;
  if (hasValidCoord) {
    directionsBtn.addEventListener('click', () => {
      const url = buildKakaoDirectionsUrl(site.site_name || site.company_name, site.lat, site.lng);
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }
  actions.appendChild(directionsBtn);

  // 사용자 요청: 액션 버튼을 "길찾기ㅣ경로추가ㅣ메모" 3개로 재구성한다("지도보기"는 대체되어
  // 제거). 새 지도/경로 로직은 만들지 않고 기존 하단 "경로" 탭(renderMobileRouteView,
  // state.selectedSiteId 기준)과 기존 buildKakaoDirectionsUrl만 재사용한다. 모바일에서만
  // 노출한다(PC는 이 media query 밖이라 기존 즐겨찾기+길찾기 2버튼 그대로 — PC 화면 미변경).
  if (isMobileViewport()) {
    // 경로추가: 하단 "경로" 탭 버튼을 클릭 위임한다. activateMobileTab()이 탭 전환 시 열려있던
    // 상세를 closeDetail()로 자동으로 닫으며 state.selectedSiteId도 함께 비우므로(§ app.js),
    // 그 직후 selectedSiteId를 다시 채우고 경로 탭 내용을 다시 그려 이 사업장이 그대로 보이게 한다.
    const routeAddBtn = document.createElement('button');
    routeAddBtn.type = 'button';
    routeAddBtn.className = 'site-detail-action-btn site-detail-btn-secondary';
    routeAddBtn.textContent = '경로추가';
    routeAddBtn.addEventListener('click', () => {
      const siteId = site.id;
      const routeTabBtn = document.querySelector('.mobile-tab-btn[data-tab="route"]');
      if (routeTabBtn) routeTabBtn.click();
      state.selectedSiteId = siteId;
      renderMobileRouteView('mobile-route-content');
    });
    actions.appendChild(routeAddBtn);

    // 메모: 메인 지도에서는 메모를 작성/열람하지 않고, "현장" 탭으로 넘어가 그곳에서 작성/열람한다.
    // closeDetail()이 selectedSiteId를 비운 뒤이므로, 탭 전환 후 selectSite()를 다시 호출해
    // 같은 사업장의 상세(메모 포함)를 현장 탭에서 다시 연다.
    const noteBtn = document.createElement('button');
    noteBtn.type = 'button';
    noteBtn.className = 'site-detail-action-btn site-detail-btn-secondary';
    noteBtn.textContent = '메모';
    noteBtn.addEventListener('click', () => {
      const siteId = site.id;
      const siteTabBtn = document.querySelector('.mobile-tab-btn[data-tab="site"]');
      if (siteTabBtn) siteTabBtn.click();
      selectSite(siteId);
    });
    actions.appendChild(noteBtn);
  }

  panel.appendChild(actions);

  // 사용자 요청: 메인 지도(모바일)에서는 메모를 지도 위 상세 패널에서 직접 작성/열람하지 않고
  // 위 "메모" 버튼으로 현장 탭으로 넘어가서 작성/열람한다. 그 외(PC 전체, 모바일 현장/즐겨찾기
  // 탭)는 기존과 동일하게 인라인 메모 섹션을 그대로 보여준다(로직 변경 없음).
  if (!(isMobileViewport() && state.mobileActiveTab === 'map')) {
    renderNoteSection(panel, site.id);
  }

  // STEP16.5-C §11: 기존 텍스트 "닫기" 버튼/핸들러는 그대로 유지하되(삭제 금지), 모바일에서는
  // 위에서 추가한 X 버튼이 동일 기능을 대신하므로 CSS로 시각적으로만 숨긴다(PC는 그대로 노출).
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.id = 'site-detail-close-btn';
  closeBtn.className = 'site-detail-close-text';
  closeBtn.textContent = '닫기';
  closeBtn.addEventListener('click', closeDetail);
  panel.appendChild(closeBtn);

  // 사용자 피드백: 시트 내용을 다 그려서 실제 높이(panel.getBoundingClientRect().height)를
  // 알 수 있는 지금 시점에, 핀이 "가려지지 않고 보이는" 지도 영역 한가운데에 오도록
  // centerSiteInVisibleArea()로 정밀 재중심화한다(지도 탭일 때만 — 다른 탭은 시트가 지도를
  // 가리지 않으므로 기존 selectSite()의 panToSite()로 충분).
  if (state.mobileActiveTab === 'map' && state.map) {
    const hiddenBottomPx = panel.getBoundingClientRect().height;
    centerSiteInVisibleArea(site, hiddenBottomPx);
  }
}

export function closeDetail() {
  const panel = document.getElementById('site-detail-panel');
  panel.style.display = 'none';
  panel.innerHTML = '';
  state.selectedSiteId = null;
  updateListActiveState();

  // 상세를 열 때 숨겼던 검색/필터 바를 다시 보이게 하고(§ renderDetail 참고), 지도 탭이라면
  // 다시 줄어든 지도 크기를 relayout()으로 반영한다(재초기화 없음).
  const appEl = document.getElementById('app');
  if (appEl) appEl.removeAttribute('data-detail-open');
  if (state.mobileActiveTab === 'map' && state.map && typeof state.map.relayout === 'function') {
    state.map.relayout();
  }
}

// STEP15-D. 모바일 "경로" 탭. 새 경로/경유지 기능을 만들지 않고, renderDetail()이 쓰는 것과
// 동일한 buildKakaoDirectionsUrl/isValidSiteCoord만 재사용해 현재(마지막) 선택된 사업장
// 하나에 대한 길찾기만 보여준다. 안내 문구는 index.html에 정적으로 있고, 여기서는 선택 유무에
// 따른 카드/안내 메시지만 채운다.
export function renderMobileRouteView(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const site = state.selectedSiteId !== null
    ? state.sites.find(s => s.id === state.selectedSiteId)
    : null;

  if (!site) {
    const msg = document.createElement('p');
    msg.className = 'mobile-placeholder';
    msg.textContent = '현장 탭에서 목적지를 선택해주세요.';
    container.appendChild(msg);
    return;
  }

  const card = document.createElement('div');
  card.className = 'mobile-route-card';

  const nameEl = document.createElement('div');
  nameEl.className = 'mobile-route-name';
  nameEl.textContent = site.site_name || site.company_name || '-';
  card.appendChild(nameEl);

  const addrEl = document.createElement('div');
  addrEl.className = 'mobile-route-address';
  addrEl.textContent = displayValue(site.address);
  card.appendChild(addrEl);

  const directionsBtn = document.createElement('button');
  directionsBtn.type = 'button';
  directionsBtn.className = 'mobile-route-directions-btn';
  directionsBtn.textContent = '카카오맵 길찾기';
  const hasValidCoord = isValidSiteCoord(site);
  directionsBtn.disabled = !hasValidCoord;
  if (hasValidCoord) {
    directionsBtn.addEventListener('click', () => {
      const url = buildKakaoDirectionsUrl(site.site_name || site.company_name, site.lat, site.lng);
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }
  card.appendChild(directionsBtn);

  container.appendChild(card);
}

// STEP15-E.6: 더보기 메뉴 행 왼쪽에 붙는 장식용 line SVG 아이콘. 외부 아이콘 라이브러리를
// 새로 쓰지 않고, 기존 하단 탭 아이콘(index.html의 .mobile-tab-icon)과 동일한 스타일
// (stroke="currentColor", stroke-width 1.8, round cap/join)로 그린다. 기능과는 무관한
// 순수 장식이며, 어떤 클릭 로직과도 연결하지 않는다.
const MOBILE_MORE_ICON_PATHS = {
  user: ['<circle cx="12" cy="8" r="3.4"/>', '<path d="M5 20c0-4 3.2-6.5 7-6.5s7 2.5 7 6.5"/>'],
  upload: ['<path d="M12 15V5"/>', '<path d="M8 9l4-4 4 4"/>', '<path d="M5 15v2.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V15"/>'],
  history: ['<circle cx="12" cy="12" r="8.5"/>', '<path d="M12 7.5V12l3 2.2"/>'],
  calendar: ['<rect x="4" y="5" width="16" height="15" rx="2"/>', '<path d="M4 10h16"/>', '<path d="M8 3v4M16 3v4"/>'],
  logout: ['<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10"/>', '<path d="M14 12H4.5"/>', '<path d="M11 8.5 14.5 12 11 15.5"/>'],
  chevron: ['<path d="M9 5.5 15 12l-6 6.5"/>'],
};

function buildMobileMoreIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mobile-more-icon-svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const parts = MOBILE_MORE_ICON_PATHS[name] || [];
  parts.forEach(markup => svg.insertAdjacentHTML('beforeend', markup));
  return svg;
}

// STEP15-E.6: 회원관리/엑셀업로드/업로드이력/감독일정 패널이 mobile-view-more 위에 전체화면으로
// 덮일 때, 다시 "더보기" 목록으로 돌아갈 수 있는 닫기(×) 버튼이 없던 패널(admin-panel)에
// 최소한으로 하나 추가한다. 클릭 시 해당 패널의 표시 여부(style.display)만 되돌릴 뿐,
// 새 router/history나 별도 상태를 만들지 않는다 — 기존 #btn-supervision-close와 동일한 방식.
function buildMobilePanelCloseBtn(panelId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mobile-panel-close-btn';
  btn.setAttribute('aria-label', '닫기');
  btn.textContent = '×';
  btn.addEventListener('click', () => {
    const panel = document.getElementById(panelId);
    if (panel) panel.style.display = 'none';
  });
  return btn;
}

// STEP15-D/E.6. 모바일 "더보기" 탭. 회원관리/엑셀업로드/업로드이력/감독일정/로그아웃을 새로
// 구현하지 않고, 기존 PC 전용 버튼(#btn-admin-panel/#btn-upload-panel/#btn-supervision-panel/
// #logout-approved)을 그대로 .click()으로 위임한다 — 그 버튼들에 이미 bindEvents()(js/app.js)가
// 등록해 둔 기존 열기/렌더/권한 검사 로직을 그대로 재사용하고, 여기서는 어떤 데이터 조회나
// RPC 호출도 직접 하지 않는다. "업로드 이력"도 별도 화면을 새로 만들지 않고 동일한 업로드 패널
// (이미 상단에 이력을 보여준다)을 그대로 연다. STEP15-E.6: 메뉴를 관리/업무/계정 그룹으로
// 나누고 행마다 아이콘 + chevron을 붙여 iOS/Android 설정화면과 비슷하게 정돈한다 —
// isAdmin() 분기(관리자만 회원관리/엑셀업로드/업로드이력 노출)는 기존 그대로다.
export function renderMobileMoreMenu(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const profile = state.profile;
  const admin = isAdmin();

  const profileCard = document.createElement('div');
  profileCard.className = 'mobile-more-profile';

  const nameEl = document.createElement('div');
  nameEl.className = 'mobile-more-name';
  nameEl.textContent = profile ? displayValue(profile.name) : '-';
  if (admin) {
    const badge = document.createElement('span');
    badge.className = 'mobile-more-admin-badge';
    badge.textContent = '관리자';
    nameEl.appendChild(badge);
  }
  profileCard.appendChild(nameEl);

  const emailEl = document.createElement('div');
  emailEl.className = 'mobile-more-email';
  emailEl.textContent = profile ? displayValue(profile.email) : '-';
  profileCard.appendChild(emailEl);

  container.appendChild(profileCard);

  // 그룹 제목(관리/업무/계정)은 시각적 분류일 뿐, admin 여부에 따라 항목이 비면 그룹 자체를
  // 그리지 않는다(빈 "관리" 그룹 헤더가 일반 사용자에게 노출되지 않도록).
  function addMenuGroup(title, items) {
    if (!items || items.length === 0) return;

    const groupTitle = document.createElement('div');
    groupTitle.className = 'mobile-more-group-title';
    groupTitle.textContent = title;
    container.appendChild(groupTitle);

    const group = document.createElement('div');
    group.className = 'mobile-more-menu';

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mobile-more-item' + (item.danger ? ' mobile-more-item-danger' : '');

      const iconWrap = document.createElement('span');
      iconWrap.className = 'mobile-more-item-icon';
      iconWrap.appendChild(buildMobileMoreIcon(item.icon));
      btn.appendChild(iconWrap);

      const labelEl = document.createElement('span');
      labelEl.className = 'mobile-more-item-label';
      labelEl.textContent = item.label;
      btn.appendChild(labelEl);

      // 로그아웃은 다음 화면으로 "들어가는" 항목이 아니라 즉시 실행되는 동작이라
      // drill-down을 뜻하는 chevron(>)을 붙이지 않는다.
      if (!item.danger) {
        const chevronWrap = document.createElement('span');
        chevronWrap.className = 'mobile-more-item-chevron';
        chevronWrap.appendChild(buildMobileMoreIcon('chevron'));
        btn.appendChild(chevronWrap);
      }

      btn.addEventListener('click', item.onClick);
      group.appendChild(btn);
    });

    container.appendChild(group);
  }

  addMenuGroup('관리', admin ? [
    { label: '회원 관리', icon: 'user', onClick: () => document.getElementById('btn-admin-panel').click() },
    { label: '엑셀 업로드', icon: 'upload', onClick: () => document.getElementById('btn-upload-panel').click() },
    { label: '업로드 이력', icon: 'history', onClick: () => document.getElementById('btn-upload-panel').click() },
  ] : []);

  addMenuGroup('업무', [
    { label: '감독일정', icon: 'calendar', onClick: () => document.getElementById('btn-supervision-panel').click() },
  ]);

  addMenuGroup('계정', [
    { label: '로그아웃', icon: 'logout', danger: true, onClick: () => document.getElementById('logout-approved').click() },
  ]);
}

let searchDebounceTimer = null;
let searchSortEventsbound = false;

// 사용자 요청: "관할" 필터 버튼(summary)에 현재 선택 상태를 보여준다.
// 0개 선택 = "관할"(기본표기, 전체), 1개 = 그 동 이름, 2개 이상 = "OO동 외 N".
function updateDongFilterLabel() {
  const labelEl = document.getElementById('site-dong-filter-label');
  const filterEl = document.getElementById('site-dong-filter');
  if (!labelEl) return;
  const selected = state.selectedDongs;
  if (!selected || selected.length === 0) labelEl.textContent = '관할';
  else if (selected.length === 1) labelEl.textContent = selected[0];
  else labelEl.textContent = `${selected[0]} 외 ${selected.length - 1}`;
  // css/mobile.css의 .site-select-filter[data-active="true"] 강조 스타일용.
  if (filterEl) filterEl.dataset.active = String(!!(selected && selected.length > 0));

  // 사용자 피드백: "전체" 버튼도 다른 옵션 행과 동일하게, 아무 동도 선택되지 않았을 때
  // 체크 표시(✓)가 보이도록 한다(.site-select-filter-option:has(input:checked)와 동일한
  // 선택 강조를 버튼 쪽은 .is-checked 클래스로 흉내낸다 — <button>은 :checked가 없으므로).
  const clearBtn = document.getElementById('site-dong-filter-clear');
  if (clearBtn) clearBtn.classList.toggle('is-checked', !selected || selected.length === 0);
}

// 사용자 요청: 공사금액/점검/산재표를 관할과 동일한 <details> 커스텀 드롭다운(단일선택 radio)
// UI로 통일한다. 패널 열기 시 화면 좌표 계산/바깥 클릭 시 닫기/활성 강조는 관할의 방식과
// 완전히 동일하며, 이 함수 하나로 세 필터에 공통 적용해 중복 코드 없이 항상 같은 동작을 보장한다.
// detailsId: <details> id (예: 'site-amount-filter'), stateKey: state의 해당 필터 키,
// labels: { value: 라벨텍스트 } 맵('all' 포함 — 미선택 시 필터명 그대로 표시).
function bindRadioFilterDetails(detailsId, stateKey, containerId, labels) {
  const detailsEl = document.getElementById(detailsId);
  if (!detailsEl) return;
  const labelEl = document.getElementById(`${detailsId}-label`);
  const panel = document.getElementById(`${detailsId}-panel`);
  if (!labelEl) return;

  function updateLabel() {
    const value = state[stateKey] || 'all';
    labelEl.textContent = labels[value] || labels.all;
    detailsEl.dataset.active = String(value !== 'all');
  }

  detailsEl.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.checked = radio.value === (state[stateKey] || 'all');
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state[stateKey] = radio.value;
      updateLabel();
      detailsEl.open = false;
      renderSiteList(containerId);
    });
  });

  // details/summary는 바깥 클릭 시 자동으로 닫히지 않으므로, 패널 바깥을 클릭하면 닫아준다
  // (관할과 동일한 방식).
  document.addEventListener('click', (e) => {
    if (detailsEl.open && !detailsEl.contains(e.target)) {
      detailsEl.open = false;
    }
  });

  // #site-filter-row의 overflow-x:auto가 overflow-y도 auto로 강제 승격시켜 position:absolute
  // 패널이 잘리는 문제(관할에서 처음 발견)가 여기서도 동일하게 발생하므로, 같은 방식으로
  // position:fixed 패널의 좌표를 열 때마다 버튼의 실제 화면 위치로 계산해 넣는다.
  if (panel) {
    detailsEl.addEventListener('toggle', () => {
      if (!detailsEl.open) return;
      const rect = detailsEl.getBoundingClientRect();
      panel.style.top = `${Math.round(rect.bottom + 6)}px`;
      panel.style.left = `${Math.round(rect.left)}px`;
    });
  }

  updateLabel();
}

// 사용자 요청: "관할" 필터를 복수 선택 checkbox 패널로 구성한다. state.sites가 갱신될 때마다
// 호출 가능하도록 매번 옵션을 새로 생성한다(중복 누적 없음). 기존 함수명(renderDongOptions)은
// app.js 호출부와의 호환을 위해 그대로 유지한다.
export function renderDongOptions() {
  const optionsContainer = document.getElementById('site-dong-filter-options');
  if (!optionsContainer) return;
  optionsContainer.innerHTML = '';

  const dongs = getDongOptions();
  // 이전 선택값 중 새 목록에도 남아있는 것만 유지한다(사업장 데이터 갱신으로 사라진 동은 자동 해제).
  state.selectedDongs = (state.selectedDongs || []).filter(d => dongs.includes(d));

  dongs.forEach(dong => {
    const label = document.createElement('label');
    // 사용자 피드백(촌스럽다는 지적): 공사금액/점검/산재표와 완전히 같은 공통 옵션 행 클래스로
    // 통일한다(이전에는 관할만 별도 .site-dong-filter-option 클래스를 써서 CSS가 어긋나 있었다).
    label.className = 'site-select-filter-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = dong;
    checkbox.checked = state.selectedDongs.includes(dong);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!state.selectedDongs.includes(dong)) state.selectedDongs.push(dong);
      } else {
        state.selectedDongs = state.selectedDongs.filter(d => d !== dong);
      }
      updateDongFilterLabel();
      renderSiteList('site-list');
    });

    const text = document.createElement('span');
    text.textContent = dong;

    const check = document.createElement('span');
    check.className = 'site-select-filter-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';

    label.appendChild(checkbox);
    label.appendChild(text);
    label.appendChild(check);
    optionsContainer.appendChild(label);
  });

  updateDongFilterLabel();
}

// 검색 input/관할(다중선택)/금액/정렬/점검/산재표/즐겨찾기 이벤트를 1회만 바인딩한다
// (중복 등록 방지 플래그). 검색은 200ms debounce, 나머지는 즉시 반영. 모두 state 값만
// 갱신하고 렌더는 renderSiteList가 담당한다.
export function bindSearchAndSort(containerId) {
  if (searchSortEventsbound) return;
  searchSortEventsbound = true;

  const searchInput = document.getElementById('site-search-input');
  const sortSelect = document.getElementById('site-sort-select');
  const dongFilterEl = document.getElementById('site-dong-filter');
  const dongFilterClearBtn = document.getElementById('site-dong-filter-clear');
  const searchClearBtn = document.getElementById('site-search-clear-btn');
  const favoriteFilterBtn = document.getElementById('site-favorite-filter-btn');

  searchInput.addEventListener('input', () => {
    if (searchClearBtn) searchClearBtn.style.display = searchInput.value ? 'inline-block' : 'none';
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.searchQuery = searchInput.value.trim();
      renderSiteList(containerId);
    }, 200);
  });

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      clearTimeout(searchDebounceTimer);
      searchInput.value = '';
      state.searchQuery = '';
      searchClearBtn.style.display = 'none';
      renderSiteList(containerId); // 검색어만 비우고 관할/금액/점검/산재표/즐겨찾기/정렬은 그대로 유지된다.
    });
  }

  sortSelect.addEventListener('change', () => {
    state.sortMode = sortSelect.value;
    renderSiteList(containerId);
  });

  // 사용자 요청: "전체" 버튼은 관할 선택을 한 번에 초기화한다(개별 체크박스 이벤트는
  // renderDongOptions()가 각자 바인딩).
  if (dongFilterClearBtn) {
    dongFilterClearBtn.addEventListener('click', () => {
      state.selectedDongs = [];
      document.querySelectorAll('#site-dong-filter-options input[type="checkbox"]')
        .forEach(cb => { cb.checked = false; });
      updateDongFilterLabel();
      if (dongFilterEl) dongFilterEl.open = false;
      renderSiteList(containerId);
    });
  }

  // details/summary는 바깥 클릭 시 자동으로 닫히지 않으므로, 패널 바깥을 클릭하면 닫아준다.
  if (dongFilterEl) {
    document.addEventListener('click', (e) => {
      if (dongFilterEl.open && !dongFilterEl.contains(e.target)) {
        dongFilterEl.open = false;
      }
    });

    // 사용자 요청 기능 확인 중 발견: #site-filter-row가 가로 스크롤(overflow-x:auto)이라
    // CSS 스펙상 overflow-y도 auto로 강제 승격되어, absolute로 띄운 패널이 그 아래로 잘려
    // 화면에 전혀 보이지 않는 버그가 있었다. css/mobile.css에서 패널을 position:fixed로
    // 바꾸고(조상 overflow에 영향받지 않음), 열릴 때마다 여기서 버튼의 실제 화면 좌표
    // (getBoundingClientRect)를 읽어 top/left를 직접 계산해 넣는다.
    dongFilterEl.addEventListener('toggle', () => {
      if (!dongFilterEl.open) return;
      const panel = document.getElementById('site-dong-filter-panel');
      if (!panel) return;
      const rect = dongFilterEl.getBoundingClientRect();
      panel.style.top = `${Math.round(rect.bottom + 6)}px`;
      panel.style.left = `${Math.round(rect.left)}px`;
    });
  }

  // 사용자 요청: 공사금액/점검/산재표를 관할과 동일한 details+radio 팝오버 UI로 통일(위
  // bindRadioFilterDetails 참고). 라벨 텍스트는 각 필터명 그대로 기본표기한다.
  bindRadioFilterDetails('site-amount-filter', 'amountFilter', containerId, {
    all: '공사금액',
    'under-5b': '50억 미만',
    '5b-12b': '50억 이상 ~ 120억 미만',
    'over-12b': '120억 이상',
  });
  bindRadioFilterDetails('site-inspection-filter', 'siteInspectionFilter', containerId, {
    all: '점검',
    yes: '점검 유',
    no: '점검 무',
  });
  bindRadioFilterDetails('site-accident-report-filter', 'siteAccidentReportFilter', containerId, {
    all: '산재표',
    yes: '산재표 유',
    no: '산재표 무',
  });

  // STEP14.5-B. "즐겨찾기만 보기" — 토글형 버튼. 다시 누르면 해제되어 기존 필터 결과로 복귀.
  if (favoriteFilterBtn) {
    favoriteFilterBtn.addEventListener('click', () => {
      state.favoriteOnly = !state.favoriteOnly;
      favoriteFilterBtn.classList.toggle('active', state.favoriteOnly);
      renderSiteList(containerId);
    });
  }
}

// 회원관리 패널을 렌더한다. loadUsers()로 채워진 state.adminUsers를 그린다 (관리자 전용).
// 상태/역할은 select 변경만으로 DB에 반영되지 않고, 각자 "저장" 버튼을 눌러야 RPC가 호출된다.
export async function renderAdminPanel(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  // STEP15-E.6: 회원관리 패널은 모바일 "더보기" 탭에서 열면 전체화면으로 덮이는데
  // 기존에는 닫고 돌아갈 버튼이 없었다. 여기서 닫기(×) 버튼을 하나 추가한다 — PC에서는
  // css/mobile.css 기본값(.mobile-panel-close-btn)이 항상 숨기므로 PC 화면은 그대로다.
  container.appendChild(buildMobilePanelCloseBtn(containerId));

  const msgEl = document.createElement('p');
  msgEl.id = 'admin-message';
  msgEl.textContent = state.adminMessage;
  container.appendChild(msgEl);

  await loadUsers();

  if (!state.adminUsers || state.adminUsers.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '표시할 회원이 없습니다.';
    container.appendChild(empty);
    return;
  }

  const currentUserId = state.user ? state.user.id : null;

  state.adminUsers.forEach(u => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';

    const info = document.createElement('div');
    info.className = 'admin-user-info';
    [
      ['이름', u.name],
      ['이메일', u.email],
      ['역할', u.role],
      ['상태', u.status],
      ['가입일', u.created_at]
    ].forEach(([label, value]) => {
      const line = document.createElement('div');
      line.textContent = `${label}: ${displayValue(value)}`;
      info.appendChild(line);
    });
    row.appendChild(info);

    const isSelf = currentUserId === u.id;

    // 상태 select + 저장 버튼
    const statusSelect = document.createElement('select');
    ['pending', 'approved', 'rejected', 'disabled'].forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === u.status) opt.selected = true;
      // 자기 자신 보호: 본인 행에서는 rejected/disabled로 이동 불가
      if (isSelf && (s === 'rejected' || s === 'disabled')) opt.disabled = true;
      statusSelect.appendChild(opt);
    });

    const statusSaveBtn = document.createElement('button');
    statusSaveBtn.type = 'button';
    statusSaveBtn.textContent = '상태 저장';
    statusSaveBtn.addEventListener('click', () =>
      handleAdminChange(u.id, () => setUserStatus(u.id, statusSelect.value), containerId, [statusSaveBtn, roleSaveBtn])
    );

    // 역할 select + 저장 버튼
    const roleSelect = document.createElement('select');
    ['user', 'admin'].forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      if (r === u.role) opt.selected = true;
      // 자기 자신 보호: 본인 행에서는 user로 강등 불가
      if (isSelf && r === 'user') opt.disabled = true;
      roleSelect.appendChild(opt);
    });

    const roleSaveBtn = document.createElement('button');
    roleSaveBtn.type = 'button';
    roleSaveBtn.textContent = '역할 저장';
    roleSaveBtn.addEventListener('click', () =>
      handleAdminChange(u.id, () => setUserRole(u.id, roleSelect.value), containerId, [statusSaveBtn, roleSaveBtn])
    );

    row.appendChild(statusSelect);
    row.appendChild(statusSaveBtn);
    row.appendChild(roleSelect);
    row.appendChild(roleSaveBtn);

    container.appendChild(row);
  });
}

// status/role 변경 공통 처리. userId 기준 in-flight로 중복 요청을 막고,
// 요청 시작 즉시 해당 사용자의 두 버튼(상태 저장/역할 저장)을 모두 disabled 한다.
// 재렌더 전에 반드시 Set에서 삭제해야 새로 그려질 버튼이 정상적으로 활성화 상태로 시작한다.
async function handleAdminChange(userId, action, containerId, buttons) {
  if (state.adminUserInFlight.has(userId)) return;
  state.adminUserInFlight.add(userId);
  buttons.forEach(btn => { btn.disabled = true; });

  try {
    const result = await action();
    state.adminMessage = result.message;
  } finally {
    state.adminUserInFlight.delete(userId);
    await renderAdminPanel(containerId);
  }
}

// STEP14. 감독일정 상태값 -> 한글 표시.
const SUPERVISION_STATUS_LABEL = { scheduled: '예정', ongoing: '진행중', done: '완료' };
// 목록 정렬 우선순위: 진행중 -> 예정 -> 완료.
const SUPERVISION_STATUS_ORDER = { ongoing: 0, scheduled: 1, done: 2 };
// 상태 배지 색상 구분용 클래스(components.css의 .sv-badge-* 규칙과 매칭).
const SUPERVISION_STATUS_CLASS = { scheduled: 'sv-badge-scheduled', ongoing: 'sv-badge-ongoing', done: 'sv-badge-done' };
const SUPERVISION_FILTERS = ['all', 'scheduled', 'ongoing', 'done'];
// 시작일/종료일 허용 범위(비정상적인 연도 입력 방지). 'YYYY-MM-DD' 문자열 비교로 충분(항상 zero-padded ISO).
const SUPERVISION_MIN_DATE = '2000-01-01';
const SUPERVISION_MAX_DATE = '2100-12-31';

// 오늘 날짜를 로컬 타임존 기준 'YYYY-MM-DD'로 반환한다(new Date().toISOString()은 UTC라
// 자정 근처에 하루가 밀릴 수 있어 사용하지 않는다).
function todayDateString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 감독명/시작일/종료일만으로 상태(예정/진행중/완료)를 오늘 날짜 기준으로 계산한다.
// 사용자가 상태를 직접 고르지 않으므로 등록/수정 시 저장할 값과, 목록에 보여줄 값 모두
// 이 함수 하나로만 결정한다 — 두 곳의 판정 기준이 어긋나는 일이 없도록 한다.
// 'YYYY-MM-DD' 문자열은 사전식 비교가 곧 날짜 비교와 같다(항상 zero-padded ISO 형식이므로).
function computeSupervisionStatus(startDate, endDate) {
  const today = todayDateString();
  if (today < startDate) return 'scheduled';
  if (today > endDate) return 'done';
  return 'ongoing';
}

// 감독일정 상황판을 렌더한다. approved 전체가 조회 가능, admin만 등록/수정/삭제 버튼이 보인다
// (최종 방어는 RLS: INSERT/UPDATE/DELETE 정책 자체가 admin만 허용).
export async function renderSupervisionPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // 닫기(×) 버튼 — 패널을 열 때마다 재바인딩(cloneNode로 이전 리스너 제거, 중복 방지).
  const closeBtn = document.getElementById('btn-supervision-close');
  if (closeBtn) {
    const freshCloseBtn = closeBtn.cloneNode(true);
    closeBtn.replaceWith(freshCloseBtn);
    freshCloseBtn.addEventListener('click', () => { container.style.display = 'none'; });
  }

  // 상태 필터 버튼 — 클릭 시 state.supervisionFilter만 바꾸고 패널을 다시 그린다(DB/RLS 무관, 프론트 표시만 변경).
  document.querySelectorAll('.sv-filter-btn').forEach(btn => {
    const freshBtn = btn.cloneNode(true);
    btn.replaceWith(freshBtn);
    freshBtn.classList.toggle('active', freshBtn.dataset.filter === state.supervisionFilter);
    freshBtn.addEventListener('click', () => {
      const filter = freshBtn.dataset.filter;
      state.supervisionFilter = SUPERVISION_FILTERS.includes(filter) ? filter : 'all';
      renderSupervisionPanel(containerId);
    });
  });

  // container(supervision-panel) 전체를 비우면 이미 index.html에 있는 header/filter/form 마크업까지
  // 사라지므로, 여기서는 그 안의 목록/등록버튼 영역만 다시 그린다(폼은 별도 show/hide로만 다룬다).
  let listWrap = document.getElementById('supervision-list-wrap');
  if (!listWrap) {
    listWrap = document.createElement('div');
    listWrap.id = 'supervision-list-wrap';
    container.appendChild(listWrap);
  }
  // 목록 화면으로 진입(최초 오픈/저장 완료/취소)할 때마다 폼은 닫고 필터바+목록은 보이게 되돌린다
  // (showSupervisionForm이 반대로 숨긴다 — 폼이 열린 동안 목록을 감추기 위함).
  const formEl = document.getElementById('supervision-form');
  if (formEl) formEl.style.display = 'none';
  const filterBarEl = document.getElementById('supervision-filter-bar');
  if (filterBarEl) filterBarEl.style.display = '';
  listWrap.style.display = '';
  listWrap.innerHTML = '';

  const rows = await loadSupervisions();
  state.supervisions = rows;

  const newBtn = document.getElementById('btn-sv-new');
  if (newBtn) {
    newBtn.style.display = isAdmin() ? 'inline-block' : 'none';
    const freshNewBtn = newBtn.cloneNode(true); // 이전 클릭 리스너 제거(재렌더 시 중복 바인딩 방지)
    newBtn.replaceWith(freshNewBtn);
    freshNewBtn.addEventListener('click', () => showSupervisionForm(containerId, null));
  }

  const listEl = document.createElement('div');
  listEl.id = 'supervision-list';
  listWrap.appendChild(listEl);

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '등록된 감독일정이 없습니다.';
    listEl.appendChild(empty);
    return;
  }

  // DB에 저장된 sv.status는 그 값을 저장한 시점의 스냅샷일 뿐이므로(예: 예전에 등록해두고
  // 아무도 다시 열어보지 않은 일정), 정렬/필터/배지 전부 오늘 날짜 기준으로 매번 다시 계산한
  // computeSupervisionStatus() 결과만 사용한다 — DB 값을 신뢰하지 않는다.
  const sorted = [...rows].sort((a, b) => {
    const statusA = computeSupervisionStatus(a.start_date, a.end_date);
    const statusB = computeSupervisionStatus(b.start_date, b.end_date);
    const orderDiff = SUPERVISION_STATUS_ORDER[statusA] - SUPERVISION_STATUS_ORDER[statusB];
    if (orderDiff !== 0) return orderDiff;
    return (a.start_date || '') < (b.start_date || '') ? 1 : -1; // 같은 상태 안에서는 최근 시작일 우선
  });

  const filtered = state.supervisionFilter === 'all'
    ? sorted
    : sorted.filter(sv => computeSupervisionStatus(sv.start_date, sv.end_date) === state.supervisionFilter);

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '해당 상태의 감독일정이 없습니다.';
    listEl.appendChild(empty);
    return;
  }

  filtered.forEach(sv => {
    const row = document.createElement('div');
    row.className = 'supervision-row';

    const info = document.createElement('div');
    info.className = 'supervision-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'supervision-title-row';
    const titleEl = document.createElement('strong');
    titleEl.textContent = sv.title;
    const liveStatus = computeSupervisionStatus(sv.start_date, sv.end_date);
    const badge = document.createElement('span');
    badge.className = `sv-badge ${SUPERVISION_STATUS_CLASS[liveStatus] || ''}`;
    badge.textContent = SUPERVISION_STATUS_LABEL[liveStatus] || liveStatus;
    titleRow.appendChild(titleEl);
    titleRow.appendChild(badge);
    info.appendChild(titleRow);

    const meta = document.createElement('div');
    meta.className = 'supervision-meta';
    meta.textContent = `${sv.manager_name || '-'} · ${sv.start_date} ~ ${sv.end_date}`;
    info.appendChild(meta);

    row.appendChild(info);

    if (isAdmin()) {
      const actions = document.createElement('div');
      actions.className = 'supervision-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '수정';
      editBtn.addEventListener('click', () => showSupervisionForm(containerId, sv));
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = '삭제';
      deleteBtn.addEventListener('click', () => handleDeleteSupervision(containerId, sv.id));
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
    }

    listEl.appendChild(row);
  });
}

// 등록/수정 폼을 채우고 연다. existing이 null이면 신규 등록, 있으면 그 값으로 폼을 채운다.
function showSupervisionForm(containerId, existing) {
  const form = document.getElementById('supervision-form');
  const errorEl = document.getElementById('supervision-form-error');
  errorEl.textContent = '';
  form.style.display = 'block';

  // 폼이 열린 동안에는 기존 목록/필터바를 숨기고 폼만 보여준다(저장/취소 시 renderSupervisionPanel
  // 또는 취소 핸들러가 다시 되돌린다).
  const filterBarEl = document.getElementById('supervision-filter-bar');
  if (filterBarEl) filterBarEl.style.display = 'none';
  const listWrapEl = document.getElementById('supervision-list-wrap');
  if (listWrapEl) listWrapEl.style.display = 'none';

  document.getElementById('sv-id').value = existing ? existing.id : '';
  document.getElementById('sv-title').value = existing ? existing.title : '';
  document.getElementById('sv-manager').value = existing ? (existing.manager_name || '') : '';
  document.getElementById('sv-start').value = existing ? existing.start_date : '';
  document.getElementById('sv-end').value = existing ? existing.end_date : '';
  // 상태는 더 이상 폼에서 직접 고르지 않는다 — handleSaveSupervision()이 저장 시점에
  // computeSupervisionStatus()로 자동 계산한다.

  const saveBtn = document.getElementById('btn-sv-save');
  const newSaveBtn = saveBtn.cloneNode(true); // 이전 클릭 리스너 제거(중복 바인딩 방지)
  saveBtn.replaceWith(newSaveBtn);
  newSaveBtn.addEventListener('click', () => handleSaveSupervision(containerId, existing ? existing.id : null));

  const cancelBtn = document.getElementById('btn-sv-cancel');
  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.replaceWith(newCancelBtn);
  newCancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
    // 취소 시 목록을 다시 불러올 필요는 없으므로 숨겨뒀던 필터바/목록만 다시 보여준다.
    const filterBarEl = document.getElementById('supervision-filter-bar');
    if (filterBarEl) filterBarEl.style.display = '';
    const listWrapEl = document.getElementById('supervision-list-wrap');
    if (listWrapEl) listWrapEl.style.display = '';
  });
}

// 등록/수정 저장. 감독명/시작일/종료일 필수, 종료일>=시작일. 상태는 사용자가 고르지 않고
// 오늘 날짜 기준으로 computeSupervisionStatus()가 자동 계산해서 저장한다.
async function handleSaveSupervision(containerId, editingId) {
  const errorEl = document.getElementById('supervision-form-error');
  errorEl.textContent = '';

  const title = document.getElementById('sv-title').value.trim();
  const manager = document.getElementById('sv-manager').value.trim();
  const start = document.getElementById('sv-start').value;
  const end = document.getElementById('sv-end').value;

  if (!title) { errorEl.textContent = '감독명을 입력해주세요.'; return; }
  if (!start) { errorEl.textContent = '시작일을 입력해주세요.'; return; }
  if (!end) { errorEl.textContent = '종료일을 입력해주세요.'; return; }
  // 비정상적인 연도(입력 오류로 인한 극단값 등) 방지 — 'YYYY-MM-DD' 문자열은 사전식 비교로 안전하게 범위 검사 가능.
  if (start < SUPERVISION_MIN_DATE || start > SUPERVISION_MAX_DATE || end < SUPERVISION_MIN_DATE || end > SUPERVISION_MAX_DATE) {
    errorEl.textContent = `시작일/종료일은 ${SUPERVISION_MIN_DATE} ~ ${SUPERVISION_MAX_DATE} 범위 내에서 입력해주세요.`;
    return;
  }
  if (end < start) { errorEl.textContent = '종료일은 시작일보다 빠를 수 없습니다.'; return; }

  const status = computeSupervisionStatus(start, end);
  const fields = { title, manager_name: manager || null, start_date: start, end_date: end, status };
  const result = editingId
    ? await updateSupervision(editingId, fields)
    : await createSupervision(fields);

  if (!result.success) {
    errorEl.textContent = result.message;
    return;
  }

  document.getElementById('supervision-form').style.display = 'none';
  await renderSupervisionPanel(containerId);
}

async function handleDeleteSupervision(containerId, id) {
  // STEP14.5-B. 즉시 DELETE하지 않고 확인 후 삭제 — 취소 시 아무 작업도 하지 않는다.
  if (!window.confirm('이 감독일정을 삭제하시겠습니까?')) return;
  const result = await deleteSupervision(id);
  if (!result.success) {
    console.error('감독일정 삭제 실패:', result.message);
    return;
  }
  await renderSupervisionPanel(containerId);
}

// STEP13-5: 관리자 업로드 영역(upload-panel)이 열릴 때 최근 업로드 이력을 조회해 표시한다.
// containerId가 가리키는 요소 안에 이력 목록을 렌더한다(예: 'upload-history' div).
export async function renderUploadHistoryPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  const loadingMsg = document.createElement('p');
  loadingMsg.textContent = '업로드 이력을 불러오는 중...';
  container.appendChild(loadingMsg);

  const list = await loadUploadHistory(10);
  state.uploadHistoryList = list;

  container.innerHTML = '';
  const heading = document.createElement('p');
  heading.textContent = '최근 업로드 이력';
  container.appendChild(heading);

  if (list.length === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = '업로드 이력이 없습니다.';
    container.appendChild(emptyMsg);
    return;
  }

  list.forEach(h => {
    const row = document.createElement('div');
    row.className = 'upload-history-row';
    const when = h.uploaded_at ? new Date(h.uploaded_at).toLocaleString() : '';
    row.textContent =
      `${when} · ${h.file_name || '-'} (${h.source_form || '-'}) · ` +
      `${h.uploaded_by_name || '-'} · 전체 ${h.total_rows ?? '-'}건 · 확정 ${h.confirmed_rows ?? '-'}건 · 확인필요 ${h.review_rows ?? '-'}건`;
    container.appendChild(row);
  });
}

// 엑셀 파일 선택 시 파싱하고 결과 요약 + 미리보기 목록을 렌더한다.
// 이번 STEP은 DB에 아무것도 반영하지 않는다 — geocoding/RPC는 STEP 11/12에서 이 결과(state.uploadParsedRows)를 이어받는다.
export async function handleExcelFileSelect(file, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  state.geocodeProgress = null; // 새 파일 선택 시 이전 geocoding 진행상황 초기화
  state.geocodeInProgress = false;
  state.uploadFileName = file.name; // STEP12-C: RPC payload의 file_name에 사용
  state.uploadImportResult = null; // 새 파일 선택 시 이전 import 결과 초기화

  const loadingMsg = document.createElement('p');
  loadingMsg.textContent = '파일을 읽는 중...';
  container.appendChild(loadingMsg);

  try {
    await parseExcelFile(file, state);
  } catch (err) {
    console.error('엑셀 파싱 실패:', err);
    container.innerHTML = '';
    const errMsg = document.createElement('p');
    errMsg.textContent = '파일을 읽는 중 오류가 발생했습니다.';
    container.appendChild(errMsg);
    return;
  }

  renderUploadPreview(containerId);
}

function renderUploadPreview(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const summary = state.uploadValidationSummary;

  if (!state.uploadDetectedForm) {
    const msg = document.createElement('p');
    msg.textContent = '인식할 수 없는 양식입니다. 지원하는 엑셀 양식인지 확인해주세요.';
    container.appendChild(msg);
    return;
  }

  const summaryEl = document.createElement('div');
  summaryEl.className = 'upload-summary';
  const summaryLines = [
    `인식된 양식: ${state.uploadDetectedForm}`,
    `전체 ${summary.total}건 · 정상 ${summary.validCount}건 · 경고 ${summary.warningCount}건 · 오류 ${summary.errorCount}건` +
      (summary.duplicateCount > 0 ? ` (그 중 배치 내 중복 ${summary.duplicateCount}건)` : '')
  ];
  summaryLines.forEach(line => {
    const p = document.createElement('p');
    p.textContent = line;
    summaryEl.appendChild(p);
  });
  container.appendChild(summaryEl);

  // geocoding 버튼 + 진행상황 표시 영역. ERROR가 아니고 address가 있는 행만 대상이 된다.
  const geocodeSection = document.createElement('div');
  geocodeSection.id = 'geocode-section';

  const geocodeBtn = document.createElement('button');
  geocodeBtn.type = 'button';
  geocodeBtn.id = 'btn-geocode-start';
  geocodeBtn.textContent = '주소 좌표 확인';
  geocodeBtn.disabled = state.geocodeInProgress;
  geocodeBtn.addEventListener('click', () => handleGeocodeStart(containerId));
  geocodeSection.appendChild(geocodeBtn);

  const progressEl = document.createElement('p');
  progressEl.id = 'geocode-progress-text';
  if (state.geocodeProgress) {
    const p = state.geocodeProgress;
    progressEl.textContent = `대상 ${p.total}건 중 완료 ${p.done}건 (성공 ${p.success} · 결과없음 ${p.notFound} · 오류 ${p.error})`;
  }
  geocodeSection.appendChild(progressEl);

  // 위치 품질 요약(전체/정확/추정/대표위치/확인필요/오류) — geocoding을 1회 이상 실행한 뒤에만 의미 있는 값이 있다.
  const qualityCounts = { EXACT: 0, ESTIMATED: 0, APPROXIMATE: 0, UNRESOLVED: 0 };
  let errorCount = 0;
  state.uploadParsedRows.forEach(row => {
    if (row._locationQuality === 'EXACT') qualityCounts.EXACT++;
    else if (row._locationQuality === 'ESTIMATED') qualityCounts.ESTIMATED++;
    else if (row._locationQuality === 'APPROXIMATE') qualityCounts.APPROXIMATE++;
    else if (row._locationQuality === 'UNRESOLVED') {
      if (row._geocodeStatus === 'ERROR') errorCount++;
      else qualityCounts.UNRESOLVED++;
    }
  });
  const hasGeocodeRun = state.uploadParsedRows.some(row => row._geocodeStatus);
  if (hasGeocodeRun) {
    const qualityEl = document.createElement('p');
    qualityEl.id = 'geocode-quality-summary';
    qualityEl.textContent =
      `전체 ${state.uploadParsedRows.length} · 정확 위치 ${qualityCounts.EXACT} · 추정 위치 ${qualityCounts.ESTIMATED} · ` +
      `대표 위치(확인요망) ${qualityCounts.APPROXIMATE} · 확인 필요 ${qualityCounts.UNRESOLVED} · 오류 ${errorCount}`;
    geocodeSection.appendChild(qualityEl);

    const notFoundCount = state.uploadParsedRows.filter(r => r._geocodeStatus === 'NOT_FOUND').length;
    if (notFoundCount > 0) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.id = 'btn-toggle-notfound';
      toggleBtn.textContent = `결과없음 ${notFoundCount}건 보기`;
      toggleBtn.addEventListener('click', () => toggleNotFoundList(containerId));
      geocodeSection.appendChild(toggleBtn);

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.id = 'btn-download-notfound-csv';
      downloadBtn.textContent = '실패 목록 CSV 다운로드';
      downloadBtn.addEventListener('click', downloadNotFoundCsv);
      geocodeSection.appendChild(downloadBtn);

      const notFoundListEl = document.createElement('div');
      notFoundListEl.id = 'notfound-list';
      notFoundListEl.style.display = 'none';
      geocodeSection.appendChild(notFoundListEl);
    }

    // STEP 11G: UNRESOLVED 건이 있으면 일괄 keyword 후보검색 버튼을 노출한다.
    const unresolvedCount = state.uploadParsedRows.filter(r => r._locationQuality === 'UNRESOLVED').length;
    if (unresolvedCount > 0) {
      const keywordBtn = document.createElement('button');
      keywordBtn.type = 'button';
      keywordBtn.id = 'btn-keyword-search-all';
      keywordBtn.textContent = `미확인 위치 후보 검색 (${unresolvedCount}건)`;
      keywordBtn.disabled = state.keywordSearchInProgress;
      keywordBtn.addEventListener('click', () => handleKeywordSearchAll(containerId));
      geocodeSection.appendChild(keywordBtn);

      if (state.keywordSearchSummary) {
        const s = state.keywordSearchSummary;
        const kwSummaryEl = document.createElement('p');
        kwSummaryEl.id = 'keyword-search-summary';
        kwSummaryEl.textContent =
          `후보검색 완료 ${s.done}/${s.total} · 강한후보 ${s.strong} · 약한후보 ${s.weak} · 후보없음 ${s.none} · 오류 ${s.error}`;
        geocodeSection.appendChild(kwSummaryEl);

        const kwCsvBtn = document.createElement('button');
        kwCsvBtn.type = 'button';
        kwCsvBtn.id = 'btn-download-keyword-csv';
        kwCsvBtn.textContent = '후보검색 결과 CSV 다운로드';
        kwCsvBtn.addEventListener('click', downloadKeywordCandidatesCsv);
        geocodeSection.appendChild(kwCsvBtn);
      }

      // STEP 11H-1: 원본에 명시적 지번이 있는 UNRESOLVED 행만 대상으로 Kakao LOT 복구를 시도한다.
      const lotTargetCount = state.uploadParsedRows.filter(
        r => r._locationQuality === 'UNRESOLVED' && buildLotQueries(r).length > 0
      ).length;
      if (lotTargetCount > 0) {
        const lotBtn = document.createElement('button');
        lotBtn.type = 'button';
        lotBtn.id = 'btn-lot-recovery';
        lotBtn.textContent = `Kakao 지번(LOT) 재검색 (${lotTargetCount}건)`;
        lotBtn.disabled = state.lotRecoveryInProgress;
        lotBtn.addEventListener('click', () => handleLotRecovery(containerId));
        geocodeSection.appendChild(lotBtn);

        if (state.lotRecoverySummary) {
          const s = state.lotRecoverySummary;
          const lotSummaryEl = document.createElement('p');
          lotSummaryEl.id = 'lot-recovery-summary';
          lotSummaryEl.textContent =
            `LOT 대상 ${s.total}건 · KAKAO LOT 성공 ${s.success}건 · 결과없음 ${s.notFound}건 · 오류 ${s.error}건`;
          geocodeSection.appendChild(lotSummaryEl);
        }
      }

      // STEP 11H-3: 원본에 도로명+건물번호(또는 지번, LOT fallback)가 있는 UNRESOLVED 행만 대상으로
      // JUSO 검증을 시도한다. buildJusoQuery는 이제 buildJusoQueryInfo 기반으로 ROAD/LOT 둘 다 포함한다.
      const jusoTargetCount = state.uploadParsedRows.filter(
        r => r._locationQuality === 'UNRESOLVED' && buildJusoQuery(r) !== null
      ).length;
      if (jusoTargetCount > 0) {
        const jusoBtn = document.createElement('button');
        jusoBtn.type = 'button';
        jusoBtn.id = 'btn-juso-normalize';
        jusoBtn.textContent = `행안부 주소 재검색 (${jusoTargetCount}건)`;
        jusoBtn.disabled = state.jusoNormalizeInProgress;
        jusoBtn.addEventListener('click', () => handleJusoNormalize(containerId));
        geocodeSection.appendChild(jusoBtn);

        if (state.jusoNormalizeSummary) {
          const s = state.jusoNormalizeSummary;
          const jusoSummaryEl = document.createElement('p');
          jusoSummaryEl.id = 'juso-normalize-summary';
          jusoSummaryEl.textContent =
            `대상 ${s.total} · 단일일치 ${s.matched} · 모호 ${s.ambiguous} · 검증불일치 ${s.noMatch} · 결과없음 ${s.notFound} · 오류 ${s.error} (좌표는 아직 미확정)`;
          geocodeSection.appendChild(jusoSummaryEl);
        }
      }

      // STEP 11H-4: JUSO 검증에서 정확히 1건 일치(MATCHED)한 행만 대상으로 한다.
      // AMBIGUOUS/NO_MATCH는 절대 이 대상에 포함되지 않는다 — Kakao 자동호출 금지.
      const kakaoJusoTargetCount = state.uploadParsedRows.filter(
        r => r._locationQuality === 'UNRESOLVED' &&
          r._jusoStatus === 'MATCHED' &&
          r._jusoMatchedCandidate
      ).length;
      if (kakaoJusoTargetCount > 0) {
        const kakaoJusoBtn = document.createElement('button');
        kakaoJusoBtn.type = 'button';
        kakaoJusoBtn.id = 'btn-kakao-juso-recovery';
        kakaoJusoBtn.textContent = `JUSO 주소로 좌표 확정 (${kakaoJusoTargetCount}건)`;
        kakaoJusoBtn.disabled = state.kakaoJusoInProgress;
        kakaoJusoBtn.addEventListener('click', () => handleKakaoJusoRecovery(containerId));
        geocodeSection.appendChild(kakaoJusoBtn);

        if (state.kakaoJusoSummary) {
          const s = state.kakaoJusoSummary;
          const kakaoJusoSummaryEl = document.createElement('p');
          kakaoJusoSummaryEl.id = 'kakao-juso-summary';
          kakaoJusoSummaryEl.textContent =
            `대상 ${s.total}건 · 좌표복구 ${s.success}건 · 결과없음 ${s.notFound}건 · 오류 ${s.error}건`;
          geocodeSection.appendChild(kakaoJusoSummaryEl);
        }
      }

      // STEP11 운영: ORIGINAL/NORMALIZED/CORE/LOT 이후 남은 UNRESOLVED 중 도로명 구조를
      // 안전하게 추출할 수 있는 행(LOT_FAILED/BLOCK/INSUFFICIENT는 자동 제외)만 대상으로 한다.
      const roadApproximateTargetCount = state.uploadParsedRows.filter(
        r => r._locationQuality === 'UNRESOLVED' && extractApproximateStructure(r.address) !== null
      ).length;
      if (roadApproximateTargetCount > 0) {
        const roadApproximateBtn = document.createElement('button');
        roadApproximateBtn.type = 'button';
        roadApproximateBtn.id = 'btn-road-approximate';
        roadApproximateBtn.textContent = `동일 도로 대표 위치 확보 (${roadApproximateTargetCount}건)`;
        roadApproximateBtn.disabled = state.roadApproximateInProgress;
        roadApproximateBtn.addEventListener('click', () => handleRoadApproximateRecovery(containerId));
        geocodeSection.appendChild(roadApproximateBtn);

        if (state.roadApproximateSummary) {
          const s = state.roadApproximateSummary;
          const roadApproximateSummaryEl = document.createElement('p');
          roadApproximateSummaryEl.id = 'road-approximate-summary';
          roadApproximateSummaryEl.textContent =
            `대상 ${s.total}건 · 대표위치 확보 ${s.success}건(⚠ 확인요망) · 결과없음 ${s.notFound}건 · 오류 ${s.error}건`;
          geocodeSection.appendChild(roadApproximateSummaryEl);
        }
      }
    }
  }

  // STEP12-C: geocoding 결과를 실제 DB(gnmap_v2_sites)에 반영한다. 버튼을 눌러야만 실행되며
  // 자동 실행은 없다. ERROR 행은 애초에 payload에서 제외된다(import.js).
  // unresolvedCount와 무관하게(UNRESOLVED=0이어도) 파싱된 데이터가 있으면 항상 이 영역이 존재해야 한다.
  const importTargetRows = state.uploadParsedRows.filter(row => row._validation !== 'ERROR');
  const canImport =
    !!state.uploadDetectedForm &&
    importTargetRows.length > 0 &&
    importTargetRows.every(row =>
      ['EXACT', 'ESTIMATED', 'APPROXIMATE', 'UNRESOLVED'].includes(row._locationQuality)
    ) &&
    !state.uploadImportInProgress;

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.id = 'btn-import-to-db';
  importBtn.textContent = 'DB에 저장';
  importBtn.disabled = !canImport || state.importPreviewInProgress;
  importBtn.addEventListener('click', () => handleImportToDatabase(containerId));
  geocodeSection.appendChild(importBtn);

  if (!canImport) {
    const importHintEl = document.createElement('p');
    importHintEl.id = 'import-hint';
    importHintEl.textContent = '주소 좌표 확인을 완료한 후 저장할 수 있습니다.';
    geocodeSection.appendChild(importHintEl);
  }

  // STEP13-1/2: 업로드 직전 신규/갱신 예정 건수를 표시한다(RPC 실행 전, 순수 조회 결과).
  if (state.importPreview) {
    const p = state.importPreview;
    const previewEl = document.createElement('p');
    previewEl.id = 'import-preview-summary';
    previewEl.textContent = p.success
      ? `저장 시 예상: 전체 ${p.total}건 · 신규 예정 ${p.insertCount}건 · 갱신 예정 ${p.updateCount}건`
      : `사전 검증 실패: ${p.message}`;
    geocodeSection.appendChild(previewEl);
  }

  if (state.uploadImportResult) {
    const r = state.uploadImportResult;
    const importResultEl = document.createElement('p');
    importResultEl.id = 'import-result-summary';
    importResultEl.textContent = r.success
      ? `저장 완료 · 전체 ${r.total_rows}건 · 신규 ${r.inserted}건 · 갱신 ${r.updated}건 · 확인필요 ${r.review_count}건`
      : `저장 실패: ${r.message}`;
    geocodeSection.appendChild(importResultEl);
  }

  container.appendChild(geocodeSection);

  // 미리보기는 목록이 매우 길어질 수 있으므로 최대 50건만 표시한다 (전체 데이터는 state.uploadParsedRows에 보존됨).
  const previewRows = state.uploadParsedRows.slice(0, 50);

  previewRows.forEach(row => {
    const rowEl = document.createElement('div');
    const validationClass = row._validation === 'ERROR' ? 'error' : (row._validation === 'WARNING' ? 'warning' : '');
    rowEl.className = 'upload-preview-row' + (validationClass ? ' ' + validationClass : '');

    const nameEl = document.createElement('span');
    nameEl.textContent = row.site_name || row.company_name || '-';
    rowEl.appendChild(nameEl);

    const bizNoEl = document.createElement('span');
    bizNoEl.textContent = row.business_start_no || '(식별번호 없음)';
    rowEl.appendChild(bizNoEl);

    const statusEl = document.createElement('span');
    statusEl.className = 'upload-status-badge';
    statusEl.textContent = row._validation === 'ERROR' ? '오류' : (row._validation === 'WARNING' ? '경고' : '정상');
    rowEl.appendChild(statusEl);

    if (row._geocodeStatus) {
      const geoEl = document.createElement('span');
      geoEl.className = 'upload-geocode-badge';
      // ESTIMATED는 실제로 사용된 method(NORMALIZED/CORE_ADDRESS/KAKAO_LOT/KAKAO_JUSO)에 따라 문구를 세분화한다.
      const methodQualityLabelMap = {
        NORMALIZED: '위치 추정(정제주소)',
        CORE_ADDRESS: '위치 추정(핵심주소)',
        KAKAO_LOT: '위치 추정(지번 재검색)',
        KAKAO_JUSO: '위치 추정(행안부 주소)',
      };
      const qualityLabelMap = {
        EXACT: '위치 확인',
        UNRESOLVED: '위치 확인 필요',
        APPROXIMATE: '⚠ 위치 확인요망 (동일 도로 대표 위치)',
      };
      const statusLabelMap = { SUCCESS: '좌표 확인됨', NOT_FOUND: '주소 검색결과 없음', ERROR: '좌표 확인 실패', PENDING: '확인 대기' };
      const qualityLabel =
        (row._locationQuality === 'ESTIMATED' && methodQualityLabelMap[row._geocodeMethod]) ||
        (row._locationQuality && qualityLabelMap[row._locationQuality]) ||
        null;
      geoEl.textContent = qualityLabel || statusLabelMap[row._geocodeStatus] || row._geocodeStatus;
      rowEl.appendChild(geoEl);
    }

    if (row._validation === 'ERROR') {
      const errEl = document.createElement('span');
      errEl.className = 'upload-error-text';
      errEl.textContent = row._errors.join(', ');
      rowEl.appendChild(errEl);
    } else if (row._validation === 'WARNING') {
      const warnEl = document.createElement('span');
      warnEl.className = 'upload-warning-text';
      warnEl.textContent = row._warnings.join(', ');
      rowEl.appendChild(warnEl);
    }

    // STEP 11G: UNRESOLVED 행에 개별 "위치 후보 찾기" 버튼과 후보 결과를 붙인다.
    if (row._locationQuality === 'UNRESOLVED' && row.business_start_no) {
      const findBtn = document.createElement('button');
      findBtn.type = 'button';
      findBtn.className = 'btn-find-candidate';
      findBtn.textContent = '위치 후보 찾기';
      findBtn.disabled = state.keywordSearchInProgress;
      findBtn.addEventListener('click', () => handleKeywordSearchSingle(row, containerId));
      rowEl.appendChild(findBtn);

      if (row._keywordSearchStatus && row._keywordSearchStatus !== 'PENDING') {
        const candWrap = document.createElement('div');
        candWrap.className = 'keyword-candidate-wrap';

        const statusLabelMap = {
          STRONG_CANDIDATE: '강한 후보 있음',
          WEAK_CANDIDATE: '약한 후보 있음',
          NO_CANDIDATE: '후보 없음',
          ERROR: '검색 오류',
        };
        const statusLine = document.createElement('div');
        // STEP 11G-LIVE-DEBUG: ERROR인 경우 row._keywordSearchError(reason)를 함께 보여준다.
        const statusText = statusLabelMap[row._keywordSearchStatus] || row._keywordSearchStatus;
        statusLine.textContent =
          (row._keywordSearchStatus === 'ERROR' && row._keywordSearchError)
            ? `${statusText} (${row._keywordSearchError})`
            : statusText;
        candWrap.appendChild(statusLine);

        (row._keywordCandidates || []).forEach((c, i) => {
          const candLine = document.createElement('div');
          candLine.className = 'keyword-candidate-item';
          const addr = c.roadAddressName || c.addressName || '-';
          candLine.textContent = `후보 ${i + 1}: ${c.placeName || '-'} · ${addr} (${c.candidateStatus === 'MATCH' ? '일치' : '약함'})`;
          candWrap.appendChild(candLine);
        });

        rowEl.appendChild(candWrap);
      }

      // STEP 11H-3: JUSO 정규화 결과(있다면)도 함께 보여준다. 좌표는 없으므로 도로명/지번주소 텍스트만 표시.
      if (row._jusoStatus && row._jusoStatus !== 'PENDING') {
        const jusoWrap = document.createElement('div');
        jusoWrap.className = 'juso-candidate-wrap';

        const jusoStatusLabelMap = {
          MATCHED: 'JUSO 단일일치',
          AMBIGUOUS: 'JUSO 모호(복수일치)',
          NO_MATCH: 'JUSO 검증불일치',
          NOT_FOUND: 'JUSO 결과 없음',
          ERROR: 'JUSO 검색 오류',
        };
        const jusoStatusLine = document.createElement('div');
        const jusoStatusText = jusoStatusLabelMap[row._jusoStatus] || row._jusoStatus;
        jusoStatusLine.textContent =
          (row._jusoStatus === 'ERROR' && row._jusoError)
            ? `${jusoStatusText} (${row._jusoError})`
            : jusoStatusText;
        jusoWrap.appendChild(jusoStatusLine);

        (row._jusoCandidates || []).forEach((c, i) => {
          const jusoLine = document.createElement('div');
          jusoLine.className = 'juso-candidate-item';
          jusoLine.textContent = `JUSO 후보 ${i + 1}: ${c.roadAddr || '-'} (지번: ${c.jibunAddr || '-'})`;
          jusoWrap.appendChild(jusoLine);
        });

        rowEl.appendChild(jusoWrap);
      }
    }

    container.appendChild(rowEl);
  });

  if (state.uploadParsedRows.length > 50) {
    const moreMsg = document.createElement('p');
    moreMsg.textContent = `그 외 ${state.uploadParsedRows.length - 50}건은 표시되지 않았습니다.`;
    container.appendChild(moreMsg);
  }
}

// "주소 좌표 확인" 버튼 클릭 처리. 중복 클릭을 막고, 진행 중에는 버튼을 disabled 한다.
// geocoding 자체는 geocoding.js가 담당하며, 여기서는 진행상황 콜백으로 미리보기만 갱신한다.
async function handleGeocodeStart(containerId) {
  if (state.geocodeInProgress) return;
  state.geocodeInProgress = true;
  renderUploadPreview(containerId); // 버튼 disabled를 즉시 반영 (이 시점엔 아직 PENDING 표시 전)

  let isFirstProgressTick = true;

  try {
    await runGeocodingForParsedRows((progress) => {
      state.geocodeProgress = progress;
      if (isFirstProgressTick) {
        // runGeocodingForParsedRows가 대상 행을 PENDING으로 표시한 직후 호출되는 첫 콜백이므로,
        // 여기서 전체를 다시 그려 각 행의 PENDING 배지가 실제로 화면에 나타나게 한다.
        isFirstProgressTick = false;
        renderUploadPreview(containerId);
        return;
      }
      const progressEl = document.getElementById('geocode-progress-text');
      if (progressEl) {
        progressEl.textContent = `대상 ${progress.total}건 중 완료 ${progress.done}건 (성공 ${progress.success} · 결과없음 ${progress.notFound} · 오류 ${progress.error})`;
      }
    });
  } finally {
    state.geocodeInProgress = false;
    renderUploadPreview(containerId); // 완료 후 각 행의 _geocodeStatus를 반영해 재렌더
  }
}

// "결과없음 N건 보기" 토글. business_start_no/site_name/원본 address/검색에 사용한 address를 보여준다.
// 전체 재렌더 없이 이 영역만 채우거나 비운다(버튼 상태·진행 표시는 그대로 유지).
function toggleNotFoundList(containerId) {
  const listEl = document.getElementById('notfound-list');
  if (!listEl) return;

  const willOpen = listEl.style.display === 'none';
  if (!willOpen) {
    listEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = '';
  const notFoundRows = state.uploadParsedRows.filter(r => r._geocodeStatus === 'NOT_FOUND');

  notFoundRows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'notfound-item';

    const fields = [
      ['식별번호', row.business_start_no || '(없음)'],
      ['사업장명', row.site_name || row.company_name || '-'],
      ['원본 주소', row.address || '-'],
      ['검색에 사용한 주소', row._geocodeSearchedAddress || '-'],
    ];
    fields.forEach(([label, value]) => {
      const line = document.createElement('div');
      line.textContent = `${label}: ${value}`;
      item.appendChild(line);
    });

    listEl.appendChild(item);
  });

  listEl.style.display = 'block';
}

// 결과없음(NOT_FOUND) 행만 CSV로 다운로드한다. 값에 콤마/줄바꿈이 있을 수 있어 큰따옴표로 감싸고
// 내부 큰따옴표는 이스케이프한다(간단한 CSV escaping, 별도 라이브러리 사용하지 않음).
function csvEscape(value) {
  const s = String(value ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadNotFoundCsv() {
  const notFoundRows = state.uploadParsedRows.filter(r => r._geocodeStatus === 'NOT_FOUND');
  const header = [
    'business_start_no', 'site_name', 'original_address', 'searched_address',
    'lot_queries', 'successful_lot_query', 'geocode_method', 'location_quality', 'lat', 'lng'
  ];
  const lines = [header.join(',')];

  notFoundRows.forEach(row => {
    const line = [
      row.business_start_no || '',
      row.site_name || row.company_name || '',
      row.address || '',
      row._geocodeSearchedAddress || '',
      (row._lotQueries || []).join(' | '),
      row._lotSuccessfulQuery || '',
      row._geocodeMethod || '',
      row._locationQuality || '',
      row.lat ?? '',
      row.lng ?? '',
    ].map(csvEscape).join(',');
    lines.push(line);
  });

  const csvContent = '\uFEFF' + lines.join('\n'); // BOM 추가 (엑셀에서 한글 깨짐 방지)
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'geocode_notfound.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// STEP 11G: 개별 행 1건에 대해 keyword 후보검색을 실행한다. 좌표는 자동 반영하지 않는다(후보 표시만).
async function handleKeywordSearchSingle(row, containerId) {
  if (state.keywordSearchInProgress) return;
  state.keywordSearchInProgress = true;
  renderUploadPreview(containerId);

  try {
    await runKeywordCandidateSearch(() => {}, row);
  } finally {
    state.keywordSearchInProgress = false;
    renderUploadPreview(containerId);
  }
}

// STEP 11G: UNRESOLVED 전체에 대해 일괄 keyword 후보검색을 실행한다. 좌표는 자동 반영하지 않는다.
async function handleKeywordSearchAll(containerId) {
  if (state.keywordSearchInProgress) return;
  state.keywordSearchInProgress = true;
  renderUploadPreview(containerId);

  try {
    const summary = await runKeywordCandidateSearch((progress) => {
      state.keywordSearchSummary = progress;
      const summaryEl = document.getElementById('keyword-search-summary');
      if (summaryEl) {
        summaryEl.textContent = `후보검색 완료 ${progress.done}/${progress.total} · 강한후보 ${progress.strong} · 약한후보 ${progress.weak} · 후보없음 ${progress.none} · 오류 ${progress.error}`;
      }
    });
    state.keywordSearchSummary = summary;
  } finally {
    state.keywordSearchInProgress = false;
    renderUploadPreview(containerId);
  }
}

// STEP 11H-1: 원본에 명시적 지번이 있는 UNRESOLVED 행에 대해 Kakao LOT 재검색을 실행한다.
// 성공한 행은 기존 cascade(ORIGINAL/NORMALIZED/CORE)와 동일하게 SUCCESS/ESTIMATED로 갱신되므로,
// 완료 후 renderUploadPreview가 위치품질 요약(EXACT/ESTIMATED/확인필요)에도 자동 반영한다.
async function handleLotRecovery(containerId) {
  if (state.lotRecoveryInProgress) return;
  state.lotRecoveryInProgress = true;
  renderUploadPreview(containerId);

  try {
    const summary = await runKakaoLotRecovery((progress) => {
      state.lotRecoverySummary = progress;
      const summaryEl = document.getElementById('lot-recovery-summary');
      if (summaryEl) {
        summaryEl.textContent = `LOT 대상 ${progress.total}건 · KAKAO LOT 성공 ${progress.success}건 · 결과없음 ${progress.notFound}건 · 오류 ${progress.error}건`;
      }
    });
    state.lotRecoverySummary = summary;
  } finally {
    state.lotRecoveryInProgress = false;
    renderUploadPreview(containerId);
  }
}

// STEP 11H-3: 원본에 도로명+건물번호가 있는 UNRESOLVED 행에 대해 JUSO(행안부) 정규화를 실행한다.
// JUSO는 좌표를 반환하지 않으므로 _locationQuality/lat/lng는 변경되지 않는다 — 후보(row._jusoCandidates)만 채워진다.
async function handleJusoNormalize(containerId) {
  if (state.jusoNormalizeInProgress) return;
  state.jusoNormalizeInProgress = true;
  renderUploadPreview(containerId);

  try {
    const summary = await runJusoNormalize((progress) => {
      state.jusoNormalizeSummary = progress;
      const summaryEl = document.getElementById('juso-normalize-summary');
      if (summaryEl) {
        summaryEl.textContent = `대상 ${progress.total} · 단일일치 ${progress.matched} · 모호 ${progress.ambiguous} · 검증불일치 ${progress.noMatch} · 결과없음 ${progress.notFound} · 오류 ${progress.error} (좌표는 아직 미확정)`;
      }
    });
    state.jusoNormalizeSummary = summary;
  } finally {
    state.jusoNormalizeInProgress = false;
    renderUploadPreview(containerId);
  }
}

// STEP 11H-4: JUSO 정규화 성공 행의 1위 후보 도로명주소로 Kakao 좌표를 확정한다.
// 성공한 행은 ESTIMATED로 갱신되어 위치품질 요약(EXACT/ESTIMATED/확인필요)에도 자동 반영된다.
async function handleKakaoJusoRecovery(containerId) {
  if (state.kakaoJusoInProgress) return;
  state.kakaoJusoInProgress = true;
  renderUploadPreview(containerId);

  try {
    const summary = await runKakaoJusoRecovery((progress) => {
      state.kakaoJusoSummary = progress;
      const summaryEl = document.getElementById('kakao-juso-summary');
      if (summaryEl) {
        summaryEl.textContent = `대상 ${progress.total}건 · 좌표복구 ${progress.success}건 · 결과없음 ${progress.notFound}건 · 오류 ${progress.error}건`;
      }
    });
    state.kakaoJusoSummary = summary;
  } finally {
    state.kakaoJusoInProgress = false;
    renderUploadPreview(containerId);
  }
}

// STEP11 운영: 동일 도로 대표 위치(APPROXIMATE) 확보. 성공한 행은 위치품질 요약(EXACT/ESTIMATED/
// APPROXIMATE/확인필요)에도 자동 반영된다. 결과는 항상 APPROXIMATE이며 EXACT/ESTIMATED로 승격되지 않는다.
async function handleRoadApproximateRecovery(containerId) {
  if (state.roadApproximateInProgress) return;
  state.roadApproximateInProgress = true;
  renderUploadPreview(containerId);

  try {
    const summary = await runRoadApproximateRecovery((progress) => {
      state.roadApproximateSummary = progress;
      const summaryEl = document.getElementById('road-approximate-summary');
      if (summaryEl) {
        summaryEl.textContent = `대상 ${progress.total}건 · 대표위치 확보 ${progress.success}건(⚠ 확인요망) · 결과없음 ${progress.notFound}건 · 오류 ${progress.error}건`;
      }
    });
    state.roadApproximateSummary = summary;
  } finally {
    state.roadApproximateInProgress = false;
    renderUploadPreview(containerId);
  }
}

// STEP12-C/13: geocoding 결과를 실제 DB에 반영한다.
// 흐름: 1) 사전 검증(previewImportImpact)으로 신규/갱신 예정 건수를 먼저 계산해 화면에 보여준다.
//       2) 브라우저 confirm으로 최종 확인을 받는다(취소 시 아무 것도 실행되지 않음).
//       3) 실제 RPC(importSitesToDatabase) 호출 — 여기서만 DB write가 발생한다.
// 성공 시에만 지도/목록을 새로고침하며, initApp()(전체 재인증/재초기화)은 호출하지 않는다.
// 실패해도 state.uploadParsedRows(파싱/검증/geocoding 결과)는 그대로 유지되어 업로드 패널이 안 사라진다.
async function handleImportToDatabase(containerId) {
  if (state.uploadImportInProgress || state.importPreviewInProgress) return;

  // 1) 사전 검증: 신규/갱신 예정 건수 계산 (DB write 없음, 순수 조회)
  state.importPreviewInProgress = true;
  renderUploadPreview(containerId);

  let preview;
  try {
    preview = await previewImportImpact(state.uploadFileName, state.uploadDetectedForm);
    state.importPreview = preview;
  } finally {
    state.importPreviewInProgress = false;
    renderUploadPreview(containerId);
  }

  if (!preview.success) {
    return; // 사전 검증 실패 메시지는 이미 화면에 표시됨. 저장을 진행하지 않는다.
  }

  // 2) 최종 확인 (취소 시 저장하지 않음)
  const confirmed = window.confirm(
    `전체 ${preview.total}건 중 신규 ${preview.insertCount}건, 갱신 ${preview.updateCount}건을 저장하시겠습니까?`
  );
  if (!confirmed) return;

  // 3) 실제 DB 반영
  state.uploadImportInProgress = true;
  renderUploadPreview(containerId);

  try {
    const result = await importSitesToDatabase(state.uploadFileName, state.uploadDetectedForm);
    state.uploadImportResult = result;

    if (result.success) {
      // DB 반영 성공 시에만 지도/목록을 다시 불러온다. 로그인/지도 재초기화는 하지 않는다.
      const sites = await loadActiveSites();
      state.sites = sites;
      renderSiteList('site-list');

      // STEP13-6: 저장 성공 직후 업로드 이력을 다시 불러와 최신 상태로 갱신한다.
      // upload-history 컨테이너가 화면에 있을 때만(업로드 패널이 열려 있을 때) 갱신한다.
      if (document.getElementById('upload-history')) {
        await renderUploadHistoryPanel('upload-history');
      }
    }
  } finally {
    state.uploadImportInProgress = false;
    renderUploadPreview(containerId);
  }
}

// keyword 후보검색 결과를 CSV로 다운로드한다 (UNRESOLVED 전체 대상, 후보가 없으면 후보 컬럼은 빈 값).
function downloadKeywordCandidatesCsv() {
  const targets = state.uploadParsedRows.filter(r => r._locationQuality === 'UNRESOLVED');
  const header = [
    'business_start_no', 'site_name', 'original_address', 'keyword_query',
    'candidate_status', 'candidate_place_name', 'candidate_address', 'candidate_lat', 'candidate_lng'
  ];
  const lines = [header.join(',')];

  targets.forEach(row => {
    const candidates = row._keywordCandidates && row._keywordCandidates.length > 0 ? row._keywordCandidates : [null];
    candidates.forEach(c => {
      const line = [
        row.business_start_no || '',
        row.site_name || row.company_name || '',
        row.address || '',
        row._keywordQuery || '',
        row._keywordSearchStatus || '',
        c ? (c.placeName || '') : '',
        c ? (c.roadAddressName || c.addressName || '') : '',
        c ? c.lat : '',
        c ? c.lng : '',
      ].map(csvEscape).join(',');
      lines.push(line);
    });
  });

  const csvContent = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'keyword_candidates.csv';
  a.click();
  URL.revokeObjectURL(url);
}
