// ui.js — STEP 6A. 사업장 목록/상세/검색/정렬 렌더링 및 선택 상태 연동.
// XSS 방지: DB 값(site_name/company_name/address 등)은 innerHTML 문자열 조립에 쓰지 않고
// 전부 textContent 또는 createElement 기반 DOM 생성으로만 넣는다.
import { state } from './state.js';
import { panToSite, renderMarkers, centerSiteInVisibleArea, highlightSelectedMarker, clearMarkerHighlight, refreshFavoriteMarker, initRouteMap, relayoutRouteMap, renderRouteMarkers, panToRouteSite, searchPlacesKeyword, showAddressSearchPin, clearAddressSearchPin, assignDongToSites } from './map.js';
import { getFilteredSortedSites, getDongOptions, loadActiveSites } from './sites.js';
import { isFavorite, toggleFavorite, loadFavorites } from './favorites.js';
import { getNote, saveNote, deleteNote, loadNotes } from './notes.js';
import { loadUsers, setUserStatus, setUserRole, resetUserPassword, deleteRejectedProfile } from './admin.js';
import { parseExcelFile } from './excel.js';
import { runGeocodingForParsedRows, runKeywordCandidateSearch, runKakaoLotRecovery, buildLotQueries, runJusoNormalize, buildJusoQuery, runKakaoJusoRecovery, runRoadApproximateRecovery, extractApproximateStructure, reverseGeocode, geocodeKeyword } from './geocoding.js';
import { importSitesToDatabase, previewImportImpact, loadUploadHistory, loadLastUploadAt } from './import.js';
import { loadSupervisions, createSupervision, updateSupervision, deleteSupervision } from './supervision.js';
import { isAdmin, isMaster, changePassword } from './auth.js';
import { requestCurrentLocation } from './location.js';
import { CONFIG } from './config.js';

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
  if (!success) { showToast('즐겨찾기 처리에 실패했습니다. 다시 시도해주세요.'); return; } // 실패 시 기존 state/표시 그대로 유지

  const nowFavorite = isFavorite(siteId);
  // STEP16.19: 지도 위 해당 사업장 마커도 즉시 별표 배지 상태로 갱신한다(전체 재렌더 없이).
  refreshFavoriteMarker(siteId);
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
        showToast('메모가 저장되었습니다.', 'success');
      } else {
        // U1(STEP16.35): 이전에는 실패해도 아무 표시가 없어 사용자가 저장 여부를 알 수 없었다.
        showToast('메모 저장에 실패했습니다. 다시 시도해주세요.');
      }
    } finally {
      state.noteInFlight.delete(siteId);
      saveBtn.disabled = false;
      deleteBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    // 사용자 요청: 삭제는 복구할 수 없으므로 확인 절차를 거친다(confirmNoteDelete는 방금
    // 작성/수정한 메모면 문구를 한 번 더 강하게 바꾼다 — 아래 정의, 새 삭제 로직 없음).
    if (!confirmNoteDelete(existing)) return;
    if (state.noteInFlight.has(siteId)) return;
    state.noteInFlight.add(siteId);
    saveBtn.disabled = true;
    deleteBtn.disabled = true;

    try {
      const success = await deleteNote(siteId);
      if (success) {
        textarea.value = '';
      } else {
        // U1(STEP16.35): 이전에는 실패해도 아무 표시가 없었다.
        showToast('메모 삭제에 실패했습니다. 다시 시도해주세요.');
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

// 사용자 요청: 지도/현장/경로 탭의 현장상세정보에서 "메모" 버튼을 누르면, 더 이상 이 팝업
// 안에서 바로 수정/삭제하지 않는다 — 메모 내용을 화면 정중앙에 크게 "보여주기만" 하고
// X로 닫으며, 작은 "메모 작성/수정" 버튼을 누르면 더보기 > 현장 메모 관리(전체화면, 해당
// 현장 자동 선택+잠금)로 넘어가 실제 작성/수정/삭제를 하도록 한다(openSiteNotesWritePanel
// 재사용 — 새 작성/수정 로직 없음). 데이터 조회는 기존 getNote()만 그대로 쓴다.
function openNoteModal(siteId) {
  closeNoteModal(); // 혹시 이미 열려있던 모달이 있으면 먼저 정리(중복 방지)

  const overlay = document.createElement('div');
  overlay.id = 'site-note-modal-overlay';
  overlay.className = 'site-note-modal-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeNoteModal();
  });

  const content = document.createElement('div');
  content.className = 'site-note-modal-content';

  const header = document.createElement('div');
  header.className = 'site-note-modal-header';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'site-note-modal-close';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeNoteModal);
  header.appendChild(closeBtn);
  content.appendChild(header);

  const title = document.createElement('h3');
  title.className = 'site-detail-section-title site-note-modal-title';
  title.textContent = '개인 메모';
  content.appendChild(title);

  const existing = getNote(siteId);
  const body = document.createElement('div');
  body.className = 'site-note-modal-body';
  if (existing && existing.content) {
    body.textContent = existing.content;
  } else {
    body.classList.add('is-empty');
    body.textContent = '작성된 메모가 없습니다.';
  }
  content.appendChild(body);

  const writeBtn = document.createElement('button');
  writeBtn.type = 'button';
  writeBtn.className = 'site-note-modal-write-btn';
  writeBtn.textContent = existing ? '메모 수정' : '메모 작성';
  writeBtn.addEventListener('click', () => {
    closeNoteModal();
    // "더보기"로 넘어가서 현장 메모 작성/수정 화면을 연다 — 해당 현장은 siteId로 자동 적용,
    // locked:true로 현장 선택은 잠근다(카드 클릭 진입과 동일한 화면/로직 재사용).
    const moreTabBtn = document.querySelector('.mobile-tab-btn[data-tab="more"]');
    if (moreTabBtn) moreTabBtn.click();
    openSiteNotesWritePanel(siteId, { locked: true });
  });
  content.appendChild(writeBtn);

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  document.addEventListener('keydown', handleNoteModalKeydown);
}

function handleNoteModalKeydown(e) {
  if (e.key === 'Escape') closeNoteModal();
}

function closeNoteModal() {
  const overlay = document.getElementById('site-note-modal-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', handleNoteModalKeydown);
  // STEP16.23: "더보기 > 현장 메모" 목록이 열려 있는 상태였다면, 모달을 닫을 때 목록(전체
  // 건수/미리보기/날짜/"수정됨" 배지)도 최신 상태로 다시 그린다.
  const notesPanel = document.getElementById('site-notes-panel');
  if (notesPanel && notesPanel.style.display !== 'none') {
    renderSiteNotesPanel('site-notes-panel');
  }
}

// ============================================================
// STEP16.23: 더보기 > "현장 메모" — 기존 현장별 개인 메모(gnmap_v2_site_notes)를 한곳에서
// 조회/검색/필터하고, 새 메모 작성 진입점을 제공하는 모바일 전용 화면.
// - 데이터/CRUD는 전부 notes.js(getNote/saveNote/deleteNote)와 state.siteNotes를 그대로
//   재사용한다. 이 화면에서 만드는 것은 "조회 UI"뿐이며, 새 테이블/새 CRUD 로직은 없다.
// - 카드를 누르면 기존 개인 메모 팝업(openNoteModal, 현장 상세와 완전히 동일한 UI/로직)을
//   그대로 연다 — 새로운 상세/수정 화면을 중복으로 만들지 않는다.
// - "+"로 여는 작성 화면은 gnmap_v2_site_notes가 UNIQUE(user_id, site_id)라서 이미 메모가
//   있는 현장을 고르면 그 메모 내용을 그대로 불러와 보여주고, 저장 시 saveNote()의 기존
//   insert-or-update 로직에 맡긴다 — 여기서 별도로 중복 INSERT 여부를 분기하지 않는다.
// ============================================================

// state.siteNotes(Map) + state.sites를 조인해 표시용 배열로 만든다. 참조하는 site가
// 목록에 없으면(이론상 FK RESTRICT라 발생하지 않지만) 조용히 제외한다.
function getSiteNotesJoined() {
  const rows = [];
  state.siteNotes.forEach((note, siteId) => {
    const site = state.sites.find(s => s.id === siteId);
    if (!site) return;
    rows.push({ ...note, site });
  });
  return rows;
}

function openSiteNotesPanel() {
  const panel = document.getElementById('site-notes-panel');
  if (!panel) return;
  panel.style.display = 'block';
  renderSiteNotesPanel('site-notes-panel');
}

export function renderSiteNotesPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  // STEP16.32: 앱설정/비밀번호변경 등과 동일한 "‹ 현장 메모" 상단 표시로 통일한다.
  // 건수 배지(STEP16.27)는 제목 옆에, 작성(+) 버튼은 오른쪽 끝에 그대로 유지한다.
  const { header, backBtn } = buildSettingsSubHeader('현장 메모');
  backBtn.addEventListener('click', () => {
    const panel = document.getElementById(containerId);
    if (panel) panel.style.display = 'none';
  });
  const allNotes = getSiteNotesJoined();
  const titleCountEl = document.createElement('span');
  titleCountEl.className = 'sv-mobile-title-count';
  titleCountEl.textContent = `전체 ${allNotes.length}건`;
  header.appendChild(titleCountEl);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'sv-mobile-add-btn';
  addBtn.style.marginLeft = 'auto';
  addBtn.setAttribute('aria-label', '현장 메모 작성');
  addBtn.appendChild(svIcon(SV_ICON_PLUS));
  addBtn.addEventListener('click', () => openSiteNotesWritePanel(null));
  header.appendChild(addBtn);
  container.appendChild(header);

  const subtitleEl = document.createElement('p');
  subtitleEl.className = 'sv-mobile-subtitle';
  subtitleEl.style.padding = '0 16px 12px';
  subtitleEl.textContent = '현장에서 작성한 메모를 한곳에서 관리합니다.';
  container.appendChild(subtitleEl);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'site-notes-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'site-notes-search-icon';
  searchIcon.appendChild(svIcon(SV_ICON_SEARCH));
  searchWrap.appendChild(searchIcon);
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'site-notes-search-input';
  searchInput.placeholder = '현장명 또는 메모 내용을 검색하세요.';
  searchInput.value = state.siteNotesSearchQuery;
  // 사용자 요청: 검색어 초기화(x) 버튼 — 입력값이 있을 때만 보이고, 누르면 검색어만 지운다
  // (필터 칩 선택은 그대로 유지).
  const searchClearBtn = document.createElement('button');
  searchClearBtn.type = 'button';
  searchClearBtn.className = 'site-notes-search-clear';
  searchClearBtn.setAttribute('aria-label', '검색어 지우기');
  searchClearBtn.textContent = '×';
  searchClearBtn.style.display = state.siteNotesSearchQuery ? 'flex' : 'none';
  searchInput.addEventListener('input', () => {
    state.siteNotesSearchQuery = searchInput.value;
    searchClearBtn.style.display = searchInput.value ? 'flex' : 'none';
    renderSiteNotesList();
  });
  searchClearBtn.addEventListener('click', () => {
    state.siteNotesSearchQuery = '';
    searchInput.value = '';
    searchClearBtn.style.display = 'none';
    renderSiteNotesList();
    searchInput.focus();
  });
  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(searchClearBtn);
  container.appendChild(searchWrap);

  const filterRow = document.createElement('div');
  filterRow.className = 'site-notes-filter-row';
  const filters = [
    { value: 'all', label: '전체' },
    { value: 'recent-created', label: '최근 작성' },
    { value: 'recent-updated', label: '최근 수정' },
  ];
  filters.forEach(f => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'site-notes-filter-chip' + (state.siteNotesFilter === f.value ? ' active' : '');
    chip.textContent = f.label;
    chip.addEventListener('click', () => {
      state.siteNotesFilter = f.value;
      renderSiteNotesPanel(containerId); // 칩 활성 표시도 함께 갱신해야 하므로 목록만이 아니라 전체를 다시 그린다.
    });
    filterRow.appendChild(chip);
  });
  container.appendChild(filterRow);

  const listWrap = document.createElement('div');
  listWrap.id = 'site-notes-list';
  listWrap.className = 'site-notes-list';
  container.appendChild(listWrap);

  // 검색/정렬만 바뀔 때는 목록 부분만 다시 그린다(검색 input 포커스 유지).
  function renderSiteNotesList() {
    const listEl = document.getElementById('site-notes-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const query = (state.siteNotesSearchQuery || '').trim();
    let rows = allNotes.filter(n => {
      if (!query) return true;
      const name = n.site.site_name || n.site.company_name || '';
      return name.includes(query) || (n.content || '').includes(query);
    });

    if (state.siteNotesFilter === 'recent-created') {
      rows = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else {
      // '전체'/'최근 수정' 모두 최신 수정순 — "전체"의 기본 정렬 기준으로도 자연스럽다.
      rows = rows.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sv-mobile-empty';
      const emptyIcon = svIcon(SV_ICON_DOC);
      emptyIcon.style.width = '32px';
      emptyIcon.style.height = '32px';
      empty.appendChild(emptyIcon);
      if (allNotes.length === 0) {
        // 메모 자체가 하나도 없는 경우 — "검색 결과 없음"과 구분되는 안내 + 바로 작성 CTA.
        const line1 = document.createElement('p');
        line1.textContent = '작성된 현장 메모가 없습니다.';
        empty.appendChild(line1);
        const line2 = document.createElement('p');
        line2.textContent = '현장에서 확인한 내용을 메모로 남겨보세요.';
        empty.appendChild(line2);
        const cta = document.createElement('button');
        cta.type = 'button';
        cta.className = 'sv-mobile-empty-cta';
        cta.appendChild(svIcon(SV_ICON_PLUS));
        const ctaText = document.createElement('span');
        ctaText.textContent = '현장 메모 작성';
        cta.appendChild(ctaText);
        cta.addEventListener('click', () => openSiteNotesWritePanel(null));
        empty.appendChild(cta);
      } else {
        // 메모는 있지만 검색어와 일치하는 것이 없는 경우 — 검색어를 원인으로 명확히 안내하고
        // 바로 지울 수 있게 한다(왜 안 보이는지 헷갈리지 않도록).
        const line1 = document.createElement('p');
        line1.textContent = '검색 결과가 없습니다.';
        empty.appendChild(line1);
        if (query) {
          const line2 = document.createElement('p');
          line2.textContent = `"${query}"와(과) 일치하는 메모를 찾지 못했습니다.`;
          empty.appendChild(line2);
          const clearCta = document.createElement('button');
          clearCta.type = 'button';
          clearCta.className = 'sv-mobile-empty-cta';
          const clearCtaText = document.createElement('span');
          clearCtaText.textContent = '검색어 지우기';
          clearCta.appendChild(clearCtaText);
          clearCta.addEventListener('click', () => {
            state.siteNotesSearchQuery = '';
            searchInput.value = '';
            searchClearBtn.style.display = 'none';
            renderSiteNotesList();
          });
          empty.appendChild(clearCta);
        }
      }
      listEl.appendChild(empty);
      return;
    }

    rows.forEach(n => listEl.appendChild(buildSiteNoteCard(n)));
  }

  renderSiteNotesList();
}

// 메모 미리보기 2줄 말줄임 + 날짜 + "수정됨"(updated_at이 created_at보다 1초 이상 뒤일 때만) 배지.
// 사용자 요청(더보기 개편): 카드를 누르면 팝업(openNoteModal)이 아니라 감독일정관리와 동일하게
// 전체화면 화면 전환(현장 메모 작성/수정 화면, locked=현장 변경 불가 + 삭제 버튼 노출)으로 연다.
function buildSiteNoteCard(n) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'sv-mobile-card site-notes-card';
  card.addEventListener('click', () => openSiteNotesWritePanel(n.site.id, { locked: true }));

  const top = document.createElement('div');
  top.className = 'sv-mobile-card-top';
  const icon = document.createElement('span');
  icon.className = 'site-notes-card-icon';
  icon.appendChild(svIcon(SV_ICON_DOC));
  top.appendChild(icon);
  // 사용자 요청: 즐겨찾기로 표시된 현장이면 별 배지를 함께 보여줘 우선순위 파악을 돕는다
  // (기존 favorites.js의 isFavorite()만 조회 — 새 상태/새 CRUD 없음).
  if (isFavorite(n.site.id)) {
    const favBadge = document.createElement('span');
    favBadge.className = 'site-notes-card-favorite-badge';
    favBadge.textContent = '★';
    favBadge.setAttribute('aria-label', '즐겨찾기 현장');
    top.appendChild(favBadge);
  }
  card.appendChild(top);

  const title = document.createElement('div');
  title.className = 'sv-mobile-card-title';
  title.textContent = n.site.site_name || n.site.company_name || '-';
  card.appendChild(title);

  const preview = document.createElement('div');
  preview.className = 'site-notes-card-preview';
  preview.textContent = n.content || '';
  card.appendChild(preview);

  const metaRow = document.createElement('div');
  metaRow.className = 'sv-mobile-card-meta-row';
  const dateEl = document.createElement('span');
  dateEl.textContent = formatUploadDateTime(n.updated_at);
  metaRow.appendChild(dateEl);

  const created = n.created_at ? new Date(n.created_at).getTime() : NaN;
  const updated = n.updated_at ? new Date(n.updated_at).getTime() : NaN;
  if (!Number.isNaN(created) && !Number.isNaN(updated) && updated - created > 1000) {
    const badge = document.createElement('span');
    badge.className = 'site-notes-modified-badge';
    badge.textContent = '수정됨';
    metaRow.appendChild(badge);
  }
  card.appendChild(metaRow);

  const chevron = document.createElement('span');
  chevron.className = 'sv-mobile-card-chevron';
  chevron.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  card.appendChild(chevron);

  return card;
}

// ============================================================
// "현장 메모 작성" — 새 메모 작성(현장 미선택 상태로 진입) 전용 화면. 이미 메모가 있는 현장을
// 고르면(UNIQUE(user_id, site_id)) 그 메모를 그대로 불러와 보여주고, 저장은 saveNote()의
// 기존 insert-or-update 로직에 맡긴다(이 화면이 insert/update를 직접 분기하지 않는다).
// ============================================================
function openSiteNotesWritePanel(siteId, opts = {}) {
  state.siteNotesWriteSiteId = siteId;
  state.siteNotesWriteLocked = !!opts.locked;
  const listPanel = document.getElementById('site-notes-panel');
  if (listPanel) listPanel.style.display = 'none';
  const writePanel = document.getElementById('site-notes-write-panel');
  if (!writePanel) return;
  writePanel.style.display = 'block';
  renderSiteNotesWritePanel('site-notes-write-panel');
}

function closeSiteNotesWritePanel() {
  const writePanel = document.getElementById('site-notes-write-panel');
  if (writePanel) writePanel.style.display = 'none';
  state.siteNotesWriteSiteId = null;
  state.siteNotesWriteLocked = false;
  openSiteNotesPanel(); // 목록으로 복귀 + 최신 데이터로 다시 렌더(방금 저장/삭제한 메모 즉시 반영).
}

function renderSiteNotesWritePanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const locked = !!state.siteNotesWriteLocked;
  const { header, backBtn } = buildSettingsSubHeader(locked ? '현장 메모 수정' : '현장 메모 작성');
  backBtn.addEventListener('click', () => closeSiteNotesWritePanel());
  container.appendChild(header);

  const form = document.createElement('div');
  form.className = 'sv-mobile-field';

  // 현장 선택
  const siteField = document.createElement('div');
  siteField.appendChild(svLabel('현장 선택', true));
  const selectedSite = state.siteNotesWriteSiteId
    ? state.sites.find(s => s.id === state.siteNotesWriteSiteId)
    : null;
  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'site-notes-select-field';
  const selectIcon = document.createElement('span');
  selectIcon.className = 'site-notes-select-field-icon';
  selectIcon.appendChild(svIcon(SV_ICON_BUILDING));
  selectBtn.appendChild(selectIcon);
  const selectText = document.createElement('span');
  selectText.className = 'site-notes-select-field-text' + (selectedSite ? '' : ' is-placeholder');
  selectText.textContent = selectedSite
    ? (selectedSite.site_name || selectedSite.company_name || '-')
    : '현장을 선택해주세요.';
  selectBtn.appendChild(selectText);
  const selectChevron = document.createElement('span');
  selectChevron.className = 'site-notes-select-field-chevron';
  selectChevron.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  selectBtn.appendChild(selectChevron);
  if (locked) {
    // 카드를 눌러 기존 메모를 수정하러 들어온 경우, UNIQUE(user_id, site_id) 제약상 현장을
    // 바꾸면 다른 메모와 충돌할 수 있으므로 현장 선택 필드를 잠근다(선택 시트 자체를 열지 않음).
    selectBtn.disabled = true;
    selectBtn.classList.add('is-locked');
    selectChevron.style.display = 'none';
  } else {
    selectBtn.addEventListener('click', () => {
      openSiteNoteSitePickerSheet((site) => {
        state.siteNotesWriteSiteId = site.id;
        renderSiteNotesWritePanel(containerId);
      });
    });
  }
  siteField.appendChild(selectBtn);

  const existingNote = selectedSite ? getNote(selectedSite.id) : null;
  if (existingNote && !locked) {
    const hint = document.createElement('p');
    hint.className = 'site-notes-existing-hint';
    hint.textContent = '이미 작성된 메모가 있어 불러왔습니다. 내용을 수정하고 저장할 수 있습니다.';
    siteField.appendChild(hint);
  }
  form.appendChild(siteField);

  // 메모 입력
  const noteField = document.createElement('div');
  noteField.appendChild(svLabel('메모', true));
  const textarea = document.createElement('textarea');
  textarea.id = 'site-notes-write-textarea';
  textarea.className = 'site-notes-textarea';
  textarea.maxLength = 1000;
  textarea.placeholder = '현장에서 확인한 내용이나 추가 확인이 필요한 사항을\n입력해주세요.';
  textarea.value = existingNote ? existingNote.content : '';
  noteField.appendChild(textarea);
  const counter = document.createElement('div');
  counter.className = 'site-notes-char-counter';
  counter.textContent = `${textarea.value.length} / 1000`;
  // 사용자 요청: 메모 칸을 자유양식 노트처럼 크게 쓰고 싶다 — 자체 내부 스크롤(고정 높이
  // textarea)이 아니라, 입력 내용에 맞춰 textarea 자체가 늘어나고 이 화면(#site-notes-write-panel,
  // 이미 overflow-y:auto) 전체가 스크롤되게 한다. 새 라이브러리 없이 input마다 scrollHeight로
  // 높이를 다시 맞추기만 한다.
  function autoGrowNoteTextarea() {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }
  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length} / 1000`;
    updateSaveBtnState();
    autoGrowNoteTextarea();
  });
  noteField.appendChild(counter);
  form.appendChild(noteField);
  // 프리필된 기존 메모 내용 기준으로도 처음부터 높이를 맞춘다(DOM에 붙은 뒤 실제
  // scrollHeight를 읽어야 하므로 이 화면을 표시(display:block)한 다음 실행되는
  // renderSiteNotesWritePanel 호출 흐름상 다음 프레임에 맞춘다).
  requestAnimationFrame(autoGrowNoteTextarea);

  container.appendChild(form);

  // 안내 카드 — 기존 앱 설정/알림 설정 화면과 동일한 안내 카드 컴포넌트를 재사용한다.
  const guideCard = document.createElement('div');
  // 사용자 확정 시안: 이 안내 카드는 옅은 파란색(Light Blue) 배경이어야 한다. 기존
  // .settings-notice-card-column 변형은 배경을 회색(--gnmap-bg-soft)으로 바꾸는 다른 화면
  // (알림 설정의 "알림 안내") 전용 스타일이라, 여기서는 그 변형 대신 파란 배경을 유지하는
  // 새 modifier(.site-notes-guide-card)를 하나 추가해 세로 배치(아이콘+제목 / 목록)만 가져온다.
  guideCard.className = 'settings-notice-card site-notes-guide-card';
  const guideHeader = document.createElement('div');
  guideHeader.className = 'settings-notice-card-header';
  guideHeader.appendChild(buildMobileMoreIcon('info'));
  const guideTitle = document.createElement('span');
  guideTitle.textContent = '현장 메모 안내';
  guideHeader.appendChild(guideTitle);
  guideCard.appendChild(guideHeader);
  const guideList = document.createElement('ul');
  guideList.className = 'site-notes-guide-list';
  [
    '메모는 선택한 현장에 저장됩니다.',
    '현장 상세 화면에서도 동일한 메모를 확인할 수 있습니다.',
    '저장된 메모는 현장 메모 메뉴에서 다시 수정할 수 있습니다.',
  ].forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    guideList.appendChild(li);
  });
  guideCard.appendChild(guideList);
  container.appendChild(guideCard);

  // 저장 버튼 — locked(카드를 눌러 들어온 수정 모드)일 때는 삭제 버튼과 한 행에 나란히
  // 배치하고(사용자 요청: 감독일정관리와 동일하게), 새 메모 작성일 때는 기존처럼 전체너비
  // 단독 버튼으로 둔다.
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = (locked && existingNote) ? 'sv-mobile-save-btn' : 'upload-mobile-primary-btn';
  saveBtn.textContent = '메모 저장';
  function updateSaveBtnState() {
    const hasSite = !!state.siteNotesWriteSiteId;
    const hasContent = textarea.value.trim().length > 0;
    saveBtn.disabled = !(hasSite && hasContent);
  }
  updateSaveBtnState();
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const siteId = state.siteNotesWriteSiteId;
    saveBtn.disabled = true;
    try {
      const success = await saveNote(siteId, textarea.value);
      if (success) {
        // U1(STEP16.35): 저장 확인을 막는 alert() 팝업 대신, 목록으로 돌아간 뒤에도 잠시
        // 보이는 토스트로 바꾼다(닫기 버튼을 눌러야 하는 번거로움이 없어짐).
        closeSiteNotesWritePanel();
        showToast('메모가 저장되었습니다.', 'success');
      } else {
        showToast('메모 저장에 실패했습니다. 다시 시도해주세요.');
        saveBtn.disabled = false;
      }
    } catch (err) {
      console.error('현장 메모 저장 실패:', err);
      showToast('메모 저장에 실패했습니다. 다시 시도해주세요.');
      saveBtn.disabled = false;
    }
  });

  // 삭제 버튼 — 감독일정관리 상세 화면과 동일하게(.sv-mobile-delete-btn), 카드를 눌러 기존
  // 메모를 수정하러 들어온 경우(locked)에만 노출한다. deleteNote()는 renderNoteSection에서
  // 쓰는 것과 동일한 기존 로직을 그대로 호출한다(새 삭제 로직 없음).
  if (locked && existingNote) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'sv-mobile-detail-actions site-notes-delete-actions';
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'sv-mobile-delete-btn';
    deleteBtn.textContent = '메모 삭제';
    deleteBtn.addEventListener('click', async () => {
      if (!confirmNoteDelete(existingNote)) return;
      const siteId = state.siteNotesWriteSiteId;
      if (state.noteInFlight.has(siteId)) return;
      state.noteInFlight.add(siteId);
      deleteBtn.disabled = true;
      try {
        const success = await deleteNote(siteId);
        if (success) {
          closeSiteNotesWritePanel();
          showToast('메모가 삭제되었습니다.', 'success');
        } else {
          // U1(STEP16.35): 이전에는 실패해도 아무 표시가 없었다.
          showToast('메모 삭제에 실패했습니다. 다시 시도해주세요.');
          deleteBtn.disabled = false;
        }
      } finally {
        state.noteInFlight.delete(siteId);
      }
    });
    actionsRow.appendChild(deleteBtn);
    actionsRow.appendChild(saveBtn);
    container.appendChild(actionsRow);
  } else {
    const saveBtnWrap = document.createElement('div');
    saveBtnWrap.className = 'site-notes-save-btn-wrap';
    saveBtnWrap.appendChild(saveBtn);
    container.appendChild(saveBtnWrap);
  }
}

// 메모 삭제 확인 — 감독일정 삭제 confirm과 동일한 패턴. "복구 불가" 안내를 항상 포함하고,
// 방금(1분 이내) 수정/작성된 메모라면 실수 클릭 방지를 위해 문구를 한 번 더 강하게 바꾼다.
function confirmNoteDelete(note) {
  const ts = note && (note.updated_at || note.created_at);
  const recentlyModified = ts && (Date.now() - new Date(ts).getTime() < 60000);
  if (recentlyModified) {
    return window.confirm('방금 작성/수정한 메모입니다. 삭제하면 복구할 수 없습니다.\n정말 삭제하시겠습니까?');
  }
  return window.confirm('이 메모를 삭제하시겠습니까?\n삭제한 메모는 복구할 수 없습니다.');
}

// "현장 선택" bottom sheet(현장 메모 작성 전용, 단일 선택) — 기존 openSupervisionManagerSheet
// (담당 감독관 선택)와 완전히 동일한 admin-sheet-overlay/admin-sheet/검색+목록 패턴을 재사용한다
// (새 sheet 컴포넌트 신설 없음). 경로탭의 다중선택용 openSitePickerSheet(완료 버튼/체크박스)와는
// 용도가 달라 별도 이름을 쓴다. state.sites(loadActiveSites로 이미 로드된 원본 목록)를 그대로
// 쓰고, 새 조회를 만들지 않는다.
function openSiteNoteSitePickerSheet(onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet';
  const titleEl = document.createElement('div');
  titleEl.className = 'admin-sheet-name';
  titleEl.textContent = '현장 선택';
  sheet.appendChild(titleEl);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'sv-manager-sheet-search';
  searchInput.placeholder = '현장명 검색';
  sheet.appendChild(searchInput);

  const listWrap = document.createElement('div');
  sheet.appendChild(listWrap);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  function renderOptions(query) {
    listWrap.innerHTML = '';
    const q = (query || '').trim();
    const sites = state.sites || [];
    const filtered = q
      ? sites.filter(s => (s.site_name || '').includes(q) || (s.company_name || '').includes(q))
      : sites;
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sv-manager-empty';
      empty.textContent = '검색 결과가 없습니다.';
      listWrap.appendChild(empty);
      return;
    }
    filtered.forEach(s => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'sv-manager-option';
      opt.textContent = s.site_name || s.company_name || '-';
      opt.addEventListener('click', () => {
        onSelect(s);
        overlay.remove();
      });
      listWrap.appendChild(opt);
    });
  }
  renderOptions('');
  searchInput.addEventListener('input', () => renderOptions(searchInput.value));
}

// 목록/마커 클릭이 공통으로 호출하는 선택 함수.
// 선택 상태 갱신 → 지도 이동 → 목록 active class 갱신 → scrollIntoView → 상세 패널 렌더까지 한 번에 처리한다.
export function selectSite(siteId) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;

  const previousSiteId = state.selectedSiteId;
  state.selectedSiteId = siteId;
  if (previousSiteId !== null && previousSiteId !== siteId) {
    clearMarkerHighlight(previousSiteId);
  }
  highlightSelectedMarker();
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
function buildFavoriteEmptyState(container, mode) {
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
  // 사용자 요청: "메모 있는 현장" 내부 탭은 별 아이콘 대신 문서 아이콘으로 구분한다.
  path.setAttribute('d', mode === 'notes'
    ? 'M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5Z'
    : 'm12 3 2.5 5.6 6.1.6-4.6 4.1 1.3 6L12 16.3 6.7 19.3l1.3-6-4.6-4.1 6.1-.6L12 3Z');
  svg.appendChild(path);

  const title = document.createElement('p');
  title.className = 'mobile-favorite-empty-title';
  title.textContent = mode === 'notes' ? '메모가 있는 현장이 없습니다' : '즐겨찾기한 현장이 없습니다';

  const desc = document.createElement('p');
  desc.className = 'mobile-favorite-empty-desc';
  desc.textContent = mode === 'notes'
    ? '현장에서 메모를 작성하면 여기에서 모아볼 수 있습니다.'
    : '자주 확인하는 현장을 즐겨찾기에 추가하면 여기에서 빠르게 확인할 수 있습니다.';

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'mobile-favorite-empty-btn';
  if (mode === 'notes') {
    goBtn.textContent = '현장 메모 작성';
    goBtn.addEventListener('click', () => {
      const moreTabBtn = document.querySelector('.mobile-tab-btn[data-tab="more"]');
      if (moreTabBtn) moreTabBtn.click();
      openSiteNotesPanel();
    });
  } else {
    goBtn.textContent = '현장 둘러보기';
    goBtn.addEventListener('click', () => {
      const siteTabBtn = document.querySelector('.mobile-tab-btn[data-tab="site"]');
      if (siteTabBtn) siteTabBtn.click();
    });
  }

  empty.appendChild(svg);
  empty.appendChild(title);
  empty.appendChild(desc);
  empty.appendChild(goBtn);
  container.appendChild(empty);
}

// U1(STEP16.35): 화면마다 제각각이던 저장/오류 안내(팝업 alert(), 조용한 실패로 아무 표시도
// 없는 경우)를 하나의 토스트로 통일한다. index.html에 마크업을 추가하지 않고 필요할 때
// document.body에 직접 붙였다가(최초 1회만 생성, 이후 재사용) 잠시 뒤 스스로 사라진다.
// 폼 유효성 검사 메시지(빈 값 등, 필드 바로 옆 errorEl)처럼 이미 잘 동작하는 화면별 인라인
// 안내는 그대로 두고, "성공/실패를 전혀 알려주지 않던 곳"과 "alert() 팝업을 쓰던 곳"만
// 이 토스트로 옮긴다.
let toastHideTimer = null;
export function showToast(message, type = 'error') {
  let toast = document.getElementById('gnmap-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'gnmap-toast';
    document.body.appendChild(toast);
  }
  clearTimeout(toastHideTimer);
  toast.textContent = message;
  toast.className = `gnmap-toast-${type}`; // 아래 setTimeout에서 gnmap-toast-visible을 더한다.
  // 브라우저가 클래스 제거→추가를 한 프레임에 합쳐버려 전환(transition)이 생략되지 않도록
  // 강제로 한 프레임 띄운다(연속으로 토스트가 뜰 때도 항상 다시 나타나는 것처럼 보이게 함).
  toast.classList.remove('gnmap-toast-visible');
  requestAnimationFrame(() => { requestAnimationFrame(() => toast.classList.add('gnmap-toast-visible')); });
  toastHideTimer = setTimeout(() => {
    toast.classList.remove('gnmap-toast-visible');
  }, 2600);
}

// F2(STEP16.35): "조회 실패"를 "0건"과 구분해서 보여주는 공용 컴포넌트. admin.js 회원목록에
// 이미 있던 문구+"다시 시도" 버튼 패턴을 사업장/감독일정 목록에도 동일하게 재사용한다.
// PC/모바일 공용 컨테이너(#site-list 등)에서도 그대로 동작하도록 특정 화면 전용 클래스는
// 쓰지 않고 최소한의 마크업만 만든다.
function buildLoadErrorState(container, message, onRetry) {
  const wrap = document.createElement('div');
  wrap.className = 'load-error-state';
  const msg = document.createElement('p');
  msg.className = 'load-error-state-msg';
  msg.textContent = message;
  wrap.appendChild(msg);
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'load-error-state-retry-btn';
  retryBtn.textContent = '다시 시도';
  retryBtn.addEventListener('click', onRetry);
  wrap.appendChild(retryBtn);
  container.appendChild(wrap);
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
    // F2(STEP16.35): 조회 자체가 실패했을 때(state.sitesLoadError)는 "등록된 사업장이 없다"는
    // 기존 문구 대신 오류 상태를 명확히 보여준다 — 그렇지 않으면 네트워크 오류로 목록이 비어도
    // 사용자에게는 실제로 사업장이 하나도 없는 것처럼 보인다.
    const favMode = state.favoriteTabView === 'notes' ? 'notes' : 'favorites';
    const isFavoriteTab = state.favoriteOnly && state.mobileActiveTab === 'favorite';
    const favModeLoadError = favMode === 'notes' ? state.notesLoadError : state.favoritesLoadError;

    if (state.sitesLoadError) {
      buildLoadErrorState(container, '사업장 정보를 불러오지 못했습니다.', async () => {
        state.sites = await loadActiveSites();
        await assignDongToSites(state.sites);
        renderDongOptions();
        renderSiteList(containerId);
      });
    } else if (isFavoriteTab && favModeLoadError) {
      buildLoadErrorState(container, favMode === 'notes' ? '메모 정보를 불러오지 못했습니다.' : '즐겨찾기 정보를 불러오지 못했습니다.', async () => {
        if (favMode === 'notes') { await loadNotes(); } else { await loadFavorites(); }
        renderSiteList(containerId);
      });
    } else if (isFavoriteTab) {
      // STEP15-E.4: 모바일 즐겨찾기 탭(state.favoriteOnly가 그 탭 진입 시에만 true가 되도록
      // app.js의 activateMobileTab이 관리)에서 0건일 때만 전용 empty state를 보여준다.
      // PC의 "즐겨찾기만 보기" 필터나 현장 탭의 일반 검색 결과 0건은 기존 문구를 그대로 유지한다.
      buildFavoriteEmptyState(container, favMode);
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

      // 사용자 요청: 목록 카드에서도 공사금액/공사기간/점검/산재표를 바로 볼 수 있게 한다
      // (상세 패널의 2x2 표와 같은 포매터를 재사용 — formatAmountKRW/formatPeriodKR/formatCount).
      // DB 원본 값은 그대로 두고 표시 문자열만 만든다(검색/정렬/저장 로직에는 관여하지 않음).
      const summary = document.createElement('div');
      summary.className = 'site-list-summary';
      const summaryRows = [
        ['공사금액', isMobileViewport() ? formatAmountKRW(site.amount) : displayValue(site.amount)],
        ['공사기간', formatPeriodKR(site.period_start, site.period_end)],
        ['점검', formatCount(site.supervision_count, '회')],
        ['산재표', formatCount(site.accident_report_count, '건')]
      ];
      summaryRows.forEach(([label, value]) => {
        const cell = document.createElement('div');
        cell.className = 'site-list-summary-item';
        // 사용자 피드백: 공사기간은 "YYYY.MM.DD ~ YYYY.MM.DD" 길이가 길어 2열 폭에서 종료일이
        // 잘려 안 보였다. 이 항목만 2열 전체 폭을 쓰도록 별도 클래스를 붙인다(css/mobile.css).
        if (label === '공사기간') cell.classList.add('site-list-summary-item--wide');
        const labelEl = document.createElement('span');
        labelEl.className = 'site-list-summary-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'site-list-summary-value';
        valueEl.textContent = value;
        cell.appendChild(labelEl);
        cell.appendChild(valueEl);
        summary.appendChild(cell);
      });
      item.appendChild(summary);

      item.addEventListener('click', () => selectSite(site.id));

      container.appendChild(item);
    });

    updateListActiveState();
  }

  // 검색/정렬 결과에 맞춰 marker도 다시 그린다.
  renderMarkers(visibleSites, selectSite);

  // 선택된 사업장이 현재 결과에서 사라졌으면 상세를 닫는다. 단, 사용자 피드백(4): 지도 탭에서
  // 연 상세는 다른 탭(예: 즐겨찾기 탭 진입 시 favoriteOnly 임시 적용)에서 목록이 일시적으로
  // 필터링되어 사라진 것뿐이라면 닫지 않는다 — 지도 탭으로 돌아오면 다시 보여야 하기 때문.
  if (state.selectedSiteId !== null && !visibleSites.some(s => s.id === state.selectedSiteId)) {
    const detailPanel = document.getElementById('site-detail-panel');
    const preservedMapDetail = detailPanel && detailPanel.dataset.detailOrigin === 'map' && state.mobileActiveTab !== 'map';
    if (!preservedMapDetail) closeDetail();
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
  // 사용자 피드백(4): 지도 탭에서 연 상세는 다른 탭을 다녀와도 닫지 않고 유지한다.
  // js/app.js의 activateMobileTab()이 이 값을 보고 지도 탭 기원 상세만 close를 건너뛴다.
  panel.dataset.detailOrigin = state.mobileActiveTab;
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
  // 제거). 모바일에서만 노출한다(PC는 이 media query 밖이라 기존 즐겨찾기+길찾기 2버튼 그대로
  // — PC 화면 미변경).
  // STEP16.13: "경로추가"는 이제 하단 "경로" 탭으로 이동시키는 대신(기존 동작), 승인된
  // "+ 경로에 추가" 카트 기능(§30)의 실제 트리거다 — state.routePlanSiteIds에 이 사업장을
  // 추가/이미 있으면 해제(dedupe)하고, 버튼 라벨/상태만 즉시 바꾼다(탭 이동 없음, 상세 패널은
  // 계속 열려 있는 채로 여러 현장을 연속으로 추가할 수 있어야 하므로).
  if (isMobileViewport()) {
    const routeAddBtn = document.createElement('button');
    routeAddBtn.type = 'button';
    routeAddBtn.className = 'site-detail-action-btn site-detail-btn-secondary';
    function refreshRouteAddBtn() {
      const added = state.routePlanSiteIds.includes(site.id);
      routeAddBtn.textContent = added ? '✓ 경로에 추가됨' : '경로추가';
      routeAddBtn.classList.toggle('is-added', added);
    }
    refreshRouteAddBtn();
    routeAddBtn.addEventListener('click', () => {
      if (state.routePlanSiteIds.includes(site.id)) {
        state.routePlanSiteIds = state.routePlanSiteIds.filter(id => id !== site.id);
      } else {
        state.routePlanSiteIds = [...state.routePlanSiteIds, site.id];
      }
      refreshRouteAddBtn();
    });
    actions.appendChild(routeAddBtn);

    // 사용자 요청: 메모는 어느 탭에서 열든 팝업(openNoteModal)으로 열람만 하고, 팝업 안의
    // 작은 "메모 작성/수정" 버튼을 눌러야 더보기 > 현장 메모 관리(해당 현장 자동 선택)로
    // 넘어가 실제 작성/수정/삭제를 한다.
    const noteBtn = document.createElement('button');
    noteBtn.type = 'button';
    noteBtn.className = 'site-detail-action-btn site-detail-btn-secondary';
    noteBtn.textContent = '메모';
    noteBtn.addEventListener('click', () => openNoteModal(site.id));
    actions.appendChild(noteBtn);

    // 사용자 요청(STEP16.22): "현장"/"즐겨찾기" 탭에서 여는 상세정보에는 "위치보기"를 추가한다
    // (지도/경로 탭은 이미 지도 위에서 보고 있거나 요청 대상이 아니므로 제외). 눌러서 "지도"
    // 탭으로 전환한 뒤 같은 사업장을 다시 선택해(selectSite) 핀 위치로 이동/강조한다.
    if (state.mobileActiveTab === 'site' || state.mobileActiveTab === 'favorite') {
      const locateBtn = document.createElement('button');
      locateBtn.type = 'button';
      locateBtn.className = 'site-detail-action-btn site-detail-btn-secondary';
      locateBtn.textContent = '위치보기';
      locateBtn.disabled = !hasValidCoord;
      if (hasValidCoord) {
        locateBtn.addEventListener('click', () => {
          const siteId = site.id;
          const mapTabBtn = document.querySelector('.mobile-tab-btn[data-tab="map"]');
          if (mapTabBtn) mapTabBtn.click();
          selectSite(siteId);
        });
      }
      actions.appendChild(locateBtn);
    }
  }

  panel.appendChild(actions);

  // 사용자 요청(STEP16.22): 모바일에서는 어느 탭(지도/경로/현장/즐겨찾기)에서 열든 상세 패널에
  // 인라인 메모를 더 이상 바로 보여주지 않는다 — 아래 "메모" 버튼을 눌러야 팝업으로 작성/열람/
  // 수정/삭제한다(openNoteModal). PC는 기존과 동일하게 인라인 메모 섹션을 그대로 보여준다.
  if (!isMobileViewport()) {
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
  closeNoteModal(); // 상세를 닫을 때 메모 팝업이 열려 있었다면 함께 정리(고아 상태 방지)
  const panel = document.getElementById('site-detail-panel');
  panel.style.display = 'none';
  panel.style.transform = ''; // 스와이프로 닫힌 경우 남아있는 드래그 이동값 초기화(§ app.js 스와이프 핸들러)
  panel.innerHTML = '';
  if (state.selectedSiteId !== null) clearMarkerHighlight(state.selectedSiteId);
  state.selectedSiteId = null;
  delete panel.dataset.detailOrigin;
  updateListActiveState();

  // 상세를 열 때 숨겼던 검색/필터 바를 다시 보이게 하고(§ renderDetail 참고), 지도 탭이라면
  // 다시 줄어든 지도 크기를 relayout()으로 반영한다(재초기화 없음).
  const appEl = document.getElementById('app');
  if (appEl) appEl.removeAttribute('data-detail-open');
  if (state.mobileActiveTab === 'map' && state.map && typeof state.map.relayout === 'function') {
    state.map.relayout();
  }
}

// ============================================================
// STEP16.13(모바일 "경로" 탭 전면 개편 — 경로 만들기/방문 순서/경로 상세).
//
// TARGET 시안은 다중 경유지 자동 최적화 + 실제 도로 경로(거리/시간/geometry)를 요구했지만,
// AUDIT 결과 그 기능은 Kakao Mobility의 유료·승인제 "다중 경유지 길찾기" API가 있어야만
// 가능하고, 그 API조차 방문 "순서 최적화"는 제공하지 않는다(경유지를 준 순서대로만 길을
// 찾아줌). 사용자 승인("1,2,3하고 역지오코딩도 포함시켜서 구현하자")에 따라 축소된 범위로
// 구현한다:
//   - 경로 만들기(#mobile-route-content): TARGET 그대로 — 현재 위치(+역지오코딩 주소),
//     여러 현장 다중 선택/삭제/전체삭제, 선택 현장 드래그 재정렬.
//   - 방문 순서(#route-order-panel): "최적 경로"가 아니라 사용자가 정한 순서를 지도 위
//     번호 마커로만 보여준다. 자동 최적화/거리/시간/경로선(polyline)은 없다.
//   - 경로 상세(#route-detail-panel): 지도 + 세로 타임라인 + 현장별 "지도에서 보기"/
//     "길찾기"(기존 buildKakaoDirectionsUrl, 단일 목적지). 거리/시간/"경로 다시 계산"은
//     없다(다시 계산할 것 자체가 없음 — 이미 사용자가 정한 순서일 뿐).
// 새 DB 테이블은 쓰지 않고 state.routePlanSiteIds(정렬된 id 배열)만으로 유지한다.
// ============================================================

// 카드/타임라인 항목을 pointer 이벤트로 드래그 재정렬한다(HTML5 draggable은 모바일 터치에서
// 신뢰할 수 없어 쓰지 않는다). listEl의 직계 자식마다 data-drag-id(=String(site.id))가 있어야
// 하며, handleSelector(예: '.route-drag-handle')를 누른 채 위아래로 끌면 지나간 카드와
// 자리를 맞바꾼다(SortableJS 등 새 라이브러리 없이 순수 DOM으로 구현). 손을 떼면 그 시점의
// 최종 DOM 순서를 문자열 배열로 onReorder에 전달한다 — 실제 state 반영은 호출부 책임이다.
function attachDragReorder(listEl, handleSelector, onReorder) {
  let dragEl = null;
  let startY = 0;

  function onPointerMove(e) {
    if (!dragEl) return;
    const deltaY = e.clientY - startY;
    dragEl.style.transform = `translateY(${deltaY}px)`;

    const cards = Array.from(listEl.children);
    const dragIndex = cards.indexOf(dragEl);
    const dragRect = dragEl.getBoundingClientRect();
    const dragCenter = dragRect.top + dragRect.height / 2;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card === dragEl) continue;
      const rect = card.getBoundingClientRect();
      const cardCenter = rect.top + rect.height / 2;
      if (i < dragIndex && dragCenter < cardCenter) {
        listEl.insertBefore(dragEl, card);
        dragEl.style.transform = 'none';
        startY = e.clientY;
        break;
      } else if (i > dragIndex && dragCenter > cardCenter) {
        listEl.insertBefore(dragEl, card.nextSibling);
        dragEl.style.transform = 'none';
        startY = e.clientY;
        break;
      }
    }
  }

  function onPointerUp() {
    if (!dragEl) return;
    dragEl.style.transform = '';
    dragEl.style.position = '';
    dragEl.style.zIndex = '';
    dragEl.classList.remove('route-card-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const newOrder = Array.from(listEl.children).map(c => c.dataset.dragId);
    dragEl = null;
    onReorder(newOrder);
  }

  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest(handleSelector);
    if (!handle) return;
    const card = handle.closest('[data-drag-id]');
    if (!card || !listEl.contains(card)) return;
    e.preventDefault();
    dragEl = card;
    startY = e.clientY;
    dragEl.style.position = 'relative';
    dragEl.style.zIndex = '10';
    dragEl.classList.add('route-card-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (_err) { /* 캡처 미지원 환경도 동작은 계속되게 무시 */ }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });
}

// attachDragReorder가 돌려주는 것은 DOM data-drag-id(=String(site.id)) 순서일 뿐이므로,
// 실제 state.routePlanSiteIds에 넣을 원래 id 값(타입 보존 — bigint든 uuid든 Number()로
// 임의 변환하지 않는다)으로 되돌린다. sites는 이 드래그가 일어난 시점의 정렬된 사업장 배열.
function mapDragOrderToIds(dragKeys, sites) {
  const byKey = new Map(sites.map(s => [String(s.id), s.id]));
  return dragKeys.map(k => byKey.get(k)).filter(id => id !== undefined);
}

// state.routePlanSiteIds -> 실제 사업장 객체 배열(순서 유지). 이미 삭제된(is_active=false 등)
// 사업장은 state.sites에 없으므로 자연히 걸러진다 — routePlanSiteIds 자체는 건드리지 않는다
// (나중에 다시 활성화되면 자동으로 목록에 복귀).
function getRoutePlanSites() {
  return state.routePlanSiteIds.map(id => state.sites.find(s => s.id === id)).filter(Boolean);
}

// ============================================================
// STEP16.16: 경로 탭 상태(선택 현장/출발지) 로컬 저장 — 새로고침/재접속 시 사라지던 문제 수정.
// 기존 STEP16.6 앱 설정과 동일하게 이 기기의 localStorage만 쓰고(새 DB 테이블 없음),
// 계정별로 섞이지 않도록 키에 state.user.id를 포함한다(같은 기기를 여러 감독관이 쓸 수 있음).
// 읽기/쓰기 모두 try/catch로 감싸 localStorage를 쓸 수 없는 환경에서도 앱이 죽지 않는다.
// ============================================================
const ROUTE_PLAN_STORAGE_PREFIX = 'gnmap_v2_route_plan_';

function getRoutePlanStorageKey() {
  const uid = state.user && state.user.id;
  return uid ? `${ROUTE_PLAN_STORAGE_PREFIX}${uid}` : null;
}

// 세 화면(경로 만들기/방문 순서/경로 상세)의 렌더 함수가 매번 호출한다 — 이 화면들에서
// 상태를 바꾸는 모든 경로(현장 추가/삭제/순서변경/출발지 설정)가 결국 재렌더로 이어지므로,
// 개별 조작마다 저장 호출을 흩어놓지 않고 이 한 지점에서만 저장해도 빠짐없이 반영된다.
function saveRoutePlanState() {
  const key = getRoutePlanStorageKey();
  if (!key) return;
  const payload = {
    siteIds: state.routePlanSiteIds,
    currentLocation: state.currentLocation,
    currentLocationAddress: state.currentLocationAddress,
    routeStartMode: state.routeStartMode,
  };
  try { localStorage.setItem(key, JSON.stringify(payload)); } catch (e) { /* 저장 불가 환경은 조용히 무시 */ }
}

// 로그인 직후(사업장 목록 로드 이후, 어떤 경로 화면을 그리기 전) app.js가 1회 호출한다.
export function restoreRoutePlanFromStorage() {
  const key = getRoutePlanStorageKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.siteIds)) {
      state.routePlanSiteIds = saved.siteIds.filter(id => typeof id === 'string' || typeof id === 'number');
    }
    if (saved.currentLocation && Number.isFinite(saved.currentLocation.lat) && Number.isFinite(saved.currentLocation.lng)) {
      state.currentLocation = { lat: saved.currentLocation.lat, lng: saved.currentLocation.lng };
    }
    if (typeof saved.currentLocationAddress === 'string') {
      state.currentLocationAddress = saved.currentLocationAddress;
    }
    if (saved.routeStartMode === 'gps' || saved.routeStartMode === 'manual') {
      state.routeStartMode = saved.routeStartMode;
    }
  } catch (e) {
    // 저장된 값이 손상된 경우 조용히 무시하고 기본(빈) 상태로 시작한다.
  }
}

// "경로 만들기"/"방문 순서" 화면에서 공용으로 쓰는 선택 현장 카드(번호+이름/주소+드래그
// 손잡이+삭제). showWarnOnly가 아니라 항상 좌표 없는 현장에는 안내문을 보여준다(§31 —
// 좌표 없는 현장은 지도에는 못 그리지만 목록/순서에서는 빠지지 않는다).
function buildRouteSiteCard(site, index, onDelete) {
  const card = document.createElement('div');
  card.className = 'route-site-card';
  card.dataset.dragId = String(site.id);

  const handle = document.createElement('span');
  handle.className = 'route-drag-handle';
  handle.setAttribute('aria-label', '순서 변경');
  handle.textContent = '☰';
  card.appendChild(handle);

  const numberBadge = document.createElement('span');
  numberBadge.className = 'route-site-number';
  numberBadge.textContent = String(index + 1);
  card.appendChild(numberBadge);

  const textWrap = document.createElement('div');
  textWrap.className = 'route-site-text';
  // STEP16.15: 현장명/주소 영역을 누르면 기존 site-detail-panel(즐겨찾기 탭 등에서 쓰는
  // selectSite()와 동일한 상세보기)이 뜨도록 한다. 드래그 손잡이(.route-drag-handle)와
  // 삭제(×) 버튼은 이 textWrap 바깥의 형제 요소라 클릭 영역이 겹치지 않는다.
  textWrap.classList.add('route-site-text-clickable');
  textWrap.addEventListener('click', () => selectSite(site.id));
  const nameEl = document.createElement('div');
  nameEl.className = 'route-site-name';
  nameEl.textContent = site.site_name || site.company_name || '-';
  textWrap.appendChild(nameEl);
  const addrEl = document.createElement('div');
  addrEl.className = 'route-site-addr';
  addrEl.textContent = displayValue(site.address);
  textWrap.appendChild(addrEl);
  if (!isValidSiteCoord(site)) {
    const warn = document.createElement('div');
    warn.className = 'route-site-warn';
    warn.textContent = '좌표 정보가 없어 지도에는 표시되지 않습니다.';
    textWrap.appendChild(warn);
  }
  card.appendChild(textWrap);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'route-site-delete-btn';
  deleteBtn.setAttribute('aria-label', '목록에서 삭제');
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', onDelete);
  card.appendChild(deleteBtn);

  return card;
}

// 방문 현장 다중 선택 sheet(기존 admin-sheet-overlay/admin-sheet 재사용 — openSupervisionManagerSheet와
// 동일한 검색+목록 뼈대에 체크박스만 추가). 이미 클라이언트에 로드돼 있는 state.sites를 그대로
// 검색 대상으로 쓰므로 새 조회는 하지 않는다. "완료"를 눌러야만 onConfirm이 호출되고, 바깥을
// 클릭하거나 그냥 닫으면 아무 것도 바뀌지 않는다(임시 선택은 이 함수 안의 draftSelected에만 있음).
function openSitePickerSheet(onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet route-site-picker-sheet';
  const titleEl = document.createElement('div');
  titleEl.className = 'admin-sheet-name';
  titleEl.textContent = '방문 현장 선택';
  sheet.appendChild(titleEl);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'sv-manager-sheet-search';
  searchInput.placeholder = '현장명/주소/관할 검색';
  sheet.appendChild(searchInput);

  const listWrap = document.createElement('div');
  listWrap.className = 'route-picker-list';
  sheet.appendChild(listWrap);

  const draftSelected = new Set(state.routePlanSiteIds);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'route-picker-confirm-btn';

  function updateConfirmLabel() {
    confirmBtn.textContent = `완료(${draftSelected.size})`;
  }

  function renderOptions(query) {
    listWrap.innerHTML = '';
    const q = (query || '').trim();
    let candidates = state.sites.filter(s => {
      if (!q) return true;
      return (s.site_name || '').includes(q) || (s.company_name || '').includes(q) ||
        (s.address || '').includes(q) || (s.dong || '').includes(q);
    });
    // STEP16.16: 즐겨찾기 현장을 목록 맨 위로 정렬한다. 같은 그룹(즐겨찾기/일반) 안에서는
    // 기존 순서(state.sites 순서)를 그대로 유지하는 stable sort.
    candidates = candidates
      .map((s, idx) => ({ s, idx, fav: isFavorite(s.id) }))
      .sort((a, b) => (b.fav === a.fav ? a.idx - b.idx : (b.fav ? 1 : -1)))
      .map(x => x.s);
    if (candidates.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sv-manager-empty';
      empty.textContent = '검색 결과가 없습니다.';
      listWrap.appendChild(empty);
      return;
    }
    candidates.forEach(site => {
      const row = document.createElement('label');
      row.className = 'route-picker-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = draftSelected.has(site.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) draftSelected.add(site.id);
        else draftSelected.delete(site.id);
        updateConfirmLabel();
      });
      row.appendChild(checkbox);

      const textWrap = document.createElement('div');
      textWrap.className = 'route-picker-row-text';
      const nameEl = document.createElement('div');
      nameEl.className = 'route-picker-row-name';
      nameEl.textContent = site.site_name || site.company_name || '-';
      if (isFavorite(site.id)) {
        const favMark = document.createElement('span');
        favMark.className = 'route-picker-row-fav';
        favMark.setAttribute('aria-label', '즐겨찾기 현장');
        favMark.textContent = ' ★';
        nameEl.appendChild(favMark);
      }
      textWrap.appendChild(nameEl);
      const addrEl = document.createElement('div');
      addrEl.className = 'route-picker-row-addr';
      addrEl.textContent = displayValue(site.address);
      textWrap.appendChild(addrEl);
      row.appendChild(textWrap);

      if (!isValidSiteCoord(site)) {
        const warn = document.createElement('span');
        warn.className = 'route-picker-row-warn';
        warn.textContent = '좌표없음';
        row.appendChild(warn);
      }

      listWrap.appendChild(row);
    });
  }

  renderOptions('');
  updateConfirmLabel();
  searchInput.addEventListener('input', () => renderOptions(searchInput.value));

  confirmBtn.addEventListener('click', () => {
    onConfirm(Array.from(draftSelected));
    overlay.remove();
  });
  sheet.appendChild(confirmBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
}

// 사이트 피커에서 "완료"로 확정된 선택 집합을 state.routePlanSiteIds에 반영한다. 기존 순서는
// 유지하고(드래그로 이미 정해둔 순서를 무너뜨리지 않음), 새로 체크된 항목만 뒤에 추가한다 —
// 정확한 "체크한 순간의 순서"까지는 추적하지 않으므로 "새로 추가된 건 맨 뒤"로 충분하다고 판단.
function applyRoutePlanSelection(newIdList) {
  const newIds = new Set(newIdList);
  const kept = state.routePlanSiteIds.filter(id => newIds.has(id));
  const keptSet = new Set(kept);
  const added = newIdList.filter(id => !keptSet.has(id));
  state.routePlanSiteIds = [...kept, ...added];
}

// 경로 미니맵(방문 순서/경로 상세 화면)을 초기화하고 현재 순서대로 번호 마커를 그린다.
// 지도 컨테이너 DOM이 이미 화면에 붙어 있어야 호출할 수 있다(크기를 읽어야 하므로).
async function setupRouteMiniMap(mapContainerId, orderedSites) {
  const firstValid = orderedSites.find(isValidSiteCoord);
  const center = state.currentLocation
    || (firstValid ? { lat: Number(firstValid.lat), lng: Number(firstValid.lng) } : undefined);
  try {
    await initRouteMap(mapContainerId, center);
    relayoutRouteMap(mapContainerId);
    renderRouteMarkers(mapContainerId, state.currentLocation, orderedSites);
  } catch (e) {
    console.error('경로 지도 초기화 실패:', e);
  }
}

// "출발지" 카드의 현재 위치 버튼. 기존 requestCurrentLocation()(§8, 1회성, watchPosition
// 없음)만 재사용하고, 성공하면 이번 STEP에서 새로 추가한 reverseGeocode()로 주소 표시를
// 시도한다. 실패해도 좌표 자체는 이미 state.currentLocation에 반영돼 있으므로 지도/마커는
// 정상 동작하고, 주소 줄만 생략한다(가짜 주소 금지, §31).
async function handleRouteLocationRequest(containerId) {
  if (state.locationRequestInFlight) return;
  state.locationRequestInFlight = true;
  renderMobileRouteView(containerId);

  const result = await requestCurrentLocation();
  state.locationRequestInFlight = false;

  if (!result.ok) {
    renderMobileRouteView(containerId);
    const container = document.getElementById(containerId);
    if (container) {
      const err = document.createElement('p');
      err.className = 'route-start-error';
      err.textContent = result.message;
      container.prepend(err);
    }
    return;
  }

  state.routeStartMode = 'gps';
  state.currentLocationAddress = null; // 역지오코딩 완료 전까지 "주소 확인 중" 표시
  renderMobileRouteView(containerId);

  const geoResult = await reverseGeocode(state.currentLocation.lat, state.currentLocation.lng);
  state.currentLocationAddress = geoResult.success ? geoResult.address : null;
  renderMobileRouteView(containerId);
}

// STEP16.14. "출발지" 카드의 "주소로 검색" 버튼. 기존 admin-sheet-overlay/admin-sheet(방문 현장
// 선택 sheet와 동일한 뼈대) 위에, geocodeKeyword(기존 Edge Function mode:'keyword', 관리자 전용
// 엑셀업로드 매칭에 쓰던 것을 그대로 재사용)로 후보를 받아 목록으로 보여준다. 자동으로 1건을
// 확정하지 않고, 사용자가 직접 고른 후보의 좌표/주소만 그대로 출발지에 반영한다(가짜 데이터 금지, §31).
function openRouteAddressSearchSheet(containerId) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet route-addr-search-sheet';
  const titleEl = document.createElement('div');
  titleEl.className = 'admin-sheet-name';
  titleEl.textContent = '출발지 주소 검색';
  sheet.appendChild(titleEl);

  const searchRow = document.createElement('div');
  searchRow.className = 'route-addr-search-row';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'sv-manager-sheet-search';
  searchInput.placeholder = '예: 테헤란로 152, 강남구청';
  searchRow.appendChild(searchInput);
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'route-addr-search-btn';
  searchBtn.textContent = '검색';
  searchRow.appendChild(searchBtn);
  sheet.appendChild(searchRow);

  const resultWrap = document.createElement('div');
  resultWrap.className = 'route-picker-list';
  sheet.appendChild(resultWrap);

  let searching = false;
  async function runSearch() {
    const q = searchInput.value.trim();
    if (!q || searching) return;
    searching = true;
    searchBtn.disabled = true;
    resultWrap.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'sv-manager-empty';
    loading.textContent = '검색 중...';
    resultWrap.appendChild(loading);

    const result = await geocodeKeyword(q);
    searching = false;
    searchBtn.disabled = false;
    resultWrap.innerHTML = '';

    if (!result || !result.success || !Array.isArray(result.candidates) || result.candidates.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sv-manager-empty';
      empty.textContent = '검색 결과가 없습니다. 다른 주소나 건물명으로 검색해보세요.';
      resultWrap.appendChild(empty);
      return;
    }

    result.candidates.forEach(c => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'route-addr-candidate-row';

      const nameEl = document.createElement('div');
      nameEl.className = 'route-picker-row-name';
      nameEl.textContent = c.placeName || c.roadAddressName || c.addressName || '-';
      row.appendChild(nameEl);

      const addrEl = document.createElement('div');
      addrEl.className = 'route-picker-row-addr';
      addrEl.textContent = c.roadAddressName || c.addressName || '';
      row.appendChild(addrEl);

      row.addEventListener('click', () => {
        state.currentLocation = { lat: c.lat, lng: c.lng };
        state.currentLocationAddress = c.roadAddressName || c.addressName || c.placeName || null;
        state.routeStartMode = 'manual';
        overlay.remove();
        renderMobileRouteView(containerId);
      });

      resultWrap.appendChild(row);
    });
  }

  searchBtn.addEventListener('click', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  searchInput.focus();
}

// ① 경로 만들기 — 하단 탭 "경로"의 첫 화면(#mobile-route-content).
export function renderMobileRouteView(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  saveRoutePlanState();
  container.innerHTML = '';

  const selectedSites = getRoutePlanSites();

  // 출발지
  const startCard = document.createElement('div');
  startCard.className = 'route-start-card';
  const startTitle = document.createElement('div');
  startTitle.className = 'route-card-title';
  startTitle.textContent = '출발지';
  startCard.appendChild(startTitle);

  const startRow = document.createElement('div');
  startRow.className = 'route-start-row';
  const startText = document.createElement('div');
  startText.className = 'route-start-text';
  if (state.currentLocation) {
    const label = document.createElement('div');
    label.className = 'route-start-label';
    label.textContent = state.routeStartMode === 'manual' ? '입력한 주소' : '현재 위치';
    startText.appendChild(label);
    const addr = document.createElement('div');
    addr.className = 'route-start-address';
    addr.textContent = state.currentLocationAddress || '주소 확인 중...';
    startText.appendChild(addr);
  } else {
    const label = document.createElement('div');
    label.className = 'route-start-label';
    label.textContent = '출발지를 아직 정하지 않았습니다.';
    startText.appendChild(label);
  }
  startRow.appendChild(startText);

  const startBtnGroup = document.createElement('div');
  startBtnGroup.className = 'route-start-btn-group';

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'route-start-btn';
  // STEP16.16: 상태와 무관하게 "현재 위치"로 통일(이전엔 이미 정해진 뒤엔 "위치 변경"이었음).
  // 버튼 글자 폭도 줄어들어 옆 "주소 검색" 버튼과 함께 출발지 카드 폭을 덜 차지한다.
  startBtn.textContent = '현재 위치';
  startBtn.disabled = state.locationRequestInFlight;
  startBtn.addEventListener('click', () => handleRouteLocationRequest(containerId));
  startBtnGroup.appendChild(startBtn);

  const addrSearchBtn = document.createElement('button');
  addrSearchBtn.type = 'button';
  addrSearchBtn.className = 'route-start-btn route-start-btn-secondary';
  addrSearchBtn.textContent = '주소 검색';
  addrSearchBtn.addEventListener('click', () => openRouteAddressSearchSheet(containerId));
  startBtnGroup.appendChild(addrSearchBtn);

  startRow.appendChild(startBtnGroup);
  startCard.appendChild(startRow);
  container.appendChild(startCard);

  // + 현장 검색 (STEP16.18: "방문 현장 추가"에서 문구 변경. 기능/시트는 동일.)
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'route-add-site-btn';
  addBtn.textContent = '+ 현장 검색';
  addBtn.addEventListener('click', () => {
    openSitePickerSheet((newIds) => {
      applyRoutePlanSelection(newIds);
      renderMobileRouteView(containerId);
    });
  });
  container.appendChild(addBtn);

  // 선택 현장 목록(드래그로 순서 변경, 개별 삭제)
  if (selectedSites.length > 0) {
    const listEl = document.createElement('div');
    listEl.className = 'route-site-list';
    selectedSites.forEach((site, index) => {
      listEl.appendChild(buildRouteSiteCard(site, index, () => {
        state.routePlanSiteIds = state.routePlanSiteIds.filter(id => id !== site.id);
        renderMobileRouteView(containerId);
      }));
    });
    container.appendChild(listEl);

    attachDragReorder(listEl, '.route-drag-handle', (newOrderIds) => {
      state.routePlanSiteIds = mapDragOrderToIds(newOrderIds, selectedSites);
      renderMobileRouteView(containerId);
    });
  }

  // 경로 보기(선택 현장과 출발지가 모두 있어야 활성화).
  // STEP16.16: 출발지 없이 방문 순서/경로 상세로 넘어가면 미니맵이 임시로 첫 현장 좌표를
  // 중심으로 쓰는데, 그 상태로 진행하는 건 사용자가 "안 정해도 되는구나"로 오해하기 쉬워
  // 아예 진행 자체를 막고 이유를 안내한다.
  // STEP16.17: "방문 순서 만들기"(주 동작)를 "전체 삭제"(부 동작)보다 위로 올려 우선순위를 명확히 한다.
  // STEP16.18: "방문 순서 만들기" → "경로 보기"로 문구 변경. 중간 단계였던 "방문 순서"
  // 화면(#route-order-panel)은 더 이상 경유하지 않고 바로 "경로 상세"(경로 보기) 화면으로 연다.
  const ctaBtn = document.createElement('button');
  ctaBtn.type = 'button';
  ctaBtn.className = 'route-cta-btn';
  ctaBtn.textContent = '경로 보기';
  ctaBtn.disabled = selectedSites.length === 0 || !state.currentLocation;
  ctaBtn.addEventListener('click', () => openRouteDetailPanel());
  container.appendChild(ctaBtn);

  if (selectedSites.length > 0 && !state.currentLocation) {
    const hint = document.createElement('p');
    hint.className = 'route-cta-hint';
    hint.textContent = '출발지를 먼저 정해주세요.';
    container.appendChild(hint);
  }

  if (selectedSites.length > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'route-clear-all-btn';
    clearBtn.textContent = '전체 삭제';
    clearBtn.addEventListener('click', () => {
      state.routePlanSiteIds = [];
      renderMobileRouteView(containerId);
    });
    container.appendChild(clearBtn);
  }
}

// ② 방문 순서 — #route-order-panel(전체화면 패널, "경로" 탭에 머무른 채 연다).
export function openRouteOrderPanel() {
  const panel = document.getElementById('route-order-panel');
  if (!panel) return;
  panel.style.display = 'block';
  renderRouteOrderPanel('route-order-panel');
}

export async function renderRouteOrderPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  saveRoutePlanState();
  container.innerHTML = '';

  const { header, backBtn } = buildSettingsSubHeader('방문 순서');
  backBtn.addEventListener('click', () => { container.style.display = 'none'; });
  container.appendChild(header);

  const selectedSites = getRoutePlanSites();

  if (selectedSites.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'mobile-placeholder';
    msg.textContent = '선택한 방문 현장이 없습니다. 경로 만들기에서 현장을 먼저 선택해주세요.';
    container.appendChild(msg);
    return;
  }

  const noteEl = document.createElement('p');
  noteEl.className = 'route-order-note';
  noteEl.textContent = '아래 번호는 자동으로 계산된 최적 경로가 아니라, 선택하거나 드래그로 정한 방문 순서입니다.';
  container.appendChild(noteEl);

  const mapWrap = document.createElement('div');
  mapWrap.id = 'route-order-map';
  mapWrap.className = 'route-mini-map';
  container.appendChild(mapWrap);

  const listEl = document.createElement('div');
  listEl.className = 'route-site-list';
  selectedSites.forEach((site, index) => {
    listEl.appendChild(buildRouteSiteCard(site, index, () => {
      state.routePlanSiteIds = state.routePlanSiteIds.filter(id => id !== site.id);
      renderRouteOrderPanel(containerId);
    }));
  });
  container.appendChild(listEl);

  attachDragReorder(listEl, '.route-drag-handle', (newOrderIds) => {
    state.routePlanSiteIds = mapDragOrderToIds(newOrderIds, selectedSites);
    renderRouteOrderPanel(containerId);
  });

  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = 'route-cta-btn';
  detailBtn.textContent = '경로 상세 보기';
  detailBtn.addEventListener('click', () => openRouteDetailPanel());
  container.appendChild(detailBtn);

  await setupRouteMiniMap('route-order-map', selectedSites);
}

// ③ 경로 상세("경로 보기") — #route-detail-panel(전체화면 패널). 지도 + 세로 타임라인 +
// 현장별 "지도에서 보기"/"길찾기". 거리/시간/"경로 다시 계산"은 없다(승인된 축소 범위 —
// 실제 도로 경로 데이터가 없어 다시 계산할 대상 자체가 없음).
// STEP16.18: 여기서 다루는 목록(routeDetailViewSiteIds)은 열릴 때 state.routePlanSiteIds를
// 복사한 "이번 보기 세션" 전용 스냅샷이다 — 경로 보기 화면에서 X로 삭제하거나 순서를 바꿔도
// "경로" 기본 탭의 선택 목록(state.routePlanSiteIds)에는 영향을 주지 않는다. 다시 열 때마다
// 기본 탭의 최신 목록으로 새로 복사된다.
let routeDetailViewSiteIds = null;

function sitesFromIds(ids) {
  return ids.map(id => state.sites.find(s => s.id === id)).filter(Boolean);
}

export function openRouteDetailPanel() {
  const panel = document.getElementById('route-detail-panel');
  if (!panel) return;
  routeDetailViewSiteIds = [...state.routePlanSiteIds];
  panel.style.display = 'block';
  renderRouteDetailPanel('route-detail-panel');
}

function buildRouteTimelineStop(site, index, total, onDelete) {
  const row = document.createElement('div');
  row.className = 'route-timeline-row';
  row.dataset.dragId = String(site.id);

  const rail = document.createElement('div');
  rail.className = 'route-timeline-rail';
  const dot = document.createElement('span');
  dot.className = 'route-timeline-dot';
  dot.textContent = String(index + 1);
  rail.appendChild(dot);
  if (index < total - 1) {
    const line = document.createElement('span');
    line.className = 'route-timeline-line';
    rail.appendChild(line);
  }
  row.appendChild(rail);

  const body = document.createElement('div');
  body.className = 'route-timeline-body';

  const topRow = document.createElement('div');
  topRow.className = 'route-timeline-top';
  const handle = document.createElement('span');
  handle.className = 'route-drag-handle';
  handle.setAttribute('aria-label', '순서 변경');
  handle.textContent = '☰';
  topRow.appendChild(handle);
  const nameEl = document.createElement('span');
  // STEP16.16: "경로 만들기"/"방문 순서" 카드(route-site-text-clickable)와 동일하게, 이름을
  // 누르면 기존 site-detail-panel 상세보기가 뜨도록 한다.
  nameEl.className = 'route-timeline-name route-site-text-clickable';
  nameEl.textContent = site.site_name || site.company_name || '-';
  nameEl.addEventListener('click', () => selectSite(site.id));
  topRow.appendChild(nameEl);
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'route-site-delete-btn';
  deleteBtn.setAttribute('aria-label', '목록에서 삭제');
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', onDelete);
  topRow.appendChild(deleteBtn);
  body.appendChild(topRow);

  const addrEl = document.createElement('div');
  addrEl.className = 'route-site-addr route-site-text-clickable';
  addrEl.textContent = displayValue(site.address);
  addrEl.addEventListener('click', () => selectSite(site.id));
  body.appendChild(addrEl);

  const hasCoord = isValidSiteCoord(site);
  if (!hasCoord) {
    const warn = document.createElement('div');
    warn.className = 'route-site-warn';
    warn.textContent = '좌표 정보가 없어 지도 표시·길찾기를 이용할 수 없습니다.';
    body.appendChild(warn);
  }

  const actions = document.createElement('div');
  actions.className = 'route-timeline-actions';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'route-timeline-action-btn';
  viewBtn.textContent = '지도에서 보기';
  viewBtn.disabled = !hasCoord;
  if (hasCoord) {
    viewBtn.addEventListener('click', () => panToRouteSite('route-detail-map', site));
  }
  actions.appendChild(viewBtn);

  const directionsBtn = document.createElement('button');
  directionsBtn.type = 'button';
  directionsBtn.className = 'route-timeline-action-btn route-timeline-action-primary';
  directionsBtn.textContent = '길찾기';
  directionsBtn.disabled = !hasCoord;
  if (hasCoord) {
    directionsBtn.addEventListener('click', () => {
      const url = buildKakaoDirectionsUrl(site.site_name || site.company_name, site.lat, site.lng);
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }
  actions.appendChild(directionsBtn);

  body.appendChild(actions);
  row.appendChild(body);
  return row;
}

export async function renderRouteDetailPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  saveRoutePlanState();
  container.innerHTML = '';

  const { header, backBtn } = buildSettingsSubHeader('경로 상세');
  backBtn.addEventListener('click', () => { container.style.display = 'none'; });
  container.appendChild(header);

  // STEP16.18: 다른 경로로 이 패널이 직접 열린 경우(예: 새로고침 복원)를 대비한 안전장치.
  // 정상 진입은 openRouteDetailPanel()이 이미 스냅샷을 채워둔 뒤 호출한다.
  if (!routeDetailViewSiteIds) {
    routeDetailViewSiteIds = [...state.routePlanSiteIds];
  }
  const selectedSites = sitesFromIds(routeDetailViewSiteIds);

  if (selectedSites.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'mobile-placeholder';
    msg.textContent = '선택한 방문 현장이 없습니다. 경로 만들기에서 현장을 먼저 선택해주세요.';
    container.appendChild(msg);
    return;
  }

  const noteEl = document.createElement('p');
  noteEl.className = 'route-order-note';
  noteEl.textContent = '실제 도로 경로와 이동 거리·소요 시간은 제공되지 않습니다. 현장별로 카카오맵 길찾기를 이용해주세요.';
  container.appendChild(noteEl);

  const mapWrap = document.createElement('div');
  mapWrap.id = 'route-detail-map';
  mapWrap.className = 'route-mini-map';
  container.appendChild(mapWrap);

  const timeline = document.createElement('div');
  timeline.className = 'route-timeline';
  selectedSites.forEach((site, index) => {
    timeline.appendChild(buildRouteTimelineStop(site, index, selectedSites.length, () => {
      // STEP16.18: 경로 보기 세션 목록에서만 제거한다(state.routePlanSiteIds는 그대로 둔다).
      routeDetailViewSiteIds = routeDetailViewSiteIds.filter(id => id !== site.id);
      renderRouteDetailPanel(containerId);
    }));
  });
  container.appendChild(timeline);

  attachDragReorder(timeline, '.route-drag-handle', (newOrderIds) => {
    routeDetailViewSiteIds = mapDragOrderToIds(newOrderIds, selectedSites);
    renderRouteDetailPanel(containerId);
  });

  await setupRouteMiniMap('route-detail-map', selectedSites);
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
  // STEP16.5 후속(더보기 화면 정비)에서 추가한 아이콘. 기존과 동일한 stroke 스타일을 따른다.
  gear: ['<circle cx="12" cy="12" r="3"/>', '<path d="M12 3v2.5M12 18.5V21M4.2 4.2l1.8 1.8M18 18l1.8 1.8M3 12h2.5M18.5 12H21M4.2 19.8l1.8-1.8M18 6l1.8-1.8"/>'],
  lock: ['<rect x="5" y="11" width="14" height="9" rx="2"/>', '<path d="M8 11V7a4 4 0 0 1 8 0v4"/>'],
  bell: ['<path d="M18 16v-5a6 6 0 1 0-12 0v5l-1.5 2.5h15L18 16Z"/>', '<path d="M9.5 20a2.5 2.5 0 0 0 5 0"/>'],
  info: ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 11v5.5"/>', '<path d="M12 8h.01"/>'],
  // STEP16.6(모바일 앱 설정/알림 설정) 추가 아이콘. 기존과 동일한 stroke 스타일, 새 아이콘
  // 라이브러리 도입 없이 같은 방식(인라인 SVG path)으로만 추가한다.
  pin: ['<path d="M12 21s7-7.2 7-12A7 7 0 0 0 5 9c0 4.8 7 12 7 12Z"/>', '<circle cx="12" cy="9" r="2.4"/>'],
  refresh: ['<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5"/>', '<path d="M20 4v4.5H15.5"/>', '<path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5"/>', '<path d="M4 20v-4.5H8.5"/>'],
  database: ['<ellipse cx="12" cy="6" rx="7" ry="2.8"/>', '<path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/>', '<path d="M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/>'],
  briefcase: ['<rect x="3.5" y="8" width="17" height="11" rx="2"/>', '<path d="M8.5 8V6.5A2.5 2.5 0 0 1 11 4h2a2.5 2.5 0 0 1 2.5 2.5V8"/>', '<path d="M3.5 13h17"/>'],
  clock: ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 7.5V12l3.2 2"/>'],
  megaphone: ['<path d="M4 10v4a1.5 1.5 0 0 0 1.5 1.5H7l3.5 4V4.5L7 8.5H5.5A1.5 1.5 0 0 0 4 10Z"/>', '<path d="M13.5 8a4.5 4.5 0 0 1 0 8"/>'],
  users: ['<circle cx="9" cy="8" r="3"/>', '<path d="M3.5 19c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/>', '<circle cx="17" cy="9" r="2.4"/>', '<path d="M15.5 13.3c1.8.4 3 1.9 3 3.7"/>'],
  eye: ['<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/>', '<circle cx="12" cy="12" r="2.8"/>'],
  eyeOff: ['<path d="M3 3l18 18"/>', '<path d="M10.6 5.6A10.7 10.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.2 15.2 0 0 1-3 3.7"/>', '<path d="M6.6 6.6C4.2 8.1 2.5 10.5 2.5 12S6 18.5 12 18.5c1.3 0 2.5-.2 3.6-.6"/>', '<path d="M9.9 10a2.8 2.8 0 0 0 4 4"/>'],
  // STEP16.23(더보기 > 현장 메모) 추가 아이콘. 기존과 동일한 stroke 스타일.
  doc: ['<path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5Z"/>', '<path d="M14 3.5V8h4"/>', '<path d="M9 13h6M9 16.5h5"/>'],
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

function buildSettingsSubHeader(title) {
  // §4: 새 Header component를 만들지 않고 기존 감독일정 모바일 sub-page 헤더
  // (.sv-mobile-subheader/.sv-mobile-back-btn/.sv-mobile-subheader-title)를 그대로 재사용한다.
  // "뒤로가기"는 admin/upload 패널의 ×와 달리, 열려 있는 패널(panelId)의 display만 되돌린다.
  const header = document.createElement('div');
  header.className = 'sv-mobile-subheader';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'sv-mobile-back-btn';
  backBtn.setAttribute('aria-label', '뒤로가기');
  backBtn.appendChild(svIcon(SV_ICON_CHEVRON_LEFT));
  header.appendChild(backBtn);
  const titleEl = document.createElement('span');
  titleEl.className = 'sv-mobile-subheader-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);
  return { header, backBtn };
}

// ============================================================
// STEP16.6: 모바일 앱 설정/비밀번호 변경/알림 설정 — 로컬(이 기기/브라우저) 설정 저장소.
// DB 테이블을 새로 만들지 않는다(TARGET 항목들은 계정 간 동기화가 필요한 정보가 아니라
// "이 기기에서 앱을 어떻게 쓸지"에 대한 환경설정이므로 localStorage로 충분하다는 AUDIT 결론).
// 키는 프로젝트 namespace 규칙(gnmap_v2_...)을 따른다. 읽기/쓰기 모두 try/catch로 감싸
// localStorage를 쓸 수 없는 환경(프라이빗 모드 등)에서도 앱이 죽지 않고 기본값으로 동작한다.
// ============================================================
const APP_SETTINGS_KEY = 'gnmap_v2_app_settings';
const NOTIFICATION_SETTINGS_KEY = 'gnmap_v2_notification_settings';

const DEFAULT_APP_SETTINGS = {
  mapStartLocation: 'gangnam', // 'gangnam' | 'current' — 기존 동작(강남구 중심 고정)을 기본값으로 유지, 규정변경 없음.
  autoShowLocation: false,     // 지도 진입 시 현재 위치 자동 표시(끄면 기존과 동일하게 버튼 클릭 시에만 표시).
};
const DEFAULT_NOTIFICATION_SETTINGS = {
  all: true,
  supervision: true,
  supervisionAdvanceDays: 1, // 0(당일) | 1 | 2 | 3
  memberApproval: true,      // admin 전용 항목(값 자체는 저장하되, UI는 admin에게만 노출)
  announcement: true,
  dataProcessing: true,
};

function loadAppSettings() {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    return raw ? { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_APP_SETTINGS };
  } catch (e) {
    return { ...DEFAULT_APP_SETTINGS };
  }
}
function saveAppSettings(patch) {
  const next = { ...loadAppSettings(), ...patch };
  try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next)); } catch (e) { /* 저장 불가 환경은 조용히 무시 — 이번 세션 동안만 적용된 값으로라도 동작 */ }
  return next;
}
function loadNotificationSettings() {
  try {
    const raw = localStorage.getItem(NOTIFICATION_SETTINGS_KEY);
    return raw ? { ...DEFAULT_NOTIFICATION_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_NOTIFICATION_SETTINGS };
  } catch (e) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}
function saveNotificationSettings(patch) {
  const next = { ...loadNotificationSettings(), ...patch };
  try { localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(next)); } catch (e) { /* 위와 동일 */ }
  return next;
}
// app.js가 로그인 직후(지도 초기화 전) 지도 시작 위치 설정만 필요할 때 쓰는 조회 전용 함수.
export function getAppSettings() {
  return loadAppSettings();
}

// iOS 스타일 pill 토글 스위치. <input type="checkbox">를 시각적으로 감춘 실제 상태 저장소로
// 쓰고, 그 옆 <span>을 CSS로 스위치처럼 그린다(새 라이브러리 없이 순수 CSS 컴포넌트 1개 신설 —
// 프로젝트에 기존 토글 UI가 없어 재사용할 대상이 없었다).
function buildSettingsToggle(checked, onChange, disabled) {
  const label = document.createElement('label');
  label.className = 'settings-toggle' + (disabled ? ' is-disabled' : '');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.disabled = !!disabled;
  input.addEventListener('change', () => onChange(input.checked));
  const track = document.createElement('span');
  track.className = 'settings-toggle-track';
  label.appendChild(input);
  label.appendChild(track);
  return label;
}

// TARGET의 "현재 위치 >" / "1일 전 >" 처럼 값+chevron으로 보이는 버튼.
function buildSettingsValueBtn(valueText, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-value-btn';
  const valueEl = document.createElement('span');
  valueEl.textContent = valueText;
  btn.appendChild(valueEl);
  btn.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  btn.addEventListener('click', onClick);
  return btn;
}

// 카드 하나 + 그 안의 row들. control은 buildSettingsToggle/buildSettingsValueBtn 결과 엘리먼트.
function buildSettingsCard(iconName, cardTitle, rows) {
  const card = document.createElement('div');
  card.className = 'settings-card';
  const titleRow = document.createElement('div');
  titleRow.className = 'settings-card-title';
  titleRow.appendChild(buildMobileMoreIcon(iconName));
  const titleText = document.createElement('span');
  titleText.textContent = cardTitle;
  titleRow.appendChild(titleText);
  card.appendChild(titleRow);

  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'settings-row' + (row.disabled ? ' is-disabled' : '');
    const iconWrap = document.createElement('span');
    iconWrap.className = 'settings-row-icon';
    iconWrap.appendChild(buildMobileMoreIcon(row.icon));
    rowEl.appendChild(iconWrap);

    const textWrap = document.createElement('div');
    textWrap.className = 'settings-row-text';
    const titleLine = document.createElement('div');
    titleLine.className = 'settings-row-title';
    titleLine.textContent = row.title;
    if (row.badge) {
      const badge = document.createElement('span');
      badge.className = 'settings-row-badge';
      badge.textContent = row.badge;
      titleLine.appendChild(badge);
    }
    textWrap.appendChild(titleLine);
    if (row.desc) {
      const descLine = document.createElement('div');
      descLine.className = 'settings-row-desc';
      descLine.textContent = row.desc;
      textWrap.appendChild(descLine);
    }
    rowEl.appendChild(textWrap);

    if (row.control) {
      const controlWrap = document.createElement('div');
      controlWrap.className = 'settings-row-control';
      controlWrap.appendChild(row.control);
      rowEl.appendChild(controlWrap);
    }
    card.appendChild(rowEl);
  });
  return card;
}

// TARGET의 "지도 시작 위치"/"감독일정 사전 알림"처럼 2~4개 중 하나를 고르는 작은 bottom sheet.
// 기존 담당 감독관 선택 sheet(openSupervisionManagerSheet)와 동일하게 admin-sheet-overlay/
// admin-sheet를 재사용하고, 검색 input 없는 단순 목록만 얹는다(새 sheet 컴포넌트 신설 없음).
function openSettingsOptionSheet(title, options, currentValue, onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet';
  const titleEl = document.createElement('div');
  titleEl.className = 'admin-sheet-name';
  titleEl.textContent = title;
  sheet.appendChild(titleEl);

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-sheet-option' + (opt.value === currentValue ? ' active' : '');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      onSelect(opt.value);
      overlay.remove();
    });
    sheet.appendChild(btn);
  });

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
}

// ============================================================
// A. 앱 설정
// ============================================================
export function renderAppSettingsPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const { header, backBtn } = buildSettingsSubHeader('앱 설정');
  backBtn.addEventListener('click', () => { document.getElementById(containerId).style.display = 'none'; });
  container.appendChild(header);

  const subtitle = document.createElement('p');
  subtitle.className = 'sv-mobile-subtitle';
  subtitle.style.padding = '0 16px 12px';
  subtitle.textContent = '산업안전 순찰지도의 사용 환경을 설정합니다.';
  container.appendChild(subtitle);

  const settings = loadAppSettings();
  const MAP_START_LABEL = { gangnam: '강남구 기본 위치', current: '현재 위치' };

  const mapStartBtn = buildSettingsValueBtn(MAP_START_LABEL[settings.mapStartLocation], () => {
    openSettingsOptionSheet('지도 시작 위치', [
      { value: 'gangnam', label: '강남구 기본 위치' },
      { value: 'current', label: '현재 위치' },
    ], settings.mapStartLocation, (value) => {
      saveAppSettings({ mapStartLocation: value });
      renderAppSettingsPanel(containerId);
    });
  });

  const autoShowToggle = buildSettingsToggle(settings.autoShowLocation, (checked) => {
    saveAppSettings({ autoShowLocation: checked });
  });

  const mapCard = buildSettingsCard('pin', '지도 설정', [
    // 실제로 지도 재초기화가 필요한 설정이라(다음 접속부터 적용), 안내 문구로 명시한다.
    { icon: 'pin', title: '지도 시작 위치', desc: '앱 실행 시 지도의 초기 위치를 설정합니다. (다음 접속부터 적용)', control: mapStartBtn },
    { icon: 'pin', title: '현재 위치 자동 표시', desc: '지도 화면에서 내 위치를 자동으로 표시합니다.', control: autoShowToggle },
  ]);
  container.appendChild(mapCard);

  // AUDIT 결과(완료 보고 §5 참고): 사업장 데이터는 이미 로그인/앱 실행마다 항상 새로 불러오고
  // 있어(routeByProfile), 이 토글을 꺼도 실제로 달라지는 동작이 없다. 값 자체는 저장하되(다른
  // 화면과의 일관성을 위해 TARGET 항목은 유지) 그 사실을 문구에 정직하게 밝힌다 — 끄면 알 수
  // 없이 계속 최신 데이터를 받아오는데도 "꺼졌다"고 오해하게 만들지 않기 위함이다.
  const autoRefreshToggle = buildSettingsToggle(true, () => {}, true);
  const dataCard = buildSettingsCard('database', '데이터 설정', [
    { icon: 'refresh', title: '앱 실행 시 데이터 자동 새로고침', desc: '현재 항상 최신 사업장 데이터를 불러오는 구조라 끌 수 있는 항목이 없습니다.', control: autoRefreshToggle },
  ]);
  container.appendChild(dataCard);
}

// ============================================================
// B. 비밀번호 변경
// ============================================================
function buildPasswordField(labelText, placeholder, options = {}) {
  const field = document.createElement('div');
  field.className = 'settings-field';
  field.appendChild(svLabel(labelText, true));
  const wrap = document.createElement('div');
  wrap.className = 'settings-password-wrap';
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = placeholder;
  input.autocomplete = 'new-password';
  wrap.appendChild(input);
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'settings-password-eye-btn';
  toggleBtn.setAttribute('aria-label', '비밀번호 표시/숨기기');
  let showing = false;
  toggleBtn.appendChild(buildMobileMoreIcon('eye'));
  toggleBtn.addEventListener('click', () => {
    showing = !showing;
    input.type = showing ? 'text' : 'password';
    toggleBtn.innerHTML = '';
    toggleBtn.appendChild(buildMobileMoreIcon(showing ? 'eyeOff' : 'eye'));
    toggleBtn.classList.toggle('active', showing);
  });
  wrap.appendChild(toggleBtn);
  field.appendChild(wrap);

  // 회원가입 화면(#signup-password-rules / #signup-password-match-msg, app.js)과 완전히
  // 동일한 클래스(mobile-signup-rules / mobile-signup-match-msg)를 그대로 재사용해, 새
  // 컴포넌트를 만들지 않고도 동일한 라이브 체크리스트·일치표시 UI를 보여준다.
  let rulesEl = null;
  let matchMsgEl = null;
  if (options.withRules) {
    rulesEl = document.createElement('ul');
    rulesEl.className = 'mobile-signup-rules';
    [['length', '8~20자'], ['letter', '영문 포함'], ['digit', '숫자 포함'], ['special', '특수문자 포함']]
      .forEach(([rule, text]) => {
        const li = document.createElement('li');
        li.dataset.rule = rule;
        li.textContent = text;
        rulesEl.appendChild(li);
      });
    field.appendChild(rulesEl);
  }
  if (options.withMatchMsg) {
    matchMsgEl = document.createElement('span');
    matchMsgEl.className = 'mobile-signup-match-msg';
    matchMsgEl.setAttribute('aria-live', 'polite');
    field.appendChild(matchMsgEl);
  }
  return { field, input, rulesEl, matchMsgEl };
}

export function renderPasswordChangePanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const { header, backBtn } = buildSettingsSubHeader('비밀번호 변경');
  backBtn.addEventListener('click', () => { document.getElementById(containerId).style.display = 'none'; });
  container.appendChild(header);

  const subtitle = document.createElement('p');
  subtitle.className = 'sv-mobile-subtitle';
  subtitle.style.padding = '0 16px 12px';
  subtitle.textContent = '계정 보안을 위해 새로운 비밀번호를 설정해주세요.';
  container.appendChild(subtitle);

  const noticeCard = document.createElement('div');
  noticeCard.className = 'settings-notice-card';
  noticeCard.appendChild(buildMobileMoreIcon('lock'));
  const noticeText = document.createElement('span');
  noticeText.textContent = '안전한 계정 사용을 위해 주기적으로 비밀번호를 변경해주세요.';
  noticeCard.appendChild(noticeText);
  container.appendChild(noticeCard);

  const form = document.createElement('div');
  form.className = 'settings-form';

  const { field: currentField, input: currentInput } = buildPasswordField('현재 비밀번호', '현재 비밀번호를 입력해주세요.');
  const { field: newField, input: newInput, rulesEl: newPwRulesEl } = buildPasswordField('새 비밀번호', '새 비밀번호를 입력해주세요.', { withRules: true });
  const { field: confirmField, input: confirmInput, matchMsgEl: confirmMatchMsgEl } = buildPasswordField('새 비밀번호 확인', '새 비밀번호를 다시 입력해주세요.', { withMatchMsg: true });
  form.appendChild(currentField);
  form.appendChild(newField);
  form.appendChild(confirmField);

  // STEP16.9(회원가입과 동일한 라이브 검증). app.js의 signup 라이브 체크리스트/일치표시
  // 로직(RULES 판정식, is-met/is-match 클래스 토글)을 그대로 재사용한다 — 새 비밀번호
  // 규칙 안내는 이제 이 라이브 체크리스트가 대신하므로, 아래 정적 안내카드는 체크리스트가
  // 다루지 않는 "기존 비밀번호와 다른 비밀번호" 항목만 남긴다.
  const PW_RULES = {
    length: (v) => v.length >= 8 && v.length <= 20,
    letter: (v) => /[A-Za-z]/.test(v),
    digit: (v) => /\d/.test(v),
    special: (v) => /[^A-Za-z0-9]/.test(v),
  };
  if (newPwRulesEl) {
    newInput.addEventListener('input', () => {
      const value = newInput.value;
      newPwRulesEl.querySelectorAll('li[data-rule]').forEach((li) => {
        const rule = PW_RULES[li.dataset.rule];
        li.classList.toggle('is-met', !!(rule && rule(value)));
      });
    });
  }
  if (confirmMatchMsgEl) {
    const updateMatchMsg = () => {
      if (!confirmInput.value) {
        confirmMatchMsgEl.textContent = '';
        confirmMatchMsgEl.className = 'mobile-signup-match-msg';
        return;
      }
      const match = newInput.value === confirmInput.value;
      confirmMatchMsgEl.textContent = match ? '비밀번호가 일치합니다.' : '비밀번호가 일치하지 않습니다.';
      confirmMatchMsgEl.className = 'mobile-signup-match-msg ' + (match ? 'is-match' : 'is-mismatch');
    };
    newInput.addEventListener('input', updateMatchMsg);
    confirmInput.addEventListener('input', updateMatchMsg);
  }

  const errorEl = document.createElement('p');
  errorEl.className = 'sv-mobile-field-error';
  form.appendChild(errorEl);

  const guideCard = document.createElement('div');
  guideCard.className = 'settings-guide-card';
  const guideTitle = document.createElement('div');
  guideTitle.className = 'settings-guide-title';
  guideTitle.textContent = '비밀번호 설정 안내';
  guideCard.appendChild(guideTitle);
  const guideList = document.createElement('ul');
  // 영문/숫자/특수문자/8~20자 안내는 위 새 비밀번호 라이브 체크리스트가 대신하므로(회원가입과
  // 동일한 방식), 여기서는 체크리스트가 다루지 않는 항목만 남긴다.
  ['기존 비밀번호와 다른 비밀번호를 사용해주세요.']
    .forEach(t => { const li = document.createElement('li'); li.textContent = t; guideList.appendChild(li); });
  guideCard.appendChild(guideList);
  form.appendChild(guideCard);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'sv-mobile-submit-btn';
  submitBtn.textContent = '비밀번호 변경';
  form.appendChild(submitBtn);
  container.appendChild(form);

  function validatePassword(pw) {
    if (pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
    const hasLetter = /[A-Za-z]/.test(pw);
    const hasDigit = /[0-9]/.test(pw);
    const hasSpecial = /[^A-Za-z0-9]/.test(pw);
    if (!(hasLetter && hasDigit && hasSpecial)) return '영문, 숫자, 특수문자를 모두 포함해주세요.';
    return null;
  }

  submitBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const current = currentInput.value;
    const next = newInput.value;
    const confirm = confirmInput.value;
    if (!current) { errorEl.textContent = '현재 비밀번호를 입력해주세요.'; return; }
    if (!next) { errorEl.textContent = '새 비밀번호를 입력해주세요.'; return; }
    if (!confirm) { errorEl.textContent = '새 비밀번호 확인을 입력해주세요.'; return; }
    const policyError = validatePassword(next);
    if (policyError) { errorEl.textContent = policyError; return; }
    if (next !== confirm) { errorEl.textContent = '새 비밀번호와 확인이 일치하지 않습니다.'; return; }
    if (next === current) { errorEl.textContent = '기존 비밀번호와 다른 비밀번호를 사용해주세요.'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '변경 중...';
    try {
      const result = await changePassword(current, next);
      if (!result.success) {
        errorEl.textContent = result.message;
        // STEP16.11: 계정이 잠긴 경우, 잠금이 풀릴 때까지 다시 시도해도 서버 잠금 체크에서
        // 매번 막히므로(추가 실패 카운트는 쌓이지 않는다) 버튼도 잠가 화면상으로 즉시 알 수
        // 있게 한다 — 다시 열면(뒤로가기 후 재진입) 정상적으로 다시 시도할 수 있다.
        if (result.locked) {
          currentInput.value = '';
          submitBtn.disabled = true;
          submitBtn.textContent = '계정 잠김';
          return;
        }
        submitBtn.disabled = false;
        submitBtn.textContent = '비밀번호 변경';
        return;
      }
      currentInput.value = ''; newInput.value = ''; confirmInput.value = '';
      errorEl.classList.add('settings-success-text');
      errorEl.textContent = '비밀번호가 변경되었습니다.';
      submitBtn.disabled = false;
      submitBtn.textContent = '비밀번호 변경';
    } catch (err) {
      console.error('비밀번호 변경 실패:', err);
      errorEl.textContent = '비밀번호 변경 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      submitBtn.disabled = false;
      submitBtn.textContent = '비밀번호 변경';
    }
  });
}

// ============================================================
// C. 알림 설정
// ============================================================
// AUDIT 결과(완료 보고 §9 참고): 이 프로젝트에는 실제 Web Push 인프라(Service Worker push
// 이벤트 핸들러, VAPID 키, push subscription 저장, 발송 서버/Edge Function)가 전혀 없다
// (sw.js에 'push'/'notificationclick' 리스너 자체가 없음, 확인됨). 그래서 아래 토글들은
// "설정값 저장"까지만 하고 실제 알림 발송과는 연결하지 않는다 — TARGET UI만 보고 없는
// 시스템을 있는 것처럼 구현하지 않는다(§23/§24 원칙).
export function renderNotificationSettingsPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const { header, backBtn } = buildSettingsSubHeader('알림 설정');
  backBtn.addEventListener('click', () => { document.getElementById(containerId).style.display = 'none'; });
  container.appendChild(header);

  const subtitle = document.createElement('p');
  subtitle.className = 'sv-mobile-subtitle';
  subtitle.style.padding = '0 16px 12px';
  subtitle.textContent = '필요한 업무 알림을 설정합니다.';
  container.appendChild(subtitle);

  // F1(STEP16.35): 위 주석대로 실제 푸시 발송 인프라가 없어 아래 토글은 설정값 저장까지만
  // 한다. 이 사실을 화면에서 안내하지 않으면 사용자가 "설정했으니 알림이 올 것"으로 오해할
  // 수 있어, 비밀번호 변경 화면과 동일한 안내 카드 컴포넌트로 명확히 표시한다.
  const pushNoticeCard = document.createElement('div');
  pushNoticeCard.className = 'settings-notice-card';
  pushNoticeCard.appendChild(buildMobileMoreIcon('info'));
  const pushNoticeText = document.createElement('span');
  pushNoticeText.textContent = '아래 설정은 이 기기에만 저장되며, 실제 알림 발송 기능은 아직 준비 중입니다.';
  pushNoticeCard.appendChild(pushNoticeText);
  container.appendChild(pushNoticeCard);

  const settings = loadNotificationSettings();
  const admin = isAdmin();

  // 전체 알림 마스터 토글 — §27: 끄면 하위 항목을 시각적으로만 비활성화하고, 저장된 값 자체는
  // 그대로 둔다(다시 켜면 이전 선택이 복원되어야 하므로 하위 값을 지우지 않는다).
  const allToggle = buildSettingsToggle(settings.all, (checked) => {
    saveNotificationSettings({ all: checked });
    renderNotificationSettingsPanel(containerId);
  });
  const allCard = buildSettingsCard('bell', '', [
    { icon: 'bell', title: '전체 알림', desc: '산업안전 순찰지도의 모든 알림을 받습니다.', control: allToggle },
  ]);
  allCard.querySelector('.settings-card-title').remove(); // 이 카드는 TARGET처럼 제목줄 없이 단일 row만 표시.
  container.appendChild(allCard);

  const disabled = !settings.all;

  const ADVANCE_LABEL = { 0: '당일', 1: '1일 전', 2: '2일 전', 3: '3일 전' };
  const advanceBtn = buildSettingsValueBtn(ADVANCE_LABEL[settings.supervisionAdvanceDays] || '1일 전', () => {
    if (disabled) return;
    openSettingsOptionSheet('감독일정 사전 알림', [
      { value: 0, label: '당일' }, { value: 1, label: '1일 전' }, { value: 2, label: '2일 전' }, { value: 3, label: '3일 전' },
    ], settings.supervisionAdvanceDays, (value) => {
      saveNotificationSettings({ supervisionAdvanceDays: value });
      renderNotificationSettingsPanel(containerId);
    });
  });

  const workRows = [
    { icon: 'calendar', title: '감독일정 알림', desc: '예정된 감독일정을 알려드립니다.', disabled, control: buildSettingsToggle(settings.supervision, (c) => saveNotificationSettings({ supervision: c }), disabled) },
    { icon: 'clock', title: '감독일정 사전 알림', desc: '감독일정 전에 미리 알려드립니다.', disabled, control: advanceBtn },
  ];
  // §28: role을 하드코딩하지 않고 isAdmin()(profile.role 기반)으로만 노출 여부를 결정한다.
  // 일반 사용자에게는 관리자 전용 설정 자체를 아예 보여주지 않는다(§20 "불필요한 관리자 설정은
  // 표시하지 않는 방향을 우선").
  if (admin) {
    workRows.push({ icon: 'users', title: '회원 승인 알림', badge: '관리자', desc: '신규 회원 승인 요청을 알려드립니다.', disabled, control: buildSettingsToggle(settings.memberApproval, (c) => saveNotificationSettings({ memberApproval: c }), disabled) });
  }
  container.appendChild(buildSettingsCard('briefcase', '업무 알림', workRows));

  container.appendChild(buildSettingsCard('gear', '시스템 알림', [
    { icon: 'megaphone', title: '공지사항', desc: '중요한 서비스 안내를 알려드립니다.', disabled, control: buildSettingsToggle(settings.announcement, (c) => saveNotificationSettings({ announcement: c }), disabled) },
    { icon: 'database', title: '데이터 처리 알림', desc: '사업장 데이터 업로드 및 처리 결과를 알려드립니다.', disabled, control: buildSettingsToggle(settings.dataProcessing, (c) => saveNotificationSettings({ dataProcessing: c }), disabled) },
  ]));

  // §26: OS 알림 권한. 실제로 존재하는 Notification API 상태만 읽고, 없는 deep-link를
  // 만들지 않는다 — "브라우저/기기 설정에서 직접 허용해주세요" 안내 텍스트로 대체.
  const permCard = document.createElement('div');
  permCard.className = 'settings-notice-card settings-notice-card-column';
  const permHeader = document.createElement('div');
  permHeader.className = 'settings-notice-card-header';
  permHeader.appendChild(buildMobileMoreIcon('info'));
  const permTitle = document.createElement('span');
  permTitle.textContent = '알림 안내';
  permHeader.appendChild(permTitle);
  permCard.appendChild(permHeader);
  const permText = document.createElement('p');
  permText.textContent = '기기의 알림 권한이 꺼져 있으면 앱에서 알림을 설정해도 알림을 받을 수 없습니다.';
  permCard.appendChild(permText);

  const permBtn = document.createElement('button');
  permBtn.type = 'button';
  permBtn.className = 'settings-value-btn settings-permission-btn';
  const supportsNotification = typeof window !== 'undefined' && 'Notification' in window;
  function permLabel() {
    if (!supportsNotification) return '이 브라우저는 알림을 지원하지 않습니다';
    if (Notification.permission === 'granted') return '허용됨';
    if (Notification.permission === 'denied') return '기기 설정에서 직접 허용해주세요';
    return '기기 알림 설정 확인';
  }
  const permBtnLabel = document.createElement('span');
  permBtnLabel.textContent = permLabel();
  permBtn.appendChild(permBtnLabel);
  if (supportsNotification && Notification.permission !== 'denied') permBtn.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  permBtn.disabled = !supportsNotification || Notification.permission === 'denied';
  permBtn.addEventListener('click', async () => {
    if (!supportsNotification || Notification.permission !== 'default') return;
    try {
      await Notification.requestPermission();
    } catch (e) { /* 무시 — 브라우저가 권한 요청 자체를 지원하지 않는 경우 */ }
    permBtnLabel.textContent = permLabel();
  });
  permCard.appendChild(permBtn);
  container.appendChild(permCard);
}

// STEP16.5 후속(더보기 화면 정비): 첨부 TARGET 이미지를 기준으로 재구성한다.
// - PROFILE CARD: 실제 gnmap_v2_profiles 데이터(name/email/role)만 사용한다. DB에 기관/부서
//   컬럼이 없으므로 TARGET의 "서울지방고용노동청/산업안전과" 같은 소속 2줄은 만들지 않고,
//   기존 회원관리 화면과 동일하게 name("{지청} {실명}")에서 지청만 표시용으로 분리해 1줄만 보여준다.
//   STEP16.10: 카드를 누르면 "내 정보 관리"(#account-info-panel, 읽기전용 계정 정보) 화면으로
//   들어간다 — 더보기 목록에 있던 정적 "내 정보 관리" 행은 이 카드가 대신하므로 제거했다.
// - 계정/설정 카드(앱 설정/비밀번호 변경/알림 설정)는 실제 화면과 연결되며, 아직 실제 기능이
//   없는 항목만 클릭 핸들러 없는 정적 행으로 표시한다.
// - TARGET에 있던 도움말 카드(이용 가이드/자주 묻는 질문/문의하기)는 사용자 최종 지시에 따라
//   미구현 표시조차 하지 않고 DOM에서 완전히 제거했다(새 FAQ/문의/가이드 기능 신규 구현 없음).
//   그 결과 비는 자리에는 관리자 메뉴 카드를 배치해 정보 구조를 프로필 → 기본 설정 → 관리자
//   기능(admin only) → 앱 정보/로그아웃 순으로 재구성했다.
// - 관리자 메뉴 카드(회원관리/사업장 데이터 관리)는 기존 그대로 유지한다(admin만 노출, 기존
//   #btn-admin-panel/#btn-upload-panel 클릭 위임 그대로).
// - "감독일정관리" 항목은 프로필 카드 바로 아래 단독 그룹으로 표시하며, 기존 헤더 벨
//   (#mobile-header-alert-btn, activateMobileTab('alert') 호출)과 완전히 동일한 진입점을
//   재사용한다(새 로직 없음). supervision-panel/데이터/RPC는 전혀 건드리지 않는다.
// - 버전 정보는 TARGET의 "v1.0.0"을 하드코딩하지 않고 CONFIG.APP_VERSION(config.js, sw.js의
//   CACHE_VERSION과 동일한 값)을 그대로 표시한다.
// - 로그아웃은 기존 #logout-approved 클릭 위임 그대로 재사용한다(새 handler 없음).
export function renderMobileMoreMenu(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const profile = state.profile;
  const admin = isAdmin();
  const { org: profileOrg, name: profileName } = splitOrgName(profile ? profile.name : '');

  // PROFILE CARD — STEP16.10: 더보기 목록의 정적 "내 정보 관리" 행을 없애는 대신, 이 카드를
  // 눌러 같은 화면(#account-info-panel)으로 들어가게 한다(button으로 변경).
  const profileCard = document.createElement('button');
  profileCard.type = 'button';
  profileCard.className = 'mobile-more-profile';
  profileCard.addEventListener('click', () => openMobileOnlyPanel('account-info-panel', renderAccountInfoPanel));

  const avatar = document.createElement('div');
  avatar.className = 'mobile-more-avatar';
  avatar.appendChild(buildMobileMoreIcon('user'));
  profileCard.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'mobile-more-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'mobile-more-name';
  nameEl.textContent = profile ? displayValue(profileName || profile.name) : '-';
  if (admin) {
    const badge = document.createElement('span');
    badge.className = 'mobile-more-admin-badge';
    badge.textContent = '관리자';
    nameEl.appendChild(badge);
  }
  info.appendChild(nameEl);

  // 지청(소속) — 회원가입 시 입력한 값을 name에서 그대로 분리한 것으로, 별도 컬럼이나 부서
  // 정보를 새로 만들지 않는다. 지청 값이 없으면(예: 초기 시드 관리자) 이 줄 자체를 생략한다.
  if (profileOrg) {
    const orgEl = document.createElement('div');
    orgEl.className = 'mobile-more-org';
    orgEl.textContent = profileOrg;
    info.appendChild(orgEl);
  }
  profileCard.appendChild(info);

  const profileChevron = document.createElement('span');
  profileChevron.className = 'mobile-more-item-chevron';
  profileChevron.appendChild(buildMobileMoreIcon('chevron'));
  profileCard.appendChild(profileChevron);

  container.appendChild(profileCard);

  // 그룹(카드) 렌더러. item.onClick이 없는 항목은 클릭 핸들러 없는 정적 행으로 그린다
  // (아직 실제 기능이 없는 미구현 메뉴 — fake 동작을 넣지 않는다).
  // item.value가 있으면 chevron 대신 우측에 값을 텍스트로 보여준다(예: 버전 정보).
  function addMenuCard(title, items) {
    if (!items || items.length === 0) return;

    if (title) {
      const groupTitle = document.createElement('div');
      groupTitle.className = 'mobile-more-group-title';
      groupTitle.textContent = title;
      container.appendChild(groupTitle);
    }

    const group = document.createElement('div');
    group.className = 'mobile-more-menu';

    items.forEach(item => {
      const interactive = typeof item.onClick === 'function';
      const row = document.createElement(interactive ? 'button' : 'div');
      if (interactive) row.type = 'button';
      row.className = 'mobile-more-item'
        + (item.danger ? ' mobile-more-item-danger' : '')
        + (interactive ? '' : ' mobile-more-item-static');

      const iconWrap = document.createElement('span');
      iconWrap.className = 'mobile-more-item-icon';
      iconWrap.appendChild(buildMobileMoreIcon(item.icon));
      row.appendChild(iconWrap);

      const labelEl = document.createElement('span');
      labelEl.className = 'mobile-more-item-label';
      labelEl.textContent = item.label;
      row.appendChild(labelEl);

      if (item.value !== undefined) {
        const valueEl = document.createElement('span');
        valueEl.className = 'mobile-more-item-value';
        valueEl.textContent = item.value;
        row.appendChild(valueEl);
      } else if (!item.danger) {
        // 로그아웃은 다음 화면으로 "들어가는" 항목이 아니라 즉시 실행되는 동작이라
        // drill-down을 뜻하는 chevron(>)을 붙이지 않는다.
        const chevronWrap = document.createElement('span');
        chevronWrap.className = 'mobile-more-item-chevron';
        chevronWrap.appendChild(buildMobileMoreIcon('chevron'));
        row.appendChild(chevronWrap);
      }

      if (interactive) row.addEventListener('click', item.onClick);
      group.appendChild(row);
    });

    container.appendChild(group);
  }

  // 사용자 요청: 감독일정관리 + 현장 메모를 관리자 메뉴와 동일한 방식(제목 있는 그룹)으로
  // "점검 관리" 아래 한데 묶는다. 감독일정관리는 기존 헤더 벨(#mobile-header-alert-btn,
  // activateMobileTab('alert'))과 동일한 진입점을 위임하고, 현장 메모는 gnmap_v2_site_notes/
  // notes.js CRUD를 그대로 쓰는 통합 화면을 연다(둘 다 기존 로직 그대로, 그룹 묶음만 변경).
  addMenuCard('점검 관리', [
    { label: '감독일정 관리', icon: 'calendar', onClick: () => document.getElementById('mobile-header-alert-btn').click() },
    { label: '현장 메모', icon: 'doc', onClick: () => openSiteNotesPanel() },
  ]);

  // STEP16.6: 앱 설정/비밀번호 변경/알림 설정 3개는 실제 화면과 연결한다(§6). admin/upload
  // 패널과 동일하게 "더보기" 탭(data-mobile-tab="more")에 머무른 채 display만 토글하고,
  // 열 때마다 해당 render 함수를 새로 호출한다(PC 화면이 없는 모바일 전용 신규 패널이라
  // btn-admin-panel처럼 위임할 기존 PC 버튼이 없다 — 여기서 직접 열고 그린다).
  // STEP16.10: "내 정보 관리"는 정적 행에서 빠지고, 위 프로필 카드를 누르면 바로 열린다.
  function openMobileOnlyPanel(panelId, renderFn) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.style.display = 'block';
    renderFn(panelId);
  }
  addMenuCard('기타 설정', [
    { label: '앱 설정', icon: 'gear', onClick: () => openMobileOnlyPanel('app-settings-panel', renderAppSettingsPanel) },
    { label: '비밀번호 변경', icon: 'lock', onClick: () => openMobileOnlyPanel('password-change-panel', renderPasswordChangePanel) },
    { label: '알림 설정', icon: 'bell', onClick: () => openMobileOnlyPanel('notification-settings-panel', renderNotificationSettingsPanel) },
  ]);

  // 관리자 메뉴 — 기존 회원관리/사업장 데이터 관리 진입점을 그대로 유지한다(admin만 노출).
  addMenuCard('관리자 메뉴', admin ? [
    { label: '회원관리', icon: 'user', onClick: () => document.getElementById('btn-admin-panel').click() },
    { label: '사업장 데이터 관리', icon: 'upload', onClick: () => document.getElementById('btn-upload-panel').click() },
  ] : []);

  // 앱 정보 — 버전 정보(실제 CONFIG.APP_VERSION 값) + 로그아웃(기존 그대로).
  addMenuCard(null, [
    { label: '버전 정보', icon: 'info', value: CONFIG.APP_VERSION },
    { label: '로그아웃', icon: 'logout', danger: true, onClick: () => document.getElementById('logout-approved').click() },
  ]);
}

// STEP16.10: "내 정보 관리" — 더보기 목록의 정적(미구현) 행을 없애고, 상단 프로필 카드를
// 누르면 열리는 화면으로 바꾼다. gnmap_v2_profiles에 실제로 존재하는 값(name/email/role)만
// 읽기전용으로 보여준다 — 이름/이메일을 직접 수정하는 기능은 이 프로젝트에 없으므로 새로
// 만들지 않는다(비밀번호만 별도의 "비밀번호 변경" 화면에서 이미 실제로 변경 가능).
export function renderAccountInfoPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const { header, backBtn } = buildSettingsSubHeader('내 정보 관리');
  backBtn.addEventListener('click', () => { document.getElementById(containerId).style.display = 'none'; });
  container.appendChild(header);

  const subtitle = document.createElement('p');
  subtitle.className = 'sv-mobile-subtitle';
  subtitle.style.padding = '0 16px 12px';
  subtitle.textContent = '등록된 계정 정보를 확인합니다.';
  container.appendChild(subtitle);

  const profile = state.profile;
  const { org: profileOrg, name: profileName } = splitOrgName(profile ? profile.name : '');

  const rows = [
    { icon: 'user', title: '이름', desc: profile ? displayValue(profileName || profile.name) : '-' },
  ];
  if (profileOrg) rows.push({ icon: 'briefcase', title: '소속', desc: profileOrg });
  rows.push({ icon: 'info', title: '아이디', desc: profile ? displayValue(profile.email) : '-' });
  // STEP16.31: 마스터관리자/관리자/사용자 3단계로 표시.
  rows.push({ icon: 'users', title: '권한', desc: profile ? adminRoleLabel(profile.role) : '-' });

  container.appendChild(buildSettingsCard('user', '계정 정보', rows));
}

let searchDebounceTimer = null;
let searchSortEventsbound = false;
let addressSearchDebounceTimer = null;
let addressSearchToken = 0;

// ============================================================
// STEP16.28-2: 검색창에 등록된 사업장뿐 아니라 일반 주소/장소도 검색되게 한다.
// map.js의 searchPlacesKeyword(kakao.maps.services.Places, JS SDK 공개 키만 사용 — REST Key
// 불필요)를 그대로 호출해 #site-list(등록 사업장 결과) 아래 별도 섹션에 보여준다. 각 결과에는
// "주소복사"/"길찾기" 버튼만 붙이고, 사업장 데이터(gnmap_v2_sites)에는 전혀 저장/반영하지 않는다
// (순수 조회/편의 기능).
// ============================================================
function renderAddressSearchResults(query) {
  const container = document.getElementById('site-address-search-results');
  if (!container) return;
  clearTimeout(addressSearchDebounceTimer);
  // STEP16.32: "현장/업체명" 모드에서는 주소/장소 검색을 아예 실행하지 않는다(등록 사업장
  // 검색과 결과가 섞여 보이는 것을 막기 위한 명시적 모드 분리).
  if (state.siteSearchMode !== 'address') {
    container.innerHTML = '';
    clearAddressSearchPin();
    return;
  }
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) {
    container.innerHTML = '';
    clearAddressSearchPin(); // 검색어를 지우면 지도 위 임시 핀도 함께 치운다.
    return;
  }
  const myToken = ++addressSearchToken;
  addressSearchDebounceTimer = setTimeout(async () => {
    let results = [];
    try {
      results = await searchPlacesKeyword(trimmed);
    } catch (err) {
      console.warn('[주소 검색] 실패:', err);
    }
    if (myToken !== addressSearchToken) return; // 그 사이 검색어가 바뀌었으면 이 결과는 버린다(경쟁 상태 방지).
    container.innerHTML = '';
    if (!results || results.length === 0) return;

    const heading = document.createElement('div');
    heading.className = 'address-search-results-heading';
    heading.textContent = '주소/장소 검색 결과';
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'address-search-results-list';
    results.slice(0, 8).forEach(r => {
      const item = document.createElement('div');
      item.className = 'address-search-result-item';
      // 사용자 요청: 검색 결과를 누르면 지도에 핀으로 위치를 표시한다. 등록 사업장이 아니라
      // 순수 조회용 임시 핀이며(map.js showAddressSearchPin, 클러스터러 밖에 직접 부착),
      // DB에는 저장하지 않는다.
      item.addEventListener('click', () => {
        showAddressSearchPin(r.lat, r.lng);
      });

      const nameEl = document.createElement('div');
      nameEl.className = 'address-search-result-name';
      nameEl.textContent = r.name;
      item.appendChild(nameEl);

      const addrText = r.roadAddress || r.address || '-';
      const addrEl = document.createElement('div');
      addrEl.className = 'address-search-result-address';
      addrEl.textContent = addrText;
      item.appendChild(addrEl);

      const actions = document.createElement('div');
      actions.className = 'address-search-result-actions';
      actions.addEventListener('click', (e) => e.stopPropagation()); // 버튼 클릭이 item의 핀 표시 클릭과 중복 실행되지 않게 한다(둘 다 실행돼도 무해하지만 불필요).

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'address-search-result-btn';
      copyBtn.textContent = '주소복사';
      copyBtn.addEventListener('click', async () => {
        const text = addrText !== '-' ? addrText : r.name;
        const original = copyBtn.textContent;
        const showResult = (ok) => {
          copyBtn.textContent = ok ? '복사됨' : '실패';
          copyBtn.disabled = true;
          setTimeout(() => { copyBtn.textContent = original; copyBtn.disabled = false; }, 1400);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
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
      actions.appendChild(copyBtn);

      const dirBtn = document.createElement('button');
      dirBtn.type = 'button';
      dirBtn.className = 'address-search-result-btn address-search-result-btn-primary';
      dirBtn.textContent = '길찾기';
      dirBtn.addEventListener('click', () => {
        const url = buildKakaoDirectionsUrl(r.name, r.lat, r.lng);
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      actions.appendChild(dirBtn);

      item.appendChild(actions);
      list.appendChild(item);
    });
    container.appendChild(list);
  }, 350);
}

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
// neutralValue: "필터 없음"에 해당하는 값(강조색 표시 기준). 관할/금액/점검/산재표는 'all'이지만,
// 정렬(sortMode)은 기존 로직(js/sites.js getFilteredSortedSites)이 'default'를 기준값으로 쓰므로
// 호출부에서 'default'를 넘길 수 있게 한다(생략하면 기존과 동일하게 'all').
function bindRadioFilterDetails(detailsId, stateKey, containerId, labels, neutralValue = 'all') {
  const detailsEl = document.getElementById(detailsId);
  if (!detailsEl) return;
  const labelEl = document.getElementById(`${detailsId}-label`);
  const panel = document.getElementById(`${detailsId}-panel`);
  if (!labelEl) return;

  function updateLabel() {
    const value = state[stateKey] || neutralValue;
    labelEl.textContent = labels[value] || labels[neutralValue];
    detailsEl.dataset.active = String(value !== neutralValue);
  }

  // 사용자 피드백: 실제 모바일 기기에서 이 summary를 탭해도 패널이 전혀 열리지 않는 경우가
  // 보고됐다. summary를 pill 버튼처럼 보이게 하려고 display/appearance를 덮어썼는데(css/
  // mobile.css), 일부 모바일 브라우저/웹뷰는 <summary>의 기본 display가 바뀌면 네이티브
  // 클릭-토글 동작 자체가 깨지는 경우가 있다(같은 줄의 일반 <button>인 "즐겨찾기"는 항상
  // 반응하는데 <details> 필터들만 반응이 없었던 것과 일치). 그래서 네이티브 토글에 기대지
  // 않고 summary의 기본 동작을 막은 뒤 detailsEl.open을 직접 켜고 끈다 — 모든 브라우저에서
  // 동일하게 동작한다. open을 스크립트로 바꿔도 'toggle' 이벤트는 그대로 발생하므로 아래
  // 위치 계산 로직은 손대지 않아도 된다.
  labelEl.addEventListener('click', (e) => {
    e.preventDefault();
    detailsEl.open = !detailsEl.open;
  });

  detailsEl.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.checked = radio.value === (state[stateKey] || neutralValue);
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

// 사용자 요청: 모바일 "즐겨찾기" 탭 내부 탭(즐겨찾기 현장/메모 있는 현장) 전환 — state 값과
// 버튼 활성 표시(.active)를 함께 맞춘다. app.js의 activateMobileTab(탭 진입 시 'favorites'로
// 초기화)과 아래 bindSearchAndSort(버튼 클릭 시 전환)가 공통으로 재사용한다.
export function setFavoriteTabView(view) {
  state.favoriteTabView = view;
  const favBtn = document.getElementById('favorite-subtab-favorites');
  const notesBtn = document.getElementById('favorite-subtab-notes');
  if (favBtn) favBtn.classList.toggle('active', view !== 'notes');
  if (notesBtn) notesBtn.classList.toggle('active', view === 'notes');
}

const SEARCH_MODE_PLACEHOLDER = {
  site: '사업장명, 업체명, 주소, 동으로 검색',
  address: '주소 또는 장소명으로 검색',
};

// STEP16.33: "현장/업체명" ↔ "주소/장소명" 검색 모드 전환을 한 곳에서 처리한다. 사용자가
// #site-search-mode-filter 드롭다운에서 고를 때뿐 아니라, "현장" 탭에 들어올 때 강제로
// "현장/업체명"으로 되돌리는 경우(js/app.js activateMobileTab)에도 이 함수만 호출하면 된다.
// 겉표시 pill 라벨은 사용자 요청대로 선택값과 무관하게 항상 "검색모드"로 고정한다(다른
// 필터처럼 선택값 텍스트로 바뀌지 않음) — dataset.active만 기본값(현장/업체명)이 아닐 때 켠다.
export function setSiteSearchMode(mode, containerId = 'site-list') {
  const normalized = mode === 'address' ? 'address' : 'site';
  if (state.siteSearchMode === normalized) return;
  state.siteSearchMode = normalized;

  const detailsEl = document.getElementById('site-search-mode-filter');
  if (detailsEl) {
    detailsEl.dataset.active = String(normalized !== 'site');
    detailsEl.querySelectorAll('input[type="radio"]').forEach(r => { r.checked = r.value === normalized; });
  }
  const searchInput = document.getElementById('site-search-input');
  if (searchInput) searchInput.placeholder = SEARCH_MODE_PLACEHOLDER[normalized];
  renderSiteList(containerId);
  renderAddressSearchResults(searchInput ? searchInput.value : '');
}

// 검색 input/관할(다중선택)/금액/정렬/점검/산재표/즐겨찾기 이벤트를 1회만 바인딩한다
// (중복 등록 방지 플래그). 검색은 200ms debounce, 나머지는 즉시 반영. 모두 state 값만
// 갱신하고 렌더는 renderSiteList가 담당한다.
export function bindSearchAndSort(containerId) {
  if (searchSortEventsbound) return;
  searchSortEventsbound = true;

  const searchInput = document.getElementById('site-search-input');
  const dongFilterEl = document.getElementById('site-dong-filter');

  // STEP16.33: 검색모드 드롭다운 — 관할/공사금액 등과 같은 <details> pill이지만, 라벨은
  // 선택값과 무관하게 항상 "검색모드"로 고정되고(bindRadioFilterDetails 미사용 이유), 값이
  // 바뀌면 검색창 placeholder/등록 사업장 목록/주소 검색 결과를 함께 갱신해야 해 setSiteSearchMode()를
  // 직접 호출한다.
  const searchModeDetailsEl = document.getElementById('site-search-mode-filter');
  const searchModeLabelEl = document.getElementById('site-search-mode-filter-label');
  if (searchModeDetailsEl && searchModeLabelEl) {
    searchModeDetailsEl.dataset.active = String(state.siteSearchMode === 'address');
    searchModeLabelEl.addEventListener('click', (e) => {
      e.preventDefault();
      searchModeDetailsEl.open = !searchModeDetailsEl.open;
    });
    searchModeDetailsEl.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.checked = radio.value === (state.siteSearchMode === 'address' ? 'address' : 'site');
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        setSiteSearchMode(radio.value, containerId);
        searchModeDetailsEl.open = false;
      });
    });
    document.addEventListener('click', (e) => {
      if (searchModeDetailsEl.open && !searchModeDetailsEl.contains(e.target)) {
        searchModeDetailsEl.open = false;
      }
    });
    const searchModePanel = document.getElementById('site-search-mode-filter-panel');
    if (searchModePanel) {
      searchModeDetailsEl.addEventListener('toggle', () => {
        if (!searchModeDetailsEl.open) return;
        const rect = searchModeDetailsEl.getBoundingClientRect();
        searchModePanel.style.top = `${Math.round(rect.bottom + 6)}px`;
        searchModePanel.style.left = `${Math.round(rect.left)}px`;
      });
    }
  }
  const dongFilterClearBtn = document.getElementById('site-dong-filter-clear');
  const searchClearBtn = document.getElementById('site-search-clear-btn');
  const favoriteFilterBtn = document.getElementById('site-favorite-filter-btn');
  const favSubtabFavoritesBtn = document.getElementById('favorite-subtab-favorites');
  const favSubtabNotesBtn = document.getElementById('favorite-subtab-notes');

  setFavoriteTabView(state.favoriteTabView); // 최초 바인딩 시 버튼 활성 표시를 현재 state에 맞춘다.
  if (favSubtabFavoritesBtn) {
    favSubtabFavoritesBtn.addEventListener('click', () => {
      setFavoriteTabView('favorites');
      renderSiteList(containerId);
    });
  }
  if (favSubtabNotesBtn) {
    favSubtabNotesBtn.addEventListener('click', () => {
      setFavoriteTabView('notes');
      renderSiteList(containerId);
    });
  }

  searchInput.addEventListener('input', () => {
    if (searchClearBtn) searchClearBtn.style.display = searchInput.value ? 'inline-block' : 'none';
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.searchQuery = searchInput.value.trim();
      renderSiteList(containerId);
    }, 200);
    renderAddressSearchResults(searchInput.value); // 등록 사업장 검색과 별개로, 자체 디바운스로 주소/장소 검색도 함께 실행한다.
  });

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      clearTimeout(searchDebounceTimer);
      searchInput.value = '';
      state.searchQuery = '';
      searchClearBtn.style.display = 'none';
      renderSiteList(containerId); // 검색어만 비우고 관할/금액/점검/산재표/즐겨찾기/정렬은 그대로 유지된다.
      renderAddressSearchResults('');
    });
  }

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
    // 사용자 피드백: 실제 모바일 기기에서 "관할" summary를 탭해도 반응이 없었다 — pill
    // 스타일을 위해 summary의 display/appearance를 덮어쓴 게 일부 모바일 브라우저에서 네이티브
    // 클릭-토글을 깨뜨리는 것으로 보인다(bindRadioFilterDetails의 나머지 3개 필터와 동일한
    // 원인/동일한 수정). 네이티브 토글에 기대지 않고 직접 open을 켜고 끈다.
    const dongFilterLabelEl = document.getElementById('site-dong-filter-label');
    if (dongFilterLabelEl) {
      dongFilterLabelEl.addEventListener('click', (e) => {
        e.preventDefault();
        dongFilterEl.open = !dongFilterEl.open;
      });
    }

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
  // 사용자 요청: "기본순서" 정렬도 나머지 4개 필터와 동일한 details+radio 팝오버로 바꾼다 —
  // 기존 <select>는 브라우저가 선택된 값이 아니라 가장 긴 옵션 문자열 기준으로 폭을 잡아
  // "기본순서"처럼 짧은 라벨일 때도 불필요하게 넓어 보이는 문제가 있었다(관할/금액 등과 동일 원인).
  bindRadioFilterDetails('site-sort-filter', 'sortMode', containerId, {
    default: '기본순서',
    'name-asc': '사업장명 가나다순',
    'company-asc': '업체명 가나다순',
    'amount-desc': '공사금액 높은순',
    'amount-asc': '공사금액 낮은순',
    deadline: '공사기간 임박순',
    favorite: '즐겨찾기 우선',
  }, 'default');

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
// PC 화면(.admin-user-row, select+저장 버튼)은 STEP9 그대로 유지하고, STEP16.5에서는 같은
// 컨테이너 안에 모바일 전용 TARGET UI(.admin-mobile-view)를 추가로 그려 넣는다 — 두 마크업은
// 항상 함께 렌더링되고 css/mobile.css가 화면 폭에 따라 어느 쪽을 보일지만 결정한다(PC 로직 불변).
export async function renderAdminPanel(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  // STEP16.32: 더보기 하위 화면 상단 표시를 앱설정/비밀번호변경 등과 동일한 "‹ 타이틀"
  // 형식으로 통일한다 — 기존 floating 닫기 버튼(buildMobilePanelCloseBtn) + 별도 브랜드/벨
  // 헤더 대신, 모바일 전용 래퍼(renderAdminMobileHost의 .admin-mobile-view, PC에서는
  // css/mobile.css 기본값으로 항상 숨김) 안에 buildSettingsSubHeader를 넣는다.

  const msgEl = document.createElement('p');
  msgEl.id = 'admin-message';
  msgEl.textContent = state.adminMessage;
  container.appendChild(msgEl);

  // STEP16.5: 모바일 뷰가 데이터 로딩 중임을 보여줄 수 있도록, 네트워크 조회 전에 먼저
  // 로딩 상태로 한 번 그린다(PC는 이 블록이 기본 숨김 목록에 있어 영향 없음).
  const mobileHost = document.createElement('div');
  mobileHost.id = 'admin-mobile-host';
  container.appendChild(mobileHost);
  renderAdminMobileLoading(mobileHost);

  await loadUsers();

  renderAdminDesktopRows(container, state.adminUsers, containerId);
  renderAdminMobileHost(mobileHost, containerId);
}

// PC 전용 목록(select+저장 버튼) — STEP9 로직 그대로, 위치만 별도 함수로 추출했다.
function renderAdminDesktopRows(container, users, containerId) {
  const wrap = document.createElement('div');
  wrap.id = 'admin-desktop-rows';

  if (!users || users.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '표시할 회원이 없습니다.';
    wrap.appendChild(empty);
    container.appendChild(wrap);
    return;
  }

  const currentUserId = state.user ? state.user.id : null;

  users.forEach(u => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';

    const info = document.createElement('div');
    info.className = 'admin-user-info';
    [
      ['이름', u.name],
      ['역할', adminRoleLabel(u.role)],
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

    // 역할 select + 저장 버튼. STEP16.31: 3단계 권한 + "회원 권한 부여"는 마스터관리자 전용
    // (DB RPC gnmap_v2_set_user_role이 최종 검증 — 여기서는 UX 보조로 비활성화만 한다).
    const viewerIsMaster = isMaster();
    const roleSelect = document.createElement('select');
    ['user', 'admin', 'master'].forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = adminRoleLabel(r);
      if (r === u.role) opt.selected = true;
      // 자기 자신 보호: 본인 행에서는 역할 변경 불가(서버도 차단)
      if (isSelf) opt.disabled = true;
      roleSelect.appendChild(opt);
    });
    roleSelect.disabled = !viewerIsMaster || isSelf;

    const roleSaveBtn = document.createElement('button');
    roleSaveBtn.type = 'button';
    roleSaveBtn.textContent = '역할 저장';
    roleSaveBtn.disabled = !viewerIsMaster || isSelf;
    if (!viewerIsMaster) roleSaveBtn.title = '마스터관리자만 회원 역할을 변경할 수 있습니다.';
    roleSaveBtn.addEventListener('click', () =>
      handleAdminChange(u.id, () => setUserRole(u.id, roleSelect.value), containerId, [statusSaveBtn, roleSaveBtn])
    );

    row.appendChild(statusSelect);
    row.appendChild(statusSaveBtn);
    row.appendChild(roleSelect);
    row.appendChild(roleSaveBtn);

    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

// ============================================================
// STEP16.5 — 모바일 관리자 회원관리 TARGET UI.
// 기존 PC 기능(loadUsers/setUserStatus/setUserRole, STEP9 self-protection)만 재사용하고
// 새 RPC/스키마는 추가하지 않는다. state.adminUsers를 그대로 데이터 소스로 쓴다.
// ============================================================

const ADMIN_STATUS_META = {
  approved: { label: '승인완료', cls: 'approved' },
  pending: { label: '승인대기', cls: 'pending' },
  rejected: { label: '승인거절', cls: 'rejected' },
  disabled: { label: '휴면', cls: 'disabled' },
};

// STEP16.31: 3단계 권한 표시 라벨. PC/모바일 회원관리 화면 전체에서 공통으로 사용한다.
const ADMIN_ROLE_META = {
  master: { label: '마스터관리자' },
  admin: { label: '관리자' },
  user: { label: '사용자' },
};
function adminRoleLabel(role) {
  return (ADMIN_ROLE_META[role] || {}).label || displayValue(role);
}

// name 컬럼은 회원가입 화면(#signup-org)에서 고른 소속을 그대로 합쳐 "{지청} {실명}" 형태로
// 저장된다(예: "강남지청 임종빈") — 별도 지청 컬럼은 없다(실 데이터로 확인 완료). 지청 컬럼을
// 새로 만들지 않고, 첫 공백을 기준으로 표시용으로만 분리한다. 공백이 없으면(예: 이름 없이
// 만들어진 시드 관리자 계정) 지청 없이 이름만 있는 것으로 본다.
function splitOrgName(rawName) {
  const value = (rawName || '').trim();
  if (!value) return { org: '', name: '' };
  const idx = value.indexOf(' ');
  if (idx === -1) return { org: '', name: value };
  return { org: value.slice(0, idx).trim(), name: value.slice(idx + 1).trim() };
}

// "계정"에는 실제 로그인 아이디만 보여준다 — "@" 이후 도메인은 아예 표시하지 않고, V1/V2
// 네임스페이스 충돌 방지용 내부 태그("+v2", toAuthEmail() 참고)도 사용자에게는 무의미하므로
// 함께 제거한다(요청: "+v2@**"까지 안 보였으면 함).
function maskEmailDomain(rawEmail) {
  const value = (rawEmail || '').trim();
  if (!value) return displayValue(value);
  const at = value.indexOf('@');
  let local = at === -1 ? value : value.slice(0, at);
  local = local.replace(/\+v2$/i, '');
  return local || displayValue(value);
}

// created_at(timestamptz) -> "YYYY. MM. DD." 표시 전용 포매터. 실제 값이 없으면 '-'.
function formatAdminDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}. ${mm}. ${dd}.`;
}

function getAdminCounts(users) {
  const list = users || [];
  return {
    all: list.length,
    pending: list.filter(u => u.status === 'pending').length,
    approved: list.filter(u => u.status === 'approved').length,
  };
}

// 현재 탭(state.adminMobileFilter) + 검색어(state.adminMobileQuery, 이름/이메일 대소문자 무관 부분일치)를
// 동시에 적용한다. "전체" 탭은 rejected/disabled를 포함한 전체 회원을 보여준다(요청사항 8).
function getFilteredAdminUsers(users) {
  const list = users || [];
  const filter = state.adminMobileFilter || 'all';
  const query = (state.adminMobileQuery || '').trim().toLowerCase();

  return list.filter(u => {
    if (filter === 'pending' && u.status !== 'pending') return false;
    if (filter === 'approved' && u.status !== 'approved') return false;
    if (!query) return true;
    const name = (u.name || '').toLowerCase();
    const email = (u.email || '').toLowerCase();
    return name.includes(query) || email.includes(query);
  });
}

function buildAdminSvg(pathsMarkup, viewBox) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox || '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.insertAdjacentHTML('beforeend', pathsMarkup);
  return svg;
}

function renderAdminMobileLoading(host) {
  host.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'admin-mobile-view';
  const loading = document.createElement('p');
  loading.className = 'admin-mobile-state-msg';
  loading.textContent = '회원 정보를 불러오는 중...';
  view.appendChild(loading);
  host.appendChild(view);
}

// 데이터 로딩이 끝난 뒤 mobileHost 안에 TARGET UI 전체를 그린다. 탭/검색 변경, 조치(승인 등) 후
// 재조회 없이 다시 부를 수 있도록(state.adminUsers를 그대로 다시 읽음) 매번 전체를 재구성한다.
function renderAdminMobileHost(host, containerId) {
  host.innerHTML = '';

  const view = document.createElement('div');
  view.className = 'admin-mobile-view';

  // STEP16.32: 앱설정/비밀번호변경 등과 동일한 "‹ 회원관리" 상단 표시로 통일한다.
  const { header: subHeader, backBtn } = buildSettingsSubHeader('회원관리');
  backBtn.addEventListener('click', () => {
    const panel = document.getElementById(containerId);
    if (panel) panel.style.display = 'none';
  });
  view.appendChild(subHeader);

  const desc = document.createElement('p');
  desc.className = 'sv-mobile-subtitle';
  desc.style.padding = '0 16px 12px';
  desc.textContent = '산업안전 순찰지도를 이용하는 사용자를 관리합니다.';
  view.appendChild(desc);

  if (state.adminLoadError) {
    const errWrap = document.createElement('div');
    errWrap.className = 'admin-mobile-state';
    const errMsg = document.createElement('p');
    errMsg.className = 'admin-mobile-state-msg';
    errMsg.textContent = '회원 정보를 불러오지 못했습니다.';
    errWrap.appendChild(errMsg);
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'admin-mobile-retry-btn';
    retryBtn.textContent = '다시 시도';
    retryBtn.addEventListener('click', async () => {
      renderAdminMobileLoading(host);
      await loadUsers();
      // PC 목록(.admin-user-row)도 함께 다시 그려야 두 마크업이 어긋나지 않는다.
      const oldDesktop = document.getElementById('admin-desktop-rows');
      if (oldDesktop) oldDesktop.remove();
      renderAdminDesktopRows(document.getElementById(containerId), state.adminUsers, containerId);
      renderAdminMobileHost(host, containerId);
    });
    errWrap.appendChild(retryBtn);
    view.appendChild(errWrap);
    host.appendChild(view);
    return;
  }

  const counts = getAdminCounts(state.adminUsers);

  // 상태 탭 — 전체/승인대기/승인완료 3개(요청사항 7/9). 탭 전환은 네트워크 재조회 없이
  // state.adminMobileFilter만 바꾸고 목록만 다시 그린다.
  const tabs = document.createElement('div');
  tabs.className = 'admin-mobile-tabs';
  tabs.setAttribute('role', 'tablist');
  [
    ['all', `전체 (${counts.all})`],
    ['pending', `승인대기 (${counts.pending})`],
    ['approved', `승인완료 (${counts.approved})`],
  ].forEach(([key, label]) => {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = 'admin-mobile-tab' + (state.adminMobileFilter === key ? ' active' : '');
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-selected', String(state.adminMobileFilter === key));
    tabBtn.textContent = label;
    tabBtn.addEventListener('click', () => {
      state.adminMobileFilter = key;
      renderAdminMobileHost(host, containerId);
    });
    tabs.appendChild(tabBtn);
  });
  view.appendChild(tabs);

  // 검색창 — 이름/이메일 대상(요청사항 10/11). V2는 아이디 기반 로그인이지만 실제 계정
  // 식별자는 email 컬럼(합성 이메일 포함)이므로 "아이디"라고 쓰지 않는다. 소속 컬럼은
  // 스키마에 없으므로 문구에 넣지 않는다.
  const searchWrap = document.createElement('div');
  searchWrap.className = 'admin-mobile-search';
  searchWrap.appendChild(buildAdminSvg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.8-3.8"/>'));
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.setAttribute('aria-label', '회원 검색');
  searchInput.placeholder = '이름, 이메일을 검색하세요.';
  searchInput.value = state.adminMobileQuery || '';
  searchInput.addEventListener('input', () => {
    state.adminMobileQuery = searchInput.value;
    renderAdminMobileList(listEl, containerId);
  });
  searchWrap.appendChild(searchInput);
  view.appendChild(searchWrap);

  const listEl = document.createElement('div');
  listEl.className = 'admin-mobile-list';
  view.appendChild(listEl);
  renderAdminMobileList(listEl, containerId);

  host.appendChild(view);

  // 검색 입력 리스너(위)는 view 전체를 다시 그리지 않고 renderAdminMobileList(listEl, ...)만
  // 호출하므로, 매 키 입력마다 헤더/탭/검색창이 재생성되어 포커스가 끊기는 문제가 없다.
}

// 탭/검색 필터만 반영해 카드 목록 부분만 다시 그린다(헤더/탭/검색창은 유지 — 검색 중 포커스 유지).
function renderAdminMobileList(listEl, containerId) {
  listEl.innerHTML = '';
  const filtered = getFilteredAdminUsers(state.adminUsers);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'admin-mobile-empty';
    empty.appendChild(buildAdminSvg('<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5"/>', '0 0 24 24'));
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = (state.adminMobileQuery || '').trim()
      ? '검색 결과가 없습니다.'
      : (state.adminMobileFilter === 'pending' ? '승인 대기 중인 회원이 없습니다.' : '표시할 회원이 없습니다.');
    empty.appendChild(emptyMsg);
    listEl.appendChild(empty);
    return;
  }

  const currentUserId = state.user ? state.user.id : null;
  filtered.forEach(u => {
    listEl.appendChild(buildAdminMemberCard(u, currentUserId, listEl, containerId));
  });
}

function buildAdminMemberCard(u, currentUserId, listEl, containerId) {
  const card = document.createElement('div');
  card.className = 'admin-mobile-card';

  const avatar = document.createElement('div');
  avatar.className = 'admin-mobile-avatar';
  avatar.appendChild(buildAdminSvg('<circle cx="12" cy="8.2" r="3.4"/><path d="M5 19.2c0-3.9 3.13-7 7-7s7 3.1 7 7"/>'));
  card.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'admin-mobile-card-body';

  const { org, name } = splitOrgName(u.name);

  const row1 = document.createElement('div');
  row1.className = 'admin-mobile-card-row1';

  const nameWrap = document.createElement('span');
  nameWrap.className = 'admin-mobile-card-name';
  nameWrap.textContent = displayValue(name);
  if (u.role === 'admin' || u.role === 'master') {
    const roleBadge = document.createElement('span');
    roleBadge.className = 'admin-mobile-role-badge' + (u.role === 'master' ? ' admin-mobile-role-badge-master' : '');
    roleBadge.textContent = adminRoleLabel(u.role);
    nameWrap.appendChild(roleBadge);
  }
  row1.appendChild(nameWrap);

  const meta = ADMIN_STATUS_META[u.status] || { label: displayValue(u.status), cls: 'disabled' };
  const statusBadge = document.createElement('span');
  statusBadge.className = `admin-mobile-badge admin-mobile-badge-${meta.cls}`;
  statusBadge.textContent = meta.label;
  row1.appendChild(statusBadge);

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'admin-mobile-more-btn';
  moreBtn.setAttribute('aria-label', '회원 관리 메뉴');
  moreBtn.appendChild(buildAdminSvg('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>'));
  moreBtn.addEventListener('click', () => openAdminActionSheet(u, currentUserId, listEl, containerId));
  row1.appendChild(moreBtn);

  body.appendChild(row1);

  // row2: 계정(이메일, 도메인은 마스킹 — 요청사항)
  const row2 = document.createElement('div');
  row2.className = 'admin-mobile-card-row2';
  const emailEl = document.createElement('span');
  emailEl.className = 'admin-mobile-card-email';
  emailEl.textContent = `계정: ${maskEmailDomain(u.email)}`;
  row2.appendChild(emailEl);
  body.appendChild(row2);

  // row3: 지청(요청사항) + 가입일
  const row3 = document.createElement('div');
  row3.className = 'admin-mobile-card-row2';
  const orgEl = document.createElement('span');
  orgEl.className = 'admin-mobile-card-org';
  orgEl.textContent = `지청: ${org || '-'}`;
  row3.appendChild(orgEl);
  const dateEl = document.createElement('span');
  dateEl.className = 'admin-mobile-card-date';
  dateEl.textContent = formatAdminDate(u.created_at);
  row3.appendChild(dateEl);
  body.appendChild(row3);

  card.appendChild(body);
  return card;
}

// 상태별로 실제 지원되는 조치만 나열한다(요청사항 19~21). 전부 기존 setUserStatus(admin.js)
// -> gnmap_v2_set_user_status RPC만 호출하며, 새 client-side 상태 판단 로직을 추가하지 않는다.
function getAdminActionsForStatus(status, isSelf) {
  if (isSelf) return []; // STEP9 서버 보호와 별개로, 본인 행은 상태 변경 액션 자체를 보여주지 않는다.
  if (status === 'pending') {
    return [
      { key: 'approved', type: 'status', label: '승인완료', danger: false },
      { key: 'rejected', type: 'status', label: '승인거절', danger: true, confirm: '이 회원의 가입을 거절하시겠습니까?' },
    ];
  }
  if (status === 'approved') {
    return [
      // "비밀번호 초기화"는 gnmap_v2_set_user_status RPC가 아니라 별도 Edge Function
      // (gnmap-v2-reset-password)을 호출한다 — status/role 값은 전혀 바뀌지 않는다.
      { type: 'reset-password', label: '비밀번호 초기화', danger: true, confirm: '이 회원의 비밀번호를 초기화하시겠습니까? 새 임시 비밀번호가 발급됩니다.' },
      { key: 'disabled', type: 'status', label: '휴면전환', danger: true, confirm: '이 회원을 휴면 상태로 전환하시겠습니까?' },
    ];
  }
  // "완전 삭제"는 status RPC가 아니라 별도 RPC(gnmap_v2_delete_rejected_profile)를 호출한다.
  // 그 함수 내부에서도 rejected/disabled 상태인지 다시 검사하므로, 다른 상태 회원은 이 액션으로
  // 지울 수 없다(서버가 최종 방어선). rejected/disabled 둘 다 같은 조치를 공유한다.
  const DELETE_ACTION = { type: 'delete-rejected', label: '완전 삭제', danger: true, confirm: '이 회원 데이터를 완전히 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.' };

  if (status === 'rejected') {
    return [
      { key: 'approved', type: 'status', label: '재승인', danger: false },
      DELETE_ACTION,
    ];
  }
  if (status === 'disabled') {
    return [
      { key: 'approved', type: 'status', label: '재활성화', danger: false },
      DELETE_ACTION,
    ];
  }
  return [];
}

// 모바일 ⋮ 메뉴 — 작은 desktop dropdown 대신 하단 bottom sheet를 새로 만든다(요청사항 23).
// 실제 조치는 기존 setUserStatus(admin.js)만 호출하고, 성공 시 loadUsers()로 다시 조회해
// 카드/카운트/배지를 즉시 갱신한다(요청사항 25). document.body에 붙여 admin-panel의 내부
// 스크롤 위치와 무관하게 항상 화면 전체를 덮도록 한다.
function openAdminActionSheet(u, currentUserId, listEl, containerId) {
  const isSelf = currentUserId === u.id;

  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSheet();
  });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet';
  overlay.appendChild(sheet);

  function closeSheet() {
    overlay.remove();
  }

  function renderMainMenu() {
    sheet.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'admin-sheet-name';
    nameEl.textContent = displayValue(splitOrgName(u.name).name);
    sheet.appendChild(nameEl);

    const infoBtn = document.createElement('button');
    infoBtn.type = 'button';
    infoBtn.className = 'admin-sheet-action';
    infoBtn.textContent = '회원 정보 보기';
    infoBtn.addEventListener('click', renderInfoView);
    sheet.appendChild(infoBtn);

    // STEP16.32: "회원 권한 부여"(역할 변경)는 마스터관리자에게만 모바일에서도 노출한다.
    // 자기 자신 행은 서버(gnmap_v2_set_user_role)도 차단하므로 버튼 자체를 보여주지 않는다.
    if (isMaster() && !isSelf) {
      const roleBtn = document.createElement('button');
      roleBtn.type = 'button';
      roleBtn.className = 'admin-sheet-action';
      roleBtn.textContent = '회원 권한 변경';
      roleBtn.addEventListener('click', renderRoleView);
      sheet.appendChild(roleBtn);
    }

    getAdminActionsForStatus(u.status, isSelf).forEach(action => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-sheet-action' + (action.danger ? ' admin-sheet-action-danger' : '');
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        if (action.confirm) renderConfirmView(action);
        else runAction(action);
      });
      sheet.appendChild(btn);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-sheet-cancel';
    cancelBtn.textContent = '취소';
    cancelBtn.addEventListener('click', closeSheet);
    sheet.appendChild(cancelBtn);
  }

  // 새 네트워크 호출 없이 이미 알고 있는 값만 보여준다(요청사항 12의 카드 정보를 그대로 나열).
  function renderInfoView() {
    sheet.innerHTML = '';
    const { org: infoOrg, name: infoName } = splitOrgName(u.name);
    const nameEl = document.createElement('div');
    nameEl.className = 'admin-sheet-name';
    nameEl.textContent = displayValue(infoName);
    sheet.appendChild(nameEl);

    const infoList = document.createElement('div');
    infoList.className = 'admin-sheet-info';
    [
      ['계정', maskEmailDomain(u.email)],
      ['지청', infoOrg || '-'],
      ['역할', adminRoleLabel(u.role)],
      ['상태', (ADMIN_STATUS_META[u.status] || {}).label || displayValue(u.status)],
      ['가입일', formatAdminDate(u.created_at)],
    ].forEach(([label, value]) => {
      const line = document.createElement('div');
      line.className = 'admin-sheet-info-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'admin-sheet-info-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'admin-sheet-info-value';
      valueEl.textContent = value;
      line.appendChild(labelEl);
      line.appendChild(valueEl);
      infoList.appendChild(line);
    });
    sheet.appendChild(infoList);

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'admin-sheet-cancel';
    backBtn.textContent = '닫기';
    backBtn.addEventListener('click', closeSheet);
    sheet.appendChild(backBtn);
  }

  // STEP16.32: 모바일에서 역할(사용자/관리자/마스터관리자)을 선택하는 화면. 마스터관리자만
  // 이 화면에 진입할 수 있고(renderMainMenu에서 노출 여부를 이미 가렸다), 실제 변경 권한은
  // DB RPC(gnmap_v2_set_user_role, is_gnmap_v2_master() 검증)가 최종적으로 확인한다.
  function renderRoleView() {
    sheet.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'admin-sheet-name';
    nameEl.textContent = '회원 권한 변경';
    sheet.appendChild(nameEl);

    ['user', 'admin', 'master'].forEach(r => {
      const isCurrent = r === u.role;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-sheet-action';
      btn.textContent = adminRoleLabel(r) + (isCurrent ? ' (현재)' : '');
      btn.disabled = isCurrent;
      btn.addEventListener('click', () => {
        renderConfirmView({
          type: 'role',
          key: r,
          label: '권한 변경',
          confirm: `이 회원의 권한을 "${adminRoleLabel(r)}"(으)로 변경하시겠습니까?`,
        });
      });
      sheet.appendChild(btn);
    });

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'admin-sheet-cancel';
    backBtn.textContent = '취소';
    backBtn.addEventListener('click', renderMainMenu);
    sheet.appendChild(backBtn);
  }

  // 거절/비활성화 등 destructive action 확인 단계(요청사항 24).
  function renderConfirmView(action) {
    sheet.innerHTML = '';
    const confirmMsg = document.createElement('div');
    confirmMsg.className = 'admin-sheet-confirm-msg';
    confirmMsg.textContent = action.confirm;
    sheet.appendChild(confirmMsg);

    const btnRow = document.createElement('div');
    btnRow.className = 'admin-sheet-confirm-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-sheet-cancel';
    cancelBtn.textContent = '취소';
    cancelBtn.addEventListener('click', renderMainMenu);
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'admin-sheet-action-danger admin-sheet-confirm-ok';
    okBtn.textContent = action.label;
    okBtn.addEventListener('click', () => runAction(action));
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    sheet.appendChild(btnRow);
  }

  // 비밀번호 초기화 결과(임시 비밀번호)를 보여준다. 상태/카운트가 바뀌는 조치가 아니므로
  // loadUsers() 재조회 없이 여기서 그대로 끝난다.
  function renderPasswordResultView(tempPassword) {
    sheet.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'admin-sheet-name';
    nameEl.textContent = '비밀번호 초기화 완료';
    sheet.appendChild(nameEl);

    const msg = document.createElement('p');
    msg.className = 'admin-sheet-confirm-msg';
    msg.textContent = '아래 임시 비밀번호를 회원에게 별도의 안전한 방법으로 전달해주세요. 이 창을 닫으면 다시 확인할 수 없습니다.';
    sheet.appendChild(msg);

    const pwRow = document.createElement('div');
    pwRow.className = 'admin-sheet-password-row';
    const pwBox = document.createElement('div');
    pwBox.className = 'admin-sheet-password-box';
    pwBox.textContent = tempPassword;
    pwRow.appendChild(pwBox);

    // 클립보드 복사(요청사항). Clipboard API를 못 쓰는 환경(구형 웹뷰 등)을 대비해
    // execCommand('copy') fallback도 함께 둔다. 복사 성공/실패는 버튼 텍스트로만 잠깐 알려준다.
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'admin-sheet-copy-btn';
    copyBtn.textContent = '복사';
    copyBtn.setAttribute('aria-label', '임시 비밀번호 복사');
    copyBtn.addEventListener('click', async () => {
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(tempPassword);
          copied = true;
        }
      } catch (e) { /* 아래 fallback 시도 */ }
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = tempPassword;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          copied = document.execCommand('copy');
          ta.remove();
        } catch (e) { /* 무시 — 아래에서 실패로 표시 */ }
      }
      copyBtn.textContent = copied ? '복사됨' : '복사 실패';
      setTimeout(() => { copyBtn.textContent = '복사'; }, 1500);
    });
    pwRow.appendChild(copyBtn);
    sheet.appendChild(pwRow);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'admin-sheet-cancel';
    closeBtn.textContent = '확인';
    closeBtn.addEventListener('click', closeSheet);
    sheet.appendChild(closeBtn);
  }

  async function runAction(action) {
    if (state.adminUserInFlight.has(u.id)) return;
    state.adminUserInFlight.add(u.id);
    sheet.innerHTML = '';
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'admin-sheet-confirm-msg';
    loadingMsg.textContent = '처리 중...';
    sheet.appendChild(loadingMsg);

    try {
      if (action.type === 'reset-password') {
        const result = await resetUserPassword(u.id);
        if (!result.ok) {
          loadingMsg.textContent = result.message || '비밀번호 초기화에 실패했습니다.';
          const backBtn = document.createElement('button');
          backBtn.type = 'button';
          backBtn.className = 'admin-sheet-cancel';
          backBtn.textContent = '닫기';
          backBtn.addEventListener('click', closeSheet);
          sheet.appendChild(backBtn);
          return;
        }
        renderPasswordResultView(result.tempPassword);
        return;
      }

      if (action.type === 'delete-rejected') {
        const result = await deleteRejectedProfile(u.id);
        if (!result.ok) {
          loadingMsg.textContent = result.message || '삭제에 실패했습니다.';
          const backBtn = document.createElement('button');
          backBtn.type = 'button';
          backBtn.className = 'admin-sheet-cancel';
          backBtn.textContent = '닫기';
          backBtn.addEventListener('click', closeSheet);
          sheet.appendChild(backBtn);
          return;
        }
        // 삭제는 전체 카운트가 줄어드는 조치이므로 승인/거절과 동일하게 목록을 다시 그린다
        // (아래 공통 마무리 코드로 흘러가도록 여기서는 return하지 않는다).
      } else if (action.type === 'role') {
        const result = await setUserRole(u.id, action.key);
        state.adminMessage = result.message;
        if (!result.ok) {
          loadingMsg.textContent = result.message || '권한 변경에 실패했습니다.';
          const backBtn = document.createElement('button');
          backBtn.type = 'button';
          backBtn.className = 'admin-sheet-cancel';
          backBtn.textContent = '닫기';
          backBtn.addEventListener('click', closeSheet);
          sheet.appendChild(backBtn);
          return;
        }
      } else {
        const result = await setUserStatus(u.id, action.key);
        state.adminMessage = result.message;
        if (!result.ok) {
          loadingMsg.textContent = result.message || '처리에 실패했습니다.';
          const backBtn = document.createElement('button');
          backBtn.type = 'button';
          backBtn.className = 'admin-sheet-cancel';
          backBtn.textContent = '닫기';
          backBtn.addEventListener('click', closeSheet);
          sheet.appendChild(backBtn);
          return;
        }
      }
    } finally {
      state.adminUserInFlight.delete(u.id);
    }

    closeSheet();
    // 요청사항 25: RPC 성공 후 목록/카운트/배지를 즉시 갱신한다. 서버가 최종 진실이므로
    // client-side로 값을 추정해 넣지 않고 loadUsers()로 다시 조회한다.
    await loadUsers();
    const desktopHost = document.getElementById(containerId);
    const oldDesktop = document.getElementById('admin-desktop-rows');
    if (oldDesktop) oldDesktop.remove();
    if (desktopHost) renderAdminDesktopRows(desktopHost, state.adminUsers, containerId);
    const mobileHost = document.getElementById('admin-mobile-host');
    if (mobileHost) renderAdminMobileHost(mobileHost, containerId);
  }

  renderMainMenu();
  document.body.appendChild(overlay);
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
    // F2(STEP16.35): 조회 자체가 실패했을 때는 "등록된 감독일정이 없다"는 문구 대신
    // 오류 상태 + 다시 시도 버튼을 보여준다.
    if (state.supervisionsLoadError) {
      buildLoadErrorState(listEl, '감독일정 정보를 불러오지 못했습니다.', () => renderSupervisionPanel(containerId));
    } else {
      const empty = document.createElement('p');
      empty.textContent = '등록된 감독일정이 없습니다.';
      listEl.appendChild(empty);
    }
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

// ============================================================
// 모바일 "감독일정관리" TARGET UI (목록/캘린더/등록/수정/상세).
// supervision.js의 CRUD(createSupervision/updateSupervision/deleteSupervision/loadSupervisions)와
// computeSupervisionStatus()(날짜 기반 예정/진행중/완료 자동계산)는 전혀 새로 만들지 않고 그대로
// 재사용한다. PC의 #supervision-panel-header/#supervision-filter-bar/#supervision-list-wrap/
// #supervision-form(STEP14/PC)은 DOM에서 지우지 않고 mobile.css가 화면 폭에서만 숨긴다.
//
// supervision_type('inspection'|'supervision'|null) — status와 완전히 별개인 "감독 유형" 축
// (사용자 최종 결정, 2026-09-27). 기존 행은 NULL 허용, 신규 등록부터 필수값으로 검증한다.
// ============================================================
const SUPERVISION_MOBILE_HOST_ID = 'supervision-mobile-host';
const SUPERVISION_TYPE_LABEL = { inspection: '점검', supervision: '감독' };
const SUPERVISION_TYPE_VALUES = ['inspection', 'supervision'];
const SV_WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const SV_ICON_PLUS = ['<path d="M12 5v14M5 12h14"/>'];
const SV_ICON_CHEVRON_LEFT = ['<path d="M15 5.5 9 12l6 6.5"/>'];
const SV_ICON_CHEVRON_RIGHT = ['<path d="M9 5.5 15 12l-6 6.5"/>'];
const SV_ICON_CALENDAR = ['<rect x="4" y="5" width="16" height="15" rx="2"/>', '<path d="M4 10h16"/>', '<path d="M8 3v4M16 3v4"/>'];
const SV_ICON_USER = ['<circle cx="12" cy="8" r="3.4"/>', '<path d="M5 20c0-4 3.2-6.5 7-6.5s7 2.5 7 6.5"/>'];
// STEP16.23(더보기 > 현장 메모) 추가 아이콘.
const SV_ICON_DOC = ['<path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5Z"/>', '<path d="M14 3.5V8h4"/>', '<path d="M9 13h6M9 16.5h5"/>'];
const SV_ICON_BUILDING = ['<rect x="6" y="4" width="12" height="16" rx="1.2"/>', '<path d="M9 8h1.4M13.6 8H15M9 12h1.4M13.6 12H15M9 16h1.4M13.6 16H15"/>'];
const SV_ICON_SEARCH = ['<circle cx="11" cy="11" r="6.5"/>', '<path d="m20 20-3.5-3.5"/>'];

function svIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach(p => svg.insertAdjacentHTML('beforeend', p));
  return svg;
}

function svLabel(text, required) {
  const label = document.createElement('div');
  label.className = 'sv-mobile-field-label';
  label.textContent = text;
  if (required) {
    const star = document.createElement('span');
    star.className = 'sv-mobile-required';
    star.textContent = '*';
    label.appendChild(star);
  }
  return label;
}

function svParseYMD(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function svFormatYMD(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function svFormatDateKR(dateStr) {
  if (!dateStr) return '-';
  const d = svParseYMD(dateStr);
  const w = SV_WEEKDAY_LABELS[d.getDay()];
  return `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}. (${w})`;
}
function svFormatDateRangeKR(start, end) {
  if (!start || !end) return '-';
  if (start === end) return svFormatDateKR(start);
  return `${svFormatDateKR(start)} ~ ${svFormatDateKR(end)}`;
}
// 등록일(created_at, timestamptz)을 실제 start/end와 동일한 'YYYY. MM. DD. (요일)' 형식으로
// 표시한다(TARGET처럼 시간은 표시하지 않는다 — 시각 단위 실사용 필드가 아니므로).
function svFormatTimestampDateKR(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return svFormatDateKR(svFormatYMD(d));
}
function svOverlapsDate(sv, dateStr) {
  return sv.start_date <= dateStr && dateStr <= sv.end_date;
}
function svOverlapsMonth(sv, year, month) {
  const monthStart = svFormatYMD(new Date(year, month, 1));
  const monthEnd = svFormatYMD(new Date(year, month + 1, 0));
  return sv.start_date <= monthEnd && sv.end_date >= monthStart;
}
// statusFilter('all'|'scheduled'|'ongoing'|'done')와 typeFilter('all'|'inspection'|'supervision')는
// 서로 독립된 두 축이며 AND로 결합된다(사용자 요청: 상태 quick filter와 감독유형 필터를 분리).
function svMatchesFilters(sv, statusFilter, typeFilter) {
  if (statusFilter !== 'all' && computeSupervisionStatus(sv.start_date, sv.end_date) !== statusFilter) return false;
  if (typeFilter !== 'all' && sv.supervision_type !== typeFilter) return false;
  return true;
}
// 캘린더 dot/bar 색 우선순위: 완료(초록) > 감독(amber) > 점검(파랑) > 유형 미지정(회색).
// (사용자 최종 결정 §7: status=done이면 유형과 무관하게 항상 초록.)
function svDisplayColorClass(sv) {
  if (computeSupervisionStatus(sv.start_date, sv.end_date) === 'done') return 'sv-status-done';
  if (sv.supervision_type === 'supervision') return 'sv-type-supervision';
  if (sv.supervision_type === 'inspection') return 'sv-type-inspection';
  return 'sv-type-none';
}

function getSupervisionMobileMonthCursor() {
  if (!state.supervisionMobileMonthCursor) {
    const today = new Date();
    state.supervisionMobileMonthCursor = { year: today.getFullYear(), month: today.getMonth() };
  }
  return state.supervisionMobileMonthCursor;
}
function getSupervisionMobileSelectedDate() {
  if (!state.supervisionMobileSelectedDate) {
    state.supervisionMobileSelectedDate = todayDateString();
  }
  return state.supervisionMobileSelectedDate;
}

// 6주(42칸) grid를 만들되, 마지막 줄이 전부 다음 달이면 잘라서 화면 공간을 아낀다(TARGET처럼
// 5주로 끝나는 달이 대부분). 기간이 월 경계를 넘는 일정도 각 달의 grid에 실제 날짜로만
// 계산되므로(§35) 정상 표시된다.
function buildSvMonthMatrix(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  const lastRowAllNextMonth = cells.slice(35).every(d => d.getMonth() !== month);
  return lastRowAllNextMonth ? cells.slice(0, 35) : cells;
}

// 진입점 — app.js가 (1) 알림 탭 진입 시, (2) 더보기>감독일정관리/헤더 벨 진입 시 호출한다.
// 매번 loadSupervisions()로 새로 조회한다(PC 패널과 완전히 독립적으로 그린다 — 타이밍 경쟁 방지).
export async function renderSupervisionMobileHost() {
  if (!document.getElementById(SUPERVISION_MOBILE_HOST_ID)) return;
  const rows = await loadSupervisions();
  state.supervisions = rows;

  const host = document.getElementById(SUPERVISION_MOBILE_HOST_ID);
  if (!host) return; // 조회 중 탭을 벗어났을 수 있다.
  host.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'supervision-mobile-view';
  host.appendChild(view);

  if (state.supervisionMobileView === 'form') {
    renderSupervisionMobileForm(view, rows);
  } else if (state.supervisionMobileView === 'detail') {
    renderSupervisionMobileDetail(view, rows);
  } else {
    renderSupervisionMobileList(view, rows);
  }
}

function renderSupervisionMobileList(view, rows) {
  const { year, month } = getSupervisionMobileMonthCursor();
  const selectedDate = getSupervisionMobileSelectedDate();
  const rerender = () => { view.innerHTML = ''; renderSupervisionMobileList(view, rows); };

  // STEP16.32: 앱설정/현장메모 등과 동일한 "‹ 감독일정관리" 상단 표시로 통일한다.
  // 주의: 이 화면은 "알림" 탭(data-mobile-tab="alert")으로 열리는데, css/mobile.css가 그
  // 상태에서 #supervision-panel을 display:block !important로 고정해두므로(하단 탭 전환이 곧
  // 닫기라는 기존 설계), 여기서 style.display만 바꿔서는 실제로 닫히지 않는다. 기존 설계와
  // 동일하게 "더보기" 하단 탭 버튼 클릭을 위임해 실제로 탭을 벗어나야 한다 — app.js의
  // activateMobileTab()이 탭 이탈 시 이 패널을 포함해 함께 정리한다(app.js 로직 변경 없음).
  const { header, backBtn } = buildSettingsSubHeader('감독일정 관리');
  backBtn.addEventListener('click', () => {
    const moreTabBtn = document.querySelector('.mobile-tab-btn[data-tab="more"]');
    if (moreTabBtn) moreTabBtn.click();
  });

  // 등록/수정/삭제는 admin만(RLS 최종 방어) — "+" 버튼도 admin에게만 보인다.
  if (isAdmin()) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'sv-mobile-add-btn';
    addBtn.style.marginLeft = 'auto';
    addBtn.setAttribute('aria-label', '감독일정 등록');
    addBtn.appendChild(svIcon(SV_ICON_PLUS));
    addBtn.addEventListener('click', () => {
      state.supervisionMobileView = 'form';
      state.supervisionMobileFormOrigin = 'list';
      state.supervisionMobileSelectedId = null;
      renderSupervisionMobileHost();
    });
    header.appendChild(addBtn);
  }
  view.appendChild(header);

  const subtitleEl = document.createElement('p');
  subtitleEl.className = 'sv-mobile-subtitle';
  subtitleEl.style.padding = '0 16px 12px';
  subtitleEl.textContent = '예정된 감독 일정을 확인하고 관리합니다.';
  view.appendChild(subtitleEl);

  // F2(STEP16.35): 조회 자체가 실패했을 때는 달력 자체를 그리지 않고(날짜별 "일정 없음"과
  // 뒤섞이면 매일 오류 문구가 뜨는 것처럼 보일 수 있음) 상단에 오류 상태만 보여준다.
  if (state.supervisionsLoadError) {
    buildLoadErrorState(view, '감독일정 정보를 불러오지 못했습니다.', () => renderSupervisionMobileHost());
    return;
  }

  const monthBar = document.createElement('div');
  monthBar.className = 'sv-mobile-month-bar';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'sv-mobile-month-nav-btn';
  prevBtn.setAttribute('aria-label', '이전 달');
  prevBtn.appendChild(svIcon(SV_ICON_CHEVRON_LEFT));
  prevBtn.addEventListener('click', () => {
    const d = new Date(year, month - 1, 1);
    state.supervisionMobileMonthCursor = { year: d.getFullYear(), month: d.getMonth() };
    rerender();
  });
  monthBar.appendChild(prevBtn);
  const monthLabel = document.createElement('span');
  monthLabel.className = 'sv-mobile-month-label';
  monthLabel.textContent = `${year}년 ${month + 1}월`;
  monthBar.appendChild(monthLabel);
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'sv-mobile-month-nav-btn';
  nextBtn.setAttribute('aria-label', '다음 달');
  nextBtn.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  nextBtn.addEventListener('click', () => {
    const d = new Date(year, month + 1, 1);
    state.supervisionMobileMonthCursor = { year: d.getFullYear(), month: d.getMonth() };
    rerender();
  });
  monthBar.appendChild(nextBtn);
  const todayBtn = document.createElement('button');
  todayBtn.type = 'button';
  todayBtn.className = 'sv-mobile-today-btn';
  todayBtn.textContent = '오늘';
  todayBtn.addEventListener('click', () => {
    const today = new Date();
    state.supervisionMobileMonthCursor = { year: today.getFullYear(), month: today.getMonth() };
    state.supervisionMobileSelectedDate = todayDateString();
    rerender();
  });
  monthBar.appendChild(todayBtn);
  view.appendChild(monthBar);

  const statusFilter = state.supervisionMobileStatusFilter;
  const typeFilter = state.supervisionMobileTypeFilter;
  // 필터 chip의 카운트는 "현재 표시 중인 달"(§13) 기준 — 선택 상태와 무관하게 매번 다 계산.
  const monthRows = rows.filter(sv => svOverlapsMonth(sv, year, month));
  const countAll = monthRows.length;
  const countOngoing = monthRows.filter(sv => computeSupervisionStatus(sv.start_date, sv.end_date) === 'ongoing').length;
  const countScheduled = monthRows.filter(sv => computeSupervisionStatus(sv.start_date, sv.end_date) === 'scheduled').length;
  const countDone = monthRows.filter(sv => computeSupervisionStatus(sv.start_date, sv.end_date) === 'done').length;
  const countTypeAll = monthRows.length;
  const countInspection = monthRows.filter(sv => sv.supervision_type === 'inspection').length;
  const countSupervision = monthRows.filter(sv => sv.supervision_type === 'supervision').length;

  const filteredRows = rows.filter(sv => svMatchesFilters(sv, statusFilter, typeFilter));

  const calendarWrap = document.createElement('div');
  calendarWrap.className = 'sv-mobile-calendar';
  const weekdayRow = document.createElement('div');
  weekdayRow.className = 'sv-mobile-weekday-row';
  SV_WEEKDAY_LABELS.forEach(w => {
    const el = document.createElement('div');
    el.className = 'sv-mobile-weekday';
    el.textContent = w;
    weekdayRow.appendChild(el);
  });
  calendarWrap.appendChild(weekdayRow);

  const cells = buildSvMonthMatrix(year, month);
  const todayStr = todayDateString();
  const colorPriority = ['sv-status-done', 'sv-type-supervision', 'sv-type-inspection', 'sv-type-none'];
  for (let i = 0; i < cells.length; i += 7) {
    const weekRow = document.createElement('div');
    weekRow.className = 'sv-mobile-week-row';
    cells.slice(i, i + 7).forEach(d => {
      const dateStr = svFormatYMD(d);
      const cellBtn = document.createElement('button');
      cellBtn.type = 'button';
      cellBtn.className = 'sv-mobile-day-cell'
        + (d.getMonth() !== month ? ' is-outside' : '')
        + (dateStr === todayStr ? ' is-today' : '')
        + (dateStr === selectedDate ? ' is-selected' : '');

      const num = document.createElement('span');
      num.className = 'sv-mobile-day-num';
      num.textContent = String(d.getDate());
      cellBtn.appendChild(num);

      const dayMatches = filteredRows.filter(sv => svOverlapsDate(sv, dateStr));
      const bar = document.createElement('span');
      if (dayMatches.length > 0) {
        const classes = dayMatches.map(svDisplayColorClass);
        const chosen = colorPriority.find(p => classes.includes(p)) || 'sv-type-none';
        bar.className = 'sv-mobile-day-bar ' + chosen;
      } else {
        bar.className = 'sv-mobile-day-bar sv-empty';
      }
      cellBtn.appendChild(bar);

      cellBtn.addEventListener('click', () => {
        state.supervisionMobileSelectedDate = dateStr;
        if (d.getMonth() !== month) {
          state.supervisionMobileMonthCursor = { year: d.getFullYear(), month: d.getMonth() };
        }
        rerender();
      });
      weekRow.appendChild(cellBtn);
    });
    calendarWrap.appendChild(weekRow);
  }
  view.appendChild(calendarWrap);

  const legend = document.createElement('div');
  legend.className = 'sv-mobile-legend';
  [['sv-type-inspection', '점검'], ['sv-type-supervision', '감독'], ['sv-status-done', '완료']].forEach(([cls, label]) => {
    const item = document.createElement('span');
    item.className = 'sv-mobile-legend-item';
    const dot = document.createElement('span');
    dot.className = 'sv-mobile-legend-dot ' + cls;
    item.appendChild(dot);
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);
    legend.appendChild(item);
  });
  view.appendChild(legend);

  // 상태 quick filter(진행/예정/완료/전체) — 사용자 요청으로 감독유형 필터와 분리된 별도 축.
  const filterBar = document.createElement('div');
  filterBar.className = 'sv-mobile-filter-bar';
  [
    ['ongoing', `진행 (${countOngoing})`],
    ['scheduled', `예정 (${countScheduled})`],
    ['done', `완료 (${countDone})`],
    ['all', `전체 (${countAll})`],
  ].forEach(([key, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sv-mobile-filter-chip' + (statusFilter === key ? ' active' : '');
    chip.textContent = label;
    chip.addEventListener('click', () => {
      state.supervisionMobileStatusFilter = key;
      rerender();
    });
    filterBar.appendChild(chip);
  });
  view.appendChild(filterBar);

  // 감독유형 필터(전체/점검/감독) — 상태 quick filter와 별개로 AND 결합된다.
  const typeFilterBar = document.createElement('div');
  typeFilterBar.className = 'sv-mobile-type-filter-bar';
  const typeFilterLabel = document.createElement('span');
  typeFilterLabel.className = 'sv-mobile-type-filter-label';
  typeFilterLabel.textContent = '감독유형';
  typeFilterBar.appendChild(typeFilterLabel);
  [
    ['all', `전체 (${countTypeAll})`],
    ['inspection', `점검 (${countInspection})`],
    ['supervision', `감독 (${countSupervision})`],
  ].forEach(([key, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sv-mobile-type-filter-chip' + (typeFilter === key ? ' active' : '');
    chip.textContent = label;
    chip.addEventListener('click', () => {
      state.supervisionMobileTypeFilter = key;
      rerender();
    });
    typeFilterBar.appendChild(chip);
  });
  view.appendChild(typeFilterBar);

  const dateRow = document.createElement('div');
  dateRow.className = 'sv-mobile-selected-date-row';
  const dateLabel = document.createElement('span');
  dateLabel.className = 'sv-mobile-selected-date-label';
  dateLabel.textContent = svFormatDateKR(selectedDate);
  dateRow.appendChild(dateLabel);
  const dayRows = filteredRows.filter(sv => svOverlapsDate(sv, selectedDate));
  const countLabel = document.createElement('span');
  countLabel.className = 'sv-mobile-selected-date-count';
  countLabel.textContent = `총 ${dayRows.length}건`;
  dateRow.appendChild(countLabel);
  view.appendChild(dateRow);

  if (dayRows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sv-mobile-empty';
    const emptyIcon = svIcon(SV_ICON_CALENDAR);
    emptyIcon.style.width = '32px';
    emptyIcon.style.height = '32px';
    empty.appendChild(emptyIcon);
    const emptyText = document.createElement('p');
    emptyText.textContent = '등록된 감독 일정이 없습니다.';
    empty.appendChild(emptyText);
    if (isAdmin()) {
      const cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'sv-mobile-empty-cta';
      cta.appendChild(svIcon(SV_ICON_PLUS));
      const ctaText = document.createElement('span');
      ctaText.textContent = '감독일정 등록';
      cta.appendChild(ctaText);
      cta.addEventListener('click', () => {
        state.supervisionMobileView = 'form';
        state.supervisionMobileFormOrigin = 'list';
        state.supervisionMobileSelectedId = null;
        renderSupervisionMobileHost();
      });
      empty.appendChild(cta);
    }
    view.appendChild(empty);
  } else {
    const sortedDayRows = [...dayRows].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    const listEl = document.createElement('div');
    listEl.className = 'sv-mobile-card-list';
    sortedDayRows.forEach(sv => listEl.appendChild(buildSupervisionMobileCard(sv)));
    view.appendChild(listEl);
  }
}

function buildSupervisionMobileCard(sv) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'sv-mobile-card';
  card.addEventListener('click', () => {
    state.supervisionMobileSelectedId = sv.id;
    state.supervisionMobileView = 'detail';
    renderSupervisionMobileHost();
  });

  const top = document.createElement('div');
  top.className = 'sv-mobile-card-top';
  if (sv.supervision_type) {
    const typeBadge = document.createElement('span');
    typeBadge.className = 'sv-mobile-badge sv-type-' + sv.supervision_type;
    typeBadge.textContent = SUPERVISION_TYPE_LABEL[sv.supervision_type];
    top.appendChild(typeBadge);
  }
  const liveStatus = computeSupervisionStatus(sv.start_date, sv.end_date);
  const statusBadge = document.createElement('span');
  statusBadge.className = 'sv-mobile-badge sv-mobile-badge-status sv-status-' + liveStatus;
  statusBadge.textContent = SUPERVISION_STATUS_LABEL[liveStatus];
  top.appendChild(statusBadge);
  const chevron = document.createElement('span');
  chevron.className = 'sv-mobile-card-chevron';
  chevron.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  top.appendChild(chevron);
  card.appendChild(top);

  const titleEl = document.createElement('p');
  titleEl.className = 'sv-mobile-card-title';
  titleEl.textContent = sv.title;
  card.appendChild(titleEl);

  const dateMeta = document.createElement('div');
  dateMeta.className = 'sv-mobile-card-meta-row';
  dateMeta.appendChild(svIcon(SV_ICON_CALENDAR));
  const dateText = document.createElement('span');
  dateText.textContent = svFormatDateRangeKR(sv.start_date, sv.end_date);
  dateMeta.appendChild(dateText);
  card.appendChild(dateMeta);

  const managerMeta = document.createElement('div');
  managerMeta.className = 'sv-mobile-card-meta-row';
  managerMeta.appendChild(svIcon(SV_ICON_USER));
  const managerText = document.createElement('span');
  managerText.textContent = `담당 감독관  ${sv.manager_name || '-'}`;
  managerMeta.appendChild(managerText);
  card.appendChild(managerMeta);

  return card;
}

// 담당 감독관 선택 bottom sheet. admin.js의 loadUsers()를 그대로 재사용하고(새 DB 조회 없음),
// 여기서는 승인된(approved) 사용자만 후보로 보여준다 — 이 폼 자체가 admin 전용 등록/수정
// 화면 안에서만 열린다. 기존 admin-sheet-overlay/admin-sheet 스타일을 그대로 재사용한다.
async function openSupervisionManagerSheet(onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet';
  const titleEl = document.createElement('div');
  titleEl.className = 'admin-sheet-name';
  titleEl.textContent = '담당 감독관 선택';
  sheet.appendChild(titleEl);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'sv-manager-sheet-search';
  searchInput.placeholder = '이름 검색';
  sheet.appendChild(searchInput);

  const listWrap = document.createElement('div');
  sheet.appendChild(listWrap);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  const allUsers = await loadUsers();
  // name이 없는 계정(예: 초기 시드 관리자)은 표시할 담당자명 자체가 없으므로 후보에서 제외한다
  // (선택 시 빈 문자열이 저장되는 것을 막기 위함 — 가짜 이름을 채우지 않는다).
  const approvedUsers = (allUsers || []).filter(u => u.status === 'approved' && u.name);

  function renderOptions(query) {
    listWrap.innerHTML = '';
    const q = (query || '').trim();
    const filtered = q ? approvedUsers.filter(u => (u.name || '').includes(q)) : approvedUsers;
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sv-manager-empty';
      empty.textContent = '선택 가능한 사용자가 없습니다.';
      listWrap.appendChild(empty);
      return;
    }
    filtered.forEach(u => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'sv-manager-option';
      opt.textContent = displayValue(u.name);
      opt.addEventListener('click', () => {
        onSelect(u.name);
        overlay.remove();
      });
      listWrap.appendChild(opt);
    });
  }
  renderOptions('');
  searchInput.addEventListener('input', () => renderOptions(searchInput.value));
}

// 등록/수정 공용 폼(§30 "동일 form을 재사용" — edit는 existing이 있을 때만).
function renderSupervisionMobileForm(view, rows) {
  const editingId = state.supervisionMobileSelectedId;
  const existing = editingId ? rows.find(r => r.id === editingId) : null;
  const isEdit = !!existing;

  const subheader = document.createElement('div');
  subheader.className = 'sv-mobile-subheader';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'sv-mobile-back-btn';
  backBtn.setAttribute('aria-label', '뒤로가기');
  backBtn.appendChild(svIcon(SV_ICON_CHEVRON_LEFT));
  backBtn.addEventListener('click', () => {
    state.supervisionMobileView = (isEdit && state.supervisionMobileFormOrigin === 'detail') ? 'detail' : 'list';
    renderSupervisionMobileHost();
  });
  subheader.appendChild(backBtn);
  const subTitle = document.createElement('span');
  subTitle.className = 'sv-mobile-subheader-title';
  subTitle.textContent = isEdit ? '감독일정 수정' : '감독일정 등록';
  subheader.appendChild(subTitle);
  view.appendChild(subheader);

  const form = document.createElement('div');
  form.className = 'sv-mobile-form';

  let selectedType = existing ? (existing.supervision_type || null) : null;
  let selectedManagerName = existing ? (existing.manager_name || '') : '';

  const titleField = document.createElement('div');
  titleField.className = 'sv-mobile-field';
  titleField.appendChild(svLabel('감독명', true));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = '감독명을 입력해주세요.';
  titleInput.value = existing ? existing.title : '';
  titleField.appendChild(titleInput);
  form.appendChild(titleField);

  const periodField = document.createElement('div');
  periodField.className = 'sv-mobile-field';
  periodField.appendChild(svLabel('감독기간', true));
  const rangeWrap = document.createElement('div');
  rangeWrap.className = 'sv-mobile-date-range';
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.min = SUPERVISION_MIN_DATE;
  startInput.max = SUPERVISION_MAX_DATE;
  startInput.value = existing ? existing.start_date : '';
  const sep = document.createElement('span');
  sep.className = 'sv-mobile-date-range-sep';
  sep.textContent = '~';
  const endInput = document.createElement('input');
  endInput.type = 'date';
  endInput.min = existing ? existing.start_date : SUPERVISION_MIN_DATE;
  endInput.max = SUPERVISION_MAX_DATE;
  endInput.value = existing ? existing.end_date : '';
  rangeWrap.appendChild(startInput);
  rangeWrap.appendChild(sep);
  rangeWrap.appendChild(endInput);
  periodField.appendChild(rangeWrap);
  const rangeErrorEl = document.createElement('p');
  rangeErrorEl.className = 'sv-mobile-range-error';
  periodField.appendChild(rangeErrorEl);
  form.appendChild(periodField);

  // 사용자 요청(추가 반영): 제출 시점 검증(§ 종료일<시작일 금지)에 더해, 시작일을 고르는 즉시
  // 종료일 date picker의 선택 가능 범위 자체를 시작일 이후로 좁히고, 이미 골라둔 종료일이
  // 시작일보다 빨라지면 그 자리에서 비우고 안내한다 — 제출 전에 역전을 원천적으로 막는다.
  startInput.addEventListener('change', () => {
    rangeErrorEl.textContent = '';
    if (startInput.value) {
      endInput.min = startInput.value;
      if (endInput.value && endInput.value < startInput.value) {
        endInput.value = '';
        rangeErrorEl.textContent = '시작일이 변경되어 종료일이 초기화되었습니다. 종료일을 다시 선택해주세요.';
      }
    } else {
      endInput.min = SUPERVISION_MIN_DATE;
    }
  });
  endInput.addEventListener('change', () => {
    if (startInput.value && endInput.value && endInput.value < startInput.value) {
      rangeErrorEl.textContent = '종료일은 시작일보다 빠를 수 없습니다.';
      endInput.value = '';
    } else {
      rangeErrorEl.textContent = '';
    }
  });

  const typeField = document.createElement('div');
  typeField.className = 'sv-mobile-field';
  typeField.appendChild(svLabel('감독 유형', true));
  const typeToggle = document.createElement('div');
  typeToggle.className = 'sv-mobile-type-toggle';
  const typeButtons = {};
  SUPERVISION_TYPE_VALUES.forEach(typeVal => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sv-mobile-type-btn' + (selectedType === typeVal ? ' active' : '');
    btn.textContent = SUPERVISION_TYPE_LABEL[typeVal];
    btn.addEventListener('click', () => {
      selectedType = typeVal;
      SUPERVISION_TYPE_VALUES.forEach(v => typeButtons[v].classList.toggle('active', v === typeVal));
    });
    typeButtons[typeVal] = btn;
    typeToggle.appendChild(btn);
  });
  typeField.appendChild(typeToggle);
  form.appendChild(typeField);

  const managerField = document.createElement('div');
  managerField.className = 'sv-mobile-field';
  managerField.appendChild(svLabel('담당 감독관', true));
  const managerBtn = document.createElement('button');
  managerBtn.type = 'button';
  managerBtn.className = 'sv-mobile-manager-select-btn' + (selectedManagerName ? '' : ' is-placeholder');
  managerBtn.appendChild(svIcon(SV_ICON_USER));
  const managerBtnText = document.createElement('span');
  managerBtnText.textContent = selectedManagerName || '담당 감독관을 선택해주세요.';
  managerBtn.appendChild(managerBtnText);
  const managerChevron = document.createElement('span');
  managerChevron.className = 'sv-mobile-card-chevron';
  managerChevron.appendChild(svIcon(SV_ICON_CHEVRON_RIGHT));
  managerBtn.appendChild(managerChevron);
  managerBtn.addEventListener('click', () => {
    openSupervisionManagerSheet((name) => {
      selectedManagerName = name;
      managerBtnText.textContent = name;
      managerBtn.classList.remove('is-placeholder');
    });
  });
  managerField.appendChild(managerBtn);
  form.appendChild(managerField);

  const errorEl = document.createElement('p');
  errorEl.className = 'sv-mobile-field-error';
  form.appendChild(errorEl);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'sv-mobile-submit-btn';
  submitBtn.textContent = isEdit ? '변경사항 저장' : '감독일정 등록';
  form.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'sv-mobile-cancel-btn';
  cancelBtn.textContent = '취소';
  cancelBtn.addEventListener('click', () => {
    state.supervisionMobileView = (isEdit && state.supervisionMobileFormOrigin === 'detail') ? 'detail' : 'list';
    renderSupervisionMobileHost();
  });
  form.appendChild(cancelBtn);

  submitBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const titleVal = titleInput.value.trim();
    const startVal = startInput.value;
    const endVal = endInput.value;
    if (!titleVal) { errorEl.textContent = '감독명을 입력해주세요.'; return; }
    if (!startVal) { errorEl.textContent = '시작일을 입력해주세요.'; return; }
    if (!endVal) { errorEl.textContent = '종료일을 입력해주세요.'; return; }
    if (startVal < SUPERVISION_MIN_DATE || startVal > SUPERVISION_MAX_DATE || endVal < SUPERVISION_MIN_DATE || endVal > SUPERVISION_MAX_DATE) {
      errorEl.textContent = `시작일/종료일은 ${SUPERVISION_MIN_DATE} ~ ${SUPERVISION_MAX_DATE} 범위 내에서 입력해주세요.`;
      return;
    }
    if (endVal < startVal) { errorEl.textContent = '종료일은 시작일보다 빠를 수 없습니다.'; return; }
    if (!selectedType) { errorEl.textContent = '감독 유형을 선택해주세요.'; return; }

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const status = computeSupervisionStatus(startVal, endVal);
    const fields = {
      title: titleVal,
      manager_name: selectedManagerName || null,
      start_date: startVal,
      end_date: endVal,
      status,
      supervision_type: selectedType,
    };
    const result = isEdit ? await updateSupervision(existing.id, fields) : await createSupervision(fields);
    if (!result.success) {
      errorEl.textContent = result.message;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      return;
    }
    if (isEdit) {
      state.supervisionMobileSelectedId = result.row.id;
      state.supervisionMobileView = 'detail';
    } else {
      state.supervisionMobileView = 'list';
      state.supervisionMobileSelectedId = null;
    }
    await renderSupervisionMobileHost();
  });

  view.appendChild(form);
}

function renderSupervisionMobileDetail(view, rows) {
  const sv = rows.find(r => r.id === state.supervisionMobileSelectedId);

  const subheader = document.createElement('div');
  subheader.className = 'sv-mobile-subheader';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'sv-mobile-back-btn';
  backBtn.setAttribute('aria-label', '뒤로가기');
  backBtn.appendChild(svIcon(SV_ICON_CHEVRON_LEFT));
  backBtn.addEventListener('click', () => {
    state.supervisionMobileView = 'list';
    renderSupervisionMobileHost();
  });
  subheader.appendChild(backBtn);
  const subTitle = document.createElement('span');
  subTitle.className = 'sv-mobile-subheader-title';
  subTitle.textContent = '감독일정 상세';
  subheader.appendChild(subTitle);
  view.appendChild(subheader);

  if (!sv) {
    const empty = document.createElement('p');
    empty.className = 'sv-mobile-empty';
    empty.textContent = '해당 감독일정을 찾을 수 없습니다. 삭제되었을 수 있습니다.';
    view.appendChild(empty);
    return;
  }

  const liveStatus = computeSupervisionStatus(sv.start_date, sv.end_date);

  const hero = document.createElement('div');
  hero.className = 'sv-mobile-detail-hero';
  const badges = document.createElement('div');
  badges.className = 'sv-mobile-detail-hero-badges';
  if (sv.supervision_type) {
    const typeBadge = document.createElement('span');
    typeBadge.className = 'sv-mobile-badge sv-type-' + sv.supervision_type;
    typeBadge.textContent = SUPERVISION_TYPE_LABEL[sv.supervision_type];
    badges.appendChild(typeBadge);
  }
  const statusBadge = document.createElement('span');
  statusBadge.className = 'sv-mobile-badge sv-mobile-badge-status sv-status-' + liveStatus;
  statusBadge.textContent = SUPERVISION_STATUS_LABEL[liveStatus];
  badges.appendChild(statusBadge);
  hero.appendChild(badges);

  const heroTitle = document.createElement('h3');
  heroTitle.className = 'sv-mobile-detail-hero-title';
  heroTitle.textContent = sv.title;
  hero.appendChild(heroTitle);

  const heroDate = document.createElement('div');
  heroDate.className = 'sv-mobile-detail-hero-date';
  heroDate.appendChild(svIcon(SV_ICON_CALENDAR));
  const heroDateText = document.createElement('span');
  heroDateText.textContent = svFormatDateRangeKR(sv.start_date, sv.end_date);
  heroDate.appendChild(heroDateText);
  hero.appendChild(heroDate);
  view.appendChild(hero);

  const infoCard = document.createElement('div');
  infoCard.className = 'sv-mobile-info-card';
  const infoTitle = document.createElement('div');
  infoTitle.className = 'sv-mobile-info-card-title';
  infoTitle.textContent = '감독 정보';
  infoCard.appendChild(infoTitle);
  [
    ['감독명', sv.title],
    ['감독 기간', svFormatDateRangeKR(sv.start_date, sv.end_date)],
    ['감독 유형', sv.supervision_type ? SUPERVISION_TYPE_LABEL[sv.supervision_type] : '미지정'],
    ['담당 감독관', displayValue(sv.manager_name)],
    ['등록일', svFormatTimestampDateKR(sv.created_at)],
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'sv-mobile-info-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'sv-mobile-info-row-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);
    const valueEl = document.createElement('span');
    valueEl.className = 'sv-mobile-info-row-value';
    valueEl.textContent = value;
    row.appendChild(valueEl);
    infoCard.appendChild(row);
  });
  view.appendChild(infoCard);

  if (isAdmin()) {
    const actions = document.createElement('div');
    actions.className = 'sv-mobile-detail-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'sv-mobile-edit-btn';
    editBtn.textContent = '수정하기';
    editBtn.addEventListener('click', () => {
      state.supervisionMobileView = 'form';
      state.supervisionMobileFormOrigin = 'detail';
      renderSupervisionMobileHost();
    });
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'sv-mobile-delete-btn';
    deleteBtn.textContent = '삭제하기';
    deleteBtn.addEventListener('click', async () => {
      // §31: 즉시 삭제 금지, confirm 후에만 기존 deleteSupervision() 재사용.
      if (!window.confirm('이 감독일정을 삭제하시겠습니까?')) return;
      // 사용자 요청(추가 반영): 완료된 감독 기록은 실적/이력 자료로서 가치가 크므로,
      // 삭제 시 일반 confirm 외에 완료 건임을 명시한 2차 경고를 한 번 더 띄운다(DB/RLS 변경 없음, 프론트 확인 절차만 강화).
      if (liveStatus === 'done') {
        if (!window.confirm('이미 완료된 감독 기록입니다. 삭제하면 복구할 수 없습니다.\n정말 삭제하시겠습니까?')) return;
      }
      deleteBtn.disabled = true;
      const result = await deleteSupervision(sv.id);
      if (!result.success) {
        console.error('감독일정 삭제 실패:', result.message);
        deleteBtn.disabled = false;
        return;
      }
      state.supervisionMobileView = 'list';
      state.supervisionMobileSelectedId = null;
      await renderSupervisionMobileHost();
    });
    actions.appendChild(deleteBtn);
    view.appendChild(actions);
  }
}

// ============================================================
// 모바일 "사업장 데이터 관리" TARGET UI.
// 기존 PC 엑셀 업로드/검증/geocoding/import/이력 로직(parseExcelFile, runGeocodingForParsedRows,
// previewImportImpact/importSitesToDatabase, loadUploadHistory 등)만 그대로 재사용한다.
// 새 파싱/검증/geocoding/import 로직은 추가하지 않으며, 여기서는 화면 구성과
// state.uploadMobileTab(탭 상태)만 다룬다. PC 전용 고급 복구 도구(결과없음 CSV, keyword/LOT/
// JUSO/도로대표위치 재검색 등)는 TARGET 목업에 없으므로 모바일 화면에는 노출하지 않는다 —
// 기능을 삭제하는 것이 아니라 PC 화면(#upload-preview)에서는 기존 그대로 계속 쓸 수 있다.
// ============================================================

const UPLOAD_MOBILE_HOST_ID = 'upload-mobile-host';

// TARGET의 "좌표 확인 N / 확인 필요 N" 2분류로 단순화한다.
// 좌표 확인 = 위/경도가 실제로 채워진 품질(EXACT/ESTIMATED/APPROXIMATE/MANUAL).
// 확인 필요 = geocoding을 시도했지만 UNRESOLVED(결과없음/오류 포함)로 남은 건.
function getUploadLocationBuckets(rows) {
  let resolved = 0;
  let needsReview = 0;
  (rows || []).forEach(row => {
    if (['EXACT', 'ESTIMATED', 'APPROXIMATE', 'MANUAL'].includes(row._locationQuality)) resolved++;
    else if (row._geocodeStatus) needsReview++;
  });
  return { resolved, needsReview };
}

// STEP16.28: 상단 헤더(#mobile-app-header, 알림벨 왼쪽)에 "가장 최근 엑셀 업로드 일시"를
// 짧게 표시한다("M.D 업로드"). 전체 일시는 title 툴팁으로만 제공한다(헤더 공간이 좁아서).
// 업로드 이력이 아예 없거나(iso===null) 조회에 실패하면 조용히 숨긴다(에러를 사용자에게
// 노출하지 않음 — 이 배지는 참고용 편의 기능일 뿐 핵심 기능이 아니다).
function formatHeaderUploadDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}.${dd} 업로드`;
}

export async function renderHeaderUploadDate() {
  const el = document.getElementById('mobile-header-upload-date');
  if (!el) return;
  let iso = null;
  try {
    iso = await loadLastUploadAt();
  } catch (e) {
    console.warn('[헤더 업로드 날짜] 조회 실패:', e);
  }
  const text = formatHeaderUploadDate(iso);
  if (!text) {
    el.style.display = 'none';
    el.textContent = '';
    el.removeAttribute('title');
    return;
  }
  el.textContent = text;
  el.title = `최근 엑셀 업로드: ${formatUploadDateTime(iso)}`;
  el.style.display = '';
}

function formatUploadDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}. ${mm}. ${dd}. ${hh}:${mi}`;
}

function formatUploadFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// "검증 결과 자세히 보기" 바텀시트 — state.uploadParsedRows 중 VALID가 아닌 행만 나열한다.
// 기존 admin-sheet 스타일(admin-sheet-overlay/admin-sheet)을 그대로 재사용한다.
function openUploadDetailSheet() {
  const overlay = document.createElement('div');
  overlay.className = 'admin-sheet-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const sheet = document.createElement('div');
  sheet.className = 'admin-sheet';

  const title = document.createElement('div');
  title.className = 'admin-sheet-name';
  title.textContent = '검증 결과 자세히 보기';
  sheet.appendChild(title);

  const problemRows = (state.uploadParsedRows || []).filter(r => r._validation !== 'VALID');
  if (problemRows.length === 0) {
    const okMsg = document.createElement('p');
    okMsg.className = 'admin-sheet-confirm-msg';
    okMsg.textContent = '경고 또는 오류가 있는 행이 없습니다.';
    sheet.appendChild(okMsg);
  } else {
    problemRows.slice(0, 100).forEach(row => {
      const item = document.createElement('div');
      item.className = 'upload-mobile-detail-row';

      const name = row.site_name || row.company_name || '(사업장명 없음)';
      const bizNo = row.business_start_no || '(식별번호 없음)';
      const isError = row._validation === 'ERROR';

      const line1 = document.createElement('div');
      line1.className = 'upload-mobile-detail-row-title' + (isError ? ' error' : ' warn');
      line1.textContent = `[${isError ? '오류' : '경고'}] ${name} (${bizNo})`;
      item.appendChild(line1);

      const line2 = document.createElement('div');
      line2.className = 'upload-mobile-detail-row-msg';
      line2.textContent = ((isError ? row._errors : row._warnings) || []).join(', ');
      item.appendChild(line2);

      sheet.appendChild(item);
    });
    if (problemRows.length > 100) {
      const more = document.createElement('p');
      more.className = 'admin-sheet-confirm-msg';
      more.textContent = `그 외 ${problemRows.length - 100}건은 표시되지 않았습니다.`;
      sheet.appendChild(more);
    }
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'admin-sheet-cancel';
  closeBtn.textContent = '닫기';
  closeBtn.addEventListener('click', () => overlay.remove());
  sheet.appendChild(closeBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
}

// "주소 좌표 확인" 모바일 버튼 — PC의 handleGeocodeStart와 동일하게 geocoding.js의
// runGeocodingForParsedRows만 호출한다(중복 클릭 방지 플래그도 PC와 동일한 state.geocodeInProgress
// 공유). 다른 점은 렌더 대상이 모바일 컨테이너라는 것 뿐이다.
async function handleGeocodeStartMobile() {
  if (state.geocodeInProgress) return;
  state.geocodeInProgress = true;
  renderUploadMobileHost(); // 버튼 disabled/진행 UI를 시작 시 1회만 반영

  try {
    await runGeocodingForParsedRows((progress) => {
      state.geocodeProgress = progress;

      // 수천 건 처리 중 매 행마다 renderUploadMobileHost()로 화면 전체를 다시 만들면 DOM 재생성이
      // 수천 번 발생해 심하게 버벅일 수 있다. 진행 중에는 숫자/텍스트만 갱신한다.
      const progressEl = document.getElementById('upload-mobile-geocode-progress');
      if (progressEl) {
        progressEl.style.display = '';
        progressEl.textContent =
          `확인 중 ${progress.done}/${progress.total}건 · 성공 ${progress.success} · 결과없음 ${progress.notFound} · 오류 ${progress.error}`;
      }
    });
  } finally {
    state.geocodeInProgress = false;
    renderUploadMobileHost(); // 완료 결과는 마지막에 1회 전체 재렌더
  }
}

// "사업장 데이터 업로드" 모바일 버튼 — PC의 handleImportToDatabase와 동일한 흐름
// (사전 검증 -> 확인 -> RPC 실행 -> 성공 시 지도/이력 갱신)을 그대로 따른다.
async function handleImportToDatabaseMobile() {
  if (state.uploadImportInProgress || state.importPreviewInProgress) return;

  state.importPreviewInProgress = true;
  renderUploadMobileHost();

  let preview;
  try {
    preview = await previewImportImpact(state.uploadFileName, state.uploadDetectedForm);
    state.importPreview = preview;
  } finally {
    state.importPreviewInProgress = false;
    renderUploadMobileHost();
  }

  if (!preview.success) return;

  const confirmed = window.confirm(
    `전체 ${preview.total}건 중 신규 ${preview.insertCount}건, 갱신 ${preview.updateCount}건을 저장하시겠습니까?`
  );
  if (!confirmed) return;

  state.uploadImportInProgress = true;
  renderUploadMobileHost();

  try {
    const result = await importSitesToDatabase(state.uploadFileName, state.uploadDetectedForm);
    state.uploadImportResult = result;

    if (result.success) {
      const sites = await loadActiveSites();
      state.sites = sites;
      // 대량 업로드 직후에도 새 사업장 전체가 지도/관할 필터에 즉시 반영되도록 초기 로딩과 같은
      // 좌표→동 배정 절차를 거친 뒤 목록/마커를 다시 그린다(DB의 dong 값을 수정하는 작업은 아님).
      await assignDongToSites(state.sites);
      renderDongOptions();
      renderSiteList('site-list');
      await renderUploadHistoryPanel('upload-history');
    }
  } finally {
    state.uploadImportInProgress = false;
    renderUploadMobileHost();
  }
}

// TARGET ①: 아직 파일을 선택하지 않은 초기 화면.
function renderUploadMobileInitial(body, fileInput) {
  const box = document.createElement('div');
  box.className = 'upload-mobile-dropzone';

  const icon = document.createElement('div');
  icon.className = 'upload-mobile-dropzone-icon';
  icon.appendChild(buildAdminSvg('<path d="M12 3v12M7 8l5-5 5 5M5 21h14"/>'));
  box.appendChild(icon);

  const heading = document.createElement('p');
  heading.className = 'upload-mobile-dropzone-title';
  heading.textContent = '엑셀 파일 업로드';
  box.appendChild(heading);

  const guide = document.createElement('p');
  guide.className = 'upload-mobile-dropzone-desc';
  guide.textContent = '사업장 목록이 담긴 엑셀 파일을 업로드하면 자동으로 검증 후 위치 정보를 확인합니다.';
  box.appendChild(guide);

  const formatBox = document.createElement('div');
  formatBox.className = 'upload-mobile-format-box';
  formatBox.textContent = '지원 형식: XLS, XLSX';
  box.appendChild(formatBox);

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'upload-mobile-primary-btn';
  selectBtn.textContent = '파일 선택';
  selectBtn.addEventListener('click', () => fileInput && fileInput.click());
  box.appendChild(selectBtn);

  body.appendChild(box);

  const infoBox = document.createElement('div');
  infoBox.className = 'upload-mobile-info-box';
  [
    '본사명/사업장명, 산재관리번호, 사업개시번호가 포함된 양식을 지원합니다.',
    '주소가 있는 사업장은 업로드 후 자동으로 좌표를 확인합니다.',
    '기존 사업장은 사업개시번호 기준으로 갱신되고, 신규 사업장은 새로 추가됩니다.',
    '수동으로 위치를 지정한 사업장의 좌표는 엑셀 업로드로 덮어쓰지 않습니다.',
  ].forEach(text => {
    const p = document.createElement('p');
    p.textContent = `· ${text}`;
    infoBox.appendChild(p);
  });
  body.appendChild(infoBox);
}

// TARGET ②: 파일 분석/검증 완료 화면.
function renderUploadMobileAnalyzed(body, fileInput) {
  const summary = state.uploadValidationSummary || { total: 0, validCount: 0, warningCount: 0, errorCount: 0 };

  const fileCard = document.createElement('div');
  fileCard.className = 'upload-mobile-file-card';

  const fileInfo = document.createElement('div');
  fileInfo.className = 'upload-mobile-file-info';
  const fileNameEl = document.createElement('div');
  fileNameEl.className = 'upload-mobile-file-name';
  fileNameEl.textContent = state.uploadFileName || '-';
  fileInfo.appendChild(fileNameEl);
  const fileMetaEl = document.createElement('div');
  fileMetaEl.className = 'upload-mobile-file-meta';
  const currentFile = fileInput && fileInput.files && fileInput.files[0];
  fileMetaEl.textContent = currentFile ? formatUploadFileSize(currentFile.size) : '';
  fileInfo.appendChild(fileMetaEl);
  fileCard.appendChild(fileInfo);

  const changeBtn = document.createElement('button');
  changeBtn.type = 'button';
  changeBtn.className = 'upload-mobile-change-btn';
  changeBtn.textContent = '파일 변경';
  changeBtn.addEventListener('click', () => fileInput && fileInput.click());
  fileCard.appendChild(changeBtn);

  body.appendChild(fileCard);

  const grid = document.createElement('div');
  grid.className = 'upload-mobile-stat-grid';
  [
    ['전체', summary.total, ''],
    ['정상', summary.validCount, 'ok'],
    ['경고', summary.warningCount, 'warn'],
    ['오류', summary.errorCount, 'error'],
  ].forEach(([label, value, cls]) => {
    const box = document.createElement('div');
    box.className = 'upload-mobile-stat-box' + (cls ? ' ' + cls : '');
    const num = document.createElement('div');
    num.className = 'upload-mobile-stat-num';
    num.textContent = String(value ?? 0);
    box.appendChild(num);
    const lab = document.createElement('div');
    lab.className = 'upload-mobile-stat-label';
    lab.textContent = label;
    box.appendChild(lab);
    grid.appendChild(box);
  });
  body.appendChild(grid);

  const geoCard = document.createElement('div');
  geoCard.className = 'upload-mobile-card';
  const geoTitle = document.createElement('div');
  geoTitle.className = 'upload-mobile-card-title';
  geoTitle.textContent = '주소·위치 확인';
  geoCard.appendChild(geoTitle);

  const hasGeocodeRun = (state.uploadParsedRows || []).some(row => row._geocodeStatus);
  if (!hasGeocodeRun) {
    const geoDesc = document.createElement('p');
    geoDesc.className = 'upload-mobile-card-desc';
    geoDesc.textContent = '주소를 기반으로 좌표를 확인합니다.';
    geoCard.appendChild(geoDesc);

    const geoBtn = document.createElement('button');
    geoBtn.type = 'button';
    geoBtn.className = 'upload-mobile-secondary-btn';
    geoBtn.textContent = state.geocodeInProgress ? '주소 좌표 확인 중...' : '주소 좌표 확인';
    geoBtn.disabled = state.geocodeInProgress;
    geoBtn.addEventListener('click', () => handleGeocodeStartMobile());
    geoCard.appendChild(geoBtn);

    // 진행 중에는 이 DOM 한 개의 textContent만 갱신한다. 수천 건에서도 전체 화면 재렌더를 피한다.
    const progressP = document.createElement('p');
    progressP.id = 'upload-mobile-geocode-progress';
    progressP.className = 'upload-mobile-card-desc';
    if (state.geocodeProgress) {
      const p = state.geocodeProgress;
      progressP.textContent =
        `확인 중 ${p.done}/${p.total}건 · 성공 ${p.success} · 결과없음 ${p.notFound} · 오류 ${p.error}`;
    } else {
      progressP.style.display = 'none';
    }
    geoCard.appendChild(progressP);
  } else {
    const { resolved, needsReview } = getUploadLocationBuckets(state.uploadParsedRows);
    const geoGrid = document.createElement('div');
    geoGrid.className = 'upload-mobile-geo-grid';
    [
      ['좌표 확인', resolved, 'ok'],
      ['확인 필요', needsReview, needsReview > 0 ? 'warn' : 'ok'],
    ].forEach(([label, value, cls]) => {
      const box = document.createElement('div');
      box.className = 'upload-mobile-geo-box ' + cls;
      const num = document.createElement('div');
      num.className = 'upload-mobile-geo-num';
      num.textContent = String(value);
      box.appendChild(num);
      const lab = document.createElement('div');
      lab.className = 'upload-mobile-geo-label';
      lab.textContent = label;
      box.appendChild(lab);
      geoGrid.appendChild(box);
    });
    geoCard.appendChild(geoGrid);
  }
  body.appendChild(geoCard);

  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = 'upload-mobile-secondary-btn';
  detailBtn.textContent = '검증 결과 자세히 보기';
  detailBtn.addEventListener('click', openUploadDetailSheet);
  body.appendChild(detailBtn);

  if (state.uploadImportResult) {
    const r = state.uploadImportResult;
    const resultCard = document.createElement('div');
    resultCard.className = 'upload-mobile-card' + (r.success ? ' upload-mobile-result-ok' : ' upload-mobile-result-error');
    const resultTitle = document.createElement('div');
    resultTitle.className = 'upload-mobile-card-title';
    resultTitle.textContent = r.success ? '업로드 완료' : '업로드 실패';
    resultCard.appendChild(resultTitle);
    const resultDesc = document.createElement('p');
    resultDesc.className = 'upload-mobile-card-desc';
    resultDesc.textContent = r.success
      ? `전체 ${r.total_rows}건 · 신규 ${r.inserted}건 · 갱신 ${r.updated}건 · 확인필요 ${r.review_count}건`
      : (r.message || '저장에 실패했습니다.');
    resultCard.appendChild(resultDesc);
    body.appendChild(resultCard);
  } else if (state.importPreview && !state.importPreview.success) {
    const err = document.createElement('p');
    err.className = 'upload-mobile-error-text';
    err.textContent = `사전 검증 실패: ${state.importPreview.message}`;
    body.appendChild(err);
  }

  const importTargetRows = (state.uploadParsedRows || []).filter(row => row._validation !== 'ERROR');
  const canImport =
    !!state.uploadDetectedForm &&
    importTargetRows.length > 0 &&
    importTargetRows.every(row => ['EXACT', 'ESTIMATED', 'APPROXIMATE', 'UNRESOLVED'].includes(row._locationQuality)) &&
    !state.uploadImportInProgress;

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'upload-mobile-primary-btn';
  importBtn.textContent = (state.uploadImportInProgress || state.importPreviewInProgress) ? '저장 중...' : '사업장 데이터 업로드';
  importBtn.disabled = !canImport || state.importPreviewInProgress;
  importBtn.addEventListener('click', () => handleImportToDatabaseMobile());
  body.appendChild(importBtn);

  if (!canImport && !state.uploadImportInProgress) {
    const hint = document.createElement('p');
    hint.className = 'upload-mobile-card-desc';
    hint.textContent = '주소 좌표 확인을 완료한 후 저장할 수 있습니다.';
    body.appendChild(hint);
  }
}

function renderUploadMobileFile(body) {
  body.innerHTML = '';
  const fileInput = document.getElementById('upload-file-input');
  if (!state.uploadDetectedForm) {
    renderUploadMobileInitial(body, fileInput);
  } else {
    renderUploadMobileAnalyzed(body, fileInput);
  }
}

// TARGET ③: 업로드 이력 탭 — gnmap_v2_upload_history에 실제로 저장된 컬럼만 사용한다
// (신규/갱신 분리, 별도 상태 컬럼이 DB에 없으므로 review_rows>0 여부로만 배지를 구분한다).
function renderUploadMobileHistory(body) {
  body.innerHTML = '';
  const list = state.uploadHistoryList || [];

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'admin-mobile-empty';
    empty.appendChild(buildAdminSvg('<path d="M4 4h16v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Z"/><path d="M4 9h16"/><path d="M9 13h6M9 17h4"/>'));
    const p = document.createElement('p');
    p.textContent = '업로드 이력이 없습니다.';
    empty.appendChild(p);
    body.appendChild(empty);
    return;
  }

  const listEl = document.createElement('div');
  listEl.className = 'upload-mobile-history-list';
  list.forEach(h => {
    const card = document.createElement('div');
    card.className = 'upload-mobile-history-card';

    const row1 = document.createElement('div');
    row1.className = 'upload-mobile-history-row1';
    const nameEl = document.createElement('span');
    nameEl.className = 'upload-mobile-history-file';
    nameEl.textContent = h.file_name || '-';
    row1.appendChild(nameEl);

    const hasReview = (h.review_rows || 0) > 0;
    const badge = document.createElement('span');
    badge.className = 'upload-mobile-history-badge' + (hasReview ? ' warn' : ' ok');
    badge.textContent = hasReview ? '확인필요 있음' : '완료';
    row1.appendChild(badge);
    card.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'upload-mobile-history-row2';
    row2.textContent = `전체 ${h.total_rows ?? '-'}건 · 확정 ${h.confirmed_rows ?? '-'}건 · 확인필요 ${h.review_rows ?? '-'}건`;
    card.appendChild(row2);

    const row3 = document.createElement('div');
    row3.className = 'upload-mobile-history-row3';
    row3.textContent = `${h.uploaded_by_name || '-'} · ${formatUploadDateTime(h.uploaded_at)}`;
    card.appendChild(row3);

    listEl.appendChild(card);
  });
  body.appendChild(listEl);
}

// 진입점 — app.js가 (1) 업로드 패널을 열 때, (2) 파일 선택이 끝났을 때, (3) 탭 전환 시 호출한다.
// admin-mobile-view와 동일하게 항상 전체를 다시 그린다(state를 그대로 다시 읽음).
export function renderUploadMobileHost() {
  const host = document.getElementById(UPLOAD_MOBILE_HOST_ID);
  if (!host) return;
  host.innerHTML = '';

  const view = document.createElement('div');
  view.className = 'upload-mobile-view';

  // STEP16.32: 앱설정/비밀번호변경 등과 동일한 "‹ 사업장 데이터 관리" 상단 표시로 통일한다
  // (기존 브랜드/벨 헤더 + 정적 #btn-upload-close 대신).
  const { header: subHeader, backBtn } = buildSettingsSubHeader('사업장 데이터 관리');
  backBtn.addEventListener('click', () => {
    const panel = document.getElementById('upload-panel');
    if (panel) panel.style.display = 'none';
  });
  view.appendChild(subHeader);

  const desc = document.createElement('p');
  desc.className = 'sv-mobile-subtitle';
  desc.style.padding = '0 16px 12px';
  desc.textContent = '엑셀 파일로 사업장 정보를 업로드하고 이력을 확인합니다.';
  view.appendChild(desc);

  const tabs = document.createElement('div');
  tabs.className = 'admin-mobile-tabs';
  [['file', '파일 업로드'], ['history', '업로드 이력']].forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-mobile-tab' + (state.uploadMobileTab === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      if (state.uploadMobileTab === key) return;
      state.uploadMobileTab = key;
      renderUploadMobileHost();
      if (key === 'history') {
        await renderUploadHistoryPanel('upload-history');
        renderUploadMobileHost();
      }
    });
    tabs.appendChild(btn);
  });
  view.appendChild(tabs);

  const body = document.createElement('div');
  body.id = 'upload-mobile-body';
  view.appendChild(body);

  if (state.uploadMobileTab === 'history') {
    renderUploadMobileHistory(body);
  } else {
    renderUploadMobileFile(body);
  }

  host.appendChild(view);
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
      // DB 반영 성공 시에만 지도/목록을 다시 불러온다. loadActiveSites()는 내부 배치 조회로
      // 수천 건 전체를 합쳐 반환하므로, 업로드 직후에도 전체 사업장을 한 번에 지도에 반영한다.
      const sites = await loadActiveSites();
      state.sites = sites;
      await assignDongToSites(state.sites);
      renderDongOptions();
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
