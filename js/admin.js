// admin.js — STEP 9. gnmap_v2_profiles 목록 조회 + status/role 변경.
// 변경은 반드시 기존 RPC(gnmap_v2_set_user_status/gnmap_v2_set_user_role)로만 수행한다.
// profiles 테이블 직접 UPDATE는 하지 않는다 — RLS가 최종 방어선이며, 여기서도 RPC 경로만 사용해
// "관리자 UI 숨김만 믿지 않는다"는 원칙을 코드 레벨에서도 지킨다.
import { sb } from './api.js';
import { state } from './state.js';
import { isAdmin } from './auth.js';

const STATUS_VALUES = ['pending', 'approved', 'rejected', 'disabled'];
const ROLE_VALUES = ['user', 'admin'];

// 관리자가 아니면 조회 시도 자체를 하지 않는다 (RLS도 어차피 막지만 불필요한 요청을 만들지 않음).
export async function loadUsers() {
  if (!isAdmin()) {
    state.adminUsers = [];
    return state.adminUsers;
  }

  const { data, error } = await sb
    .from('gnmap_v2_profiles')
    .select('id, name, email, role, status, created_at, last_login_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('회원 목록 조회 실패:', error);
    state.adminUsers = [];
    return state.adminUsers;
  }

  state.adminUsers = data || [];
  return state.adminUsers;
}

// RPC 성공 후에만 state.adminUsers의 해당 행을 갱신한다 (실패 시 기존 표시 유지).
export async function setUserStatus(userId, status) {
  if (!STATUS_VALUES.includes(status)) {
    console.error('유효하지 않은 상태값:', status);
    return { ok: false, message: '유효하지 않은 상태값입니다.' };
  }

  const { error } = await sb.rpc('gnmap_v2_set_user_status', {
    p_user_id: userId,
    p_status: status
  });

  if (error) {
    console.error('상태 변경 실패:', error);
    return { ok: false, message: '변경 실패' };
  }

  const row = state.adminUsers.find(u => u.id === userId);
  if (row) row.status = status;
  return { ok: true, message: '변경 완료' };
}

export async function setUserRole(userId, role) {
  if (!ROLE_VALUES.includes(role)) {
    console.error('유효하지 않은 역할값:', role);
    return { ok: false, message: '유효하지 않은 역할값입니다.' };
  }

  const { error } = await sb.rpc('gnmap_v2_set_user_role', {
    p_user_id: userId,
    p_role: role
  });

  if (error) {
    console.error('역할 변경 실패:', error);
    return { ok: false, message: '변경 실패' };
  }

  const row = state.adminUsers.find(u => u.id === userId);
  if (row) row.role = role;
  return { ok: true, message: '변경 완료' };
}
