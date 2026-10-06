// pc_admin.js — PC(데스크톱) 전용 "회원관리" 화면(확정 시안).
// 모바일/TWA 화면은 전혀 건드리지 않는다: 이 파일이 그리는 #pc-admin-page는 css/desktop.css의
// @media (min-width:769px) 안에서만 보이고, js/app.js의 activatePcTab()(모바일 폭에서는 즉시 return)
// 에서만 호출된다.
//
// 데이터/권한은 기존 js/admin.js만 재사용한다(loadUsers / setUserStatus / setUserRole /
// resetUserPassword / deleteRejectedProfile). profiles 테이블을 직접 수정하지 않고, 실제 권한 검증은
// 기존과 같이 DB RPC/Edge Function이 최종적으로 한다(UI 숨김만 믿지 않는다).
// DB(gnmap_v2_profiles)에는 소속/연락처/직급 컬럼이 없으므로 시안의 해당 항목은 임의 값을 만들지 않고 뺐다.
import { state } from './state.js';
import { isAdmin, isMaster } from './auth.js';
import { loadUsers, setUserStatus, setUserRole, resetUserPassword, deleteRejectedProfile } from './admin.js';
import { showToast } from './ui.js';

const pad2 = (n) => String(n).padStart(2, '0');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS_META = {
  pending: { label: '승인대기', cls: 'is-pending' },
  approved: { label: '승인완료', cls: 'is-approved' },
  rejected: { label: '거절', cls: 'is-rejected' },
  disabled: { label: '휴면', cls: 'is-disabled' },
};
const ROLE_LABEL = { user: '일반 사용자', admin: '관리자', master: '마스터관리자' };

function fmtDate(iso, withWeekday) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const base = `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  return withWeekday ? `${base} (${WD[d.getDay()]})` : base;
}
function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
const ICONS = {
  users: '<circle cx="9" cy="8" r="3.2" fill="currentColor" stroke="none"/><path d="M3 19c0-3.4 2.7-5.6 6-5.6s6 2.2 6 5.6z" fill="currentColor" stroke="none"/><circle cx="17" cy="9" r="2.4" fill="currentColor" stroke="none" opacity=".75"/><path d="M16 13.6c3 0 5 1.9 5 4.9h-4.4c0-1.9-.5-3.5-1.6-4.6z" fill="currentColor" stroke="none" opacity=".75"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5" stroke-width="3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18" stroke-width="3"/>',
  person: '<circle cx="12" cy="8.5" r="4" fill="currentColor" stroke="none"/><path d="M4.5 21c0-4.6 3.4-7 7.5-7s7.5 2.4 7.5 7z" fill="currentColor" stroke="none"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  sort: '<path d="m8 10 4-4 4 4M8 14l4 4 4-4"/>',
  sortDown: '<path d="m7 9 5 6 5-6" fill="currentColor"/>',
  sortUp: '<path d="m7 15 5-6 5 6" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 11v6" stroke="#fff" stroke-width="2.2"/><circle cx="12" cy="7.6" r="1.3" fill="#fff" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  dots: '<circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"/>',
  first: '<path d="m12 7-5 5 5 5M18 7l-5 5 5 5"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  last: '<path d="m6 7 5 5-5 5M12 7l5 5-5 5"/>',
};
function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size || 20));
  svg.setAttribute('height', String(size || 20));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// ---------- 모달 ----------
function openModal(content, opts) {
  const overlay = el('div', 'pc-modal-overlay');
  const box = el('div', 'pc-modal');
  if (opts && opts.narrow) box.classList.add('is-narrow');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.appendChild(content);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  return { close };
}

function confirmModal({ title, message, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const wrap = el('div', 'pc-modal-body');
    const head = el('div', 'pc-modal-head');
    head.appendChild(el('h3', '', title));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'pc-ad-confirm-msg', message));
    const actions = el('div', 'pc-modal-actions');
    const cancel = el('button', 'pc-sv-secondary-btn', '취소');
    cancel.type = 'button';
    const ok = el('button', danger ? 'pc-sv-danger-btn' : 'pc-sv-primary-btn', confirmLabel || '확인');
    ok.type = 'button';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    wrap.appendChild(actions);
    let done = false;
    const { close } = openModal(wrap, { narrow: true });
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    // 배경 클릭/Esc로 닫히는 경우를 취소로 처리한다.
    const obs = new MutationObserver(() => { if (!document.body.contains(wrap)) { obs.disconnect(); finish(false); } });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

function passwordModal(tempPassword) {
  const wrap = el('div', 'pc-modal-body');
  const head = el('div', 'pc-modal-head');
  head.appendChild(el('h3', '', '비밀번호 초기화 완료'));
  wrap.appendChild(head);
  wrap.appendChild(el('p', 'pc-ad-confirm-msg', '아래 임시 비밀번호를 회원에게 별도의 안전한 방법으로 전달해주세요. 이 창을 닫으면 다시 확인할 수 없습니다.'));
  const row = el('div', 'pc-ad-pw-row');
  row.appendChild(el('code', 'pc-ad-pw-box', tempPassword));
  const copy = el('button', 'pc-sv-secondary-btn is-small', '복사');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(tempPassword); ok = true; }
    } catch (e) { /* fallback */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = tempPassword; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch (e) { /* ignore */ }
    }
    copy.textContent = ok ? '복사됨' : '복사 실패';
    setTimeout(() => { copy.textContent = '복사'; }, 1500);
  });
  row.appendChild(copy);
  wrap.appendChild(row);
  const actions = el('div', 'pc-modal-actions');
  const done = el('button', 'pc-sv-primary-btn', '확인');
  done.type = 'button';
  actions.appendChild(done);
  wrap.appendChild(actions);
  const { close } = openModal(wrap, { narrow: true });
  done.addEventListener('click', close);
}

// ---------- 상태 ----------
const AD = {
  status: 'all',      // 'all' | pending | approved | rejected | disabled
  role: 'all',        // 'all' | user | admin | master
  q: '',
  sort: 'desc',       // 가입일 정렬
  page: 1,
  size: 10,
  selectedId: null,
  checked: new Set(),
  loadError: false,
  loaded: false,
};
let adMenuCleanup = null;

function currentUserId() { return state.user && state.user.id; }

function filteredUsers() {
  const q = AD.q.trim().toLowerCase();
  const rows = (state.adminUsers || []).filter((u) => {
    if (AD.status !== 'all' && u.status !== AD.status) return false;
    if (AD.role !== 'all' && u.role !== AD.role) return false;
    if (q) {
      const hay = `${u.name || ''} ${u.email || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  rows.sort((a, b) => {
    const r = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    return AD.sort === 'asc' ? r : -r;
  });
  return rows;
}

// 상태별로 실제 지원되는 조치만 나열한다(모바일 getAdminActionsForStatus와 같은 규칙).
function actionsFor(u) {
  if (u.id === currentUserId()) return [];
  const DELETE = { type: 'delete-rejected', label: '완전 삭제', danger: true, confirm: '이 회원 데이터를 완전히 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.' };
  if (u.status === 'pending') {
    return [
      { key: 'approved', type: 'status', label: '승인 처리', primary: true, icon: 'check', confirm: `"${u.name || u.email}" 회원의 가입을 승인하시겠습니까?` },
      { key: 'rejected', type: 'status', label: '반려 처리', danger: true, icon: 'x', confirm: '이 회원의 가입을 반려(승인 거절)하시겠습니까?' },
    ];
  }
  if (u.status === 'approved') {
    return [
      { type: 'reset-password', label: '비밀번호 초기화', danger: true, confirm: '이 회원의 비밀번호를 초기화하시겠습니까? 새 임시 비밀번호가 발급됩니다.' },
      { key: 'disabled', type: 'status', label: '휴면 전환', danger: true, confirm: '이 회원을 휴면 상태로 전환하시겠습니까?' },
    ];
  }
  if (u.status === 'rejected') {
    return [{ key: 'approved', type: 'status', label: '재승인', primary: true, icon: 'check', confirm: '이 회원을 승인하시겠습니까?' }, DELETE];
  }
  if (u.status === 'disabled') {
    return [{ key: 'approved', type: 'status', label: '재활성화', primary: true, icon: 'check', confirm: '이 회원을 다시 활성화하시겠습니까?' }, DELETE];
  }
  return [];
}

async function runAction(u, action) {
  const ok = await confirmModal({
    title: action.label,
    message: action.confirm,
    confirmLabel: action.label,
    danger: !!action.danger,
  });
  if (!ok) return;
  if (!state.adminUserInFlight) state.adminUserInFlight = new Set();
  if (state.adminUserInFlight.has(u.id)) return;
  state.adminUserInFlight.add(u.id);
  try {
    let result;
    if (action.type === 'reset-password') {
      result = await resetUserPassword(u.id);
      if (!result.ok) { showToast(result.message || '비밀번호 초기화에 실패했습니다.'); return; }
      passwordModal(result.tempPassword);
      return;
    }
    if (action.type === 'delete-rejected') result = await deleteRejectedProfile(u.id);
    else if (action.type === 'role') result = await setUserRole(u.id, action.key);
    else result = await setUserStatus(u.id, action.key);
    if (!result.ok) { showToast(result.message || '처리에 실패했습니다.'); return; }
    showToast('처리되었습니다.', 'success');
  } finally {
    state.adminUserInFlight.delete(u.id);
  }
  // 서버가 최종 진실이므로 값을 추정하지 않고 다시 조회한다.
  await loadUsers();
  AD.checked.delete(u.id);
  if (!(state.adminUsers || []).some(x => x.id === AD.selectedId)) AD.selectedId = null;
  paint();
}

function openRoleModal(u) {
  const wrap = el('div', 'pc-modal-body');
  const head = el('div', 'pc-modal-head');
  head.appendChild(el('h3', '', '회원 권한 수정'));
  const closeBtn = el('button', 'pc-modal-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.appendChild(icon('close', 20));
  head.appendChild(closeBtn);
  wrap.appendChild(head);
  wrap.appendChild(el('p', 'pc-ad-confirm-msg', `"${u.name || u.email}" 회원의 권한을 선택하세요.`));
  const list = el('div', 'pc-ad-role-list');
  const { close } = openModal(wrap, { narrow: true });
  ['user', 'admin', 'master'].forEach((r) => {
    const isCur = r === u.role;
    const b = el('button', 'pc-ad-role-btn' + (isCur ? ' is-current' : ''), ROLE_LABEL[r] + (isCur ? ' (현재)' : ''));
    b.type = 'button';
    b.disabled = isCur;
    b.addEventListener('click', () => {
      close();
      runAction(u, { type: 'role', key: r, label: '권한 변경', confirm: `이 회원의 권한을 "${ROLE_LABEL[r]}"(으)로 변경하시겠습니까?` });
    });
    list.appendChild(b);
  });
  wrap.appendChild(list);
  closeBtn.addEventListener('click', close);
}

// ---------- 화면 ----------
export async function renderPcAdminPage() {
  const root = document.getElementById('pc-admin-page');
  if (!root) return;
  if (!isAdmin()) {
    root.innerHTML = '';
    root.appendChild(el('p', 'pc-ad-denied', '회원관리는 관리자만 이용할 수 있습니다.'));
    return;
  }
  AD.status = 'all'; AD.role = 'all'; AD.q = ''; AD.page = 1; AD.checked = new Set();
  await loadUsers();
  AD.loadError = !!state.adminLoadError;
  AD.loaded = true;
  const rows = filteredUsers();
  if (!rows.some(u => u.id === AD.selectedId)) AD.selectedId = rows.length ? rows[0].id : null;
  paint();
}

function closeMenu() { if (adMenuCleanup) { adMenuCleanup(); adMenuCleanup = null; } }

function paint() {
  const root = document.getElementById('pc-admin-page');
  if (!root) return;
  closeMenu();
  const keepSearchFocus = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('pc-ad-search-input');
  const caret = keepSearchFocus ? document.activeElement.selectionStart : null;
  root.innerHTML = '';

  const titleBlock = el('div', 'pc-np-titleblock pc-ad-titleblock');
  titleBlock.appendChild(el('h2', 'pc-np-title', '회원관리'));
  titleBlock.appendChild(el('p', 'pc-np-subtitle', '사용자 계정과 승인 상태를 관리합니다.'));
  root.appendChild(titleBlock);

  if (AD.loadError) {
    const err = el('div', 'pc-sv-error');
    err.appendChild(el('p', '', '회원 목록을 불러오지 못했습니다.'));
    const retry = el('button', 'pc-sv-secondary-btn', '다시 시도');
    retry.type = 'button';
    retry.addEventListener('click', () => renderPcAdminPage());
    err.appendChild(retry);
    root.appendChild(err);
    return;
  }

  const all = state.adminUsers || [];
  const count = (st) => all.filter(u => u.status === st).length;

  const grid = el('div', 'pc-ad-grid');
  const main = el('div', 'pc-ad-main');

  // ---- 통계 카드
  const stats = el('div', 'pc-ad-stats');
  [
    ['total', 'users', '전체 회원', all.length],
    ['pending', 'clock', '승인대기', count('pending')],
    ['approved', 'check', '승인완료', count('approved')],
    ['rejected', 'x', '거절', count('rejected')],
  ].forEach(([key, ic, label, n]) => {
    const card = el('div', `pc-ad-stat is-${key}`);
    const iconBox = el('span', 'pc-ad-stat-icon');
    iconBox.appendChild(icon(ic, key === 'total' ? 28 : 26));
    card.appendChild(iconBox);
    const text = el('div', 'pc-ad-stat-text');
    text.appendChild(el('span', '', label));
    const num = el('strong', '');
    num.appendChild(document.createTextNode(String(n)));
    num.appendChild(el('small', '', '명'));
    text.appendChild(num);
    card.appendChild(text);
    stats.appendChild(card);
  });
  main.appendChild(stats);

  // ---- 상태 탭
  const tabs = el('div', 'pc-ad-tabs');
  [['all', '전체', all.length], ['pending', '승인대기', count('pending')], ['approved', '승인완료', count('approved')], ['rejected', '거절', count('rejected')], ['disabled', '휴면', count('disabled')]].forEach(([key, label, n]) => {
    const b = el('button', 'pc-ad-tab' + (AD.status === key ? ' active' : ''), `${label} (${n})`);
    b.type = 'button';
    b.addEventListener('click', () => { AD.status = key; AD.page = 1; paint(); });
    tabs.appendChild(b);
  });
  main.appendChild(tabs);

  // ---- 검색 줄
  const bar = el('div', 'pc-ad-searchrow');
  const sbox = el('label', 'pc-ad-searchbox');
  sbox.appendChild(icon('search', 22));
  const sinput = el('input', 'pc-ad-search-input');
  sinput.type = 'search';
  sinput.placeholder = '이름, 계정(이메일)을 검색하세요.';
  sinput.value = AD.q;
  sinput.addEventListener('input', () => { AD.q = sinput.value; AD.page = 1; paint(); });
  sbox.appendChild(sinput);
  bar.appendChild(sbox);
  const mkSelect = (opts, value, onChange) => {
    const wrap = el('label', 'pc-ad-select');
    const sel = el('select', '');
    opts.forEach(([v, label]) => { const o = el('option', '', label); o.value = v; if (v === value) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', () => onChange(sel.value));
    wrap.appendChild(sel);
    wrap.appendChild(icon('chevronDown', 18));
    return wrap;
  };
  bar.appendChild(mkSelect([['all', '전체 권한'], ['user', '일반 사용자'], ['admin', '관리자'], ['master', '마스터관리자']], AD.role, (v) => { AD.role = v; AD.page = 1; paint(); }));
  bar.appendChild(mkSelect([['all', '전체 상태'], ['pending', '승인대기'], ['approved', '승인완료'], ['rejected', '거절'], ['disabled', '휴면']], AD.status, (v) => { AD.status = v; AD.page = 1; paint(); }));
  const sbtn = el('button', 'pc-ad-search-btn', '검색');
  sbtn.type = 'button';
  sbtn.addEventListener('click', () => { AD.q = sinput.value; AD.page = 1; paint(); });
  bar.appendChild(sbtn);
  main.appendChild(bar);

  // ---- 표
  const rows = filteredUsers();
  const pages = Math.max(1, Math.ceil(rows.length / AD.size));
  if (AD.page > pages) AD.page = pages;
  const pageRows = rows.slice((AD.page - 1) * AD.size, AD.page * AD.size);

  const pendingChecked = Array.from(AD.checked).filter(id => {
    const u = all.find(x => x.id === id);
    return u && u.status === 'pending' && u.id !== currentUserId();
  });
  if (pendingChecked.length > 0) {
    const bulk = el('div', 'pc-ad-bulkbar');
    bulk.appendChild(el('span', '', `승인대기 ${pendingChecked.length}명 선택됨`));
    const bb = el('button', 'pc-sv-primary-btn is-small', '일괄 승인');
    bb.type = 'button';
    bb.addEventListener('click', async () => {
      const okc = await confirmModal({ title: '일괄 승인', message: `선택한 승인대기 회원 ${pendingChecked.length}명을 모두 승인하시겠습니까?`, confirmLabel: '일괄 승인' });
      if (!okc) return;
      let fail = 0;
      for (const id of pendingChecked) {
        const r = await setUserStatus(id, 'approved');
        if (!r.ok) fail++;
      }
      showToast(fail ? `${pendingChecked.length - fail}명 승인, ${fail}명 실패` : `${pendingChecked.length}명을 승인했습니다.`, fail ? undefined : 'success');
      AD.checked = new Set();
      await loadUsers();
      paint();
    });
    bulk.appendChild(bb);
    main.appendChild(bulk);
  }

  const wrap = el('div', 'pc-ad-tablewrap');
  const table = el('table', 'pc-ad-table');
  const thead = el('thead');
  const hr = el('tr');
  const thCheck = el('th', 'pc-ad-col-check');
  const allBox = el('input', '');
  allBox.type = 'checkbox';
  allBox.setAttribute('aria-label', '현재 페이지 전체 선택');
  allBox.checked = pageRows.length > 0 && pageRows.every(u => AD.checked.has(u.id));
  allBox.addEventListener('change', () => {
    pageRows.forEach(u => { if (allBox.checked) AD.checked.add(u.id); else AD.checked.delete(u.id); });
    paint();
  });
  thCheck.appendChild(allBox);
  hr.appendChild(thCheck);
  ['사용자', '계정(이메일)', '상태'].forEach(h => hr.appendChild(el('th', '', h)));
  const thDate = el('th', 'pc-ad-th-sort');
  const dateBtn = el('button', 'pc-ad-sort-btn');
  dateBtn.type = 'button';
  dateBtn.appendChild(document.createTextNode('가입일'));
  dateBtn.appendChild(icon(AD.sort === 'asc' ? 'sortUp' : 'sortDown', 14));
  dateBtn.addEventListener('click', () => { AD.sort = AD.sort === 'asc' ? 'desc' : 'asc'; paint(); });
  thDate.appendChild(dateBtn);
  hr.appendChild(thDate);
  hr.appendChild(el('th', '', '최근접속'));
  hr.appendChild(el('th', 'pc-ad-col-act', '관리'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (pageRows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'pc-ad-empty');
    td.colSpan = 7;
    td.textContent = '조건에 맞는 회원이 없습니다.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  pageRows.forEach((u) => {
    const tr = el('tr', u.id === AD.selectedId ? 'is-selected' : '');
    const tdc = el('td', 'pc-ad-col-check');
    const cb = el('input', '');
    cb.type = 'checkbox';
    cb.checked = AD.checked.has(u.id);
    cb.setAttribute('aria-label', `${u.name || u.email} 선택`);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { if (cb.checked) AD.checked.add(u.id); else AD.checked.delete(u.id); paint(); });
    tdc.appendChild(cb);
    tr.appendChild(tdc);
    const tdu = el('td', 'pc-ad-td-user');
    tdu.appendChild(el('strong', '', u.name || '(이름 없음)'));
    tdu.appendChild(el('span', '', ROLE_LABEL[u.role] || u.role || '-'));
    tr.appendChild(tdu);
    tr.appendChild(el('td', 'pc-ad-td-email', u.email || '-'));
    const tds = el('td');
    const meta = STATUS_META[u.status] || { label: u.status || '-', cls: '' };
    tds.appendChild(el('span', `pc-ad-badge ${meta.cls}`, meta.label));
    tr.appendChild(tds);
    tr.appendChild(el('td', '', fmtDate(u.created_at)));
    tr.appendChild(el('td', '', fmtDateTime(u.last_login_at)));
    const tda = el('td', 'pc-ad-col-act');
    const dots = el('button', 'pc-ad-dots');
    dots.type = 'button';
    dots.setAttribute('aria-label', `${u.name || u.email} 관리 메뉴`);
    dots.appendChild(icon('dots', 18));
    dots.addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(dots, u); });
    tda.appendChild(dots);
    tr.appendChild(tda);
    tr.addEventListener('click', () => { AD.selectedId = u.id; paint(); });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  main.appendChild(wrap);

  // ---- 페이지 줄
  const pager = el('div', 'pc-ad-pager');
  pager.appendChild(el('span', 'pc-ad-total', `전체 ${rows.length}건`));
  const nav = el('div', 'pc-ad-pages');
  const navBtn = (ic, target, label, disabled) => {
    const b = el('button', 'pc-ad-page-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.appendChild(icon(ic, 18));
    b.addEventListener('click', () => { AD.page = target; paint(); });
    return b;
  };
  nav.appendChild(navBtn('first', 1, '처음', AD.page === 1));
  nav.appendChild(navBtn('prev', Math.max(1, AD.page - 1), '이전', AD.page === 1));
  const startP = Math.max(1, Math.min(AD.page - 2, pages - 4));
  for (let p = startP; p <= Math.min(pages, startP + 4); p++) {
    const b = el('button', 'pc-ad-page-num' + (p === AD.page ? ' active' : ''), String(p));
    b.type = 'button';
    b.addEventListener('click', () => { AD.page = p; paint(); });
    nav.appendChild(b);
  }
  nav.appendChild(navBtn('next', Math.min(pages, AD.page + 1), '다음', AD.page === pages));
  nav.appendChild(navBtn('last', pages, '마지막', AD.page === pages));
  pager.appendChild(nav);
  pager.appendChild(mkSelect([['10', '10개씩 보기'], ['20', '20개씩 보기'], ['50', '50개씩 보기']], String(AD.size), (v) => { AD.size = Number(v); AD.page = 1; paint(); }));
  main.appendChild(pager);

  grid.appendChild(main);
  grid.appendChild(buildDetail(all.find(u => u.id === AD.selectedId) || null));
  root.appendChild(grid);

  if (keepSearchFocus) {
    const ni = root.querySelector('.pc-ad-search-input');
    if (ni) { ni.focus(); try { ni.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
  }
}

function openRowMenu(anchor, u) {
  closeMenu();
  const menu = el('div', 'pc-ad-menu');
  const addItem = (label, danger, fn) => {
    const b = el('button', 'pc-ad-menu-item' + (danger ? ' is-danger' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => { closeMenu(); fn(); });
    menu.appendChild(b);
  };
  addItem('상세 보기', false, () => { AD.selectedId = u.id; paint(); });
  actionsFor(u).forEach(a => addItem(a.label, a.danger, () => runAction(u, a)));
  if (u.id !== currentUserId() && isMaster()) addItem('권한 수정', false, () => openRoleModal(u));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey);
  adMenuCleanup = () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    menu.remove();
  };
}

function buildDetail(u) {
  const panel = el('aside', 'pc-ad-detail');
  const head = el('div', 'pc-ad-detail-head');
  head.appendChild(el('strong', '', '회원 상세 정보'));
  const x = el('button', 'pc-ad-detail-close');
  x.type = 'button';
  x.setAttribute('aria-label', '닫기');
  x.appendChild(icon('close', 20));
  x.addEventListener('click', () => { AD.selectedId = null; paint(); });
  head.appendChild(x);
  panel.appendChild(head);

  if (!u) {
    panel.appendChild(el('p', 'pc-ad-detail-empty', '목록에서 회원을 선택하면 상세 정보와 관리 기능이 표시됩니다.'));
    return panel;
  }

  const prof = el('div', 'pc-ad-profile');
  const av = el('span', 'pc-ad-avatar');
  av.appendChild(icon('person', 36));
  prof.appendChild(av);
  const nm = el('div', 'pc-ad-profile-name');
  nm.appendChild(el('strong', '', u.name || '(이름 없음)'));
  nm.appendChild(el('span', '', ROLE_LABEL[u.role] || u.role || '-'));
  prof.appendChild(nm);
  const meta = STATUS_META[u.status] || { label: u.status || '-', cls: '' };
  const badge = el('span', `pc-ad-badge is-pill ${meta.cls}`);
  badge.appendChild(el('i', 'pc-ad-badge-dot'));
  badge.appendChild(document.createTextNode(meta.label));
  prof.appendChild(badge);
  panel.appendChild(prof);

  const info = el('div', 'pc-ad-info');
  const addRow = (label, value, extra) => {
    const row = el('div', 'pc-ad-info-row');
    row.appendChild(el('span', 'pc-ad-info-label', label));
    row.appendChild(el('span', 'pc-ad-info-value', value));
    if (extra) row.appendChild(extra);
    info.appendChild(row);
  };
  addRow('계정(이메일)', u.email || '-');
  addRow('가입일', fmtDate(u.created_at, true));
  addRow('최근접속', fmtDateTime(u.last_login_at));
  let roleBtn = null;
  if (u.id !== currentUserId()) {
    roleBtn = el('button', 'pc-ad-mini-btn', '권한 수정');
    roleBtn.type = 'button';
    if (isMaster()) roleBtn.addEventListener('click', () => openRoleModal(u));
    else { roleBtn.disabled = true; roleBtn.title = '마스터관리자만 회원 권한을 변경할 수 있습니다.'; }
  }
  addRow('권한', ROLE_LABEL[u.role] || u.role || '-', roleBtn);
  panel.appendChild(info);

  panel.appendChild(el('h4', 'pc-ad-detail-sub', '관리 기능'));
  const acts = actionsFor(u);
  if (u.id === currentUserId()) {
    panel.appendChild(el('p', 'pc-ad-detail-empty', '본인 계정은 이 화면에서 변경할 수 없습니다.'));
  } else {
    const primary = acts.find(a => a.primary);
    const others = acts.filter(a => !a.primary);
    if (primary) {
      const pb = el('button', 'pc-ad-act-primary');
      pb.type = 'button';
      pb.appendChild(icon(primary.icon || 'check', 20));
      pb.appendChild(document.createTextNode(primary.label));
      pb.addEventListener('click', () => runAction(u, primary));
      panel.appendChild(pb);
    }
    const grid2 = el('div', 'pc-ad-act-grid');
    others.forEach((a) => {
      const b = el('button', 'pc-ad-act' + (a.danger ? ' is-danger' : ''));
      b.type = 'button';
      if (a.icon) b.appendChild(icon(a.icon, 18));
      b.appendChild(document.createTextNode(a.label));
      b.addEventListener('click', () => runAction(u, a));
      grid2.appendChild(b);
    });
    const rb = el('button', 'pc-ad-act');
    rb.type = 'button';
    rb.appendChild(icon('gear', 18));
    rb.appendChild(document.createTextNode('권한 수정'));
    if (isMaster()) rb.addEventListener('click', () => openRoleModal(u));
    else { rb.disabled = true; rb.title = '마스터관리자만 회원 권한을 변경할 수 있습니다.'; }
    grid2.appendChild(rb);
    panel.appendChild(grid2);
  }

  const note = el('div', 'pc-ad-note');
  const nh = el('div', 'pc-ad-note-head');
  nh.appendChild(icon('info', 20));
  nh.appendChild(el('strong', '', '안내사항'));
  note.appendChild(nh);
  const ul = el('ul', '');
  [
    '승인 처리 시 해당 사용자가 시스템에 로그인할 수 있습니다.',
    '반려 처리된 회원은 로그인할 수 없으며, 이후 재승인할 수 있습니다.',
    '권한 수정은 마스터관리자만 할 수 있습니다.',
  ].forEach(t => ul.appendChild(el('li', '', t)));
  note.appendChild(ul);
  panel.appendChild(note);
  return panel;
}
