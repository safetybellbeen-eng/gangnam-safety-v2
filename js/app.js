// app.js — STEP 3B. 인증 흐름 최소 테스트 UI 연결.
// 지도/사업장 등 실제 기능은 이후 STEP에서 추가한다 (CLAUDE.md 12절: 대규모 UI 금지).
import { state } from './state.js';
import { signUp, signIn, signOut, loadCurrentProfile, isApproved, isAdmin } from './auth.js';
import { initMap, clearMarkers } from './map.js';
import { loadActiveSites } from './sites.js';
import { loadFavorites } from './favorites.js';
import { loadNotes } from './notes.js';
import { renderSiteList, selectSite, closeDetail, bindSearchAndSort, renderDongOptions, renderAdminPanel, handleExcelFileSelect, renderUploadHistoryPanel, renderSupervisionPanel } from './ui.js';
import { requestCurrentLocation, clearCurrentLocationMarker } from './location.js';

const VIEWS = [
  'view-login', 'view-signup', 'view-signup-done',
  'view-pending', 'view-rejected', 'view-disabled', 'view-approved'
];

// STEP15-B. 모바일 "즐겨찾기" 탭에 들어가기 직전의 state.favoriteOnly 값을 임시 보관한다.
// (탭을 벗어나면 사용자가 PC/모바일 공용 즐겨찾기 토글로 실제 선택해둔 값으로 복원 — 다른 필터는 건드리지 않는다.)
let mobileFavoriteOnlyBackup = null;

// STEP15-B. 모바일 하단 탭 전환. 기존 DOM/데이터 조회는 재사용하고 표시 여부(CSS)만 바꾼다.
// 지도 인스턴스/marker/cluster는 여기서 절대 재생성하지 않는다.
function activateMobileTab(tab) {
  const previousTab = state.mobileActiveTab;
  state.mobileActiveTab = tab;

  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.mobileTab = tab;

  document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // "즐겨찾기" 탭 진입/이탈 시에만 기존 favoriteOnly 토글을 임시로 켜고 되돌린다.
  let favoriteOnlyChanged = false;
  if (tab === 'favorite' && previousTab !== 'favorite') {
    if (mobileFavoriteOnlyBackup === null) mobileFavoriteOnlyBackup = state.favoriteOnly;
    state.favoriteOnly = true;
    favoriteOnlyChanged = true;
  } else if (previousTab === 'favorite' && tab !== 'favorite' && mobileFavoriteOnlyBackup !== null) {
    state.favoriteOnly = mobileFavoriteOnlyBackup;
    mobileFavoriteOnlyBackup = null;
    favoriteOnlyChanged = true;
  }
  if (favoriteOnlyChanged) {
    const favBtn = document.getElementById('site-favorite-filter-btn');
    if (favBtn) favBtn.classList.toggle('active', state.favoriteOnly);
    renderSiteList('site-list'); // 검색/동/금액 등 다른 필터 state는 그대로 유지한 채 재렌더만 한다.
  }

  // 지도 탭으로 복귀 시, 숨겨져 있던 동안 틀어졌을 수 있는 지도 크기만 보정한다(재초기화 아님).
  if (tab === 'map' && state.map && window.kakao && window.kakao.maps) {
    window.kakao.maps.event.trigger(state.map, 'relayout');
  }
}

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
      // 관리자에게만 회원 관리 버튼을 보여준다. UI 숨김은 편의 목적일 뿐,
      // 실제 데이터 접근/변경 보안은 RLS와 RPC 내부의 is_gnmap_v2_admin() 검증이 담당한다.
      document.getElementById('btn-admin-panel').style.display = isAdmin() ? 'inline-block' : 'none';
      document.getElementById('btn-upload-panel').style.display = isAdmin() ? 'inline-block' : 'none';
      // 감독일정 상황판은 approved 전체가 볼 수 있다(등록/수정/삭제만 admin — renderSupervisionPanel 내부에서 분기).
      document.getElementById('btn-supervision-panel').style.display = 'inline-block';
      showView('view-approved');
      // approved 상태에서만 지도를 초기화한다. pending/rejected/disabled는 여기 도달하지 않는다.
      // 지도 초기화가 끝난 뒤에만 사업장을 조회해 마커/목록을 그린다. 조회 실패해도 지도는 유지된다.
      initMap('map-container')
        .then(() => Promise.all([loadActiveSites(), loadFavorites(), loadNotes()]))
        .then(([sites]) => {
          state.sites = sites;
          renderDongOptions(); // state.sites 기준으로 동 select 옵션을 채운 뒤 이벤트 바인딩
          bindSearchAndSort('site-list');
          renderSiteList('site-list'); // 내부에서 marker도 함께 렌더한다 (getFilteredSortedSites 기준, 즐겨찾기 별표 포함)
          activateMobileTab(state.mobileActiveTab || 'map'); // STEP15-B. 모바일 하단 탭 초기 표시 상태 적용(PC에서는 CSS로 무효화됨)
        })
        .catch(err => {
          console.error('지도/사업장 초기화 실패:', err);
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
  clearMarkers(); // 지도가 폐기되기 전에 마커를 먼저 정리
  clearCurrentLocationMarker();
  closeDetail();
  state.map = null; // 재로그인 시 지도가 정상적으로 다시 초기화되도록 초기화
  state.sites = [];
  state.searchQuery = '';
  state.sortMode = 'default';
  state.selectedDong = 'all';
  state.amountFilter = 'all';
  state.favoriteSiteIds = new Set();
  state.favoriteInFlight = new Set();
  state.siteNotes = new Map();
  state.noteInFlight = new Set();
  state.currentLocation = null;
  state.locationRequestInFlight = false;
  state.adminUsers = [];
  state.adminUserInFlight = new Set();
  state.adminMessage = '';
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) { adminPanel.style.display = 'none'; adminPanel.innerHTML = ''; }
  const adminBtn = document.getElementById('btn-admin-panel');
  if (adminBtn) adminBtn.style.display = 'none';
  state.uploadParsedRows = [];
  state.uploadDetectedForm = null;
  state.uploadValidationSummary = null;
  const uploadPanel = document.getElementById('upload-panel');
  if (uploadPanel) uploadPanel.style.display = 'none';
  const uploadPreview = document.getElementById('upload-preview');
  if (uploadPreview) uploadPreview.innerHTML = '';
  const uploadFileInput = document.getElementById('upload-file-input');
  if (uploadFileInput) uploadFileInput.value = '';
  const uploadBtn = document.getElementById('btn-upload-panel');
  if (uploadBtn) uploadBtn.style.display = 'none';
  const supervisionPanel = document.getElementById('supervision-panel');
  if (supervisionPanel) supervisionPanel.style.display = 'none';
  const supervisionForm = document.getElementById('supervision-form');
  if (supervisionForm) supervisionForm.style.display = 'none';
  const supervisionBtn = document.getElementById('btn-supervision-panel');
  if (supervisionBtn) supervisionBtn.style.display = 'none';
  state.supervisionFilter = 'all';
  const searchInput = document.getElementById('site-search-input');
  const sortSelect = document.getElementById('site-sort-select');
  const dongSelect = document.getElementById('site-dong-select');
  const amountSelect = document.getElementById('site-amount-select');
  const locationMsg = document.getElementById('location-message');
  if (searchInput) searchInput.value = '';
  if (sortSelect) sortSelect.value = 'default';
  if (dongSelect) dongSelect.innerHTML = '';
  if (amountSelect) amountSelect.value = 'all';
  if (locationMsg) locationMsg.textContent = '';
  // STEP14.5-B. 즐겨찾기만보기/확인필요만보기 토글과 검색 지우기(×) 버튼 표시 상태 초기화.
  state.favoriteOnly = false;
  state.reviewOnly = false;
  const favFilterBtn = document.getElementById('site-favorite-filter-btn');
  if (favFilterBtn) favFilterBtn.classList.remove('active');
  const reviewFilterBtn = document.getElementById('site-review-filter-btn');
  if (reviewFilterBtn) reviewFilterBtn.classList.remove('active');
  const searchClearBtn = document.getElementById('site-search-clear-btn');
  if (searchClearBtn) searchClearBtn.style.display = 'none';
  const countLabel = document.getElementById('site-count-label');
  if (countLabel) countLabel.textContent = '';
  const signupNameInput = document.getElementById('signup-name');
  if (signupNameInput) signupNameInput.value = '';
  // STEP15-B. 모바일 하단 탭 상태를 초기화한다(재로그인 시 항상 지도 탭부터 시작).
  state.mobileActiveTab = 'map';
  mobileFavoriteOnlyBackup = null;
  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.mobileTab = 'map';
  document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === 'map');
  });
  showView('view-login');
}

function bindEvents() {
  document.getElementById('show-signup').addEventListener('click', () => showView('view-signup'));
  document.getElementById('show-login').addEventListener('click', () => showView('view-login'));
  document.getElementById('signup-done-to-login').addEventListener('click', () => showView('view-login'));

  ['logout-pending', 'logout-rejected', 'logout-disabled', 'logout-approved'].forEach(id => {
    document.getElementById(id).addEventListener('click', handleLogout);
  });

  document.getElementById('btn-current-location').addEventListener('click', async () => {
    if (state.locationRequestInFlight) return;
    state.locationRequestInFlight = true;

    const btn = document.getElementById('btn-current-location');
    const msgEl = document.getElementById('location-message');
    btn.disabled = true;
    msgEl.textContent = '';

    try {
      const result = await requestCurrentLocation();
      msgEl.textContent = result.ok ? '' : result.message;
    } finally {
      btn.disabled = false;
      state.locationRequestInFlight = false;
    }
  });

  document.getElementById('btn-admin-panel').addEventListener('click', async () => {
    if (!isAdmin()) return; // UI 숨김을 우회해 호출해도 클라이언트에서 한 번 더 막음(최종 방어는 RLS/RPC)
    const panel = document.getElementById('admin-panel');
    const willOpen = panel.style.display === 'none';
    panel.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
      state.adminMessage = '';
      await renderAdminPanel('admin-panel');
    }
  });

  document.getElementById('btn-upload-panel').addEventListener('click', () => {
    if (!isAdmin()) return; // UI 숨김 우회 방지(최종 방어는 STEP 12 RPC 내부의 관리자 검증)
    const panel = document.getElementById('upload-panel');
    const willOpen = panel.style.display === 'none';
    panel.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
      renderUploadHistoryPanel('upload-history'); // STEP13-5: 패널을 열 때 최근 업로드 이력을 표시한다.
    }
  });

  document.getElementById('btn-supervision-panel').addEventListener('click', () => {
    // approved 사용자 전체가 조회 가능(등록/수정/삭제 버튼만 renderSupervisionPanel 내부에서 admin으로 제한).
    if (!isApproved()) return;
    const panel = document.getElementById('supervision-panel');
    const willOpen = panel.style.display === 'none';
    panel.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
      renderSupervisionPanel('supervision-panel');
    }
  });

  // STEP15-B. 모바일 하단 탭 버튼(6개) 클릭 바인딩. bindEvents()는 bootstrap에서 1회만 호출되므로 중복 등록 없음.
  document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateMobileTab(btn.dataset.tab));
  });

  document.getElementById('upload-file-input').addEventListener('change', async (e) => {
    if (!isAdmin()) return;
    const file = e.target.files[0];
    if (!file) return;
    await handleExcelFileSelect(file, 'upload-preview');
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
    const name = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    try {
      await signUp(email, password, name);
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
