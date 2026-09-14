// app.js — STEP 3B. 인증 흐름 최소 테스트 UI 연결.
// 지도/사업장 등 실제 기능은 이후 STEP에서 추가한다 (CLAUDE.md 12절: 대규모 UI 금지).
import { state } from './state.js';
import { signUp, signIn, signOut, loadCurrentProfile, isApproved, isAdmin } from './auth.js';
import { initMap } from './map.js';

const VIEWS = [
  'view-login', 'view-signup', 'view-signup-done',
  'view-pending', 'view-rejected', 'view-disabled', 'view-approved'
];

function showView(id) {
  VIEWS.forEach(v => {
    document.getElementById(v).style.display = (v === id) ? 'block' : 'none';
  });
}

function clearError(el) {
  el.textContent = '';
}

// 로그인 직후 profile.status에 따라 화면을 분기한다.
// 보안 판단(누가 실제로 데이터에 접근 가능한가)은 RLS가 하고, 이 분기는 안내 화면 표시 목적일 뿐이다.
function routeByProfile() {
  const profile = state.profile;

  if (!state.user) {
    showView('view-login');
    return;
  }

  if (!profile) {
    // 정상적으로는 가입 트리거가 항상 profile을 만들어야 하므로 발생하지 않아야 함.
    showView('view-login');
    return;
  }

  switch (profile.status) {
    case 'approved':
      document.getElementById('approved-role-badge').textContent =
        isAdmin() ? '관리자 계정입니다.' : '';
      showView('view-approved');
      // approved 상태에서만 지도를 초기화한다. pending/rejected/disabled는 여기 도달하지 않는다.
      initMap('map-container').catch(err => {
        console.error('지도 초기화 실패:', err);
      });
      break;
    case 'pending':
      showView('view-pending');
      break;
    case 'rejected':
      showView('view-rejected');
      break;
    case 'disabled':
      showView('view-disabled');
      break;
    default:
      showView('view-login');
  }
}

async function handleLogout() {
  await signOut();
  state.map = null; // 재로그인 시 지도가 정상적으로 다시 초기화되도록 초기화
  showView('view-login');
}

function bindEvents() {
  document.getElementById('show-signup').addEventListener('click', () => showView('view-signup'));
  document.getElementById('show-login').addEventListener('click', () => showView('view-login'));
  document.getElementById('signup-done-to-login').addEventListener('click', () => showView('view-login'));

  ['logout-pending', 'logout-rejected', 'logout-disabled', 'logout-approved'].forEach(id => {
    document.getElementById(id).addEventListener('click', handleLogout);
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    clearError(errorEl);
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      await signIn(email, password);
      routeByProfile();
    } catch (err) {
      errorEl.textContent = err.message || '로그인에 실패했습니다.';
    }
  });

  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('signup-error');
    clearError(errorEl);
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    try {
      await signUp(email, password);
      showView('view-signup-done');
    } catch (err) {
      errorEl.textContent = err.message || '회원가입에 실패했습니다.';
    }
  });
}

async function bootstrap() {
  bindEvents();
  await loadCurrentProfile();
  routeByProfile();
}

bootstrap();
