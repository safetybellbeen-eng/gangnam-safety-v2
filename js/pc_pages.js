// pc_pages.js — PC(769px 이상) 전용 "감독일정관리" / "현장 메모" 화면(확정 시안).
// 모바일/TWA 화면은 전혀 건드리지 않는다: 이 파일이 그리는 #pc-supervision-page / #pc-notes-page는
// css/desktop.css 최상단에서 기본 display:none이고 PC 미디어쿼리 안에서만 보이며, 렌더 진입점은
// js/app.js activatePcTab()(모바일 폭이면 즉시 return)뿐이다.
// 데이터/CRUD는 기존 supervision.js(감독일정), notes.js(현장 메모)를 그대로 재사용하고 새 테이블/쿼리를
// 만들지 않는다. 감독 상태(예정/진행/완료)는 ui.js의 computeSupervisionStatus()(날짜 기반 자동 계산)
// 하나만 사용해 모바일 화면과 판정 기준이 어긋나지 않게 한다.
import { state } from './state.js';
import { loadSupervisions, createSupervision, updateSupervision, deleteSupervision } from './supervision.js';
import { saveNote, deleteNote, getNote } from './notes.js';
import { isAdmin } from './auth.js';
import { loadUsers } from './admin.js';
import { computeSupervisionStatus, todayDateString, showToast } from './ui.js';

// ------------------------------------------------------------------
// 공통 헬퍼
// ------------------------------------------------------------------
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const SV_MIN_DATE = '2000-01-01';
const SV_MAX_DATE = '2100-12-31';
const STATUS_LABEL = { scheduled: '예정', ongoing: '진행', done: '완료' };
const TYPE_LABEL = { inspection: '점검', supervision: '감독' };
const MAX_BAR_LANES = 2;

const pad2 = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = parseYMD(s);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}
function addMonths(s, n) {
  const d = parseYMD(s);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return toYMD(d);
}
function fmtDot(s) {
  if (!s) return '-';
  const d = parseYMD(s);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} (${WEEKDAYS[d.getDay()]})`;
}
function fmtRangeDot(a, b) {
  return `${fmtDot(a)}  ~  ${fmtDot(b)}`;
}
function fmtMD(s) {
  return `${s.slice(5, 7)}.${s.slice(8, 10)}`;
}
function fmtTimestampDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return fmtDot(toYMD(d));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const ICONS = {
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  play: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M10 8l6 4-6 4V8Z" fill="#fff" stroke="none"/>',
  check: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.8 12.3 2.7 2.7 5.7-5.9" stroke="#fff" stroke-width="2.2"/>',
  checkSmall: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.8 12.3 2.7 2.7 5.7-5.9" stroke="#fff" stroke-width="2.4"/>',
  warn: '<path d="M12 3.2 22 20.5H2L12 3.2Z" fill="currentColor" stroke="none"/><path d="M12 9.5v5M12 17.4v.2" stroke="#fff" stroke-width="2.2"/>',
  chevronLeft: '<path d="M15 5.5 9 12l6 6.5"/>',
  chevronRight: '<path d="M9 5.5 15 12l-6 6.5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronUp: '<path d="m6 14.5 6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-4 3.2-6.5 7-6.5s7 2.5 7 6.5"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 14h5"/>',
  info: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 11v6" stroke="#fff" stroke-width="2.2"/><circle cx="12" cy="7.6" r="1.3" fill="#fff" stroke="none"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z"/><path d="M12 1v0M4 6 2.5 5M20 6l1.5-1M2 12H.8M23.2 12H22"/>',
  building: '<rect x="6" y="4" width="12" height="16" rx="1.2"/><path d="M9 8h1.4M13.6 8H15M9 12h1.4M13.6 12H15M9 16h1.4M13.6 16H15"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// 공용 모달(감독일정 등록/수정/상세 전용). Esc/바깥 클릭으로 닫힌다.
function openModal(contentEl, extraClass) {
  const overlay = el('div', 'pc-modal-overlay');
  const box = el('div', 'pc-modal' + (extraClass ? ` ${extraClass}` : ''));
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.appendChild(contentEl);
  overlay.appendChild(box);
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { close, overlay };
}

// ==================================================================
// 감독일정관리
// ==================================================================
const SV = {
  view: 'month',            // 'month' | 'week' | 'day' | 'list'
  anchor: null,             // 현재 보고 있는 기준 날짜(YYYY-MM-DD)
  selected: null,           // 우측 "선택 날짜 일정"에 보여줄 날짜
  rows: [],
  loadError: false,
  manager: 'all',           // 'all' | 'mine' | 담당 감독관 이름
  otherMode: 'upcoming',    // 우측 '다른 날짜 일정': 'upcoming'(오늘 이후) | 'past'(오늘 이전)
};

// 담당 감독관 필터가 적용된 일정 목록
function svRows() {
  if (SV.manager === 'all') return SV.rows;
  if (SV.manager === 'mine') {
    const me = ((state.profile && state.profile.name) || '').trim();
    return me ? SV.rows.filter(sv => (sv.manager_name || '').includes(me)) : [];
  }
  return SV.rows.filter(sv => (sv.manager_name || '') === SV.manager);
}
// 감독/점검 구분: supervision_type 이 'inspection' 이면 점검, 그 외(감독 또는 미지정)는 감독으로 본다.
function svKind(sv) { return sv.supervision_type === 'inspection' ? 'ins' : 'sup'; }
const SV_KIND_LABEL = { sup: '감독', ins: '점검' };
function svDotClass(sv) { return 'pc-sv-dot is-kind-' + svKind(sv); }

// 30일 이상 이어지는 장기 일정은 달력 칸을 차지하지 않고 위쪽 띠로 보여준다.
const SV_LONG_DAYS = 30;
function svIsLong(sv) { return (parseYMD(sv.end_date) - parseYMD(sv.start_date)) / 86400000 >= SV_LONG_DAYS; }

// 담당 감독관 이니셜/색(이름 순서대로 고정 배정)
const SV_MGR_COLORS = ['#6a3fb5', '#0b7a6b', '#a35a14', '#4b5563', '#a3338c', '#2a7a2a', '#8a6d00', '#1c6fa8'];
function svMgrNames() {
  return Array.from(new Set(SV.rows.map(sv => (sv.manager_name || '').trim()).filter(Boolean))).sort();
}
function svMgrInitial(name) { const t = (name || '').trim(); return t ? Array.from(t)[0] : ''; }
function svMgrColor(name) {
  const i = svMgrNames().indexOf((name || '').trim());
  return SV_MGR_COLORS[(i < 0 ? 0 : i) % SV_MGR_COLORS.length];
}
function buildAvatar(name) {
  const a = el('span', 'pc-sv-av', svMgrInitial(name));
  a.style.setProperty('--mc', svMgrColor(name));
  a.setAttribute('aria-hidden', 'true');
  return a;
}

function svTone(sv) {
  const status = computeSupervisionStatus(sv.start_date, sv.end_date);
  if (status === 'done') return 'done';
  if (status === 'ongoing') return 'ongoing';
  return sv.start_date !== sv.end_date ? 'period' : 'scheduled';
}
function svOverlapsDate(sv, d) { return sv.start_date <= d && d <= sv.end_date; }
function svOverlapsRange(sv, a, b) { return sv.start_date <= b && sv.end_date >= a; }
function monthRange(anchor) {
  const d = parseYMD(anchor);
  return [toYMD(new Date(d.getFullYear(), d.getMonth(), 1)), toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
}
function weekStartOf(s) {
  const d = parseYMD(s);
  d.setDate(d.getDate() - d.getDay());
  return toYMD(d);
}
function monthMatrix(anchor) {
  const d = parseYMD(anchor);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const c = new Date(start);
    c.setDate(start.getDate() + i);
    cells.push(toYMD(c));
  }
  const month = d.getMonth();
  const lastRowOutside = cells.slice(35).every(s => parseYMD(s).getMonth() !== month);
  return lastRowOutside ? cells.slice(0, 35) : cells;
}
function sortEvents(list) {
  return [...list].sort((a, b) => a.start_date.localeCompare(b.start_date) || (b.end_date.localeCompare(a.end_date)) || (a.title || '').localeCompare(b.title || ''));
}

function periodTitle() {
  const d = parseYMD(SV.anchor);
  if (SV.view === 'day') return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  if (SV.view === 'week') {
    const ws = parseYMD(weekStartOf(SV.anchor));
    const we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    if (ws.getMonth() === we.getMonth()) return `${ws.getFullYear()}년 ${ws.getMonth() + 1}월 ${ws.getDate()}일 ~ ${we.getDate()}일`;
    return `${ws.getMonth() + 1}월 ${ws.getDate()}일 ~ ${we.getMonth() + 1}월 ${we.getDate()}일`;
  }
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
function shiftPeriod(dir) {
  if (SV.view === 'day') SV.anchor = addDays(SV.anchor, dir);
  else if (SV.view === 'week') SV.anchor = addDays(SV.anchor, 7 * dir);
  else SV.anchor = addMonths(SV.anchor, dir);
  // 보고 있는 구간 밖으로 이동하면 선택 날짜도 같이 옮겨 우측 패널이 항상 화면의 기간과 맞게 한다.
  if (SV.view === 'day') SV.selected = SV.anchor;
  else if (SV.view === 'week') {
    const ws = weekStartOf(SV.anchor);
    if (SV.selected < ws || SV.selected > addDays(ws, 6)) SV.selected = ws;
  } else {
    const [a, b] = monthRange(SV.anchor);
    if (SV.selected < a || SV.selected > b) SV.selected = a;
  }
}

export async function renderPcSupervisionPage() {
  const root = document.getElementById('pc-supervision-page');
  if (!root) return;
  if (!SV.anchor) { SV.anchor = todayDateString(); SV.selected = SV.anchor; }
  // 탭에 들어올 때마다 최신 데이터를 다시 조회한다(다른 기기/관리자가 등록한 일정 반영).
  const rows = await loadSupervisions();
  SV.rows = rows;
  SV.loadError = !!state.supervisionsLoadError;
  paintSupervisionPage();
}

function rerenderSv() { paintSupervisionPage(); }

async function refreshSv() {
  SV.rows = await loadSupervisions();
  SV.loadError = !!state.supervisionsLoadError;
  paintSupervisionPage();
}

function paintSupervisionPage() {
  const root = document.getElementById('pc-supervision-page');
  if (!root) return;
  closeDayPopover();
  closeSvTip();
  root.innerHTML = '';

  const admin = isAdmin();

  // ---- 제목 줄
  const titleBar = el('div', 'pc-sv-titlebar');
  const titleWrap = el('div', 'pc-sv-title-wrap');
  titleWrap.appendChild(el('h2', 'pc-sv-title', '감독일정관리'));
  titleWrap.appendChild(el('p', 'pc-sv-subtitle', '예정된 감독 일정을 확인하고 관리합니다.'));
  titleBar.appendChild(titleWrap);
  const rightBox = el('div', 'pc-sv-titlebar-right');
  const names = Array.from(new Set(SV.rows.map(sv => (sv.manager_name || '').trim()).filter(Boolean))).sort();
  const filterWrap = el('label', 'pc-sv-filter');
  filterWrap.appendChild(el('span', '', '담당 감독관'));
  const filterSel = el('select', 'pc-sv-filter-select');
  [['all', '전체 일정'], ['mine', '내 일정'], ...names.map(n => [n, n])].forEach(([v, label]) => {
    const o = el('option', '', label);
    o.value = v;
    if (SV.manager === v) o.selected = true;
    filterSel.appendChild(o);
  });
  filterSel.addEventListener('change', () => { SV.manager = filterSel.value; rerenderSv(); });
  filterWrap.appendChild(filterSel);
  rightBox.appendChild(filterWrap);
  titleBar.appendChild(rightBox);
  if (admin) {
    const addBtn = el('button', 'pc-sv-add-btn');
    addBtn.type = 'button';
    addBtn.appendChild(icon('plus', 20));
    addBtn.appendChild(el('span', '', '감독일정 등록'));
    addBtn.addEventListener('click', () => openSvFormModal(null));
    rightBox.appendChild(addBtn);
  }
  root.appendChild(titleBar);

  if (SV.loadError) {
    const err = el('div', 'pc-sv-error');
    err.appendChild(el('p', '', '감독일정 정보를 불러오지 못했습니다.'));
    const retry = el('button', 'pc-sv-secondary-btn', '다시 시도');
    retry.type = 'button';
    retry.addEventListener('click', () => renderPcSupervisionPage());
    err.appendChild(retry);
    root.appendChild(err);
    return;
  }

  // ---- 통계 카드 + 기간 이동/보기 전환 툴바
  const [mStart, mEnd] = monthRange(SV.anchor);
  const monthRows = svRows().filter(sv => svOverlapsRange(sv, mStart, mEnd));
  const rowsOf = (st) => st === 'total' ? monthRows : monthRows.filter(sv => computeSupervisionStatus(sv.start_date, sv.end_date) === st);

  const topLine = el('div', 'pc-sv-topline');
  const stats = el('div', 'pc-sv-stats');
  [
    ['total', 'calendar', '전체 일정'],
    ['scheduled', 'clock', '예정'],
    ['ongoing', 'play', '진행'],
    ['done', 'check', '완료'],
  ].forEach(([key, ic, label]) => {
    const list = rowsOf(key);
    const count = list.length;
    const supN = list.filter(sv => svKind(sv) === 'sup').length;
    const card = el('div', `pc-sv-stat pc-sv-stat-${key}`);
    const iconBox = el('span', 'pc-sv-stat-icon');
    iconBox.appendChild(icon(ic, key === 'total' ? 26 : 30));
    card.appendChild(iconBox);
    const text = el('div', 'pc-sv-stat-text');
    text.appendChild(el('span', 'pc-sv-stat-label', label));
    const num = el('strong', 'pc-sv-stat-num');
    num.appendChild(document.createTextNode(String(count)));
    num.appendChild(el('small', '', '건'));
    text.appendChild(num);
    const sub = el('span', 'pc-sv-stat-sub');
    sub.appendChild(el('b', 'is-sup', `감독 ${supN}`));
    sub.appendChild(document.createTextNode(' · '));
    sub.appendChild(el('b', 'is-ins', `점검 ${count - supN}`));
    text.appendChild(sub);
    card.appendChild(text);
    stats.appendChild(card);
  });
  topLine.appendChild(stats);

  const toolbar = el('div', 'pc-sv-toolbar');
  const nav = el('div', 'pc-sv-nav');
  const todayBtn = el('button', 'pc-sv-today-btn', '오늘');
  todayBtn.type = 'button';
  todayBtn.addEventListener('click', () => {
    SV.anchor = todayDateString();
    SV.selected = SV.anchor;
    rerenderSv();
  });
  nav.appendChild(todayBtn);
  const prev = el('button', 'pc-sv-nav-btn');
  prev.type = 'button';
  prev.setAttribute('aria-label', '이전');
  prev.appendChild(icon('chevronLeft', 18));
  prev.addEventListener('click', () => { shiftPeriod(-1); rerenderSv(); });
  nav.appendChild(prev);
  nav.appendChild(el('strong', 'pc-sv-period', periodTitle()));
  const next = el('button', 'pc-sv-nav-btn');
  next.type = 'button';
  next.setAttribute('aria-label', '다음');
  next.appendChild(icon('chevronRight', 18));
  next.addEventListener('click', () => { shiftPeriod(1); rerenderSv(); });
  nav.appendChild(next);
  toolbar.appendChild(nav);

  const seg = el('div', 'pc-sv-seg');
  [['month', '월'], ['week', '주'], ['day', '일'], ['list', '목록']].forEach(([key, label]) => {
    const b = el('button', 'pc-sv-seg-btn' + (SV.view === key ? ' active' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => {
      SV.view = key;
      if (key === 'day') SV.anchor = SV.selected;
      rerenderSv();
    });
    seg.appendChild(b);
  });
  toolbar.appendChild(seg);
  topLine.appendChild(toolbar);
  root.appendChild(topLine);
  const subRow = buildSvSubRow();
  if (subRow) root.appendChild(subRow);

  // ---- 본문: 좌측(달력/주/일/목록) + 우측(선택 날짜 일정 / 다른 날짜 일정)
  const body = el('div', 'pc-sv-body');
  const mainCard = el('div', 'pc-sv-main');
  if (SV.view === 'month') buildMonthView(mainCard);
  else if (SV.view === 'week') buildWeekView(mainCard);
  else if (SV.view === 'day') buildDayView(mainCard);
  else buildListView(mainCard);
  if (SV.view === 'month' || SV.view === 'week') mainCard.appendChild(buildLegend());
  body.appendChild(mainCard);
  body.appendChild(buildSidePanel());
  root.appendChild(body);
}

function buildLegend() {
  const legend = el('div', 'pc-sv-legend');
  [['sup', '감독'], ['ins', '점검']].forEach(([k, label]) => {
    const item = el('span', 'pc-sv-legend-item');
    item.appendChild(el('i', `pc-sv-swatch is-kind-${k}`));
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  });
  legend.appendChild(el('span', 'pc-sv-legend-sep'));
  const done = el('span', 'pc-sv-legend-item');
  done.appendChild(el('i', 'pc-sv-swatch is-kind-sup is-faded'));
  done.appendChild(document.createTextNode('흐림 = 완료'));
  legend.appendChild(done);
  const av = el('span', 'pc-sv-legend-item');
  const sample = el('span', 'pc-sv-av', '김');
  sample.style.setProperty('--mc', SV_MGR_COLORS[0]);
  av.appendChild(sample);
  av.appendChild(document.createTextNode('담당 감독관'));
  legend.appendChild(av);
  const dd = el('span', 'pc-sv-legend-item');
  dd.appendChild(el('span', 'pc-sv-dday', 'D-3'));
  dd.appendChild(document.createTextNode('곧 시작'));
  legend.appendChild(dd);
  const tl = el('span', 'pc-sv-legend-item');
  tl.appendChild(el('i', 'pc-sv-legend-todayline'));
  tl.appendChild(document.createTextNode('오늘'));
  legend.appendChild(tl);
  return legend;
}

// 달력 위 한 줄: 담당자 필터 + 장기 일정 띠(월 보기에서만)
function buildSvSubRow() {
  const row = el('div', 'pc-sv-subrow');
  const names = svMgrNames();
  if (names.length) {
    const box = el('div', 'pc-sv-mgrbox');
    box.appendChild(el('b', 'pc-sv-subrow-label', '담당자'));
    const me = ((state.profile && state.profile.name) || '').trim();
    names.forEach(n => {
      const on = SV.manager === 'all' || SV.manager === n || (SV.manager === 'mine' && me && n.includes(me));
      const chip = el('button', 'pc-sv-mgrchip' + (on ? ' is-on' : ''));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.style.setProperty('--mc', svMgrColor(n));
      chip.appendChild(buildAvatar(n));
      chip.appendChild(document.createTextNode(n));
      chip.addEventListener('click', () => { SV.manager = SV.manager === n ? 'all' : n; rerenderSv(); });
      box.appendChild(chip);
    });
    row.appendChild(box);
  }
  if (SV.view === 'month') {
    const [ms, me2] = monthRange(SV.anchor);
    const longs = sortEvents(svRows().filter(sv => svIsLong(sv) && svOverlapsRange(sv, ms, me2)));
    if (longs.length) {
      const box = el('div', 'pc-sv-longbox');
      box.appendChild(el('b', 'pc-sv-subrow-label', '장기 일정'));
      const today = todayDateString();
      longs.forEach(sv => {
        const total = Math.max(1, (parseYMD(sv.end_date) - parseYMD(sv.start_date)) / 86400000);
        const pct = Math.round(Math.min(1, Math.max(0, (parseYMD(today) - parseYMD(sv.start_date)) / 86400000 / total)) * 100);
        const chip = el('button', `pc-sv-longchip is-kind-${svKind(sv)}`);
        chip.type = 'button';
        chip.appendChild(el('span', 'pc-sv-bar-tag', SV_KIND_LABEL[svKind(sv)]));
        chip.appendChild(buildAvatar(sv.manager_name));
        chip.appendChild(el('span', 'pc-sv-longchip-title', sv.title));
        const pg = el('span', 'pc-sv-longchip-pg');
        const fill = el('i');
        fill.style.width = `${pct}%`;
        pg.appendChild(fill);
        chip.appendChild(pg);
        chip.appendChild(el('small', '', `${fmtMD(sv.start_date)} ~ ${fmtMD(sv.end_date)} · ${pct}%`));
        chip.addEventListener('click', () => {
          const lo = sv.start_date > ms ? sv.start_date : ms;
          const hi = sv.end_date < me2 ? sv.end_date : me2;
          SV.selected = today < lo ? lo : today > hi ? hi : today;
          rerenderSv();
        });
        attachSvTip(chip, sv);
        box.appendChild(chip);
      });
      row.appendChild(box);
    }
  }
  return row.childNodes.length ? row : null;
}

// ---- 월 보기
function buildMonthView(host) {
  host.classList.add('is-month');
  const head = el('div', 'pc-sv-weekdays');
  WEEKDAYS.forEach((w, i) => head.appendChild(el('div', 'pc-sv-weekday' + (i === 0 ? ' is-sun' : i === 6 ? ' is-sat' : ''), w)));
  host.appendChild(head);

  const cells = monthMatrix(SV.anchor);
  const anchorMonth = parseYMD(SV.anchor).getMonth();
  const today = todayDateString();
  const grid = el('div', 'pc-sv-grid');
  for (let i = 0; i < cells.length; i += 7) {
    grid.appendChild(buildWeekRow(cells.slice(i, i + 7), anchorMonth, today));
  }
  host.appendChild(grid);
}

function layoutWeek(days, skipLong) {
  const ws = days[0];
  const we = days[6];
  const segs = svRows()
    .filter(sv => svOverlapsRange(sv, ws, we) && !(skipLong && svIsLong(sv)))
    .map(sv => {
      const s = sv.start_date < ws ? ws : sv.start_date;
      const t = sv.end_date > we ? we : sv.end_date;
      return { sv, c0: days.indexOf(s), c1: days.indexOf(t), contL: sv.start_date < ws, contR: sv.end_date > we };
    });
  segs.sort((a, b) => a.c0 - b.c0 || (b.c1 - b.c0) - (a.c1 - a.c0) || (a.sv.title || '').localeCompare(b.sv.title || ''));
  const laneEnd = [];
  segs.forEach(sg => {
    let lane = 0;
    while (laneEnd[lane] !== undefined && laneEnd[lane] >= sg.c0) lane++;
    sg.lane = lane;
    laneEnd[lane] = sg.c1;
  });
  return segs;
}

function buildWeekRow(days, anchorMonth, today) {
  const row = el('div', 'pc-sv-week');
  days.forEach((d, col) => {
    const date = parseYMD(d);
    const cell = el('button', 'pc-sv-cell'
      + (date.getMonth() !== anchorMonth ? ' is-outside' : '')
      + (col === 0 ? ' is-sun' : col === 6 ? ' is-sat' : '')
      + (d === today ? ' is-today' : '')
      + (d < today ? ' is-past' : '')
      + (d === SV.selected ? ' is-selected' : ''));
    cell.type = 'button';
    cell.setAttribute('aria-label', fmtDot(d));
    cell.appendChild(el('span', 'pc-sv-cell-num', String(date.getDate())));
    cell.addEventListener('click', () => {
      SV.selected = d;
      if (date.getMonth() !== anchorMonth) SV.anchor = d;
      rerenderSv();
    });
    row.appendChild(cell);
  });

  const segs = layoutWeek(days, true);
  const layer = el('div', 'pc-sv-week-events');
  segs.forEach(sg => {
    if (sg.lane >= MAX_BAR_LANES) return;
    layer.appendChild(buildBar(sg, days));
  });
  // 칸이 모자라 가려진 일정은 날짜별로 "감독 N / 점검 N" 으로 알려준다.
  for (let col = 0; col < 7; col++) {
    const hiddenSegs = segs.filter(sg => sg.lane >= MAX_BAR_LANES && sg.c0 <= col && sg.c1 >= col);
    if (hiddenSegs.length > 0) {
      const supN = hiddenSegs.filter(sg => svKind(sg.sv) === 'sup').length;
      const insN = hiddenSegs.length - supN;
      const more = el('button', 'pc-sv-more');
      more.type = 'button';
      more.setAttribute('aria-label', `숨은 일정 ${hiddenSegs.length}건 보기`);
      if (supN) more.appendChild(el('span', 'pc-sv-more-badge is-sup', `감독 ${supN}`));
      if (insN) more.appendChild(el('span', 'pc-sv-more-badge is-ins', `점검 ${insN}`));
      more.style.gridColumn = String(col + 1);
      more.style.gridRow = String(MAX_BAR_LANES + 1);
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        SV.selected = days[col];
        openDayPopover(more, days[col]);
      });
      layer.appendChild(more);
    }
  }
  // 오늘 세로선
  const tcol = days.indexOf(today);
  if (tcol >= 0) {
    const line = el('i', 'pc-sv-todayline');
    line.style.left = `${(tcol / 7) * 100}%`;
    row.appendChild(line);
  }
  row.appendChild(layer);
  return row;
}

let svPopoverCleanup = null;
function closeDayPopover() {
  if (svPopoverCleanup) { svPopoverCleanup(); svPopoverCleanup = null; }
}
// "+N건" 클릭 시 그 날짜의 일정을 전부 작은 창으로 보여준다.
function openDayPopover(anchorEl, dateStr) {
  closeDayPopover();
  const items = sortEvents(svRows().filter(sv => svOverlapsDate(sv, dateStr)));
  const pop = el('div', 'pc-sv-popover');
  pop.appendChild(el('div', 'pc-sv-popover-head', `${fmtDot(dateStr)} · ${items.length}건`));
  items.forEach(sv => {
    const b = el('button', 'pc-sv-popover-item');
    b.type = 'button';
    b.appendChild(el('i', svDotClass(sv)));
    const t = el('span', 'pc-sv-popover-text');
    t.appendChild(el('strong', '', sv.title));
    t.appendChild(el('small', '', sv.start_date === sv.end_date ? fmtMD(sv.start_date) : `${fmtMD(sv.start_date)} ~ ${fmtMD(sv.end_date)}`));
    b.appendChild(t);
    b.addEventListener('click', () => { closeDayPopover(); SV.selected = dateStr; rerenderSv(); });
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  const r0 = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pw - 8, r0.left))}px`;
  pop.style.top = `${r0.bottom + ph + 8 > window.innerHeight ? Math.max(8, r0.top - ph - 4) : r0.bottom + 4}px`;
  const onDown = (e) => { if (!pop.contains(e.target)) { closeDayPopover(); rerenderSv(); } };
  const onKey = (e) => { if (e.key === 'Escape') { closeDayPopover(); rerenderSv(); } };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey);
  svPopoverCleanup = () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    pop.remove();
  };
}

let svTipEl = null;
function closeSvTip() { if (svTipEl) { svTipEl.remove(); svTipEl = null; } }
// 막대/띠에 마우스를 올리거나 키보드로 포커스하면 상세 미리보기를 띄운다.
function openSvTip(anchorEl, sv) {
  closeSvTip();
  const kind = svKind(sv);
  const status = computeSupervisionStatus(sv.start_date, sv.end_date);
  const tip = el('div', 'pc-sv-tip');
  tip.setAttribute('role', 'tooltip');
  tip.appendChild(el('strong', 'pc-sv-tip-title', sv.title));
  [
    ['구분', `${SV_KIND_LABEL[kind]} · ${STATUS_LABEL[status]}`],
    ['기간', sv.start_date === sv.end_date ? fmtMD(sv.start_date) : `${fmtMD(sv.start_date)} ~ ${fmtMD(sv.end_date)}`],
    ['담당', sv.manager_name || '-'],
  ].forEach(([k, v]) => {
    const r = el('div', 'pc-sv-tip-row');
    r.appendChild(el('span', '', k));
    r.appendChild(el('span', '', v));
    tip.appendChild(r);
  });
  document.body.appendChild(tip);
  svTipEl = tip;
  const r0 = anchorEl.getBoundingClientRect();
  const pw = tip.offsetWidth, ph = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - pw - 8, r0.left + 16))}px`;
  tip.style.top = `${r0.bottom + ph + 10 > window.innerHeight ? Math.max(8, r0.top - ph - 6) : r0.bottom + 6}px`;
}
function attachSvTip(node, sv) {
  node.addEventListener('mouseenter', () => openSvTip(node, sv));
  node.addEventListener('mouseleave', closeSvTip);
  node.addEventListener('focus', () => openSvTip(node, sv));
  node.addEventListener('blur', closeSvTip);
  node.addEventListener('click', closeSvTip);
}

function buildBar(sg, days) {
  const { sv } = sg;
  const kind = svKind(sv);
  const status = computeSupervisionStatus(sv.start_date, sv.end_date);
  const bar = el('button', `pc-sv-bar is-kind-${kind}` + (status === 'done' ? ' is-done' : '')
    + (sg.contL ? ' cont-left' : '') + (sg.contR ? ' cont-right' : '')
    + (SV.selected && svOverlapsDate(sv, SV.selected) ? ' is-active' : ''));
  bar.type = 'button';
  bar.style.gridColumn = `${sg.c0 + 1} / ${sg.c1 + 2}`;
  bar.style.gridRow = String(sg.lane + 1);
  bar.setAttribute('aria-label', `${SV_KIND_LABEL[kind]} ${sv.title} (${fmtMD(sv.start_date)} ~ ${fmtMD(sv.end_date)}) ${STATUS_LABEL[status]}${sv.manager_name ? ' 담당 ' + sv.manager_name : ''}`);
  bar.appendChild(el('span', 'pc-sv-bar-tag', SV_KIND_LABEL[kind]));
  if ((sv.manager_name || '').trim()) bar.appendChild(buildAvatar(sv.manager_name));
  const multi = sv.start_date !== sv.end_date;
  bar.appendChild(el('span', 'pc-sv-bar-title', sv.title));
  const dday = status === 'scheduled' ? Math.round((parseYMD(sv.start_date) - parseYMD(todayDateString())) / 86400000) : -1;
  if (dday >= 1 && dday <= 3) bar.appendChild(el('span', 'pc-sv-dday', `D-${dday}`));
  // 칸이 좁으면 기간 글자는 빼고(툴팁/상세에서 확인), 하루짜리는 상태 글자도 뺀다.
  const span = sg.c1 - sg.c0 + 1;
  if (multi && span >= 4) bar.appendChild(el('span', 'pc-sv-bar-range', `(${fmtMD(sv.start_date)} ~ ${fmtMD(sv.end_date)})`));
  if (multi && span >= 2) bar.appendChild(el('span', 'pc-sv-bar-st', STATUS_LABEL[status]));
  attachSvTip(bar, sv);
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    // 막대가 여러 날에 걸쳐 있어 클릭한 칸을 알기 어려우므로, 이 주에서 보이는 첫 날을 선택한다.
    SV.selected = sv.start_date < days[0] ? days[0] : sv.start_date;
    rerenderSv();
  });
  return bar;
}

// ---- 주 보기 (월 보기와 같은 막대 표시)
function buildWeekView(host) {
  host.classList.add('is-week');
  const ws = weekStartOf(SV.anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const today = todayDateString();
  const head = el('div', 'pc-sv-weekhead');
  const body = el('div', 'pc-sv-weekbody');
  days.forEach((d, col) => {
    const date = parseYMD(d);
    const flags = (col === 0 ? ' is-sun' : col === 6 ? ' is-sat' : '') + (d === today ? ' is-today' : '') + (d === SV.selected ? ' is-selected' : '');
    const h = el('button', 'pc-sv-weekhead-cell' + flags);
    h.type = 'button';
    h.appendChild(el('span', 'pc-sv-weekcol-wd', WEEKDAYS[col]));
    h.appendChild(el('strong', 'pc-sv-weekcol-num', String(date.getDate())));
    h.addEventListener('click', () => { SV.selected = d; rerenderSv(); });
    head.appendChild(h);
    const cell = el('button', 'pc-sv-weekcell' + flags);
    cell.type = 'button';
    cell.setAttribute('aria-label', fmtDot(d));
    cell.addEventListener('click', () => { SV.selected = d; rerenderSv(); });
    body.appendChild(cell);
  });
  const segs = layoutWeek(days);
  const layer = el('div', 'pc-sv-week-events is-week');
  segs.forEach(sg => layer.appendChild(buildBar(sg, days)));
  body.appendChild(layer);
  const lanes = segs.reduce((m, sg) => Math.max(m, sg.lane + 1), 0);
  body.style.minHeight = `${Math.max(320, 28 + lanes * 42)}px`;
  if (segs.length === 0) {
    const none = el('div', 'pc-sv-week-none', '이 주에 등록된 감독일정이 없습니다.');
    body.appendChild(none);
  }
  host.appendChild(head);
  host.appendChild(body);
}

// ---- 일 보기
function buildDayView(host) {
  host.classList.add('is-day');
  const d = SV.anchor;
  const list = el('div', 'pc-sv-daylist');
  const items = sortEvents(svRows().filter(sv => svOverlapsDate(sv, d)));
  if (items.length === 0) {
    list.appendChild(buildEmpty('이 날짜에 등록된 감독일정이 없습니다.'));
  } else {
    items.forEach(sv => list.appendChild(buildEventCard(sv)));
  }
  host.appendChild(list);
}

// ---- 목록 보기(보고 있는 달에 걸친 모든 일정)
function buildListView(host) {
  host.classList.add('is-list');
  const [a, b] = monthRange(SV.anchor);
  const items = sortEvents(svRows().filter(sv => svOverlapsRange(sv, a, b)));
  if (items.length === 0) {
    host.appendChild(buildEmpty('이 달에 등록된 감독일정이 없습니다.'));
    return;
  }
  const wrap = el('div', 'pc-sv-tablewrap');
  const table = el('table', 'pc-sv-table');
  const thead = el('thead');
  const hr = el('tr');
  ['상태', '감독명', '감독기간', '유형', '담당 감독관', ''].forEach(h => hr.appendChild(el('th', '', h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  const admin = isAdmin();
  items.forEach(sv => {
    const tr = el('tr', (SV.selected && svOverlapsDate(sv, SV.selected) ? 'is-active' : ''));
    const st = computeSupervisionStatus(sv.start_date, sv.end_date);
    const tdStatus = el('td');
    tdStatus.appendChild(el('span', `pc-sv-badge pc-status-${st}`, STATUS_LABEL[st]));
    tr.appendChild(tdStatus);
    tr.appendChild(el('td', 'pc-sv-td-title', sv.title));
    tr.appendChild(el('td', '', fmtRangeDot(sv.start_date, sv.end_date)));
    tr.appendChild(el('td', '', sv.supervision_type ? TYPE_LABEL[sv.supervision_type] : '-'));
    tr.appendChild(el('td', '', sv.manager_name || '-'));
    const tdAct = el('td', 'pc-sv-td-actions');
    const detail = el('button', 'pc-sv-secondary-btn is-small', '상세보기');
    detail.type = 'button';
    detail.addEventListener('click', (e) => { e.stopPropagation(); openSvDetailModal(sv); });
    tdAct.appendChild(detail);
    if (admin) {
      const edit = el('button', 'pc-sv-primary-btn is-small', '수정');
      edit.type = 'button';
      edit.addEventListener('click', (e) => { e.stopPropagation(); openSvFormModal(sv); });
      tdAct.appendChild(edit);
    }
    tr.appendChild(tdAct);
    tr.addEventListener('click', () => {
      SV.selected = sv.start_date < a ? a : sv.start_date;
      rerenderSv();
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

function buildEmpty(message) {
  const empty = el('div', 'pc-sv-empty');
  empty.appendChild(icon('calendar', 34));
  empty.appendChild(el('p', '', message));
  return empty;
}

// ---- 우측 패널
function buildSidePanel() {
  const side = el('div', 'pc-sv-side');
  const admin = isAdmin();

  // 오늘 요약
  const todayStr = todayDateString();
  const todayCount = svRows().filter(sv => svOverlapsDate(sv, todayStr)).length;
  const ongoingCount = svRows().filter(sv => computeSupervisionStatus(sv.start_date, sv.end_date) === 'ongoing').length;
  const todayBar = el('button', 'pc-sv-today-bar');
  todayBar.type = 'button';
  todayBar.appendChild(icon('calendar', 20));
  todayBar.appendChild(el('span', 'pc-sv-today-text', `오늘 ${todayCount}건`));
  todayBar.appendChild(el('i', 'pc-sv-today-sep'));
  todayBar.appendChild(el('span', 'pc-sv-today-text is-ongoing', `진행 중 ${ongoingCount}건`));
  todayBar.appendChild(el('span', 'pc-sv-today-go', '오늘로 이동'));
  todayBar.addEventListener('click', () => { SV.anchor = todayStr; SV.selected = todayStr; rerenderSv(); });
  side.appendChild(todayBar);

  const sel = el('div', 'pc-sv-side-card is-selected-card');
  const selHead = el('div', 'pc-sv-side-head');
  selHead.appendChild(el('strong', '', '선택 날짜 일정'));
  selHead.appendChild(el('span', 'pc-sv-side-date', `${parseYMD(SV.selected).getFullYear()}년 ${parseYMD(SV.selected).getMonth() + 1}월 ${parseYMD(SV.selected).getDate()}일 (${WEEKDAYS[parseYMD(SV.selected).getDay()]})`));
  const dayRows = sortEvents(svRows().filter(sv => svOverlapsDate(sv, SV.selected)));
  selHead.appendChild(el('span', 'pc-sv-count-badge', `${dayRows.length}건`));
  sel.appendChild(selHead);
  if (dayRows.length === 0) {
    const empty = buildEmpty('선택한 날짜에 등록된 감독일정이 없습니다.');
    if (admin) {
      const add = el('button', 'pc-sv-secondary-btn', '+ 감독일정 등록');
      add.type = 'button';
      add.addEventListener('click', () => openSvFormModal(null, SV.selected));
      empty.appendChild(add);
    }
    sel.appendChild(empty);
  } else {
    dayRows.forEach(sv => sel.appendChild(buildEventCard(sv)));
  }
  side.appendChild(sel);

  // 다른 날짜 일정(오늘 이후, 선택한 날짜와 겹치지 않는 것) — 가까운 순 3건.
  const today = todayDateString();
  const isPast = SV.otherMode === 'past';
  const upcoming = isPast
    ? svRows().filter(sv => sv.end_date < today && !svOverlapsDate(sv, SV.selected)).sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 3)
    : sortEvents(svRows().filter(sv => sv.end_date >= today && !svOverlapsDate(sv, SV.selected))).slice(0, 3);
  const other = el('div', 'pc-sv-side-card is-other-card');
  const otherHead = el('div', 'pc-sv-side-head');
  const otherTitle = el('strong', '', '다른 날짜 일정');
  otherHead.appendChild(otherTitle);
  otherHead.appendChild(el('span', 'pc-sv-side-date is-plain', isPast ? '(오늘 이전)' : '(오늘 이후)'));
  const modeToggle = el('div', 'pc-sv-mode-toggle');
  [['upcoming', '예정'], ['past', '지난']].forEach(([key, label]) => {
    const mb = el('button', 'pc-sv-mode-btn' + (SV.otherMode === key ? ' active' : ''), label);
    mb.type = 'button';
    mb.addEventListener('click', () => { SV.otherMode = key; rerenderSv(); });
    modeToggle.appendChild(mb);
  });
  otherHead.appendChild(modeToggle);
  const more = el('button', 'pc-sv-more-link');
  more.type = 'button';
  more.appendChild(document.createTextNode('더보기'));
  more.appendChild(icon('chevronRight', 14));
  more.addEventListener('click', () => { SV.view = 'list'; rerenderSv(); });
  otherHead.appendChild(more);
  other.appendChild(otherHead);
  if (upcoming.length === 0) {
    other.appendChild(el('p', 'pc-sv-side-empty', isPast ? '지난 일정이 없습니다.' : '예정된 다른 일정이 없습니다.'));
  } else {
    upcoming.forEach(sv => {
      const st = computeSupervisionStatus(sv.start_date, sv.end_date);
      const item = el('button', 'pc-sv-mini');
      item.type = 'button';
      item.appendChild(el('i', svDotClass(sv)));
      const info = el('div', 'pc-sv-mini-info');
      info.appendChild(el('strong', '', sv.title));
      info.appendChild(el('span', '', fmtRangeDot(sv.start_date, sv.end_date)));
      item.appendChild(info);
      item.appendChild(el('span', `pc-sv-badge pc-status-${st}`, STATUS_LABEL[st]));
      item.addEventListener('click', () => {
        SV.selected = (!isPast && sv.start_date < today) ? today : sv.start_date;
        SV.anchor = SV.selected;
        rerenderSv();
      });
      other.appendChild(item);
    });
  }
  side.appendChild(other);
  return side;
}

function buildInfoRow(iconName, label, value) {
  const row = el('div', 'pc-sv-info-row');
  const lab = el('span', 'pc-sv-info-label');
  lab.appendChild(icon(iconName, 17));
  lab.appendChild(document.createTextNode(label));
  row.appendChild(lab);
  row.appendChild(el('span', 'pc-sv-info-value', value));
  return row;
}

function buildEventCard(sv) {
  const st = computeSupervisionStatus(sv.start_date, sv.end_date);
  const card = el('div', 'pc-sv-event');
  const head = el('div', 'pc-sv-event-head');
  head.appendChild(el('strong', 'pc-sv-event-title', sv.title));
  head.appendChild(el('span', `pc-sv-badge pc-status-${st}`, STATUS_LABEL[st]));
  card.appendChild(head);
  // 감독일정 테이블에는 사업장 연결(site_id)이 없으므로(supervision.js 참고) 시안의 "대상 사업장" 행은
  // 가짜 값을 만들지 않기 위해 두지 않는다.
  card.appendChild(buildInfoRow('calendar', '감독기간', fmtRangeDot(sv.start_date, sv.end_date)));
  card.appendChild(buildInfoRow('clipboard', '감독유형', sv.supervision_type ? TYPE_LABEL[sv.supervision_type] : '미지정'));
  card.appendChild(buildInfoRow('user', '담당 감독관', sv.manager_name || '-'));
  const actions = el('div', 'pc-sv-event-actions');
  const detail = el('button', 'pc-sv-secondary-btn', '상세보기');
  detail.type = 'button';
  detail.addEventListener('click', () => openSvDetailModal(sv));
  actions.appendChild(detail);
  if (isAdmin()) {
    const edit = el('button', 'pc-sv-primary-btn', '수정');
    edit.type = 'button';
    edit.addEventListener('click', () => openSvFormModal(sv));
    actions.appendChild(edit);
  }
  card.appendChild(actions);
  return card;
}

// ---- 상세 모달
function openSvDetailModal(sv) {
  const st = computeSupervisionStatus(sv.start_date, sv.end_date);
  const wrap = el('div', 'pc-modal-body');
  const head = el('div', 'pc-modal-head');
  head.appendChild(el('h3', '', '감독일정 상세'));
  const closeBtn = el('button', 'pc-modal-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.appendChild(icon('close', 20));
  head.appendChild(closeBtn);
  wrap.appendChild(head);

  const hero = el('div', 'pc-modal-hero');
  const badges = el('div', 'pc-modal-badges');
  if (sv.supervision_type) badges.appendChild(el('span', `pc-sv-badge pc-type-${sv.supervision_type}`, TYPE_LABEL[sv.supervision_type]));
  badges.appendChild(el('span', `pc-sv-badge pc-status-${st}`, STATUS_LABEL[st]));
  hero.appendChild(badges);
  hero.appendChild(el('h4', '', sv.title));
  wrap.appendChild(hero);

  const info = el('div', 'pc-modal-info');
  [
    ['감독명', sv.title],
    ['감독 기간', fmtRangeDot(sv.start_date, sv.end_date)],
    ['감독 유형', sv.supervision_type ? TYPE_LABEL[sv.supervision_type] : '미지정'],
    ['담당 감독관', sv.manager_name || '-'],
    ['등록일', fmtTimestampDate(sv.created_at)],
  ].forEach(([label, value]) => {
    const row = el('div', 'pc-modal-info-row');
    row.appendChild(el('span', '', label));
    row.appendChild(el('strong', '', value));
    info.appendChild(row);
  });
  wrap.appendChild(info);

  const actions = el('div', 'pc-modal-actions');
  const { close } = openModal(wrap);
  closeBtn.addEventListener('click', close);
  if (isAdmin()) {
    const del = el('button', 'pc-sv-danger-btn', '삭제하기');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!window.confirm('이 감독일정을 삭제하시겠습니까?')) return;
      if (st === 'done' && !window.confirm('이미 완료된 감독 기록입니다. 삭제하면 복구할 수 없습니다.\n정말 삭제하시겠습니까?')) return;
      del.disabled = true;
      const result = await deleteSupervision(sv.id);
      if (!result.success) {
        del.disabled = false;
        showToast(result.message || '감독일정 삭제에 실패했습니다.');
        return;
      }
      close();
      showToast('감독일정이 삭제되었습니다.', 'success');
      await refreshSv();
    });
    actions.appendChild(del);
    const edit = el('button', 'pc-sv-primary-btn', '수정하기');
    edit.type = 'button';
    edit.addEventListener('click', () => { close(); openSvFormModal(sv); });
    actions.appendChild(edit);
  } else {
    const ok = el('button', 'pc-sv-secondary-btn', '닫기');
    ok.type = 'button';
    ok.addEventListener('click', close);
    actions.appendChild(ok);
  }
  wrap.appendChild(actions);
}

// ---- 등록/수정 모달(모바일 폼과 동일한 필드/검증)
async function openSvFormModal(existing, presetDate) {
  const isEdit = !!existing;
  const wrap = el('div', 'pc-modal-body');
  const head = el('div', 'pc-modal-head');
  head.appendChild(el('h3', '', isEdit ? '감독일정 수정' : '감독일정 등록'));
  const closeBtn = el('button', 'pc-modal-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.appendChild(icon('close', 20));
  head.appendChild(closeBtn);
  wrap.appendChild(head);

  const form = el('div', 'pc-modal-form');
  const field = (labelText, required, control, errorEl) => {
    const f = el('div', 'pc-modal-field');
    const lab = el('label', 'pc-modal-label', labelText);
    if (required) lab.appendChild(el('span', 'pc-req', '*'));
    f.appendChild(lab);
    f.appendChild(control);
    if (errorEl) f.appendChild(errorEl);
    return f;
  };

  const titleInput = el('input', 'pc-modal-input');
  titleInput.type = 'text';
  titleInput.placeholder = '감독명을 입력해주세요.';
  titleInput.value = existing ? existing.title : '';
  form.appendChild(field('감독명', true, titleInput));

  const range = el('div', 'pc-modal-range');
  const startInput = el('input', 'pc-modal-input');
  startInput.type = 'date';
  startInput.min = SV_MIN_DATE; startInput.max = SV_MAX_DATE;
  startInput.value = existing ? existing.start_date : (presetDate || '');
  const endInput = el('input', 'pc-modal-input');
  endInput.type = 'date';
  endInput.min = startInput.value || SV_MIN_DATE; endInput.max = SV_MAX_DATE;
  endInput.value = existing ? existing.end_date : (presetDate || '');
  range.appendChild(startInput);
  range.appendChild(el('span', '', '~'));
  range.appendChild(endInput);
  const rangeError = el('p', 'pc-modal-hint');
  form.appendChild(field('감독기간', true, range, rangeError));
  startInput.addEventListener('change', () => {
    rangeError.textContent = '';
    if (startInput.value) {
      endInput.min = startInput.value;
      if (endInput.value && endInput.value < startInput.value) {
        endInput.value = '';
        rangeError.textContent = '시작일이 변경되어 종료일이 초기화되었습니다. 종료일을 다시 선택해주세요.';
      }
    } else {
      endInput.min = SV_MIN_DATE;
    }
  });
  endInput.addEventListener('change', () => {
    if (startInput.value && endInput.value && endInput.value < startInput.value) {
      rangeError.textContent = '종료일은 시작일보다 빠를 수 없습니다.';
      endInput.value = '';
    } else {
      rangeError.textContent = '';
    }
  });

  let selectedType = existing ? (existing.supervision_type || null) : null;
  const typeToggle = el('div', 'pc-modal-toggle');
  const typeButtons = {};
  Object.keys(TYPE_LABEL).forEach(key => {
    const b = el('button', 'pc-modal-toggle-btn' + (selectedType === key ? ' active' : ''), TYPE_LABEL[key]);
    b.type = 'button';
    b.addEventListener('click', () => {
      selectedType = key;
      Object.keys(typeButtons).forEach(k => typeButtons[k].classList.toggle('active', k === key));
    });
    typeButtons[key] = b;
    typeToggle.appendChild(b);
  });
  form.appendChild(field('감독 유형', true, typeToggle));

  const managerSelect = el('select', 'pc-modal-input');
  const placeholderOpt = el('option', '', '담당 감독관을 선택해주세요.');
  placeholderOpt.value = '';
  managerSelect.appendChild(placeholderOpt);
  form.appendChild(field('담당 감독관', false, managerSelect));

  const errorEl = el('p', 'pc-modal-error');
  form.appendChild(errorEl);
  wrap.appendChild(form);

  const actions = el('div', 'pc-modal-actions');
  const cancel = el('button', 'pc-sv-secondary-btn', '취소');
  cancel.type = 'button';
  const submit = el('button', 'pc-sv-primary-btn', isEdit ? '변경사항 저장' : '감독일정 등록');
  submit.type = 'button';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  wrap.appendChild(actions);

  const { close } = openModal(wrap);
  closeBtn.addEventListener('click', close);
  cancel.addEventListener('click', close);
  setTimeout(() => titleInput.focus(), 30);

  // 담당 감독관 후보: admin.js loadUsers() 재사용(승인된 사용자 중 이름이 있는 계정만).
  const currentManager = existing ? (existing.manager_name || '') : '';
  const users = await loadUsers();
  const names = (users || []).filter(u => u.status === 'approved' && u.name).map(u => u.name);
  if (currentManager && !names.includes(currentManager)) names.unshift(currentManager);
  [...new Set(names)].forEach(name => {
    const o = el('option', '', name);
    o.value = name;
    managerSelect.appendChild(o);
  });
  managerSelect.value = currentManager;

  submit.addEventListener('click', async () => {
    errorEl.textContent = '';
    const title = titleInput.value.trim();
    const start = startInput.value;
    const end = endInput.value;
    if (!title) { errorEl.textContent = '감독명을 입력해주세요.'; return; }
    if (!start) { errorEl.textContent = '시작일을 입력해주세요.'; return; }
    if (!end) { errorEl.textContent = '종료일을 입력해주세요.'; return; }
    if (start < SV_MIN_DATE || start > SV_MAX_DATE || end < SV_MIN_DATE || end > SV_MAX_DATE) {
      errorEl.textContent = `시작일/종료일은 ${SV_MIN_DATE} ~ ${SV_MAX_DATE} 범위 내에서 입력해주세요.`;
      return;
    }
    if (end < start) { errorEl.textContent = '종료일은 시작일보다 빠를 수 없습니다.'; return; }
    if (!selectedType) { errorEl.textContent = '감독 유형을 선택해주세요.'; return; }

    submit.disabled = true;
    cancel.disabled = true;
    const fields = {
      title,
      manager_name: managerSelect.value || null,
      start_date: start,
      end_date: end,
      status: computeSupervisionStatus(start, end),
      supervision_type: selectedType,
    };
    const result = isEdit ? await updateSupervision(existing.id, fields) : await createSupervision(fields);
    if (!result.success) {
      errorEl.textContent = result.message;
      submit.disabled = false;
      cancel.disabled = false;
      return;
    }
    close();
    showToast(isEdit ? '감독일정이 수정되었습니다.' : '감독일정이 등록되었습니다.', 'success');
    SV.selected = start;
    SV.anchor = start;
    await refreshSv();
  });
}

// ==================================================================
// 현장 메모 (작성/수정)
// ==================================================================
const NP = {
  siteId: null,
  helpOpen: true,
  restoreDraft: null,   // 임시저장에서 복원할 메모 내용
  choose: null,         // 폼의 현장 선택 함수(저장된 메모 목록에서 호출)
  refreshSaved: null,   // 저장된 메모 목록 다시 그리기
  pendingSiteId: null,  // 다른 탭의 '상세 메모' 버튼에서 넘어온 현장(한 번만 사용)
};

// 지도/현장/즐겨찾기 상세의 '상세 메모' 버튼: 현장 메모 탭을 해당 현장이 선택된 상태로 열기 위한 준비.
// 상세 패널에서 작성 중이던(저장 전) 내용은 임시저장으로 넘겨 그대로 이어서 쓸 수 있게 한다.
export function openNoteForSite(siteId, draftText) {
  NP.pendingSiteId = siteId;
  const saved = getNote(siteId);
  const text = typeof draftText === 'string' ? draftText : '';
  if (text.trim() && (!saved || saved.content !== text)) writeNoteDraft(siteId, text);
  else clearNoteDraft();
}
const NOTE_DRAFT_KEY = 'gnmap_v2_note_draft';
function readNoteDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(NOTE_DRAFT_KEY) || 'null');
    const uid = state.user && state.user.id;
    return d && d.siteId && d.uid === uid ? d : null;
  } catch (e) { return null; }
}
function writeNoteDraft(siteId, content) {
  try {
    if (!siteId || !content || !content.trim()) { localStorage.removeItem(NOTE_DRAFT_KEY); return; }
    localStorage.setItem(NOTE_DRAFT_KEY, JSON.stringify({ siteId, content, uid: state.user && state.user.id, ts: Date.now() }));
  } catch (e) { /* 저장소를 못 써도 작성에는 영향 없음 */ }
}
function clearNoteDraft() { try { localStorage.removeItem(NOTE_DRAFT_KEY); } catch (e) { /* ignore */ } }
function fmtAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}억원`;
  return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만원`;
}
const NOTE_TEMPLATES = [
  ['점검 사항', '[점검 사항]\n- '],
  ['시정 요청', '[시정 요청]\n- '],
  ['재점검 예정', '[재점검 예정]\n- 예정일: '],
];
const NOTE_MAX = 1000;
const NOTE_OPTION_LIMIT = 80;
let npOutsideHandler = null;

function siteLabel(site) {
  return site.site_name || site.company_name || '-';
}

export function renderPcNotesPage() {
  const root = document.getElementById('pc-notes-page');
  if (!root) return;
  NP.siteId = null; // 탭에 들어올 때마다 빈 작성 화면으로 시작한다.
  NP.restoreDraft = null;
  // 작성 중 새로고침/탭 이동으로 사라진 메모가 있으면 임시저장본을 복원한다.
  const draft = readNoteDraft();
  if (draft && (state.sites || []).some(x => x.id === draft.siteId)) {
    const saved = getNote(draft.siteId);
    if (!saved || saved.content !== draft.content) {
      NP.siteId = draft.siteId;
      NP.restoreDraft = draft.content;
    } else {
      clearNoteDraft();
    }
  }
  if (NP.pendingSiteId && (state.sites || []).some(x => x.id === NP.pendingSiteId)) {
    if (NP.siteId !== NP.pendingSiteId) { NP.restoreDraft = null; }
    NP.siteId = NP.pendingSiteId;
  }
  NP.pendingSiteId = null;
  paintNotesPage();
}

function paintNotesPage() {
  const root = document.getElementById('pc-notes-page');
  if (!root) return;
  if (npOutsideHandler) { document.removeEventListener('mousedown', npOutsideHandler); npOutsideHandler = null; }
  root.innerHTML = '';

  const titleBlock = el('div', 'pc-np-titleblock');
  titleBlock.appendChild(el('h2', 'pc-np-title', '현장 메모 작성'));
  titleBlock.appendChild(el('p', 'pc-np-subtitle', '현장에서 작성한 메모를 저장하고 관리합니다.'));
  root.appendChild(titleBlock);

  const grid = el('div', 'pc-np-grid');
  grid.appendChild(buildNoteFormCard());
  const side = el('div', 'pc-np-side');
  side.appendChild(buildNoteHelpCard());
  side.appendChild(buildSavedNotesCard());
  grid.appendChild(side);
  root.appendChild(grid);
}

function buildNoteFormCard() {
  const card = el('div', 'pc-np-card');

  // ---- 현장 선택(검색형 콤보박스)
  const siteField = el('div', 'pc-np-field');
  const siteLab = el('div', 'pc-np-label', '현장 선택');
  siteLab.appendChild(el('span', 'pc-req', '*'));
  siteField.appendChild(siteLab);

  const selectWrap = el('div', 'pc-np-select');
  const box = el('div', 'pc-np-select-box');
  const searchIcon = el('span', 'pc-np-select-icon');
  searchIcon.appendChild(icon('search', 22));
  box.appendChild(searchIcon);
  const input = el('input', 'pc-np-select-input');
  input.type = 'text';
  input.placeholder = '등록된 현장을 검색하여 선택하세요.';
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  const chevron = el('button', 'pc-np-select-chevron');
  chevron.type = 'button';
  chevron.setAttribute('aria-label', '현장 목록 열기');
  chevron.tabIndex = -1;
  chevron.appendChild(icon('chevronDown', 22));
  box.appendChild(input);
  box.appendChild(chevron);
  selectWrap.appendChild(box);
  const list = el('div', 'pc-np-select-list');
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  selectWrap.appendChild(list);
  siteField.appendChild(selectWrap);
  const hint = el('p', 'pc-np-existing-hint');
  hint.hidden = true;
  siteField.appendChild(hint);
  const summary = el('div', 'pc-np-site-summary');
  summary.hidden = true;
  siteField.appendChild(summary);
  card.appendChild(siteField);

  // ---- 메모
  const memoField = el('div', 'pc-np-field');
  const memoLab = el('div', 'pc-np-label', '메모');
  memoLab.appendChild(el('span', 'pc-req', '*'));
  memoField.appendChild(memoLab);
  const tplRow = el('div', 'pc-np-templates');
  tplRow.appendChild(el('span', 'pc-np-templates-label', '빠른 입력'));
  const textarea = el('textarea', 'pc-np-textarea');
  textarea.maxLength = NOTE_MAX;
  textarea.placeholder = '현장에서 확인한 내용이나 추가 확인이 필요한 사항을 입력해주세요.';
  memoField.appendChild(tplRow);
  memoField.appendChild(textarea);
  const counter = el('div', 'pc-np-counter', `0 / ${NOTE_MAX}`);
  memoField.appendChild(counter);
  card.appendChild(memoField);

  // ---- 안내 카드
  const guide = el('div', 'pc-np-guide');
  const guideHead = el('div', 'pc-np-guide-head');
  guideHead.appendChild(icon('info', 28));
  guideHead.appendChild(el('strong', '', '현장 메모 안내'));
  guide.appendChild(guideHead);
  const guideList = el('ul', 'pc-np-guide-list');
  [
    '메모는 선택한 현장에 저장됩니다.',
    '현장 상세 화면에서도 동일한 메모를 확인할 수 있습니다.',
    '저장된 메모는 현장 메모 메뉴에서 다시 수정할 수 있습니다.',
  ].forEach(t => guideList.appendChild(el('li', '', t)));
  guide.appendChild(guideList);
  card.appendChild(guide);

  // ---- 버튼
  const actions = el('div', 'pc-np-actions');
  const delBtn = el('button', 'pc-np-btn is-danger', '메모 삭제');
  delBtn.type = 'button';
  delBtn.hidden = true;
  const cancelBtn = el('button', 'pc-np-btn is-cancel', '취소');
  cancelBtn.type = 'button';
  const saveBtn = el('button', 'pc-np-btn is-save', '메모 저장');
  saveBtn.type = 'button';
  actions.appendChild(delBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  card.appendChild(actions);

  // ---------------- 동작 ----------------
  const selectedSite = () => (NP.siteId ? (state.sites || []).find(s => s.id === NP.siteId) : null);
  let activeIndex = -1;
  let draftRestored = false;

  function renderSummary(site) {
    summary.innerHTML = '';
    if (!site) { summary.hidden = true; return; }
    summary.hidden = false;
    const rows = [
      ['업체명', site.company_name || '-'],
      ['소재지', site.address || '-'],
      ['공사금액', fmtAmount(site.amount)],
      ['공사기간', site.period_start || site.period_end ? `${(site.period_start || '').replaceAll('-', '.') || '-'} ~ ${(site.period_end || '').replaceAll('-', '.') || '-'}` : '-'],
    ];
    rows.forEach(([k, v]) => {
      const it = el('div', 'pc-np-summary-item');
      it.appendChild(el('span', '', k));
      it.appendChild(el('strong', '', v));
      summary.appendChild(it);
    });
  }
  function persistDraft() {
    const saved = NP.siteId ? getNote(NP.siteId) : null;
    if (saved && saved.content === textarea.value) clearNoteDraft();
    else writeNoteDraft(NP.siteId, textarea.value);
  }
  NOTE_TEMPLATES.forEach(([label, text]) => {
    const b = el('button', 'pc-np-template-btn', `+ ${label}`);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (!NP.siteId) { showToast('먼저 현장을 선택해주세요.'); return; }
      let v = textarea.value;
      if (v && !v.endsWith('\n')) v += '\n';
      v = (v + text).slice(0, NOTE_MAX);
      textarea.value = v;
      textarea.focus();
      textarea.setSelectionRange(v.length, v.length);
      draftRestored = false;
      syncCounter(); refreshButtons(); persistDraft();
    });
    tplRow.appendChild(b);
  });

  function refreshButtons() {
    const hasSite = !!NP.siteId;
    const hasContent = textarea.value.trim().length > 0;
    saveBtn.disabled = !(hasSite && hasContent);
    const existing = hasSite ? getNote(NP.siteId) : null;
    delBtn.hidden = !existing;
    renderSummary(hasSite ? selectedSite() : null);
    tplRow.classList.toggle('is-disabled', !hasSite);
    if (draftRestored) {
      hint.hidden = false;
      hint.textContent = '작성 중이던 내용(임시저장)을 불러왔습니다. 저장 버튼을 눌러야 반영됩니다.';
    } else if (existing) {
      hint.hidden = false;
      hint.textContent = '이미 작성된 메모가 있어 불러왔습니다. 내용을 수정하고 저장할 수 있습니다.';
    } else {
      hint.hidden = true;
    }
  }
  function syncCounter() {
    counter.textContent = `${textarea.value.length} / ${NOTE_MAX}`;
  }
  function closeList() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    const site = selectedSite();
    input.value = site ? siteLabel(site) : '';
  }
  function choose(site) {
    NP.siteId = site.id;
    const existing = getNote(site.id);
    textarea.value = existing ? existing.content : '';
    draftRestored = false;
    const d = readNoteDraft();
    if (d && d.siteId === site.id && d.content !== textarea.value) {
      textarea.value = d.content;
      draftRestored = true;
    }
    syncCounter();
    closeList();
    refreshButtons();
    if (NP.refreshSaved) NP.refreshSaved();
  }
  NP.choose = choose;
  function renderList(query) {
    list.innerHTML = '';
    const q = (query || '').trim();
    const sites = state.sites || [];
    // 공백으로 나눈 모든 검색어가 사업장명/업체명/주소/동 중 어디든 들어 있으면 검색된다(대소문자 무시).
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = tokens.length
      ? sites.filter(s => {
          const hay = `${s.site_name || ''} ${s.company_name || ''} ${s.address || ''} ${s.dong || ''}`.toLowerCase();
          return tokens.every(t => hay.includes(t));
        })
      : sites;
    if (tokens.length) {
      list.appendChild(el('div', 'pc-np-option-count', `검색 결과 ${matches.length}건`));
    }
    const hl = (parent, text) => {
      const str = String(text || '');
      if (!tokens.length) { parent.textContent = str; return; }
      const re = new RegExp('(' + tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
      str.split(re).forEach((part, i) => {
        if (i % 2 === 1) { const m = document.createElement('mark'); m.textContent = part; parent.appendChild(m); }
        else if (part) parent.appendChild(document.createTextNode(part));
      });
    };
    if (matches.length === 0) {
      list.appendChild(el('div', 'pc-np-option-empty', '검색 결과가 없습니다.'));
      return;
    }
    matches.slice(0, NOTE_OPTION_LIMIT).forEach((site, idx) => {
      const opt = el('button', 'pc-np-option' + (site.id === NP.siteId ? ' is-selected' : ''));
      opt.type = 'button';
      opt.setAttribute('role', 'option');
      opt.dataset.index = String(idx);
      const main = el('div', 'pc-np-option-main');
      const nameEl = el('strong');
      hl(nameEl, siteLabel(site));
      main.appendChild(nameEl);
      if (site.address) { const addrEl = el('span'); hl(addrEl, site.address); main.appendChild(addrEl); }
      opt.appendChild(main);
      if (getNote(site.id)) opt.appendChild(el('em', 'pc-np-option-tag', '메모 작성됨'));
      opt.addEventListener('mousedown', (e) => e.preventDefault()); // input blur 방지
      opt.addEventListener('click', () => choose(site));
      list.appendChild(opt);
    });
    if (matches.length > NOTE_OPTION_LIMIT) {
      list.appendChild(el('div', 'pc-np-option-empty', `검색 결과 ${matches.length}건 중 ${NOTE_OPTION_LIMIT}건만 표시됩니다. 검색어를 더 입력해주세요.`));
    }
  }
  function openList(query) {
    renderList(query);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activeIndex = -1;
  }
  function moveActive(delta) {
    const opts = Array.from(list.querySelectorAll('.pc-np-option'));
    if (opts.length === 0) return;
    activeIndex = (activeIndex + delta + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('is-active', i === activeIndex));
    opts[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', () => { input.select(); openList(''); });
  input.addEventListener('input', () => openList(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) openList(input.value); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      const opts = list.querySelectorAll('.pc-np-option');
      if (!list.hidden && opts.length > 0) {
        e.preventDefault();
        (opts[activeIndex >= 0 ? activeIndex : 0]).click();
      }
    } else if (e.key === 'Escape') { closeList(); input.blur(); }
  });
  chevron.addEventListener('mousedown', (e) => e.preventDefault());
  chevron.addEventListener('click', () => {
    if (list.hidden) { input.focus(); } else { closeList(); }
  });
  npOutsideHandler = (e) => {
    if (!selectWrap.contains(e.target) && !list.hidden) closeList();
  };
  document.addEventListener('mousedown', npOutsideHandler);

  textarea.addEventListener('input', () => { draftRestored = false; syncCounter(); refreshButtons(); persistDraft(); });

  cancelBtn.addEventListener('click', () => {
    clearNoteDraft();
    NP.siteId = null;
    paintNotesPage();
  });

  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const siteId = NP.siteId;
    saveBtn.disabled = true;
    try {
      const ok = await saveNote(siteId, textarea.value);
      if (ok) {
        showToast('메모가 저장되었습니다.', 'success');
        clearNoteDraft();
        draftRestored = false;
        refreshButtons();
        if (NP.refreshSaved) NP.refreshSaved();
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

  delBtn.addEventListener('click', async () => {
    const siteId = NP.siteId;
    const existing = siteId ? getNote(siteId) : null;
    if (!existing) return;
    if (!window.confirm('이 메모를 삭제하시겠습니까?\n삭제한 메모는 복구할 수 없습니다.')) return;
    if (state.noteInFlight && state.noteInFlight.has(siteId)) return;
    if (state.noteInFlight) state.noteInFlight.add(siteId);
    delBtn.disabled = true;
    try {
      const ok = await deleteNote(siteId);
      if (ok) {
        textarea.value = '';
        syncCounter();
        clearNoteDraft();
        draftRestored = false;
        showToast('메모가 삭제되었습니다.', 'success');
        if (NP.refreshSaved) NP.refreshSaved();
      } else {
        showToast('메모 삭제에 실패했습니다. 다시 시도해주세요.');
      }
    } finally {
      if (state.noteInFlight) state.noteInFlight.delete(siteId);
      delBtn.disabled = false;
      refreshButtons();
    }
  });

  // 초기 상태(다시 그릴 때 선택된 현장이 있으면 복원)
  const site = selectedSite();
  if (site) {
    input.value = siteLabel(site);
    const existing = getNote(site.id);
    textarea.value = existing ? existing.content : '';
    if (NP.restoreDraft !== null) {
      textarea.value = NP.restoreDraft;
      draftRestored = true;
      NP.restoreDraft = null;
    }
    syncCounter();
  }
  refreshButtons();
  return card;
}

function buildSavedNotesCard() {
  const card = el('div', 'pc-np-saved');
  const head = el('div', 'pc-np-saved-head');
  head.appendChild(el('strong', '', '저장된 메모'));
  const badge = el('span', 'pc-sv-count-badge', '0건');
  head.appendChild(badge);
  card.appendChild(head);
  const body = el('div', 'pc-np-saved-list');
  card.appendChild(body);

  function paint() {
    body.innerHTML = '';
    const sitesById = new Map((state.sites || []).map(x => [x.id, x]));
    const notes = Array.from((state.siteNotes && state.siteNotes.values && state.siteNotes.values()) || [])
      .filter(n => sitesById.has(n.site_id))
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    badge.textContent = `${notes.length}건`;
    if (notes.length === 0) {
      body.appendChild(el('p', 'pc-np-saved-empty', '저장된 메모가 없습니다.'));
      return;
    }
    notes.forEach(n => {
      const site = sitesById.get(n.site_id);
      const item = el('button', 'pc-np-saved-item' + (n.site_id === NP.siteId ? ' is-active' : ''));
      item.type = 'button';
      const top = el('div', 'pc-np-saved-top');
      top.appendChild(el('strong', '', siteLabel(site)));
      top.appendChild(el('span', '', fmtTimestampDate(n.updated_at || n.created_at)));
      item.appendChild(top);
      item.appendChild(el('p', '', String(n.content || '').replace(/\s+/g, ' ').trim().slice(0, 70)));
      item.addEventListener('click', () => { if (NP.choose) NP.choose(site); });
      body.appendChild(item);
    });
  }
  NP.refreshSaved = paint;
  paint();
  return card;
}

function buildNoteHelpCard() {
  const card = el('div', 'pc-np-help' + (NP.helpOpen ? '' : ' is-collapsed'));
  const head = el('button', 'pc-np-help-head');
  head.type = 'button';
  const bulb = el('span', 'pc-np-help-bulb');
  bulb.appendChild(icon('bulb', 30));
  head.appendChild(bulb);
  head.appendChild(el('strong', '', '작성 도움말'));
  const caret = el('span', 'pc-np-help-caret');
  caret.appendChild(icon(NP.helpOpen ? 'chevronUp' : 'chevronDown', 22));
  head.appendChild(caret);
  head.setAttribute('aria-expanded', String(NP.helpOpen));
  head.addEventListener('click', () => {
    NP.helpOpen = !NP.helpOpen;
    card.classList.toggle('is-collapsed', !NP.helpOpen);
    caret.innerHTML = '';
    caret.appendChild(icon(NP.helpOpen ? 'chevronUp' : 'chevronDown', 22));
    head.setAttribute('aria-expanded', String(NP.helpOpen));
  });
  card.appendChild(head);

  const body = el('div', 'pc-np-help-body');
  const example = el('div', 'pc-np-help-example');
  example.appendChild(el('strong', '', '좋은 현장 메모 작성 예시'));
  const exList = el('ul', 'pc-np-help-list');
  [
    '확인한 주요 위험요인과 조치 필요 사항을 구체적으로 작성합니다.',
    '작업자의 안전수칙 준수 여부를 함께 기록합니다.',
    '추후 조치 예정 사항이나 재점검 계획을 포함하면 좋습니다.',
  ].forEach(t => {
    const li = el('li');
    const ic = el('span', 'pc-np-help-ic is-check');
    ic.appendChild(icon('checkSmall', 20));
    li.appendChild(ic);
    li.appendChild(el('span', '', t));
    exList.appendChild(li);
  });
  example.appendChild(exList);
  body.appendChild(example);

  const caution = el('div', 'pc-np-help-caution');
  caution.appendChild(el('strong', '', '유의사항'));
  const cList = el('ul', 'pc-np-help-list');
  [
    '개인정보(이름, 연락처 등)는 메모에 기재하지 않도록 주의합니다.',
    '사실에 근거하여 객관적으로 작성합니다.',
  ].forEach(t => {
    const li = el('li');
    const ic = el('span', 'pc-np-help-ic is-warn');
    ic.appendChild(icon('warn', 22));
    li.appendChild(ic);
    li.appendChild(el('span', '', t));
    cList.appendChild(li);
  });
  caution.appendChild(cList);
  body.appendChild(caution);
  card.appendChild(body);
  return card;
}
