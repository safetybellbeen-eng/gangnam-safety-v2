// shared_notes.js — STEP19. 공유 현장 메모(gnmap_v2_shared_notes): 승인된 모든 사용자가 읽고,
// 작성자 본인만 수정/삭제(관리자는 삭제만). 개인 메모(notes.js / gnmap_v2_site_notes)와는 완전히 별개다.
// 작성자 이름/ID는 DB 트리거가 서버에서 채우므로 클라이언트 값은 보내지 않는다.
import { sb } from './api.js';
import { state } from './state.js';
import { showToast } from './ui.js';
import { isAdmin } from './auth.js';

export const SHARED_NOTE_MAX = 300;
export const SHARED_NOTE_WARNING = '승인된 모든 사용자에게 보입니다. 개인정보·조사 진행 내용은 적지 마세요.';
const COLS = 'id, site_id, author_id, author_name, content, created_at, updated_at';
const AUTHOR_COLORS = ['#7b61c9', '#2f9e6f', '#e8890c', '#0e8fa8', '#a3338c', '#6b7a1f', '#8a5a3c', '#4b5563'];

function groupBySite(rows) {
  const m = new Map();
  (rows || []).forEach(r => { if (!m.has(r.site_id)) m.set(r.site_id, []); m.get(r.site_id).push(r); });
  m.forEach(list => list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
  return m;
}

// 전체 공유 메모를 1회 조회(수천 건 이하 규모). 실패해도 다른 기능을 막지 않는다.
export async function loadSharedNotes() {
  state.sharedNotesError = false;
  if (!state.user) { state.sharedNotes = new Map(); return; }
  const { data, error } = await sb.from('gnmap_v2_shared_notes').select(COLS).order('created_at', { ascending: true }).limit(5000);
  if (error) {
    console.error('공유 메모 조회 실패:', error);
    state.sharedNotes = new Map();
    state.sharedNotesError = true;
    return;
  }
  state.sharedNotes = groupBySite(data);
}

async function refreshSite(siteId) {
  const { data, error } = await sb.from('gnmap_v2_shared_notes').select(COLS).eq('site_id', siteId).order('created_at', { ascending: true });
  if (error) return false;
  if (data && data.length) state.sharedNotes.set(siteId, data); else state.sharedNotes.delete(siteId);
  return true;
}

export function getSharedNotes(siteId) { return (state.sharedNotes && state.sharedNotes.get(siteId)) || []; }
export function sharedCount(siteId) { return getSharedNotes(siteId).length; }
export function isMySharedNote(n) { return !!(state.user && n && n.author_id === state.user.id); }

export async function addSharedNote(siteId, content) {
  const text = (content || '').trim();
  if (!state.user || !text || text.length > SHARED_NOTE_MAX) return false;
  const { data, error } = await sb.from('gnmap_v2_shared_notes').insert({ site_id: siteId, content: text }).select(COLS).single();
  if (error) { console.error('공유 메모 등록 실패:', error); return false; }
  const list = getSharedNotes(siteId).slice(); list.push(data);
  state.sharedNotes.set(siteId, list);
  return true;
}

export async function updateSharedNote(note, content) {
  const text = (content || '').trim();
  if (!isMySharedNote(note) || !text || text.length > SHARED_NOTE_MAX) return false;
  const { data, error } = await sb.from('gnmap_v2_shared_notes').update({ content: text }).eq('id', note.id).eq('author_id', state.user.id).select(COLS).single();
  if (error) { console.error('공유 메모 수정 실패:', error); return false; }
  state.sharedNotes.set(note.site_id, getSharedNotes(note.site_id).map(n => (n.id === note.id ? data : n)));
  return true;
}

export async function deleteSharedNote(note) {
  if (!state.user || !note) return false;
  if (!isMySharedNote(note) && !isAdmin()) return false;
  const { error } = await sb.from('gnmap_v2_shared_notes').delete().eq('id', note.id);
  if (error) { console.error('공유 메모 삭제 실패:', error); return false; }
  const rest = getSharedNotes(note.site_id).filter(n => n.id !== note.id);
  if (rest.length) state.sharedNotes.set(note.site_id, rest); else state.sharedNotes.delete(note.site_id);
  return true;
}

// ---------- 표시용 도우미 ----------
// "강남지청 유호정" → 이름 "유호정"
export function authorShort(name) { const t = String(name || '').trim().split(/\s+/); return t[t.length - 1] || '알 수 없음'; }
export function authorColor(name) {
  let h = 0; for (const ch of authorShort(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}
export function fmtNoteTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function buildAuthorPill(name) {
  const p = h('span', 'sn-pill');
  p.style.setProperty('--mc', authorColor(name));
  p.appendChild(h('i'));
  p.appendChild(document.createTextNode(authorShort(name)));
  p.title = String(name || '').trim();
  return p;
}

// 개인 메모 | 공유 메모 탭. panes: [{key,label,count?,el}] — 선택한 탭은 state.memoTab에 기억한다.
export function buildMemoTabs(panes, onSwitch) {
  const root = h('div', 'sn-tabs-wrap');
  const bar = h('div', 'sn-tabs'); bar.setAttribute('role', 'tablist');
  const body = h('div', 'sn-tab-body');
  const btns = {};
  function select(key) {
    state.memoTab = key;
    panes.forEach(p => { p.el.hidden = p.key !== key; btns[p.key].classList.toggle('is-active', p.key === key); btns[p.key].setAttribute('aria-selected', String(p.key === key)); });
    if (onSwitch) onSwitch(key);
  }
  panes.forEach(p => {
    const b = h('button', 'sn-tab'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = p.key;
    b.appendChild(document.createTextNode(p.label));
    if (p.count != null) { const c = h('span', 'sn-tab-count', String(p.count)); c.dataset.countFor = p.key; b.appendChild(c); }
    b.addEventListener('click', () => select(p.key));
    btns[p.key] = b; bar.appendChild(b); body.appendChild(p.el);
  });
  root.appendChild(bar); root.appendChild(body);
  const want = panes.some(p => p.key === state.memoTab) ? state.memoTab : panes[0].key;
  select(want);
  root.setCount = (key, n) => { const c = bar.querySelector(`[data-count-for="${key}"]`); if (c) c.textContent = String(n); };
  root.select = select;
  return root;
}

// 한 현장의 공유 메모 목록 + 작성창. onChange(siteId)는 등록/수정/삭제 후 호출(건수 배지 갱신 등).
export function buildSharedNotesBox(siteId, onChange) {
  const box = h('div', 'sn-box');
  box.appendChild(h('div', 'sn-warning', SHARED_NOTE_WARNING));
  const listEl = h('div', 'sn-list');
  box.appendChild(listEl);

  const form = h('div', 'sn-form');
  const ta = h('textarea', 'sn-textarea');
  ta.placeholder = '이 현장에 대해 함께 알아야 할 내용을 남기세요';
  ta.maxLength = SHARED_NOTE_MAX; ta.rows = 3; ta.setAttribute('aria-label', '공유 메모 입력');
  const foot = h('div', 'sn-form-foot');
  const counter = h('span', 'sn-counter', `0 / ${SHARED_NOTE_MAX}`);
  const addBtn = h('button', 'sn-btn sn-btn-primary', '등록'); addBtn.type = 'button'; addBtn.disabled = true;
  foot.appendChild(counter); foot.appendChild(addBtn);
  form.appendChild(ta); form.appendChild(foot);
  box.appendChild(form);

  let busy = false;
  let editingId = null;
  const changed = () => { if (onChange) onChange(siteId); };
  ta.addEventListener('input', () => { counter.textContent = `${ta.value.length} / ${SHARED_NOTE_MAX}`; addBtn.disabled = busy || !ta.value.trim(); });

  addBtn.addEventListener('click', async () => {
    if (busy || !ta.value.trim()) return;
    busy = true; addBtn.disabled = true;
    const ok = await addSharedNote(siteId, ta.value);
    busy = false;
    if (ok) { ta.value = ''; counter.textContent = `0 / ${SHARED_NOTE_MAX}`; paint(); changed(); showToast('공유 메모가 등록되었습니다.', 'success'); }
    else { addBtn.disabled = !ta.value.trim(); showToast('공유 메모 등록에 실패했습니다. 다시 시도해주세요.'); }
  });

  function buildItem(n) {
    const item = h('div', 'sn-item' + (isMySharedNote(n) ? ' is-mine' : ''));
    const head = h('div', 'sn-item-head');
    head.appendChild(buildAuthorPill(n.author_name));
    const edited = new Date(n.updated_at) - new Date(n.created_at) > 1000;
    head.appendChild(h('span', 'sn-time', fmtNoteTime(n.created_at) + (edited ? ' (수정됨)' : '')));
    const acts = h('span', 'sn-item-acts');
    const mine = isMySharedNote(n);
    if (mine) {
      const eb = h('button', 'sn-link', '수정'); eb.type = 'button';
      eb.addEventListener('click', () => { editingId = n.id; paint(); });
      acts.appendChild(eb);
    }
    if (mine || isAdmin()) {
      const db = h('button', 'sn-link is-danger', '삭제'); db.type = 'button';
      db.addEventListener('click', async () => {
        if (!window.confirm('이 공유 메모를 삭제하시겠습니까?\n삭제한 메모는 복구할 수 없습니다.')) return;
        db.disabled = true;
        const ok = await deleteSharedNote(n);
        if (ok) { paint(); changed(); showToast('공유 메모가 삭제되었습니다.', 'success'); }
        else { db.disabled = false; showToast('공유 메모 삭제에 실패했습니다. 다시 시도해주세요.'); }
      });
      acts.appendChild(db);
    }
    head.appendChild(acts);
    item.appendChild(head);

    if (editingId === n.id) {
      const eta = h('textarea', 'sn-textarea'); eta.value = n.content; eta.maxLength = SHARED_NOTE_MAX; eta.rows = 3;
      const row = h('div', 'sn-form-foot');
      const cancel = h('button', 'sn-btn', '취소'); cancel.type = 'button';
      const save = h('button', 'sn-btn sn-btn-primary', '저장'); save.type = 'button';
      cancel.addEventListener('click', () => { editingId = null; paint(); });
      save.addEventListener('click', async () => {
        if (!eta.value.trim()) return;
        save.disabled = true;
        const ok = await updateSharedNote(n, eta.value);
        if (ok) { editingId = null; paint(); changed(); showToast('공유 메모가 수정되었습니다.', 'success'); }
        else { save.disabled = false; showToast('공유 메모 수정에 실패했습니다. 다시 시도해주세요.'); }
      });
      const right = h('span', 'sn-edit-btns'); right.appendChild(cancel); right.appendChild(save);
      row.appendChild(h('span')); row.appendChild(right);
      item.appendChild(eta); item.appendChild(row);
    } else {
      item.appendChild(h('div', 'sn-content', n.content));
    }
    return item;
  }

  function paint() {
    listEl.innerHTML = '';
    const list = getSharedNotes(siteId);
    if (!list.length) {
      listEl.appendChild(h('p', 'sn-empty', state.sharedNotesError ? '공유 메모를 불러오지 못했습니다.' : '아직 공유 메모가 없습니다. 첫 메모를 남겨보세요.'));
      return;
    }
    list.forEach(n => listEl.appendChild(buildItem(n)));
  }
  paint();
  // 다른 사용자가 남긴 최신 메모를 반영한다(수정 중이 아닐 때만 다시 그림).
  refreshSite(siteId).then(ok => { if (ok && box.isConnected && editingId == null) { paint(); changed(); } });
  return box;
}
