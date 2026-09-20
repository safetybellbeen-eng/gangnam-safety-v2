// ui.js — STEP 6A. 사업장 목록/상세/검색/정렬 렌더링 및 선택 상태 연동.
// XSS 방지: DB 값(site_name/company_name/address 등)은 innerHTML 문자열 조립에 쓰지 않고
// 전부 textContent 또는 createElement 기반 DOM 생성으로만 넣는다.
import { state } from './state.js';
import { panToSite, renderMarkers } from './map.js';
import { getFilteredSortedSites, getDongOptions, loadActiveSites } from './sites.js';
import { isFavorite, toggleFavorite } from './favorites.js';
import { getNote, saveNote, deleteNote } from './notes.js';
import { loadUsers, setUserStatus, setUserRole } from './admin.js';
import { parseExcelFile } from './excel.js';
import { runGeocodingForParsedRows, runKeywordCandidateSearch, runKakaoLotRecovery, buildLotQueries, runJusoNormalize, buildJusoQuery, runKakaoJusoRecovery, runRoadApproximateRecovery, extractApproximateStructure } from './geocoding.js';
import { importSitesToDatabase } from './import.js';

function displayValue(v) {
  return (v === null || v === undefined || v === '') ? '-' : v;
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
    .forEach(btn => { btn.textContent = nowFavorite ? '★' : '☆'; });

  const detailFavBtn = document.getElementById('site-detail-favorite-btn');
  if (detailFavBtn && detailFavBtn.dataset.siteId === String(siteId)) {
    detailFavBtn.textContent = nowFavorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가';
  }
}

// 상세 패널에 개인 메모 섹션(제목/textarea/저장/삭제)을 추가한다.
// textarea.value만 사용하므로 XSS 위험이 없다 (innerHTML 미사용).
function renderNoteSection(panel, siteId) {
  const title = document.createElement('h3');
  title.textContent = '개인 메모';
  panel.appendChild(title);

  const existing = getNote(siteId);

  const textarea = document.createElement('textarea');
  textarea.id = 'site-note-textarea';
  textarea.value = existing ? existing.content : '';
  panel.appendChild(textarea);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = '저장';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.textContent = '삭제';

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

  panel.appendChild(saveBtn);
  panel.appendChild(deleteBtn);
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

// 목록 전체를 다시 그린다. 매번 새 DOM을 생성하므로 이전 렌더의 이벤트가 남아 누적되지 않는다.
// 검색/정렬이 적용된 파생 배열(getFilteredSortedSites)만 받아서 렌더한다 — state.sites 원본은 건드리지 않는다.
export function renderSiteList(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const visibleSites = getFilteredSortedSites();

  if (!visibleSites || visibleSites.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '표시할 사업장이 없습니다.';
    container.appendChild(empty);
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

  // STEP12-C: APPROXIMATE(동일 도로 대표 위치)인 사업장은 정확한 위치가 아님을 명확히 알린다.
  if (site.location_quality === 'APPROXIMATE') {
    const warningEl = document.createElement('p');
    warningEl.className = 'site-detail-approximate-warning';
    warningEl.textContent = '⚠ 위치 확인요망: 정확한 사업장 위치를 확인하지 못해 동일 도로상의 대표 위치에 표시했습니다.';
    panel.appendChild(warningEl);
  }

  const rows = [
    ['사업장명', site.site_name],
    ['업체명', site.company_name],
    ['주소', site.address],
    ['행정동', site.dong],
    ['공사금액', site.amount]
  ];

  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'site-detail-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'site-detail-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'site-detail-value';
    valueEl.textContent = displayValue(value);

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    panel.appendChild(row);
  });

  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.id = 'site-detail-favorite-btn';
  favBtn.dataset.siteId = String(site.id);
  favBtn.textContent = isFavorite(site.id) ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가';
  favBtn.addEventListener('click', () => handleFavoriteToggle(site.id, favBtn));
  panel.appendChild(favBtn);

  const directionsBtn = document.createElement('button');
  directionsBtn.type = 'button';
  directionsBtn.textContent = '길찾기';
  const hasValidCoord = isValidSiteCoord(site);
  directionsBtn.disabled = !hasValidCoord;
  if (hasValidCoord) {
    directionsBtn.addEventListener('click', () => {
      const url = buildKakaoDirectionsUrl(site.site_name || site.company_name, site.lat, site.lng);
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }
  panel.appendChild(directionsBtn);

  renderNoteSection(panel, site.id);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '닫기';
  closeBtn.addEventListener('click', closeDetail);
  panel.appendChild(closeBtn);
}

export function closeDetail() {
  const panel = document.getElementById('site-detail-panel');
  panel.style.display = 'none';
  panel.innerHTML = '';
  state.selectedSiteId = null;
  updateListActiveState();
}

let searchDebounceTimer = null;
let searchSortEventsbound = false;

// 행정동 select의 옵션을 state.sites 기준으로 채운다. 데이터가 갱신될 때마다 호출 가능하도록
// 매번 옵션을 새로 생성한다 (중복 누적 없음, "전체"는 항상 최상단 고정).
export function renderDongOptions() {
  const select = document.getElementById('site-dong-select');
  const currentValue = select.value || 'all';
  select.innerHTML = '';

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = '전체';
  select.appendChild(allOption);

  getDongOptions().forEach(dong => {
    const opt = document.createElement('option');
    opt.value = dong;
    opt.textContent = dong;
    select.appendChild(opt);
  });

  // 이전 선택값이 새 옵션 목록에도 있으면 유지, 없으면 전체로.
  select.value = [...select.options].some(o => o.value === currentValue) ? currentValue : 'all';
  state.selectedDong = select.value;
}

// 검색 input/정렬 select/행정동 select/금액 select 이벤트를 1회만 바인딩한다 (중복 등록 방지 플래그).
// 검색은 200ms debounce, 나머지는 즉시 반영. 모두 state 값만 갱신하고 렌더는 renderSiteList가 담당한다.
export function bindSearchAndSort(containerId) {
  if (searchSortEventsbound) return;
  searchSortEventsbound = true;

  const searchInput = document.getElementById('site-search-input');
  const sortSelect = document.getElementById('site-sort-select');
  const dongSelect = document.getElementById('site-dong-select');
  const amountSelect = document.getElementById('site-amount-select');

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.searchQuery = searchInput.value.trim();
      renderSiteList(containerId);
    }, 200);
  });

  sortSelect.addEventListener('change', () => {
    state.sortMode = sortSelect.value;
    renderSiteList(containerId);
  });

  dongSelect.addEventListener('change', () => {
    state.selectedDong = dongSelect.value;
    renderSiteList(containerId);
  });

  amountSelect.addEventListener('change', () => {
    state.amountFilter = amountSelect.value;
    renderSiteList(containerId);
  });
}

// 회원관리 패널을 렌더한다. loadUsers()로 채워진 state.adminUsers를 그린다 (관리자 전용).
// 상태/역할은 select 변경만으로 DB에 반영되지 않고, 각자 "저장" 버튼을 눌러야 RPC가 호출된다.
export async function renderAdminPanel(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

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

      // STEP12-C: geocoding 결과를 실제 DB(gnmap_v2_sites)에 반영한다. 버튼을 눌러야만 실행되며
      // 자동 실행은 없다. ERROR 행은 애초에 payload에서 제외된다(import.js).
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.id = 'btn-import-to-db';
      importBtn.textContent = 'DB에 저장';
      importBtn.disabled = state.uploadImportInProgress;
      importBtn.addEventListener('click', () => handleImportToDatabase(containerId));
      geocodeSection.appendChild(importBtn);

      if (state.uploadImportResult) {
        const r = state.uploadImportResult;
        const importResultEl = document.createElement('p');
        importResultEl.id = 'import-result-summary';
        importResultEl.textContent = r.success
          ? `저장 완료 · 전체 ${r.total_rows}건 · 신규 ${r.inserted}건 · 갱신 ${r.updated}건 · 확인필요 ${r.review_count}건`
          : `저장 실패: ${r.message}`;
        geocodeSection.appendChild(importResultEl);
      }
    }
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

// STEP12-C: geocoding 결과를 실제 DB에 반영한다. 성공 시에만 지도/목록을 새로고침하며,
// initApp()(전체 재인증/재초기화)은 호출하지 않는다 — loadActiveSites + renderSiteList만 재실행한다.
// 실패해도 state.uploadParsedRows(파싱/검증/geocoding 결과)는 그대로 유지되어 업로드 패널이 안 사라진다.
async function handleImportToDatabase(containerId) {
  if (state.uploadImportInProgress) return;
  state.uploadImportInProgress = true;
  renderUploadPreview(containerId); // 버튼 disabled 즉시 반영

  try {
    const result = await importSitesToDatabase(state.uploadFileName, state.uploadDetectedForm);
    state.uploadImportResult = result;

    if (result.success) {
      // DB 반영 성공 시에만 지도/목록을 다시 불러온다. 로그인/지도 재초기화는 하지 않는다.
      const sites = await loadActiveSites();
      state.sites = sites;
      renderSiteList('site-list');
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
