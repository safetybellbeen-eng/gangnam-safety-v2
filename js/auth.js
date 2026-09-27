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

// STEP16.5(인증번호 시도 잠금용 기기 토큰). 회원가입 전 단계라 auth.uid()가 없으므로,
// 브라우저에 한 번 생성해 localStorage에 보관하는 임의 토큰을 실패횟수 집계 키로 쓴다.
// 개인정보가 아닌 임의 문자열이며, 이 브라우저의 회원가입 시도를 구분하는 용도로만 쓰인다.
const DEVICE_TOKEN_KEY = 'gnmap_v2_device_token';

function getDeviceToken() {
  try {
    let token = localStorage.getItem(DEVICE_TOKEN_KEY);
    if (!token) {
      token = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `dt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_TOKEN_KEY, token);
    }
    return token;
  } catch (e) {
    // localStorage 사용 불가 환경(프라이빗 모드 등)에서는 매번 새 토큰 — 잠금 추적만 약해질 뿐 기능은 그대로 동작.
    return null;
  }
}

// STEP16.5(회원가입 인증번호). 고정 인증번호는 프론트에 절대 두지 않고, DB의
// SECURITY DEFINER 함수(gnmap_v2_verify_signup_code)에서만 비교한다 — 이 함수는
// 일치 여부만 반환하며 실제 코드 값은 클라이언트로 내려오지 않는다.
// 5회 연속 실패 시 서버에서 해당 기기 토큰을 10분간 잠근다(gnmap_v2_signup_code_attempts).
// 반환값: { ok, locked, lockedUntil, attemptsLeft }
export async function verifySignupCode(code) {
  const deviceToken = getDeviceToken();
  const { data, error } = await sb.rpc('gnmap_v2_verify_signup_code', { p_code: code, p_device_token: deviceToken });
  if (error) throw error;
  return {
    ok: data && data.ok === true,
    locked: !!(data && data.locked),
    lockedUntil: data ? data.locked_until : null,
    attemptsLeft: data ? data.attempts_left : null,
  };
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

// STEP16.8(로그인 실패 5회 잠금). 회원가입 인증번호 잠금과 동일한 정책(5회 실패 시 10분
// 잠금)을 로그인에도 적용한다. 다만 로그인은 "누가 이 계정을 시도하는가"가 중요하므로
// 기기 토큰이 아니라 대상 계정의 합성 이메일(아이디)을 키로 서버(gnmap_v2_login_attempts)에서
// 추적한다 — 브라우저를 바꿔도 동일 계정은 동일하게 잠긴다. Supabase Auth 자체의 내장
// rate limit과는 별개로, 사용자에게 남은 시도/잠금 해제 시각을 안내하기 위한 용도다.
// 아래 두 함수(*Email*)는 이미 실제 Auth 이메일(합성 이메일 포함)을 알고 있는 호출부용
// 저수준 버전이다 — checkLoginLock/recordLoginResult(둘 다 순수 "아이디"를 받아 toAuthEmail로
// 변환)와 changePassword(이미 user.email을 알고 있어 변환이 필요 없음)가 이 두 함수를 공유한다.
async function checkEmailLock(email) {
  const { data, error } = await sb.rpc('gnmap_v2_check_login_lock', { p_email: email });
  if (error) throw error;
  return {
    locked: !!(data && data.locked),
    lockedUntil: data ? data.locked_until : null,
  };
}

async function recordEmailAttempt(email, success) {
  const { data, error } = await sb.rpc('gnmap_v2_record_login_result', { p_email: email, p_success: success });
  if (error) throw error;
  return {
    locked: !!(data && data.locked),
    lockedUntil: data ? data.locked_until : null,
    attemptsLeft: data ? data.attempts_left : null,
  };
}

export async function checkLoginLock(id) {
  return checkEmailLock(toAuthEmail(id));
}

async function recordLoginResult(id, success) {
  return recordEmailAttempt(toAuthEmail(id), success);
}

// 잠금 해제까지 남은 시간을 사람이 읽을 수 있는 문구로 바꾼다(정확한 초 단위 카운트다운은
// 만들지 않는다 — 분 단위 안내만으로 충분하고, 서버 시각 기준이라 클라이언트 시계 오차에도
// 덜 민감하다).
function formatLockRemaining(lockedUntil) {
  if (!lockedUntil) return '잠시 후 다시 시도해주세요.';
  const ms = new Date(lockedUntil).getTime() - Date.now();
  const mins = Math.max(1, Math.ceil(ms / 60000));
  return `${mins}분 후 다시 시도해주세요.`;
}

// signIn()은 이제 lockout 기록까지 함께 처리한다(app.js는 checkLoginLock()으로 시도 전
// 잠금 여부만 먼저 확인하면 되고, 성공/실패 기록은 이 함수 안에서 자동으로 이루어진다).
// 로그인 자체가 실패하면 원래 Supabase 오류(err)에 lockInfo를 덧붙여 던진다 — app.js는
// translateAuthError(err)로 기본 메시지를, err.lockInfo로 잠금/남은시도 안내를 함께 보여줄 수 있다.
export async function signIn(id, password) {
  const email = toAuthEmail(id);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    let lockInfo = null;
    try { lockInfo = await recordLoginResult(id, false); } catch (e) { /* 잠금 기록 실패는 로그인 실패 처리 자체를 막지 않는다 */ }
    if (lockInfo) error.lockInfo = lockInfo;
    throw error;
  }
  try { await recordLoginResult(id, true); } catch (e) { /* 무시 — 다음 로그인 때 다시 리셋 시도 */ }
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
  // "Database error saving new user"는 이 프로젝트에서 실질적으로 거의 항상 아이디 중복(같은 로그인
  // 시스템을 공유하는 다른 앱 쪽 아이디와 겹치는 경우 포함)이 원인이었으므로, 사용자에게는
  // 원인이 같은 "이미 사용 중인 아이디입니다."로 안내한다(내부적으로는 +v2 태그로 재발을 막아뒀다).
  { test: /database error saving new user/i, ko: '이미 사용 중인 아이디입니다.' },
  { test: /user already registered/i, ko: '이미 등록된 아이디입니다.' },
  { test: /invalid login credentials/i, ko: '아이디 또는 비밀번호가 올바르지 않습니다.' },
  { test: /email not confirmed/i, ko: '계정 인증이 완료되지 않았습니다. 관리자에게 문의해주세요.' },
  { test: /password should be at least/i, ko: '비밀번호가 너무 짧습니다. 8자 이상 입력해주세요.' },
  { test: /unable to validate email address/i, ko: '아이디 형식이 올바르지 않습니다.' },
  { test: /signup is disabled/i, ko: '현재 회원가입이 중지되어 있습니다. 관리자에게 문의해주세요.' },
  { test: /rate limit/i, ko: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  { test: /network|fetch failed|failed to fetch/i, ko: '네트워크 연결을 확인해주세요.' },
];

// STEP16.6(모바일 비밀번호 변경). Supabase Auth는 "현재 비밀번호가 맞는지"만 별도로 확인하는
// API가 없으므로, Supabase가 권장하는 방식대로 현재 비밀번호로 재로그인(signInWithPassword)을
// 먼저 시도해 검증한 뒤에만 실제 변경(updateUser)을 수행한다 — TARGET처럼 "현재 비밀번호"를
// 입력받아놓고 검증 없이 새 비밀번호만 반영하는 일은 하지 않는다. 비밀번호 값 자체는 이 함수
// 안에서만 쓰이고 어디에도(DB/localStorage/console) 저장/로그하지 않는다.
// 반환: { success:true } | { success:false, message, locked?:true, lockedUntil? }
//
// STEP16.11(보안 강화 — 현재 비밀번호 5회 오류 시 잠금). 로그인 화면과 동일한 5회 실패/10분
// 잠금 정책(gnmap_v2_login_attempts, gnmap_v2_check_login_lock/gnmap_v2_record_login_result)을
// 새 테이블 없이 그대로 재사용한다 — 계정 이메일을 키로 쓰므로, 로그인 화면에서 틀린 경우와
// 비밀번호 변경 화면에서 틀린 경우가 같은 계정에 대해 잠금 횟수를 함께 누적한다(같은 계정을
// 노리는 무차별 대입 시도는 진입 화면이 달라도 동일하게 막아야 한다).
export async function changePassword(currentPassword, newPassword) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user || !user.email) {
    return { success: false, message: '로그인 상태를 확인할 수 없습니다. 다시 로그인해주세요.' };
  }

  // 0) 이미 잠긴 계정이면 재인증 시도 자체를 서버에 보내지 않는다(잠금 우회/추가 시도 방지).
  let lockStatus;
  try { lockStatus = await checkEmailLock(user.email); } catch (e) { lockStatus = { locked: false }; }
  if (lockStatus.locked) {
    return {
      success: false,
      locked: true,
      lockedUntil: lockStatus.lockedUntil,
      message: `현재 비밀번호를 여러 번 잘못 입력하여 계정이 일시적으로 잠겼습니다. ${formatLockRemaining(lockStatus.lockedUntil)}`,
    };
  }

  // 1) 현재 비밀번호 검증 — 실제 재인증. 실패하면 새 비밀번호로 진행하지 않는다.
  const { error: reauthError } = await sb.auth.signInWithPassword({ email: user.email, password: currentPassword });
  if (reauthError) {
    let attempt = null;
    try { attempt = await recordEmailAttempt(user.email, false); } catch (e) { /* 잠금 기록 실패는 재인증 실패 처리 자체를 막지 않는다 */ }
    if (attempt && attempt.locked) {
      return {
        success: false,
        locked: true,
        lockedUntil: attempt.lockedUntil,
        message: `현재 비밀번호를 5회 잘못 입력하여 계정이 일시적으로 잠겼습니다. ${formatLockRemaining(attempt.lockedUntil)}`,
      };
    }
    const attemptsLeftText = attempt && attempt.attemptsLeft != null ? ` (남은 시도 ${attempt.attemptsLeft}회)` : '';
    return { success: false, message: `현재 비밀번호가 올바르지 않습니다.${attemptsLeftText}` };
  }
  // 재인증 성공 시 실패 카운트를 리셋한다(로그인 성공 시와 동일한 정책).
  try { await recordEmailAttempt(user.email, true); } catch (e) { /* 리셋 실패는 무시 — 다음 시도 때 다시 시도 */ }

  // 2) 실제 비밀번호 변경.
  const { error: updateError } = await sb.auth.updateUser({ password: newPassword });
  if (updateError) {
    return { success: false, message: translateAuthError(updateError, '비밀번호 변경 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.') };
  }
  return { success: true };
}

export function translateAuthError(err, fallback) {
  const message = (err && err.message) || '';
  const matched = AUTH_ERROR_MAP.find((row) => row.test.test(message));
  return matched ? matched.ko : (fallback || '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
}
