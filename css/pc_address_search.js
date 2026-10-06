// PC 상단 "일반주소 검색" — 사업장 검색과 별개로, 도로명/지번/건물·장소명을 Kakao로 검색해
// 입력창 아래 목록으로 보여주고, 결과를 누르면 지도에 임시 핀을 찍는다(DB 저장 없음).
import { searchAddressAndPlaces, showAddressSearchPin, clearAddressSearchPin } from './map.js';
import { state } from './state.js';
import { openDirections } from './nav_chooser.js';

let bound = false;

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* 아래 대체 방법 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

export function bindPcAddressSearch() {
  if (bound) return;
  const input = document.getElementById('pc-global-search-input');
  if (!input) return;
  bound = true;

  const panel = document.createElement('div');
  panel.id = 'pc-address-dropdown';
  panel.hidden = true;
  document.body.appendChild(panel);

  let timer = null;
  let token = 0;

  const place = () => {
    const r = input.closest('.pc-global-search').getBoundingClientRect();
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.width = `${Math.round(r.width)}px`;
  };
  const close = () => { panel.hidden = true; };
  const open = () => { place(); panel.hidden = false; };

  const message = (text) => {
    panel.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'pc-addr-empty';
    el.textContent = text;
    panel.appendChild(el);
    open();
  };

  const render = (results) => {
    panel.innerHTML = '';
    if (!results.length) { message('검색 결과가 없습니다. 도로명(예: 테헤란로 152)이나 건물명으로 검색해 보세요.'); return; }
    const head = document.createElement('div');
    head.className = 'pc-addr-head';
    head.textContent = `일반주소 검색 결과 ${results.length}건`;
    panel.appendChild(head);
    results.slice(0, 10).forEach((r) => {
      const item = document.createElement('div');
      item.className = 'pc-addr-item';
      const text = document.createElement('div');
      text.className = 'pc-addr-text';
      const name = document.createElement('div');
      name.className = 'pc-addr-name';
      name.textContent = r.name;
      const addr = document.createElement('div');
      addr.className = 'pc-addr-addr';
      const addrText = r.roadAddress || r.address || '';
      addr.textContent = addrText && addrText !== r.name ? addrText : (r.address && r.address !== r.name ? r.address : '');
      text.appendChild(name);
      if (addr.textContent) text.appendChild(addr);
      item.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'pc-addr-actions';
      actions.addEventListener('click', (e) => e.stopPropagation());
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = '주소복사';
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(r.roadAddress || r.address || r.name);
        copyBtn.textContent = ok ? '복사됨' : '실패';
        setTimeout(() => { copyBtn.textContent = '주소복사'; }, 1300);
      });
      const dirBtn = document.createElement('button');
      dirBtn.type = 'button';
      dirBtn.className = 'primary';
      dirBtn.textContent = '길찾기';
      dirBtn.addEventListener('click', () => openDirections(r.name, r.lat, r.lng, r.roadAddress || r.address));
      actions.appendChild(copyBtn);
      actions.appendChild(dirBtn);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        // 지도 탭이 아니면 지도 탭으로 이동해 핀을 보여준다.
        const mapTab = document.querySelector('.pc-nav-btn[data-pc-tab="map"]');
        const app = document.getElementById('app');
        if (mapTab && app && app.dataset.pcTab !== 'map') mapTab.click();
        setTimeout(() => {
          showAddressSearchPin(r.lat, r.lng);
          if (state.map && state.map.setLevel) state.map.setLevel(3);
        }, 120);
        close();
      });
      panel.appendChild(item);
    });
    open();
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { token++; close(); clearAddressSearchPin(); return; }
    const my = ++token;
    timer = setTimeout(async () => {
      message('검색 중…');
      let results = [];
      try { results = await searchAddressAndPlaces(q); } catch (e) { console.warn('[일반주소 검색] 실패:', e); }
      if (my !== token) return;
      render(results);
    }, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); }
    if (e.key === 'Enter') { e.preventDefault(); input.dispatchEvent(new Event('input')); }
  });
  input.addEventListener('focus', () => { if (panel.children.length && input.value.trim().length >= 2) open(); });
  document.addEventListener('mousedown', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || input.contains(e.target) || e.target === input) return;
    close();
  });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });
}
