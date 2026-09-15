// ui.js — STEP 6A. 사업장 목록/상세/검색/정렬 렌더링 및 선택 상태 연동.
// XSS 방지: DB 값(site_name/company_name/address 등)은 innerHTML 문자열 조립에 쓰지 않고
// 전부 textContent 또는 createElement 기반 DOM 생성으로만 넣는다.
import { state } from './state.js';
import { panToSite, renderMarkers } from './map.js';
import { getFilteredSortedSites, getDongOptions } from './sites.js';
import { isFavorite, toggleFavorite } from './favorites.js';
import { getNote, saveNote, deleteNote } from './notes.js';
import { loadUsers, setUserStatus, setUserRole } from './admin.js';
import { parseExcelFile } from './excel.js';
import { runGeocodingForParsedRows } from './geocoding.js';

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
      const labelMap = { SUCCESS: '좌표 확인됨', NOT_FOUND: '주소 검색결과 없음', ERROR: '좌표 확인 실패', PENDING: '확인 대기' };
      geoEl.textContent = labelMap[row._geocodeStatus] || row._geocodeStatus;
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
