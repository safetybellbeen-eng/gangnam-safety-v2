// session_guard.js — 미사용 자동 로그아웃 + 자동로그인 기기 만료(보안).
// 서버/DB와 무관한 프론트 전용 정책이다. 실제 세션 종료는 호출 측(app.js)이 넘기는 onTimeout()이 수행한다.
//
// 정책값(필요하면 이 상수만 고치면 된다):
//  - PC(화면 폭 769px 이상): 30분 동안 아무 조작이 없으면 자동 로그아웃(1분 전 경고 표시)
//  - 모바일/TWA(768px 이하): 현장에서 지도를 켜 둔 채 오래 쓰는 경우가 많아 4시간
//  - 자동 로그인: 로그인한 날부터 30일이 지나면 만료(다시 로그인)
export const IDLE_LIMIT_MS_PC = 30 * 60 * 1000;
export const IDLE_LIMIT_MS_MOBILE = 4 * 60 * 60 * 1000;
export const WARN_BEFORE_MS = 60 * 1000;
export const AUTO_LOGIN_MAX_DAYS = 30;

const ACTIVITY_KEY = 'gnmap_v2_last_activity'; // 여러 탭에서 공유(한 탭에서 조작하면 다른 탭도 연장)
const AUTO_LOGIN_AT_KEY = 'gnmap_v2_auto_login_at';

function ls() { try { return window.localStorage; } catch (e) { return null; } }

function idleLimit() {
  return window.innerWidth <= 768 ? IDLE_LIMIT_MS_MOBILE : IDLE_LIMIT_MS_PC;
}

// ---------- 자동 로그인 만료 ----------
export function markAutoLoginNow() {
  const s = ls(); if (!s) return;
  try { s.setItem(AUTO_LOGIN_AT_KEY, String(Date.now())); } catch (e) { /* ignore */ }
}
export function clearAutoLoginMark() {
  const s = ls(); if (!s) return;
  try { s.removeItem(AUTO_LOGIN_AT_KEY); } catch (e) { /* ignore */ }
}
// 자동 로그인이 켜져 있는데 30일이 지났으면 true. 기록이 없는 기존 사용자는 "지금부터" 30일로 시작한다.
export function isAutoLoginExpired() {
  const s = ls(); if (!s) return false;
  try {
    const raw = s.getItem(AUTO_LOGIN_AT_KEY);
    if (!raw) { s.setItem(AUTO_LOGIN_AT_KEY, String(Date.now())); return false; }
    const at = Number(raw);
    if (!Number.isFinite(at)) { s.setItem(AUTO_LOGIN_AT_KEY, String(Date.now())); return false; }
    return Date.now() - at > AUTO_LOGIN_MAX_DAYS * 86400000;
  } catch (e) { return false; }
}

// ---------- 미사용 자동 로그아웃 ----------
let timer = null;
let warnEl = null;
let onTimeoutCb = null;
let lastWrite = 0;
let started = false;

function lastActivity() {
  // 여러 탭이 공유하는 localStorage 값을 우선 사용한다(사용 불가 환경에서만 메모리 값).
  const s = ls();
  if (s) {
    try { const v = Number(s.getItem(ACTIVITY_KEY)); if (v) return v; } catch (e) { /* ignore */ }
  }
  return memActivity;
}
let memActivity = Date.now();

function touch() {
  const now = Date.now();
  memActivity = now;
  if (now - lastWrite < 5000) return; // localStorage 쓰기는 5초에 한 번만
  lastWrite = now;
  const s = ls();
  if (s) { try { s.setItem(ACTIVITY_KEY, String(now)); } catch (e) { /* ignore */ } }
  hideWarn();
}

function hideWarn() {
  if (warnEl) { warnEl.remove(); warnEl = null; }
}
function showWarn(secLeft) {
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.setAttribute('role', 'alert');
    warnEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:100000;background:#0b2358;color:#fff;padding:12px 18px;border-radius:12px;font:600 14px/1.4 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Noto Sans KR",sans-serif;box-shadow:0 8px 28px rgba(8,30,70,.35);max-width:calc(100vw - 32px);text-align:center';
    document.body.appendChild(warnEl);
  }
  warnEl.textContent = `장시간 사용하지 않아 ${secLeft}초 후 자동 로그아웃됩니다. 화면을 누르면 연장됩니다.`;
}

function tick() {
  if (!started) return;
  const idle = Date.now() - lastActivity();
  const limit = idleLimit();
  if (idle >= limit) {
    stopIdleGuard();
    if (onTimeoutCb) onTimeoutCb();
    return;
  }
  const left = limit - idle;
  if (left <= WARN_BEFORE_MS) showWarn(Math.max(1, Math.ceil(left / 1000)));
  else hideWarn();
}

const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const onActivity = () => touch();
const onVisible = () => { if (!document.hidden) tick(); };

export function startIdleGuard(onTimeout) {
  stopIdleGuard();
  onTimeoutCb = onTimeout;
  started = true;
  memActivity = Date.now();
  lastWrite = 0;
  touch();
  EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(tick, 5000);
}

export function stopIdleGuard() {
  started = false;
  if (timer) { clearInterval(timer); timer = null; }
  EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }));
  document.removeEventListener('visibilitychange', onVisible);
  hideWarn();
}
