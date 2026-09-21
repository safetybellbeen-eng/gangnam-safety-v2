// auth.js — STEP 3. 회원가입/로그인/세션/승인 상태 확인.
import { sb } from './api.js';
import { state } from './state.js';

// 회원가입: profile 생성은 DB 트리거(handle_gnmap_v2_new_user)가 보장하므로
// 여기서 별도로 insert하지 않는다 — 프론트 로직 누락으로 profile이 안 생기는 사고를 원천 차단.
// 회원가입: user metadata에 app='gangnam-safety-v2'와 name을 담아 전달한다.
// DB 트리거(handle_gnmap_v2_new_user, STEP14.5-B에서 name도 함께 저장하도록 수정됨)가
// 이 metadata를 확인해 V2 가입자만 gnmap_v2_profiles를 생성한다 — V1/V2가 같은 auth.users를 공유하므로 필수.
export async function signUp(email, password, name) {
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { app: 'gangnam-safety-v2', name } }
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await loadCurrentProfile();
  return data;
}

export async function signOut() {
  await sb.auth.signOut();
  state.profile = null;
  state.user = null;
}

// 로그인 성공 후 profile을 조회해 상태를 확인한다.
// pending/rejected/disabled 사용자는 로그인 자체(auth)는 성공하지만
// 앱 데이터 접근은 RLS(is_gnmap_v2_approved())가 차단하므로,
// 프론트는 이 상태를 보고 "승인 대기 화면"으로 안내만 한다 (보안 처리를 프론트가 대신하지 않음).
export async function loadCurrentProfile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    state.user = null;
    state.profile = null;
    return null;
  }
  state.user = user;

  const { data: profile, error } = await sb
    .from('gnmap_v2_profiles')
    .select('id, name, email, role, status')
    .eq('id', user.id)
    .single();

  if (error) {
    // profile이 없거나(정상적으로는 트리거가 보장하므로 발생하지 않아야 함) RLS로 조회 불가한 경우
    state.profile = null;
    return null;
  }
  state.profile = profile;
  return profile;
}

export function isApproved() {
  return state.profile && state.profile.status === 'approved';
}

export function isAdmin() {
  return state.profile && state.profile.role === 'admin';
}
