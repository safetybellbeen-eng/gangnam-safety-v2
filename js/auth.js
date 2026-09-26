// auth.js — STEP 3. 회원가입/로그인/세션/승인 상태 확인.
import { sb } from './api.js';
import { state } from './state.js';

// STEP16.5(아이디 방식 전환). Supabase Auth는 이메일(또는 전화번호/OAuth) 기준으로만
// 계정을 만들 수 있어 순수 아이디(username) 인증을 지원하지 않는다. 사용자에게는 "@" 없는
// 순수 아이디만 입력받고, Supabase에는 고정 도메인을 붙인 합성 이메일로 보이게 만든다
// (Auth 내부 구조/스키마는 변경하지 않음 — 이메일 필드에 넣을 값만 가공). 이미 "@"가 포함된
// 값(기존 실제 이메일로 가입된 계정)은 그대로 통과시켜 하위호환을 유지한다.
//
// 중요(버그 수정): 이 Supabase 프로젝트는 V1("motorrad-pulse")과 auth.users를 공유하고,
// V1에는 이 프로젝트와 무관하게 "회원가입될 때마다 이메일의 '@' 앞부분(local-part)을
// V1 자체 profiles.username에 UNIQUE로 저장"하는 트리거가 이미 존재한다(V1은 절대 수정 금지
// 대상이라 우리가 바꿀 수 없음). 그래서 V2 아이디를 그대로 로컬파트로 쓰면(예: "hong" →
// "hong@gnmap.local"), 같은 문자열을 V1 쪽 사용자가 이미 쓰고 있을 경우
// "duplicate key value violates unique constraint profiles_username_key" 로 V2 가입 자체가
// 실패한다("Database error saving new user"). 이를 피하기 위해 로컬파트에 "+v2" 태그를 붙여
// V1 namespace와 절대 겹치지 않게 만든다 — 화면에 보이는 "아이디" 표시/로그인 동작에는
// 영향이 없다(사용자는 여전히 순수 아이디만 입력).
const SIGNUP_ID_DOMAIN = '@gnmap.local';
const SIGNUP_ID_TAG = '+v2';

export function toAuthEmail(id) {
  const trimmed = (id || '').trim();
  if (!trimmed) return trimmed;
  return trimmed.includes('@') ? trimmed : `${trimmed}${SIGNUP_ID_TAG}${SIGNUP_ID_DOMAIN}`;
}

// 회원가입: profile 생성은 DB 트리거(handle_gnmap_v2_new_user)가 보장하므로
// 여기서 별도로 insert하지 않는다 — 프론트 로직 누락으로 profile이 안 생기는 사고를 원천 차단.
// 회원가입: user metadata에 app='gangnam-safety-v2'와 name을 담아 전달한다.
// DB 트리거(handle_gnmap_v2_new_user, STEP14.5-B에서 name도 함께 저장하도록 수정됨)가
// 이 metadata를 확인해 V2 가입자만 gnmap_v2_profiles를 생성한다 — V1/V2가 같은 auth.users를 공유하므로 필수.
export async function signUp(id, password, name) {
  const email = toAuthEmail(id);
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { app: 'gangnam-safety-v2', name } }
  });
  if (error) throw error;
  return data;
}

// STEP16.5(회원가입 인증번호). 고정 인증번호는 프론트에 절대 두지 않고, DB의
// SECURITY DEFINER 함수(gnmap_v2_verify_signup_code)에서만 비교한다 — 이 함수는
// 일치 여부(boolean)만 반환하며 실제 코드 값은 클라이언트로 내려오지 않는다.
export async function verifySignupCode(code) {
  const { data, error } = await sb.rpc('gnmap_v2_verify_signup_code', { p_code: code });
  if (error) throw error;
  return data === true;
}

// STEP16.5(아이디 중복확인). gnmap_v2_profiles.email(합성 이메일 포함)과 대조만 하는
// DB 함수(gnmap_v2_check_id_exists)를 호출한다. auth.users는 REST로 직접 조회할 수 없어
// 트리거로 항상 동기화되는 gnmap_v2_profiles.email을 기준으로 확인한다.
export async function checkIdExists(id) {
  const email = toAuthEmail(id);
  const { data, error } = await sb.rpc('gnmap_v2_check_id_exists', { p_email: email });
  if (error) throw error;
  return data === true;
}

export async function signIn(id, password) {
  const email = toAuthEmail(id);
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

// "자동 로그인" 체크 여부 판단용. Supabase 클라이언트는 기본적으로 세션을 localStorage에
// 영구 저장하므로, 로그인 시 "자동 로그인"을 체크하지 않았다면 앱 재시작(bootstrap) 시점에
// 남아있는 세션을 이 함수로 확인한 뒤 로그아웃시켜 로그인 화면부터 다시 시작하게 한다.
export async function hasActiveSession() {
  const { data: { session } } = await sb.auth.getSession();
  return !!session;
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

// STEP16.5(오류 메시지 한글화). Supabase Auth/PostgREST가 내려주는 오류 메시지는 영어 원문이라
// 화면에 그대로 노출하면 사용자가 이해하기 어렵다. 자주 발생하는 메시지만 한글로 매핑하고,
// 매핑에 없는 메시지는 원문을 노출하지 않고 안전한 일반 문구로 대체한다.
const AUTH_ERROR_MAP = [
  { test: /database error saving new user/i, ko: '계정 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' },
  { test: /user already registered/i, ko: '이미 등록된 아이디입니다.' },
  { test: /invalid login credentials/i, ko: '아이디 또는 비밀번호가 올바르지 않습니다.' },
  { test: /email not confirmed/i, ko: '계정 인증이 완료되지 않았습니다. 관리자에게 문의해주세요.' },
  { test: /password should be at least/i, ko: '비밀번호가 너무 짧습니다. 8자 이상 입력해주세요.' },
  { test: /unable to validate email address/i, ko: '아이디 형식이 올바르지 않습니다.' },
  { test: /signup is disabled/i, ko: '현재 회원가입이 중지되어 있습니다. 관리자에게 문의해주세요.' },
  { test: /rate limit/i, ko: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  { test: /network|fetch failed|failed to fetch/i, ko: '네트워크 연결을 확인해주세요.' },
];

export function translateAuthError(err, fallback) {
  const message = (err && err.message) || '';
  const matched = AUTH_ERROR_MAP.find((row) => row.test.test(message));
  return matched ? matched.ko : (fallback || '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
}
