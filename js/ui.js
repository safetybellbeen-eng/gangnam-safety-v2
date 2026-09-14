// ui.js — STEP 5B. 사업장 목록/상세 렌더링 및 선택 상태 연동.
// XSS 방지: DB 값(site_name/company_name/address 등)은 innerHTML 문자열 조립에 쓰지 않고
// 전부 textContent 또는 createElement 기반 DOM 생성으로만 넣는다.
import { state } from './state.js';
import { panToSite } from './map.js';

function displayValue(v) {
  return (v === null || v === undefined || v === '') ? '-' : v;
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
export function renderSiteList(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!state.sites || state.sites.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '표시할 사업장이 없습니다.';
    container.appendChild(empty);
    return;
  }

  state.sites.forEach(site => {
    const item = document.createElement('div');
    item.className = 'site-list-item';
    item.dataset.siteId = site.id;

    const title = document.createElement('div');
    title.className = 'site-list-title';
    title.textContent = site.site_name || site.company_name || '-';

    const company = document.createElement('div');
    company.className = 'site-list-company';
    company.textContent = displayValue(site.company_name);

    const address = document.createElement('div');
    address.className = 'site-list-address';
    address.textContent = displayValue(site.address);

    item.appendChild(title);
    item.appendChild(company);
    item.appendChild(address);

    item.addEventListener('click', () => selectSite(site.id));

    container.appendChild(item);
  });

  updateListActiveState();
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
