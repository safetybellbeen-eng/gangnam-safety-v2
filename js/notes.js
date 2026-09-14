// notes.js — STEP 7B. gnmap_v2_site_notes 조회/저장(insert or update)/삭제.
// RLS가 본인 것만 select/insert/update/delete 가능하도록 이미 강제하지만,
// 여기서도 user_id를 항상 state.user.id(현재 로그인 사용자)로만 고정해서
// 다른 user_id를 조작할 수 있는 여지를 코드 레벨에서도 만들지 않는다.
import { sb } from './api.js';
import { state } from './state.js';

// 현재 로그인 사용자의 메모를 1회 조회해 state.siteNotes(Map)에 채운다.
// 실패해도 예외를 던지지 않는다 — sites/map 등 다른 기능을 막지 않기 위함.
export async function loadNotes() {
  if (!state.user) {
    state.siteNotes = new Map();
    return;
  }

  const { data, error } = await sb
    .from('gnmap_v2_site_notes')
    .select('id, site_id, content, updated_at')
    .eq('user_id', state.user.id);

  if (error) {
    console.error('메모 조회 실패:', error);
    state.siteNotes = new Map();
    return;
  }

  state.siteNotes = new Map((data || []).map(row => [row.site_id, row]));
}

export function getNote(siteId) {
  return state.siteNotes.get(siteId) || null;
}

// 메모가 없으면 insert, 있으면 update. content는 이미 trim되어 넘어온다고 가정하지 않고 여기서도 trim한다.
// trim 결과가 빈 문자열이면: 기존 메모가 있으면 삭제, 없으면 DB 요청 없이 종료 (공백만 있는 메모 저장 금지).
export async function saveNote(siteId, content) {
  if (!state.user) return false;

  const existing = getNote(siteId);
  const trimmed = (content || '').trim();

  if (!trimmed) {
    if (existing) return deleteNote(siteId);
    return true;
  }

  if (!existing) {
    const { data, error } = await sb
      .from('gnmap_v2_site_notes')
      .insert({ user_id: state.user.id, site_id: siteId, content: trimmed })
      .select('id, site_id, content, updated_at')
      .single();

    if (error) {
      console.error('메모 저장(insert) 실패:', error);
      return false;
    }
    state.siteNotes.set(siteId, data);
    return true;
  }

  const { data, error } = await sb
    .from('gnmap_v2_site_notes')
    .update({ content: trimmed })
    .eq('user_id', state.user.id)
    .eq('site_id', siteId)
    .select('id, site_id, content, updated_at')
    .single();

  if (error) {
    console.error('메모 저장(update) 실패:', error);
    return false;
  }
  state.siteNotes.set(siteId, data);
  return true;
}

// user_id + site_id 조건으로만 삭제한다 (본인 것만, 다른 user_id 삭제 불가).
export async function deleteNote(siteId) {
  if (!state.user) return false;

  const { error } = await sb
    .from('gnmap_v2_site_notes')
    .delete()
    .eq('user_id', state.user.id)
    .eq('site_id', siteId);

  if (error) {
    console.error('메모 삭제 실패:', error);
    return false;
  }
  state.siteNotes.delete(siteId);
  return true;
}
