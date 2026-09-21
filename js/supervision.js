// supervision.js — STEP14. gnmap_v2_supervisions(감독일정/상황판) 조회/등록/수정/삭제.
// site_id/사업장 연결은 이번 STEP 범위가 아니다(별도 테이블/FK 없음, 캠페인 단위 상황판만).
// RLS: SELECT는 approved 전체, INSERT/UPDATE/DELETE는 admin만 — 이 파일은 그 위에서 얇게만 감싼다.
import { sb } from './api.js';

const SUPERVISION_COLUMNS = 'id, title, manager_name, start_date, end_date, status, created_by, created_at, updated_at';

// 전체 감독일정을 조회한다. 실패해도 예외를 던지지 않고 빈 배열을 반환한다 —
// 다른 기능(지도/사업장 목록 등)을 막지 않기 위함(notes.js/favorites.js와 동일한 방어 패턴).
export async function loadSupervisions() {
  const { data, error } = await sb
    .from('gnmap_v2_supervisions')
    .select(SUPERVISION_COLUMNS)
    .order('start_date', { ascending: false });

  if (error) {
    console.error('감독일정 조회 실패:', error);
    return [];
  }
  return data || [];
}

// 신규 감독일정을 등록한다. { title, manager_name, start_date, end_date, status }를 받는다.
// DB CHECK(end_date>=start_date)와 status 허용값은 서버(RLS/제약)에서도 보호되지만,
// UI 쪽 검증은 ui.js에서 먼저 수행한다(여기서는 그대로 insert만 담당).
export async function createSupervision(fields) {
  const { data, error } = await sb
    .from('gnmap_v2_supervisions')
    .insert({
      title: fields.title,
      manager_name: fields.manager_name ?? null,
      start_date: fields.start_date,
      end_date: fields.end_date,
      status: fields.status,
    })
    .select(SUPERVISION_COLUMNS)
    .single();

  if (error) {
    console.error('감독일정 등록 실패:', error);
    return { success: false, message: error.message || '감독일정 등록에 실패했습니다.' };
  }
  return { success: true, row: data };
}

// 기존 감독일정을 수정한다. id는 절대 변경하지 않는다(그대로 WHERE 조건으로만 사용).
export async function updateSupervision(id, fields) {
  const { data, error } = await sb
    .from('gnmap_v2_supervisions')
    .update({
      title: fields.title,
      manager_name: fields.manager_name ?? null,
      start_date: fields.start_date,
      end_date: fields.end_date,
      status: fields.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(SUPERVISION_COLUMNS)
    .single();

  if (error) {
    console.error('감독일정 수정 실패:', error);
    return { success: false, message: error.message || '감독일정 수정에 실패했습니다.' };
  }
  return { success: true, row: data };
}

// 감독일정을 삭제한다. 하드 DELETE — V1 supervision_board.sql도 별도 soft-delete 없이 동일하게 처리했다.
export async function deleteSupervision(id) {
  const { error } = await sb
    .from('gnmap_v2_supervisions')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('감독일정 삭제 실패:', error);
    return { success: false, message: error.message || '감독일정 삭제에 실패했습니다.' };
  }
  return { success: true };
}
