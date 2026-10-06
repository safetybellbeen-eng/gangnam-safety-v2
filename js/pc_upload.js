// pc_upload.js — PC(데스크톱) 전용 "사업장 데이터 관리" 화면(확정 시안).
// 모바일/TWA 화면은 전혀 건드리지 않는다: 이 파일이 그리는 #pc-upload-page는 css/desktop.css의
// @media (min-width:769px) 안에서만 보이고, js/app.js의 activatePcTab()(모바일 폭에서는 즉시 return)
// 에서만 호출된다.
//
// 업로드 로직은 새로 만들지 않고 기존 모듈을 그대로 재사용한다:
//   excel.js(parseExcelFile: 파싱·식별번호·검증) → geocoding.js(runGeocodingForParsedRows: Edge Function 경유)
//   → import.js(previewImportImpact / importSitesToDatabase: 단일 트랜잭션 RPC, loadUploadHistory)
// CLAUDE.md의 Excel Import 원칙(DELETE ALL→INSERT ALL 금지, RPC 단일 트랜잭션, 누락 사업장 is_active=false)은
// RPC가 담당하며 이 파일은 DB를 직접 쓰지 않는다. 관리자 검증은 기존과 같이 RLS/RPC가 최종 확인한다.
// DB(gnmap_v2_upload_history)에는 '대기/실패' 상태 컬럼이 없어(성공한 업로드만 기록) 시안의 해당 배지는
// 실제 데이터가 생기는 경우(확인필요 건수 유무)만 구분해 표시한다.
import { state } from './state.js';
import { isAdmin } from './auth.js';
import { parseExcelFile } from './excel.js';
import {
  runGeocodingForParsedRows, runKeywordCandidateSearch, runKakaoLotRecovery, runJusoNormalize,
  runKakaoJusoRecovery, runRoadApproximateRecovery, buildLotQueries, buildJusoQuery, extractApproximateStructure,
} from './geocoding.js';
import { previewImportImpact, importSitesToDatabase, loadUploadHistory } from './import.js';
import { loadActiveSites } from './sites.js';
import { assignDongToSites } from './map.js';
import { showToast, renderDongOptions, renderSiteList, renderHeaderUploadDate } from './ui.js';

const MAX_BYTES = 10 * 1024 * 1024; // 시안: 최대 10MB
const pad2 = (n) => String(n).padStart(2, '0');
const FORM_LABEL = { form1: '양식 1 (본사명·공사기간형)', form2: '양식 2 (공사시작일·종료일형)' };
const FORM_SHORT = { form1: '양식 1', form2: '양식 2' };

// 양식 미리보기/다운로드 양식 — excel.js가 인식하는 '양식 2'(FORM2_REQUIRED + 선택 열)와 동일한 열 이름을 쓴다.
const TEMPLATE_HEADERS = ['사업장명', '사업현장명', '산재관리번호', '사업개시번호', '사업현장주소', '공사금액', '공사시작일', '공사종료일'];
const TEMPLATE_OPTIONAL = ['사업자등록번호', '법인등록번호'];
const TEMPLATE_ROWS = [
  ['삼성에스택', '테헤란로 현장', '11000000001', '1100000001', '강남구 테헤란로 123', 4800, '2025-03-01', '2026-08-31'],
  ['한빛개발', '강남대로 현장', '11000000002', '1100000002', '강남구 강남대로 456', 2300, '2025-01-15', '2026-01-30'],
  ['대성종합건설', '연주로 현장', '11000000003', '1100000003', '강남구 연주로 789', 8200, '2024-11-01', '2027-04-30'],
  ['한국기술산업', '봉은사로 현장', '11000000004', '1100000004', '강남구 봉은사로 234', 1200, '2025-02-10', '2025-12-31'],
  ['미래이엔지', '압구정로 현장', '11000000005', '1100000005', '강남구 압구정로 321', 6500, '2024-08-20', '2026-05-15'],
];

const PU = {
  tab: 'upload',          // 'upload' | 'history'
  hist: [],
  histLoaded: false,
  histLoading: false,
  histError: false,
  page: 1,
  size: 10,
  checked: new Set(),
  vfilter: 'all',         // 검증 결과 필터: all | error | warn
  busy: '',               // '' | 'parsing' | 'preview' | 'import'
  dragOver: false,
  hq: '', hfrom: '', hto: '',   // 이력 검색/기간
  hsort: 'date', hdir: 'desc',   // 이력 정렬
  hqFocus: false,
};
let puMenuCleanup = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
const ICONS = {
  info: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 11v6" stroke="#fff" stroke-width="2.2"/><circle cx="12" cy="7.6" r="1.3" fill="#fff" stroke="none"/>',
  megaphone: '<path d="M4 10v4h3.2L15 18.2V5.8L7.2 10H4z" fill="currentColor" stroke="none"/><path d="M17.5 9.2a4 4 0 0 1 0 5.6M19.8 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/>',
  dots: '<circle cx="12" cy="5" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.8" fill="currentColor" stroke="none"/>',
  first: '<path d="m12 7-5 5 5 5M18 7l-5 5 5 5"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  last: '<path d="m6 7 5 5-5 5M12 7l5 5-5 5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
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
function excelLogo() {
  const wrap = el('span', 'pc-up-xl');
  wrap.innerHTML =
    '<svg viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">' +
    '<rect x="22" y="6" width="44" height="60" rx="5" fill="#33c481"/>' +
    '<rect x="44" y="6" width="22" height="15" fill="#21a366"/><rect x="44" y="21" width="22" height="15" fill="#33c481"/>' +
    '<rect x="44" y="36" width="22" height="15" fill="#107c41"/><rect x="44" y="51" width="22" height="15" fill="#185c37"/>' +
    '<path d="M44 6h22v15H44zM44 36h22v15H44z" fill="none"/>' +
    '<rect x="4" y="16" width="40" height="40" rx="5" fill="#107c41"/>' +
    '<path d="m14 26 5.2 8L14 46h5.6l2.7-5.2 2.8 5.2h5.9L25.2 35l5.2-9h-5.6l-2.6 4.7-2.5-4.7z" fill="#fff"/></svg>';
  return wrap;
}

function fmtDT(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const fmtNum = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('ko-KR'));
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 업로드 이력의 처리 상태 — DB 컬럼(review_rows)으로 구분 가능한 두 가지만 표시한다.
function statusOf(h) {
  const review = Number(h.review_rows || 0);
  if (review > 0) return { cls: 'is-warn', label: '업로드 완료', result: `경고 ${fmtNum(review)}건`, resCls: 'is-warn' };
  return { cls: 'is-ok', label: '업로드 완료', result: `정상 ${fmtNum(h.confirmed_rows ?? h.total_rows)}건`, resCls: '' };
}

function closeMenu() { if (puMenuCleanup) { puMenuCleanup(); puMenuCleanup = null; } }

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
function confirmModal({ title, message, confirmLabel, rows, note }) {
  return new Promise((resolve) => {
    const wrap = el('div', 'pc-modal-body');
    const head = el('div', 'pc-modal-head');
    head.appendChild(el('h3', '', title));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'pc-up-confirm-msg', message));
    if (rows && rows.length) {
      const sumBox = el('div', 'pc-up-sumcard');
      rows.forEach(([k, v, cls]) => {
        const r = el('div', 'pc-up-sum-row' + (cls ? ' ' + cls : ''));
        r.appendChild(el('span', '', k));
        r.appendChild(el('strong', '', v));
        sumBox.appendChild(r);
      });
      wrap.appendChild(sumBox);
    }
    if (note) wrap.appendChild(el('p', 'pc-up-hint is-err', note));
    const actions = el('div', 'pc-modal-actions');
    const cancel = el('button', 'pc-sv-secondary-btn', '취소');
    cancel.type = 'button';
    const ok = el('button', 'pc-sv-primary-btn', confirmLabel || '확인');
    ok.type = 'button';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    wrap.appendChild(actions);
    let done = false;
    const { close } = openModal(wrap, { narrow: true });
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    const obs = new MutationObserver(() => { if (!document.body.contains(wrap)) { obs.disconnect(); finish(false); } });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

// ---------- 진입점 ----------
export async function renderPcUploadPage() {
  const root = document.getElementById('pc-upload-page');
  if (!root) return;
  if (!isAdmin()) {
    root.innerHTML = '';
    root.appendChild(el('p', 'pc-up-denied', '사업장 데이터 관리는 관리자만 이용할 수 있습니다.'));
    return;
  }
  PU.page = 1;
  PU.checked = new Set();
  bindPageDrop(root);
  paint();
  await refreshHistory();
}

async function refreshHistory() {
  PU.histLoading = true;
  paint();
  try {
    const list = await loadUploadHistory(200);
    PU.hist = list || [];
    PU.histError = false;
    state.uploadHistoryList = PU.hist;
  } catch (e) {
    PU.histError = true;
  }
  PU.histLoaded = true;
  PU.histLoading = false;
  const maxPage = Math.max(1, Math.ceil(PU.hist.length / PU.size));
  if (PU.page > maxPage) PU.page = maxPage;
  paint();
}

function resetUpload() {
  state.uploadParsedRows = [];
  state.uploadDetectedForm = null;
  state.uploadValidationSummary = null;
  state.uploadFileName = null;
  state.uploadImportResult = null;
  state.importPreview = null;
  state.geocodeProgress = null;
  state.uploadFileSize = null;
  PU.busy = '';
  PU.vfilter = 'all';
  paint();
}

// ---------- 화면 ----------
function paint() {
  const root = document.getElementById('pc-upload-page');
  if (!root) return;
  closeMenu();
  root.innerHTML = '';

  const titleBlock = el('div', 'pc-up-titleblock');
  titleBlock.appendChild(el('h2', 'pc-np-title', '사업장 데이터 관리'));
  titleBlock.appendChild(el('p', 'pc-up-subtitle', '엑셀 파일을 업로드하여 사업장 데이터를 등록하고, 업로드 이력을 확인할 수 있습니다.'));
  root.appendChild(titleBlock);

  const tabs = el('div', 'pc-up-tabs');
  [['upload', '엑셀 업로드'], ['history', '업로드 이력']].forEach(([key, label]) => {
    const b = el('button', 'pc-up-tab' + (PU.tab === key ? ' active' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => { if (PU.tab !== key) { PU.tab = key; paint(); } });
    tabs.appendChild(b);
  });
  root.appendChild(tabs);

  if (PU.tab === 'upload') {
    root.appendChild(buildStepper());
    const grid = el('div', 'pc-up-grid');
    const left = el('div', 'pc-up-left');
    left.appendChild(buildUploadCard());
    left.appendChild(buildGuideBox());
    const right = el('div', 'pc-up-right');
    right.appendChild(buildPreviewCard());
    right.appendChild(buildNoticeCard());
    grid.appendChild(left);
    grid.appendChild(right);
    root.appendChild(grid);
  } else {
    root.appendChild(buildHistoryCard({ compact: false }));
  }
  if (PU.hqFocus) {
    PU.hqFocus = false;
    const qi = root.querySelector('.pc-up-hsearch');
    if (qi) { qi.focus(); try { qi.setSelectionRange(qi.value.length, qi.value.length); } catch (e) { /* ignore */ } }
  }
}

// ---- 진행 단계 표시줄 ----
function currentStep() {
  const parsed = !!state.uploadFileName && !!state.uploadDetectedForm && (state.uploadParsedRows || []).length > 0;
  const saved = !!(state.uploadImportResult && state.uploadImportResult.success);
  if (saved) return 4;
  if (parsed && geocodeDone()) return 3;
  if (parsed) return 2;
  return 0;
}
function buildStepper() {
  const cur = currentStep();
  const bar = el('ol', 'pc-up-stepper');
  ['파일 선택', '검증', '좌표 확인', '저장'].forEach((label, i) => {
    const li = el('li', 'pc-up-step-item' + (i < cur ? ' is-done' : (i === cur ? ' is-current' : '')));
    li.appendChild(el('span', 'pc-up-step-dot', i < cur ? '✓' : String(i + 1)));
    li.appendChild(el('span', 'pc-up-step-label', label));
    bar.appendChild(li);
  });
  return bar;
}

// 저장하지 않은 업로드 파일이 있는지(탭 이동/새로고침 경고에 사용)
function isDirty() {
  const saved = !!(state.uploadImportResult && state.uploadImportResult.success);
  return !saved && (!!PU.busy || (!!state.uploadFileName && (state.uploadParsedRows || []).length > 0));
}
window.__pcUploadDirty = isDirty;
if (!window.__pcUploadUnloadBound) {
  window.__pcUploadUnloadBound = true;
  window.addEventListener('beforeunload', (e) => {
    if (document.getElementById('app') && document.getElementById('app').dataset.pcTab === 'upload' && window.__pcUploadDirty && window.__pcUploadDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// 페이지 어디에 파일을 끌어놓아도 업로드되도록 한다.
function bindPageDrop(root) {
  if (root.__puDropBound) return;
  root.__puDropBound = true;
  let depth = 0;
  let overlay = null;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const hide = () => { depth = 0; if (overlay) { overlay.remove(); overlay = null; } };
  root.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !isAdmin()) return;
    depth++;
    if (!overlay) {
      overlay = el('div', 'pc-up-dropall');
      overlay.appendChild(el('strong', '', '여기에 파일을 놓으세요'));
      overlay.appendChild(el('span', '', '엑셀 파일(.xlsx, .xls) · 최대 10MB'));
      root.appendChild(overlay);
    }
  });
  root.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  root.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) hide(); });
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (PU.busy || state.geocodeInProgress || state.uploadImportInProgress) { showToast('처리 중에는 새 파일을 올릴 수 없습니다.', 'error'); return; }
    PU.tab = 'upload';
    handleFile(f);
  });
}

// ---- 좌측: 업로드 카드(드롭존 / 분석 결과 / 완료 결과) ----
function buildUploadCard() {
  const input = el('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.className = 'pc-up-fileinput';
  input.addEventListener('change', () => { const f = input.files && input.files[0]; if (f) handleFile(f); input.value = ''; });
  const pick = () => input.click();

  if (PU.busy === 'parsing') {
    const box = el('div', 'pc-up-drop is-busy');
    box.appendChild(excelLogo());
    box.appendChild(el('p', 'pc-up-drop-title', '파일을 읽는 중입니다...'));
    return box;
  }

  const r = state.uploadImportResult;
  if (r && r.success) {
    const box = el('div', 'pc-up-drop is-result');
    box.appendChild(el('span', 'pc-up-result-mark', '✓'));
    box.appendChild(el('p', 'pc-up-drop-title', '업로드가 완료되었습니다.'));
    box.appendChild(el('p', 'pc-up-result-desc',
      `전체 ${fmtNum(r.total_rows)}건 · 신규 ${fmtNum(r.inserted)}건 · 갱신 ${fmtNum(r.updated)}건 · 확인필요 ${fmtNum(r.review_count)}건`));
    const again = el('button', 'pc-up-primary', '새 파일 업로드');
    again.type = 'button';
    again.addEventListener('click', resetUpload);
    box.appendChild(again);
    return box;
  }

  if (state.uploadFileName && (state.uploadParsedRows && state.uploadParsedRows.length || state.uploadDetectedForm === null)) {
    return buildAnalyzedCard(pick, input);
  }

  // 초기: 드롭존 (시안)
  const box = el('div', 'pc-up-drop' + (PU.dragOver ? ' is-over' : ''));
  box.appendChild(excelLogo());
  const t = el('p', 'pc-up-drop-title');
  t.appendChild(document.createTextNode('엑셀 파일을 여기에 드래그하거나'));
  t.appendChild(document.createElement('br'));
  t.appendChild(document.createTextNode('파일을 선택하세요.'));
  box.appendChild(t);
  box.appendChild(el('p', 'pc-up-drop-meta', '지원 형식 : .xlsx, .xls  |  최대 10MB'));
  const btn = el('button', 'pc-up-primary', '파일 선택');
  btn.type = 'button';
  btn.addEventListener('click', pick);
  box.appendChild(btn);
  box.appendChild(input);
  box.addEventListener('dragover', (e) => { if (!PU.dragOver) { PU.dragOver = true; box.classList.add('is-over'); } });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) { PU.dragOver = false; box.classList.remove('is-over'); } });
  box.addEventListener('drop', () => { PU.dragOver = false; });
  return box;
}

async function handleFile(file) {
  if (!isAdmin()) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) { showToast('엑셀 파일(.xlsx, .xls)만 업로드할 수 있습니다.', 'error'); return; }
  if (file.size > MAX_BYTES) { showToast('파일 크기는 최대 10MB까지 업로드할 수 있습니다.', 'error'); return; }
  state.geocodeProgress = null;
  state.geocodeInProgress = false;
  state.uploadFileName = file.name;
  state.uploadFileSize = file.size;
  state.uploadImportResult = null;
  state.importPreview = null;
  PU.vfilter = 'all';
  PU.busy = 'parsing';
  paint();
  try {
    await parseExcelFile(file, state);
  } catch (err) {
    console.error('엑셀 파싱 실패:', err);
    state.uploadParsedRows = [];
    state.uploadDetectedForm = null;
    state.uploadValidationSummary = null;
    state.uploadFileName = null;
    PU.busy = '';
    paint();
    showToast('파일을 읽는 중 오류가 발생했습니다.', 'error');
    return;
  }
  PU.busy = '';
  paint();
}

function importableRows() { return (state.uploadParsedRows || []).filter(r => r._validation !== 'ERROR'); }
function geocodeDone() {
  const rows = importableRows();
  return rows.length > 0 && rows.every(r => ['EXACT', 'ESTIMATED', 'APPROXIMATE', 'UNRESOLVED'].includes(r._locationQuality));
}

function buildAnalyzedCard(pick, input) {
  const box = el('div', 'pc-up-drop is-analyzed');
  box.appendChild(input);

  const fileRow = el('div', 'pc-up-file');
  fileRow.appendChild(excelLogo());
  const info = el('div', 'pc-up-file-info');
  info.appendChild(el('strong', '', state.uploadFileName || '-'));
  info.appendChild(el('span', '', [state.uploadDetectedForm ? FORM_LABEL[state.uploadDetectedForm] : '', state.uploadFileSize ? fmtSize(state.uploadFileSize) : ''].filter(Boolean).join(' · ')));
  fileRow.appendChild(info);
  const change = el('button', 'pc-up-ghost', '다른 파일 선택');
  change.type = 'button';
  change.disabled = !!state.geocodeInProgress || !!state.uploadImportInProgress;
  change.addEventListener('click', pick);
  fileRow.appendChild(change);
  box.appendChild(fileRow);

  if (!state.uploadDetectedForm) {
    box.appendChild(el('p', 'pc-up-error', '인식할 수 없는 양식입니다. 오른쪽 양식 미리보기와 같은 열 이름의 엑셀인지 확인해주세요.'));
    return box;
  }

  const s = state.uploadValidationSummary || { total: 0, validCount: 0, warningCount: 0, errorCount: 0 };
  const stats = el('div', 'pc-up-stats');
  [['전체', s.total, ''], ['정상', s.validCount, 'is-ok'], ['경고', s.warningCount, 'is-warn'], ['오류', s.errorCount, 'is-err']].forEach(([lab, n, cls]) => {
    const c = el('div', 'pc-up-stat ' + cls);
    c.appendChild(el('strong', '', fmtNum(n)));
    c.appendChild(el('span', '', lab));
    stats.appendChild(c);
  });
  box.appendChild(stats);
  if (s.errorCount > 0) {
    const al = el('div', 'pc-up-alert is-err');
    al.appendChild(el('span', 'pc-up-alert-text', `오류 ${fmtNum(s.errorCount)}건은 저장에서 제외됩니다. 엑셀을 수정해 다시 올리거나 그대로 진행할 수 있습니다.`));
    const v = el('button', 'pc-up-link', '오류 행 보기');
    v.type = 'button';
    v.addEventListener('click', () => openValidationModal('error'));
    const c = el('button', 'pc-up-link', '오류 행 CSV');
    c.type = 'button';
    c.addEventListener('click', downloadErrorRowsCsv);
    al.appendChild(v); al.appendChild(c);
    box.appendChild(al);
  } else if (s.warningCount > 0) {
    const al = el('div', 'pc-up-alert is-warn');
    al.appendChild(el('span', 'pc-up-alert-text', `경고 ${fmtNum(s.warningCount)}건(주소·공사금액·법인번호 등 누락)이 있습니다. 저장은 가능합니다.`));
    const v = el('button', 'pc-up-link', '경고 행 보기');
    v.type = 'button';
    v.addEventListener('click', () => openValidationModal('warn'));
    al.appendChild(v);
    box.appendChild(al);
  }
  if (s.duplicateCount > 0) box.appendChild(el('p', 'pc-up-hint is-err', `배치 내 사업개시번호 중복 ${fmtNum(s.duplicateCount)}건은 오류로 처리되어 저장에서 제외됩니다.`));

  // 좌표 확인
  const geo = el('div', 'pc-up-step');
  const geoHead = el('div', 'pc-up-step-head');
  geoHead.appendChild(el('strong', '', '① 주소 좌표 확인'));
  const hasRun = (state.uploadParsedRows || []).some(r => r._geocodeStatus);
  const gbtn = el('button', 'pc-up-ghost', state.geocodeInProgress ? '확인 중...' : (hasRun ? '다시 확인' : '좌표 확인 시작'));
  gbtn.type = 'button';
  gbtn.disabled = !!state.geocodeInProgress || !!state.uploadImportInProgress || importableRows().length === 0;
  gbtn.addEventListener('click', startGeocode);
  geoHead.appendChild(gbtn);
  geo.appendChild(geoHead);
  const prog = el('p', 'pc-up-progress');
  prog.id = 'pc-up-geo-progress';
  if (state.geocodeProgress) {
    const p = state.geocodeProgress;
    prog.textContent = `${state.geocodeInProgress ? '확인 중' : '완료'} ${p.done}/${p.total}건 · 성공 ${p.success} · 결과없음 ${p.notFound} · 오류 ${p.error}`;
  } else {
    prog.textContent = '저장 전에 주소를 좌표로 변환합니다. (오류 행은 제외)';
  }
  geo.appendChild(prog);
  if (hasRun) {
    const q = { EXACT: 0, ESTIMATED: 0, APPROXIMATE: 0, UNRESOLVED: 0 };
    state.uploadParsedRows.forEach(r => { if (q[r._locationQuality] !== undefined) q[r._locationQuality]++; });
    geo.appendChild(el('p', 'pc-up-hint', `정확 ${fmtNum(q.EXACT)} · 추정 ${fmtNum(q.ESTIMATED)} · 대표위치(확인요망) ${fmtNum(q.APPROXIMATE)} · 확인필요 ${fmtNum(q.UNRESOLVED)}`));
    const nf = state.uploadParsedRows.filter(r => r._geocodeStatus === 'NOT_FOUND').length;
    if (q.UNRESOLVED > 0 || nf > 0) {
      const rb = el('button', 'pc-up-ghost pc-up-rec-open', `위치 확인이 안 된 주소 복구 (미확인 ${fmtNum(q.UNRESOLVED)}건)`);
      rb.type = 'button';
      rb.disabled = !!state.uploadImportInProgress;
      rb.addEventListener('click', openRecoveryModal);
      geo.appendChild(rb);
    }
  }
  box.appendChild(geo);

  // 저장
  const canImport = geocodeDone() && !state.uploadImportInProgress && !state.geocodeInProgress && PU.busy === '';
  const actions = el('div', 'pc-up-actions');
  const detailBtn = el('button', 'pc-up-ghost', '검증 결과 보기');
  detailBtn.type = 'button';
  detailBtn.addEventListener('click', () => openValidationModal('all'));
  const adv = el('button', 'pc-up-link', '고급 복구 도구(기존 화면)');
  adv.type = 'button';
  adv.title = '결과없음 CSV, 후보 검색 등 기존 PC 업로드 화면을 엽니다(파일을 다시 선택해야 합니다).';
  adv.addEventListener('click', () => { const b = document.getElementById('btn-upload-panel'); if (b) b.click(); });
  const imp = el('button', 'pc-up-primary', PU.busy === 'preview' || PU.busy === 'import' ? '저장 중...' : '② 사업장 데이터 업로드');
  imp.type = 'button';
  imp.disabled = !canImport;
  imp.addEventListener('click', startImport);
  actions.appendChild(detailBtn);
  actions.appendChild(adv);
  actions.appendChild(imp);
  box.appendChild(actions);
  if (PU.busy === 'import') box.appendChild(el('p', 'pc-up-saving', '저장 중입니다. 사업장 수에 따라 시간이 걸릴 수 있으니 창을 닫거나 다른 화면으로 이동하지 마세요.'));
  if (!geocodeDone() && !state.geocodeInProgress) box.appendChild(el('p', 'pc-up-hint', '주소 좌표 확인을 완료한 후 저장할 수 있습니다.'));
  if (r0() && !r0().success) box.appendChild(el('p', 'pc-up-error', `저장 실패: ${r0().message || '저장에 실패했습니다.'}`));
  if (state.importPreview && !state.importPreview.success) box.appendChild(el('p', 'pc-up-error', `사전 검증 실패: ${state.importPreview.message}`));
  return box;
}
function r0() { return state.uploadImportResult; }

async function startGeocode() {
  if (state.geocodeInProgress) return;
  state.geocodeInProgress = true;
  paint();
  try {
    await runGeocodingForParsedRows((progress) => {
      state.geocodeProgress = progress;
      const p = document.getElementById('pc-up-geo-progress');
      if (p) p.textContent = `확인 중 ${progress.done}/${progress.total}건 · 성공 ${progress.success} · 결과없음 ${progress.notFound} · 오류 ${progress.error}`;
    });
  } catch (e) {
    console.error('좌표 확인 실패:', e);
    showToast('주소 좌표 확인 중 오류가 발생했습니다.', 'error');
  } finally {
    state.geocodeInProgress = false;
    paint();
  }
}

async function startImport() {
  if (state.uploadImportInProgress || PU.busy) return;
  PU.busy = 'preview';
  paint();
  let preview;
  try {
    preview = await previewImportImpact(state.uploadFileName, state.uploadDetectedForm);
    state.importPreview = preview;
  } finally {
    PU.busy = '';
    paint();
  }
  if (!preview || !preview.success) return;

  const all = state.uploadParsedRows || [];
  const targets = importableRows();
  const qc = { EXACT: 0, ESTIMATED: 0, APPROXIMATE: 0, UNRESOLVED: 0 };
  targets.forEach(r => { if (qc[r._locationQuality] !== undefined) qc[r._locationQuality]++; });
  const noCoord = qc.UNRESOLVED;
  const ok = await confirmModal({
    title: '사업장 데이터 업로드',
    message: '아래 내용으로 저장합니다. 저장 후에는 일괄로 되돌릴 수 없습니다.',
    rows: [
      ['파일', state.uploadFileName || '-'],
      ['파일 전체 행', `${fmtNum(all.length)}건`],
      ['오류로 제외', `${fmtNum(all.length - targets.length)}건`, all.length - targets.length ? 'is-err' : ''],
      ['저장 대상', `${fmtNum(preview.total)}건 (신규 ${fmtNum(preview.insertCount)} · 갱신 ${fmtNum(preview.updateCount)})`],
      ['위치 확인', `정확 ${fmtNum(qc.EXACT)} · 추정 ${fmtNum(qc.ESTIMATED)} · 대표위치 ${fmtNum(qc.APPROXIMATE)} · 미확인 ${fmtNum(qc.UNRESOLVED)}`],
    ],
    note: noCoord > 0 ? `위치 미확인 ${fmtNum(noCoord)}건은 좌표 없이 저장되어 지도에는 표시되지 않습니다.` : '',
    confirmLabel: '저장',
  });
  if (!ok) return;

  state.uploadImportInProgress = true;
  PU.busy = 'import';
  paint();
  try {
    const result = await importSitesToDatabase(state.uploadFileName, state.uploadDetectedForm);
    state.uploadImportResult = result;
    if (result.success) {
      // 기존 모바일/PC 업로드와 같은 후처리: 사업장 목록·동 배정·필터를 다시 읽어 지도/목록에 즉시 반영한다.
      try {
        state.sites = await loadActiveSites();
        await assignDongToSites(state.sites);
        renderDongOptions();
        renderSiteList('site-list');
        renderHeaderUploadDate();
      } catch (e) { console.error('업로드 후 목록 갱신 실패:', e); }
      showToast('사업장 데이터를 업로드했습니다.', 'success');
    } else {
      showToast(result.message || '저장에 실패했습니다.', 'error');
    }
  } finally {
    state.uploadImportInProgress = false;
    PU.busy = '';
    paint();
  }
  if (state.uploadImportResult && state.uploadImportResult.success) await refreshHistory();
}

// ---- 좌측 하단: 업로드 안내 ----
function buildGuideBox() {
  const box = el('div', 'pc-up-guide');
  const head = el('div', 'pc-up-guide-head');
  const title = el('div', 'pc-up-box-title');
  const ic = el('span', 'pc-up-box-icon is-info');
  ic.appendChild(icon('info', 26));
  title.appendChild(ic);
  title.appendChild(el('strong', '', '업로드 안내'));
  head.appendChild(title);
  box.appendChild(head);
  const ul = el('ul', 'pc-up-bullets');
  ['지정된 엑셀 양식에 맞게 작성한 이후 업로드해주세요.', '중복된 사업장 데이터(사업개시번호 기준)는 자동으로 업데이트됩니다.', '업로드 후 데이터 처리에는 일정 시간이 소요될 수 있습니다.'].forEach(t => ul.appendChild(el('li', '', t)));
  box.appendChild(ul);
  return box;
}

// ---- 우측: 양식 미리보기 / 유의사항 ----
function buildPreviewCard() {
  const card = el('div', 'pc-up-card is-preview');
  card.appendChild(el('h3', 'pc-up-card-title', '양식 미리보기'));
  const wrap = el('div', 'pc-up-sheetwrap');
  const table = el('table', 'pc-up-sheet');
  const thead = el('thead');
  const letters = el('tr', 'is-letters');
  letters.appendChild(el('th', 'is-corner'));
  TEMPLATE_HEADERS.forEach((h, i) => letters.appendChild(el('th', '', String.fromCharCode(65 + i))));
  thead.appendChild(letters);
  const names = el('tr', 'is-names');
  names.appendChild(el('th', 'is-corner'));
  TEMPLATE_HEADERS.forEach(h => names.appendChild(el('th', '', h)));
  thead.appendChild(names);
  table.appendChild(thead);
  const tbody = el('tbody');
  TEMPLATE_ROWS.forEach((r, i) => {
    const tr = el('tr');
    tr.appendChild(el('th', 'is-rownum', String(i + 1)));
    r.forEach((v, c) => {
      const td = el('td', c === 5 ? 'is-num' : (c >= 6 ? 'is-date' : ''), c === 5 ? Number(v).toLocaleString('ko-KR') : String(v));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  card.appendChild(el('p', 'pc-up-sheet-note', `※ 예시 데이터입니다. 선택 열: ${TEMPLATE_OPTIONAL.join(', ')}`));
  return card;
}

function buildNoticeCard() {
  const card = el('div', 'pc-up-notice');
  const title = el('div', 'pc-up-box-title');
  const ic = el('span', 'pc-up-box-icon is-mega');
  ic.appendChild(icon('megaphone', 24));
  title.appendChild(ic);
  title.appendChild(el('strong', '', '업로드 시 유의사항'));
  card.appendChild(title);
  const ul = el('ul', 'pc-up-bullets');
  [
    '엑셀 파일의 첫 번째 행은 반드시 제목 행이어야 합니다.',
    '필수 항목(사업장명, 사업개시번호, 공사금액 등)은 반드시 입력해야 합니다.',
    '날짜 형식은 YYYY-MM-DD 또는 YYYY.MM.DD 형식으로 입력해주세요.',
    '업로드 후 결과는 업로드 이력에서 처리 결과를 확인할 수 있습니다.',
  ].forEach(t => ul.appendChild(el('li', '', t)));
  card.appendChild(ul);
  return card;
}

// ---- 업로드 이력 ----
function buildHistoryCard({ compact }) {
  const card = el('div', 'pc-up-card is-history' + (compact ? ' is-compact' : ''));
  const head = el('div', 'pc-up-hist-head');
  head.appendChild(el('h3', 'pc-up-card-title', compact ? '최근 업로드 이력' : '업로드 이력'));
  if (PU.checked.size > 0) {
    const exp = el('button', 'pc-up-link', `선택 ${PU.checked.size}건 CSV 저장`);
    exp.type = 'button';
    exp.addEventListener('click', exportChecked);
    head.appendChild(exp);
  }
  card.appendChild(head);

  const frow = el('div', 'pc-up-hfilter');
  const qin = el('input', 'pc-up-hsearch');
  qin.type = 'search';
  qin.placeholder = '파일명·업로드자 검색';
  qin.value = PU.hq;
  qin.addEventListener('input', () => { PU.hq = qin.value; PU.page = 1; PU.hqFocus = true; paint(); });
  frow.appendChild(qin);
  const rg = el('div', 'pc-up-range');
  rg.appendChild(el('span', '', '기간'));
  const f1 = el('input'); f1.type = 'date'; f1.value = PU.hfrom; f1.max = PU.hto || '';
  const f2 = el('input'); f2.type = 'date'; f2.value = PU.hto; f2.min = PU.hfrom || '';
  f1.addEventListener('change', () => { PU.hfrom = f1.value; PU.page = 1; paint(); });
  f2.addEventListener('change', () => { PU.hto = f2.value; PU.page = 1; paint(); });
  rg.appendChild(f1); rg.appendChild(el('span', '', '~')); rg.appendChild(f2);
  frow.appendChild(rg);
  if (PU.hq || PU.hfrom || PU.hto) {
    const rs = el('button', 'pc-up-link', '필터 초기화');
    rs.type = 'button';
    rs.addEventListener('click', () => { PU.hq = ''; PU.hfrom = ''; PU.hto = ''; PU.page = 1; paint(); });
    frow.appendChild(rs);
  }
  card.appendChild(frow);

  const list = filteredHist();
  const total = list.length;
  const size = PU.size;
  const pages = Math.max(1, Math.ceil(total / size));
  if (PU.page > pages) PU.page = pages;
  const slice = list.slice((PU.page - 1) * size, PU.page * size);

  const wrap = el('div', 'pc-up-tablewrap');
  const table = el('table', 'pc-up-table');
  const thead = el('thead');
  const hr = el('tr');
  const thc = el('th', 'pc-up-col-check');
  const all = el('input');
  all.type = 'checkbox';
  all.setAttribute('aria-label', '현재 페이지 전체 선택');
  all.checked = slice.length > 0 && slice.every(h => PU.checked.has(h.id));
  all.addEventListener('change', () => { slice.forEach(h => (all.checked ? PU.checked.add(h.id) : PU.checked.delete(h.id))); paint(); });
  thc.appendChild(all);
  hr.appendChild(thc);
  [['업로드일시', 'date'], ['파일명', 'name'], ['건수', 'count'], ['처리 상태', 'status'], ['처리 결과', 'status'], ['작업', null]].forEach(([t, key], i) => {
    const th = el('th', 'pc-up-th-' + i);
    if (!key || (i === 4)) { th.textContent = t; hr.appendChild(th); return; }
    const on = PU.hsort === key;
    const sb = el('button', 'pc-up-sort' + (on ? ' is-on' : ''), t + (on ? (PU.hdir === 'asc' ? ' ▲' : ' ▼') : ' ↕'));
    sb.type = 'button';
    sb.addEventListener('click', () => { if (PU.hsort === key) PU.hdir = PU.hdir === 'asc' ? 'desc' : 'asc'; else { PU.hsort = key; PU.hdir = key === 'name' ? 'asc' : 'desc'; } PU.page = 1; paint(); });
    th.appendChild(sb);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (PU.histLoading && !PU.histLoaded) {
    const tr = el('tr'); const td = el('td', 'pc-up-empty', '업로드 이력을 불러오는 중...'); td.colSpan = 7; tr.appendChild(td); tbody.appendChild(tr);
  } else if (PU.histError) {
    const tr = el('tr'); const td = el('td', 'pc-up-empty', '업로드 이력을 불러오지 못했습니다.'); td.colSpan = 7; tr.appendChild(td); tbody.appendChild(tr);
  } else if (slice.length === 0) {
    const tr = el('tr'); const td = el('td', 'pc-up-empty', (PU.hq || PU.hfrom || PU.hto) ? '조건에 맞는 업로드 이력이 없습니다.' : '업로드 이력이 없습니다.'); td.colSpan = 7; tr.appendChild(td); tbody.appendChild(tr);
  } else {
    slice.forEach(h => {
      const st = statusOf(h);
      const tr = el('tr');
      const c0 = el('td', 'pc-up-col-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = PU.checked.has(h.id);
      cb.setAttribute('aria-label', '선택');
      cb.addEventListener('change', () => { cb.checked ? PU.checked.add(h.id) : PU.checked.delete(h.id); paint(); });
      c0.appendChild(cb);
      tr.appendChild(c0);
      const tdDate = el('td', '', fmtDT(h.uploaded_at));
      if (PU.hist[0] && PU.hist[0].id === h.id) tdDate.appendChild(el('span', 'pc-up-new', '최신'));
      tr.appendChild(tdDate);
      tr.appendChild(el('td', 'pc-up-td-file', h.file_name || '-'));
      tr.appendChild(el('td', 'pc-up-td-num', fmtNum(h.total_rows)));
      const cs = el('td');
      cs.appendChild(el('span', 'pc-up-badge ' + st.cls, st.label));
      tr.appendChild(cs);
      tr.appendChild(el('td', 'pc-up-td-result ' + st.resCls, st.result));
      const ca = el('td', 'pc-up-td-act');
      const view = el('button', 'pc-up-view');
      view.type = 'button';
      view.appendChild(icon('eye', 16));
      view.appendChild(document.createTextNode('상세보기'));
      view.addEventListener('click', () => openDetail(h.id));
      ca.appendChild(view);
      const dots = el('button', 'pc-up-dots');
      dots.type = 'button';
      dots.setAttribute('aria-label', '더보기');
      dots.appendChild(icon('dots', 18));
      dots.addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(dots, h); });
      ca.appendChild(dots);
      tr.appendChild(ca);
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  // 페이지 영역
  const pager = el('div', 'pc-up-pager');
  const nav = el('div', 'pc-up-pages');
  const mkBtn = (name, label, target, disabled) => {
    const b = el('button', 'pc-up-page-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.appendChild(icon(name, 16));
    b.addEventListener('click', () => { PU.page = target; paint(); });
    return b;
  };
  nav.appendChild(mkBtn('first', '처음', 1, PU.page <= 1));
  nav.appendChild(mkBtn('prev', '이전', PU.page - 1, PU.page <= 1));
  const start = Math.max(1, Math.min(PU.page - 2, pages - 4));
  const end = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) {
    const b = el('button', 'pc-up-page-num' + (p === PU.page ? ' active' : ''), String(p));
    b.type = 'button';
    b.addEventListener('click', () => { PU.page = p; paint(); });
    nav.appendChild(b);
  }
  nav.appendChild(mkBtn('next', '다음', PU.page + 1, PU.page >= pages));
  nav.appendChild(mkBtn('last', '마지막', pages, PU.page >= pages));
  pager.appendChild(nav);

  const right = el('div', 'pc-up-pager-right');
  const sel = el('label', 'pc-up-select');
  const select = el('select');
  [10, 20, 50].forEach(n => { const o = el('option', '', `${n}개씩 보기`); o.value = String(n); if (n === PU.size) o.selected = true; select.appendChild(o); });
  select.addEventListener('change', () => { PU.size = Number(select.value); PU.page = 1; paint(); });
  sel.appendChild(select);
  sel.appendChild(icon('chevronDown', 16));
  right.appendChild(sel);
  right.appendChild(el('span', 'pc-up-pageinfo', `${PU.page} / ${pages} 페이지`));
  pager.appendChild(right);
  card.appendChild(pager);
  return card;
}

function ymdLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function filteredHist() {
  const q = PU.hq.trim().toLowerCase();
  const rows = PU.hist.filter(h => {
    if (q && !`${h.file_name || ''} ${h.uploaded_by_name || ''}`.toLowerCase().includes(q)) return false;
    if (PU.hfrom || PU.hto) {
      const d = h.uploaded_at ? ymdLocal(h.uploaded_at) : '';
      if (!d) return false;
      if (PU.hfrom && d < PU.hfrom) return false;
      if (PU.hto && d > PU.hto) return false;
    }
    return true;
  });
  const val = (h) => {
    switch (PU.hsort) {
      case 'name': return h.file_name || '';
      case 'count': return Number(h.total_rows || 0);
      case 'status': return Number(h.review_rows || 0);
      default: return h.uploaded_at || '';
    }
  };
  const dir = PU.hdir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ko')) * dir;
  });
}

function openDetail(id) {
  const h = PU.hist.find(x => x.id === id);
  if (h) openHistoryModal(h);
}

function openRowMenu(anchor, h) {
  closeMenu();
  const menu = el('div', 'pc-ad-menu');
  const add = (label, fn) => {
    const b = el('button', 'pc-ad-menu-item', label);
    b.type = 'button';
    b.addEventListener('click', () => { closeMenu(); fn(); });
    menu.appendChild(b);
  };
  add('상세보기', () => openDetail(h.id));
  add('파일명 복사', async () => {
    try { await navigator.clipboard.writeText(h.file_name || ''); showToast('파일명을 복사했습니다.', 'success'); }
    catch (e) { showToast('복사하지 못했습니다.', 'error'); }
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey);
  puMenuCleanup = () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    menu.remove();
  };
}

// 오류 행만 '수정용' CSV로 저장한다(원인 확인 후 엑셀을 고쳐 다시 올릴 때 사용).
function downloadErrorRowsCsv() {
  const rows = (state.uploadParsedRows || []).filter(r => r._validation === 'ERROR');
  downloadCsv('업로드_오류행.csv', [
    ['엑셀 행', '오류 사유', '사업장명', '사업현장명', '산재관리번호', '사업개시번호', '주소', '공사금액', '공사시작일', '공사종료일'],
    ...rows.map(r => [(r._rowIndex ?? 0) + 2, (r._errors || []).join(', '), r.company_name || '', r.site_name || '', r.industrial_accident_no || '', r.business_start_no || '', r.address || '', r.amount ?? '', r.period_start || '', r.period_end || '']),
  ]);
}
function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function downloadCsv(name, rows) {
  const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportChecked() {
  const rows = PU.hist.filter(h => PU.checked.has(h.id));
  if (!rows.length) return;
  downloadCsv('업로드이력.csv', [
    ['업로드일시', '파일명', '양식', '업로드자', '전체', '확정', '확인필요'],
    ...rows.map(h => [fmtDT(h.uploaded_at), h.file_name, FORM_SHORT[h.source_form] || h.source_form || '', h.uploaded_by_name || '', h.total_rows, h.confirmed_rows, h.review_rows]),
  ]);
}

// ---- 위치 확인이 안 된 주소 복구 (기존 PC 업로드 화면의 복구 단계를 그대로 이어받는다) ----
// 순서: 위치 후보 검색(좌표 미반영) → 지번(LOT) 재검색 → 행안부 주소 재검색 → 행안부 주소로 좌표 확정 → 동일 도로 대표 위치.
// 각 단계는 geocoding.js의 기존 함수를 그대로 호출하며, 결과는 state.uploadParsedRows에 반영된다.
const GEO_STATUS = { SUCCESS: '좌표 확인됨', NOT_FOUND: '주소 검색결과 없음', ERROR: '좌표 확인 실패', PENDING: '확인 대기' };
const KW_STATUS = { STRONG_CANDIDATE: '강한 후보 있음', WEAK_CANDIDATE: '약한 후보 있음', NO_CANDIDATE: '후보 없음', ERROR: '검색 오류' };
const JUSO_STATUS = { MATCHED: '행안부 단일일치', AMBIGUOUS: '행안부 모호(복수일치)', NO_MATCH: '행안부 검증불일치', NOT_FOUND: '행안부 결과 없음', ERROR: '행안부 검색 오류' };
const REC = { view: 'unresolved' }; // 'unresolved' | 'notfound'
let recDraw = null;

function recRows() { return state.uploadParsedRows || []; }
function recUnresolved() { return recRows().filter(r => r._locationQuality === 'UNRESOLVED'); }

function recSteps() {
  const rows = recUnresolved();
  const lot = rows.filter(r => buildLotQueries(r).length > 0).length;
  const juso = rows.filter(r => buildJusoQuery(r) !== null).length;
  const kjuso = rows.filter(r => r._jusoStatus === 'MATCHED' && r._jusoMatchedCandidate).length;
  const road = rows.filter(r => extractApproximateStructure(r.address) !== null).length;
  const sum = (key, fmt) => (state[key] ? fmt(state[key]) : '');
  return [
    { id: 'kw', flag: 'keywordSearchInProgress', title: '① 위치 후보 검색', count: rows.filter(r => r.business_start_no).length,
      desc: '사업장명·주소로 후보 장소를 찾아 보여줍니다. 좌표는 자동으로 반영되지 않습니다.',
      summary: sum('keywordSearchSummary', s => `후보검색 ${s.done}/${s.total} · 강한후보 ${s.strong} · 약한후보 ${s.weak} · 후보없음 ${s.none} · 오류 ${s.error}`),
      run: async (cb) => { state.keywordSearchSummary = await runKeywordCandidateSearch((p) => { state.keywordSearchSummary = p; cb(`후보검색 ${p.done}/${p.total} · 강한후보 ${p.strong} · 약한후보 ${p.weak} · 후보없음 ${p.none} · 오류 ${p.error}`); }); } },
    { id: 'lot', flag: 'lotRecoveryInProgress', title: '② Kakao 지번(LOT) 재검색', count: lot,
      desc: '원본에 지번이 있는 주소를 지번 기준으로 다시 검색해 좌표를 확정합니다.',
      summary: sum('lotRecoverySummary', s => `대상 ${s.total}건 · 성공 ${s.success} · 결과없음 ${s.notFound} · 오류 ${s.error}`),
      run: async (cb) => { state.lotRecoverySummary = await runKakaoLotRecovery((p) => { state.lotRecoverySummary = p; cb(`대상 ${p.total}건 · 성공 ${p.success} · 결과없음 ${p.notFound} · 오류 ${p.error}`); }); } },
    { id: 'juso', flag: 'jusoNormalizeInProgress', title: '③ 행안부 주소 재검색', count: juso,
      desc: '도로명+건물번호를 행안부 주소로 검증해 후보를 만듭니다. 좌표는 아직 확정되지 않습니다.',
      summary: sum('jusoNormalizeSummary', s => `대상 ${s.total} · 단일일치 ${s.matched} · 모호 ${s.ambiguous} · 검증불일치 ${s.noMatch} · 결과없음 ${s.notFound} · 오류 ${s.error}`),
      run: async (cb) => { state.jusoNormalizeSummary = await runJusoNormalize((p) => { state.jusoNormalizeSummary = p; cb(`대상 ${p.total} · 단일일치 ${p.matched} · 모호 ${p.ambiguous} · 검증불일치 ${p.noMatch} · 결과없음 ${p.notFound} · 오류 ${p.error}`); }); } },
    { id: 'kjuso', flag: 'kakaoJusoInProgress', title: '④ 행안부 주소로 좌표 확정', count: kjuso,
      desc: '③에서 정확히 1건 일치한 주소만 대상으로 좌표를 확정합니다. 모호·불일치는 제외됩니다.',
      summary: sum('kakaoJusoSummary', s => `대상 ${s.total}건 · 좌표복구 ${s.success} · 결과없음 ${s.notFound} · 오류 ${s.error}`),
      run: async (cb) => { state.kakaoJusoSummary = await runKakaoJusoRecovery((p) => { state.kakaoJusoSummary = p; cb(`대상 ${p.total}건 · 좌표복구 ${p.success} · 결과없음 ${p.notFound} · 오류 ${p.error}`); }); } },
    { id: 'road', flag: 'roadApproximateInProgress', title: '⑤ 동일 도로 대표 위치 확보', count: road,
      desc: '위 방법으로도 안 되는 주소에 같은 도로의 대표 위치를 지정합니다. ⚠ 정확한 위치가 아니므로 확인이 필요합니다.',
      summary: sum('roadApproximateSummary', s => `대상 ${s.total}건 · 대표위치 확보 ${s.success}(⚠ 확인요망) · 결과없음 ${s.notFound} · 오류 ${s.error}`),
      run: async (cb) => { state.roadApproximateSummary = await runRoadApproximateRecovery((p) => { state.roadApproximateSummary = p; cb(`대상 ${p.total}건 · 대표위치 확보 ${p.success}(⚠ 확인요망) · 결과없음 ${p.notFound} · 오류 ${p.error}`); }); } },
  ];
}

function anyRecBusy() {
  return ['keywordSearchInProgress', 'lotRecoveryInProgress', 'jusoNormalizeInProgress', 'kakaoJusoInProgress', 'roadApproximateInProgress', 'geocodeInProgress', 'uploadImportInProgress'].some(k => state[k]);
}

async function runRecStep(step) {
  if (anyRecBusy()) return;
  state[step.flag] = true;
  if (recDraw) recDraw();
  try {
    await step.run((text) => { const p = document.getElementById('pc-up-rec-sum-' + step.id); if (p) p.textContent = text; });
  } catch (e) {
    console.error('위치 복구 단계 실패:', step.id, e);
    showToast('처리 중 오류가 발생했습니다.', 'error');
  } finally {
    state[step.flag] = false;
    if (recDraw) recDraw();
    paint();
  }
}

async function recSearchOne(row) {
  if (anyRecBusy()) return;
  state.keywordSearchInProgress = true;
  if (recDraw) recDraw();
  try { await runKeywordCandidateSearch(() => {}, row); }
  catch (e) { console.error('후보 검색 실패:', e); showToast('후보 검색 중 오류가 발생했습니다.', 'error'); }
  finally { state.keywordSearchInProgress = false; if (recDraw) recDraw(); }
}

function geoLabel(r) {
  const methodLabel = { NORMALIZED: '위치 추정(정제주소)', CORE_ADDRESS: '위치 추정(핵심주소)', KAKAO_LOT: '위치 추정(지번 재검색)', KAKAO_JUSO: '위치 추정(행안부 주소)' };
  const q = { EXACT: '위치 확인', UNRESOLVED: '위치 확인 필요', APPROXIMATE: '⚠ 위치 확인요망(대표 위치)' };
  return (r._locationQuality === 'ESTIMATED' && methodLabel[r._geocodeMethod]) || q[r._locationQuality] || GEO_STATUS[r._geocodeStatus] || '-';
}

function downloadNotFoundCsv() {
  const rows = recRows().filter(r => r._geocodeStatus === 'NOT_FOUND');
  downloadCsv('geocode_notfound.csv', [
    ['business_start_no', 'site_name', 'original_address', 'searched_address', 'lot_queries', 'successful_lot_query', 'geocode_method', 'location_quality', 'lat', 'lng'],
    ...rows.map(r => [r.business_start_no || '', r.site_name || r.company_name || '', r.address || '', r._geocodeSearchedAddress || '', (r._lotQueries || []).join(' | '), r._lotSuccessfulQuery || '', r._geocodeMethod || '', r._locationQuality || '', r.lat ?? '', r.lng ?? '']),
  ]);
}
function downloadKeywordCsv() {
  const out = [['business_start_no', 'site_name', 'original_address', 'keyword_query', 'candidate_status', 'candidate_place_name', 'candidate_address', 'candidate_lat', 'candidate_lng']];
  recUnresolved().forEach(r => {
    const cands = r._keywordCandidates && r._keywordCandidates.length ? r._keywordCandidates : [null];
    cands.forEach(c => out.push([r.business_start_no || '', r.site_name || r.company_name || '', r.address || '', r._keywordQuery || '', r._keywordSearchStatus || '', c ? (c.placeName || '') : '', c ? (c.roadAddressName || c.addressName || '') : '', c ? c.lat : '', c ? c.lng : '']));
  });
  downloadCsv('keyword_candidates.csv', out);
}

function openRecoveryModal() {
  const { wrap, close } = modalShell('위치 확인이 안 된 주소 복구');
  const body = el('div', 'pc-up-rec');
  wrap.appendChild(body);
  const actions = el('div', 'pc-modal-actions');
  const ok = el('button', 'pc-sv-primary-btn', '닫기');
  ok.type = 'button';
  ok.addEventListener('click', close);
  actions.appendChild(ok);
  wrap.appendChild(actions);

  const draw = () => {
    if (!document.body.contains(wrap)) { recDraw = null; return; }
    body.innerHTML = '';
    const busy = anyRecBusy();
    const rows = recRows();
    const q = { EXACT: 0, ESTIMATED: 0, APPROXIMATE: 0, UNRESOLVED: 0 };
    rows.forEach(r => { if (q[r._locationQuality] !== undefined) q[r._locationQuality]++; });
    body.appendChild(el('p', 'pc-up-rec-sum', `정확 ${fmtNum(q.EXACT)} · 추정 ${fmtNum(q.ESTIMATED)} · 대표위치(확인요망) ${fmtNum(q.APPROXIMATE)} · 확인필요 ${fmtNum(q.UNRESOLVED)}`));
    body.appendChild(el('p', 'pc-up-hint', '위에서부터 순서대로 진행하는 것을 권장합니다. 확인필요로 남은 주소도 저장은 가능하지만, 좌표가 없어 지도에는 표시되지 않고 목록에만 나타납니다.'));

    let recRecommendedShown = false;
    recSteps().forEach(st => {
      const box = el('div', 'pc-up-rec-step');
      const head = el('div', 'pc-up-rec-head');
      const done = !!st.summary;
      const recommended = !done && st.count > 0 && !recRecommendedShown;
      if (recommended) recRecommendedShown = true;
      box.classList.add(state[st.flag] ? 'is-running' : (done ? 'is-done' : (st.count === 0 ? 'is-skip' : (recommended ? 'is-next' : 'is-wait'))));
      const tt = el('div', 'pc-up-rec-title');
      tt.appendChild(el('strong', '', st.title));
      tt.appendChild(el('span', 'pc-up-rec-count', `대상 ${fmtNum(st.count)}건`));
      tt.appendChild(el('span', 'pc-up-rec-tag', state[st.flag] ? '진행 중' : (done ? '실행 완료' : (st.count === 0 ? '대상 없음' : (recommended ? '다음 권장' : '대기')))));
      head.appendChild(tt);
      const b = el('button', 'pc-up-ghost', state[st.flag] ? '진행 중...' : '실행');
      b.type = 'button';
      b.disabled = busy || st.count === 0;
      b.addEventListener('click', () => runRecStep(st));
      head.appendChild(b);
      box.appendChild(head);
      box.appendChild(el('p', 'pc-up-rec-desc', st.desc));
      const sm = el('p', 'pc-up-progress', st.summary);
      sm.id = 'pc-up-rec-sum-' + st.id;
      box.appendChild(sm);
      body.appendChild(box);
    });

    // 목록
    const nfRows = rows.filter(r => r._geocodeStatus === 'NOT_FOUND');
    const unRows = recUnresolved();
    const tabs = el('div', 'pc-up-chips');
    [['unresolved', `위치 확인 필요 ${unRows.length}`], ['notfound', `주소 검색결과 없음 ${nfRows.length}`]].forEach(([k, label]) => {
      const c = el('button', 'pc-up-chip' + (REC.view === k ? ' active' : ''), label);
      c.type = 'button';
      c.addEventListener('click', () => { REC.view = k; draw(); });
      tabs.appendChild(c);
    });
    const csv1 = el('button', 'pc-up-link', '결과없음 CSV');
    csv1.type = 'button'; csv1.addEventListener('click', downloadNotFoundCsv);
    const csv2 = el('button', 'pc-up-link', '후보검색 결과 CSV');
    csv2.type = 'button'; csv2.addEventListener('click', downloadKeywordCsv);
    tabs.appendChild(csv1); tabs.appendChild(csv2);
    body.appendChild(tabs);

    const list = REC.view === 'notfound' ? nfRows : unRows;
    if (!list.length) { body.appendChild(el('p', 'pc-up-detail-empty', '해당하는 주소가 없습니다.')); return; }
    const tw = el('div', 'pc-up-tablewrap is-scroll');
    const t = el('table', 'pc-up-table is-validate');
    const th = el('thead'); const hr = el('tr');
    ['사업장명', '식별번호', '원본 주소', '진행 상태', '후보', ''].forEach(x => hr.appendChild(el('th', '', x)));
    th.appendChild(hr); t.appendChild(th);
    const tb = el('tbody');
    list.slice(0, 100).forEach(r => {
      const tr = el('tr');
      tr.appendChild(el('td', 'pc-up-td-file', r.site_name || r.company_name || '-'));
      tr.appendChild(el('td', '', r.business_start_no || '(없음)'));
      tr.appendChild(el('td', 'pc-up-td-reason', r.address || '-'));
      const stText = [geoLabel(r), r._keywordSearchStatus && r._keywordSearchStatus !== 'PENDING' ? (KW_STATUS[r._keywordSearchStatus] || r._keywordSearchStatus) : '', r._jusoStatus && r._jusoStatus !== 'PENDING' ? (JUSO_STATUS[r._jusoStatus] || r._jusoStatus) : ''].filter(Boolean).join(' / ');
      tr.appendChild(el('td', 'pc-up-td-reason', stText));
      const cand = [
        ...(r._keywordCandidates || []).map((c, i) => `후보 ${i + 1}: ${c.placeName || '-'} · ${c.roadAddressName || c.addressName || '-'} (${c.candidateStatus === 'MATCH' ? '일치' : '약함'})`),
        ...(r._jusoCandidates || []).map((c, i) => `행안부 ${i + 1}: ${c.roadAddr || '-'} (지번: ${c.jibunAddr || '-'})`),
      ];
      tr.appendChild(el('td', 'pc-up-td-reason', cand.join('\n') || '-'));
      const ta = el('td');
      if (r._locationQuality === 'UNRESOLVED' && r.business_start_no) {
        const fb = el('button', 'pc-up-ghost is-small', '후보 찾기');
        fb.type = 'button'; fb.disabled = busy;
        fb.addEventListener('click', () => recSearchOne(r));
        ta.appendChild(fb);
      }
      tr.appendChild(ta);
      tb.appendChild(tr);
    });
    t.appendChild(tb); tw.appendChild(t); body.appendChild(tw);
    if (list.length > 100) body.appendChild(el('p', 'pc-up-sheet-note', `※ 처음 100건만 표시합니다. (전체 ${fmtNum(list.length)}건, CSV에는 전체가 포함됩니다)`));
  };
  recDraw = draw;
  draw();
}

// ---- 상세 팝업 (업로드 이력 / 검증 결과) ----
function modalShell(title) {
  const wrap = el('div', 'pc-modal-body');
  const head = el('div', 'pc-modal-head');
  head.appendChild(el('h3', '', title));
  const x = el('button', 'pc-modal-close');
  x.type = 'button';
  x.setAttribute('aria-label', '닫기');
  x.textContent = '×';
  head.appendChild(x);
  wrap.appendChild(head);
  const m = openModal(wrap, {});
  wrap.closest('.pc-modal').classList.add('is-wide');
  x.addEventListener('click', m.close);
  return { wrap, close: m.close };
}

function openHistoryModal(h) {
  const { wrap, close } = modalShell('업로드 상세');
  const st = statusOf(h);
  const grid = el('div', 'pc-up-kv');
  [
    ['파일명', h.file_name || '-'],
    ['업로드일시', fmtDT(h.uploaded_at)],
    ['업로드자', h.uploaded_by_name || '-'],
    ['엑셀 양식', FORM_SHORT[h.source_form] || h.source_form || '-'],
    ['전체 건수', `${fmtNum(h.total_rows)}건`],
    ['확정 건수', `${fmtNum(h.confirmed_rows)}건`],
    ['확인필요 건수', `${fmtNum(h.review_rows)}건`],
  ].forEach(([k, v]) => {
    const row = el('div', 'pc-up-kv-row');
    row.appendChild(el('span', 'pc-up-kv-k', k));
    row.appendChild(el('strong', 'pc-up-kv-v', v));
    grid.appendChild(row);
  });
  const srow = el('div', 'pc-up-kv-row');
  srow.appendChild(el('span', 'pc-up-kv-k', '처리 결과'));
  const sv = el('span', 'pc-up-kv-v');
  sv.appendChild(el('span', 'pc-up-badge ' + st.cls, st.label));
  sv.appendChild(el('strong', 'pc-up-td-result ' + st.resCls, st.result));
  srow.appendChild(sv);
  grid.appendChild(srow);
  wrap.appendChild(grid);
  wrap.appendChild(el('p', 'pc-up-sheet-note', '※ 확인필요 건수는 좌표를 확정하지 못해 위치 확인이 필요한 사업장 수입니다.'));
  const actions = el('div', 'pc-modal-actions');
  const ok = el('button', 'pc-sv-primary-btn', '확인');
  ok.type = 'button';
  ok.addEventListener('click', close);
  actions.appendChild(ok);
  wrap.appendChild(actions);
}

function openValidationModal(initialFilter) {
  const { wrap, close } = modalShell('검증 결과');
  const rowsAll = state.uploadParsedRows || [];
  wrap.appendChild(el('p', 'pc-up-detail-file', `${state.uploadFileName || ''}${state.uploadDetectedForm ? ' · ' + FORM_SHORT[state.uploadDetectedForm] : ''}`));
  const problems = rowsAll.filter(r => r._validation !== 'VALID');
  const errCount = problems.filter(r => r._validation === 'ERROR').length;
  const warnCount = problems.length - errCount;
  const body = el('div');
  let filter = initialFilter === 'error' || initialFilter === 'warn' ? initialFilter : 'all';
  const draw = () => {
    body.innerHTML = '';
    const chips = el('div', 'pc-up-chips');
    [['all', `문제 전체 ${problems.length}`], ['error', `오류 ${errCount}`], ['warn', `경고 ${warnCount}`]].forEach(([k, label]) => {
      const b = el('button', 'pc-up-chip' + (filter === k ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { filter = k; draw(); });
      chips.appendChild(b);
    });
    body.appendChild(chips);
    const shown = problems.filter(r => filter === 'all' || (filter === 'error' ? r._validation === 'ERROR' : r._validation === 'WARNING'));
    if (!shown.length) {
      body.appendChild(el('p', 'pc-up-detail-empty', problems.length === 0 ? '모든 행이 정상입니다.' : '해당 항목이 없습니다.'));
      return;
    }
    const reason = (r) => [...(r._errors || []), ...(r._warnings || [])].join(', ');
    const tw = el('div', 'pc-up-tablewrap is-scroll');
    const t = el('table', 'pc-up-table is-validate');
    const th = el('thead'); const hr = el('tr');
    ['엑셀 행', '사업장명', '사업개시번호', '구분', '사유'].forEach(x => hr.appendChild(el('th', '', x)));
    th.appendChild(hr); t.appendChild(th);
    const tb = el('tbody');
    shown.slice(0, 300).forEach(r => {
      const tr = el('tr');
      tr.appendChild(el('td', '', String((r._rowIndex ?? 0) + 2)));
      tr.appendChild(el('td', 'pc-up-td-file', r.site_name || r.company_name || '-'));
      tr.appendChild(el('td', '', r.business_start_no || '-'));
      const k = el('td'); k.appendChild(el('span', 'pc-up-badge ' + (r._validation === 'ERROR' ? 'is-err' : 'is-warn'), r._validation === 'ERROR' ? '오류' : '경고')); tr.appendChild(k);
      tr.appendChild(el('td', 'pc-up-td-reason', reason(r)));
      tb.appendChild(tr);
    });
    t.appendChild(tb); tw.appendChild(t); body.appendChild(tw);
    if (shown.length > 300) body.appendChild(el('p', 'pc-up-sheet-note', `※ 처음 300건만 표시합니다. (전체 ${fmtNum(shown.length)}건)`));
    const csv = el('button', 'pc-up-link', '검증 결과 CSV 저장');
    csv.type = 'button';
    csv.addEventListener('click', () => downloadCsv('검증결과.csv', [
      ['엑셀 행', '사업장명', '사업개시번호', '구분', '사유'],
      ...shown.map(r => [(r._rowIndex ?? 0) + 2, r.site_name || r.company_name || '', r.business_start_no || '', r._validation === 'ERROR' ? '오류' : '경고', reason(r)]),
    ]));
    body.appendChild(csv);
  };
  draw();
  wrap.appendChild(body);
  const actions = el('div', 'pc-modal-actions');
  const ok = el('button', 'pc-sv-primary-btn', '닫기');
  ok.type = 'button';
  ok.addEventListener('click', close);
  actions.appendChild(ok);
  wrap.appendChild(actions);
}
