// ui.js — STEP 6A. 사업장 목록/상세/검색/정렬 렌더링 및 선택 상태 연동.
// XSS 방지: DB 값(site_name/company_name/address 등)은 innerHTML 문자열 조립에 쓰지 않고
// 전부 textContent 또는 createElement 기반 DOM 생성으로만 넣는다.
import { state } from './state.js';
import { panToSite, renderMarkers } from './map.js';
import { getFilteredSortedSites, getDongOptions } from './sites.js';
import { isFavorite, toggleFavorite } from './favorites.js';
import { getNote, saveNote, deleteNote } from './notes.js';

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
