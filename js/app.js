// app.js — STEP 3B. 인증 흐름 최소 테스트 UI 연결.
// 지도/사업장 등 실제 기능은 이후 STEP에서 추가한다 (CLAUDE.md 12절: 대규모 UI 금지).
import { state } from './state.js';
import { signUp, signIn, signOut, loadCurrentProfile, isApproved, isAdmin } from './auth.js';
import { initMap, clearMarkers } from './map.js';
import { loadActiveSites } from './sites.js';
import { loadFavorites } from './favorites.js';
import { loadNotes } from './notes.js';
import { renderSiteList, selectSite, closeDetail, bindSearchAndSort, renderDongOptions, renderAdminPanel, handleExcelFileSelect, renderUploadHistoryPanel, renderSupervisionPanel, renderMobileRouteView, renderMobileMoreMenu } from './ui.js';
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

  // 사용자 피드백: 사업장 상세(#site-detail-panel)가 열린 채로 하단 탭을 이동하면 이전 탭에서
  // 열었던 상세가 새 탭 화면 위에 계속 떠 있는 채로 남아 있었다. 다른 탭으로 이동할 때는
  // 기존 closeDetail()(state.selectedSiteId 초기화 포함)을 그대로 호출해 자동으로 닫는다.
  // 단, 사용자 피드백(4): 지도 탭에서 연 상세는 닫지 않고 유지한다 — 다른 탭을 들렀다가
  // 지도 탭으로 돌아오면(닫기를 누르지 않은 이상) 이전에 보던 상세가 그대로 다시 보이게 한다.
  // panel은 DOM/state 그대로 두고, css/mobile.css의 [data-detail-origin="map"] 규칙이
  // 지도 탭이 아닐 때만 시각적으로 숨긴다.
  if (tab !== previousTab) {
    const detailPanel = document.getElementById('site-detail-panel');
    // origin이 'map'이면 지금 어느 탭을 오가는 중이든(지도→다른 탭, 다른 탭→지도 포함)
    // 사용자가 X/닫기 버튼으로 직접 닫기 전까지는 계속 유지한다.
    const keepMapDetail = detailPanel && detailPanel.dataset.detailOrigin === 'map';
    if (detailPanel && detailPanel.style.display !== 'none' && !keepMapDetail) {
      closeDetail();
    }
  }

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

  // 지도 탭으로 복귀(또는 최초 진입) 시, display:none 상태였던 동안 틀어진 지도 크기를 보정한다(재초기화 아님).
  // STEP15-C.1: kakao.maps.event.trigger(map,'relayout')는 relayout을 실제로 트리거하지 않는 잘못된
  // 호출이었다(흰 화면 원인) — Kakao Maps SDK가 제공하는 실제 인스턴스 메서드 map.relayout()으로 수정.
  if (tab === 'map' && state.map && typeof state.map.relayout === 'function') {
    state.map.relayout();
    state.map.setCenter(state.map.getCenter()); // relayout 직후 타일이 흰 화면으로 남는 것을 방지(중심 재설정으로 강제 리드로우)
  }

  // STEP15-D. 경로 탭: 새 로직 없이 기존 선택 상태(state.selectedSiteId/state.sites)와
  // 기존 길찾기(buildKakaoDirectionsUrl)만 재사용해 다시 그린다.
  if (tab === 'route') {
    renderMobileRouteView('mobile-route-content');
  }

  // STEP15-D. 알림 탭: 전용 알림 데이터가 없으므로 기존 감독일정 상황판을 그대로 재사용한다.
  // 표시 위치/크기는 css/mobile.css의 #app[data-mobile-tab="alert"] 규칙이 전체화면으로 override한다.
  if (tab === 'alert') {
    renderSupervisionPanel('supervision-panel');
  }

  // STEP15-D. 더보기 탭: 회원관리/엑셀업로드/감독일정/로그아웃 메뉴를 새로 구현하지 않고
  // renderMobileMoreMenu()가 기존 PC 버튼들을 그대로 클릭 위임하도록 다시 그린다(관리자 여부에
  // 따라 매번 최신 상태로 다시 그려야 하므로 탭 진입마다 재호출한다 — 네트워크 호출 없음).
  if (tab === 'more') {
    renderMobileMoreMenu('mobile-more-content');
  }

  // STEP15-D. 알림/더보기 탭에서 열었던 관리자/업로드/감독일정 패널은 그 탭을 벗어나면 닫아,
  // 다른 탭으로 이동했을 때 화면 위에 그대로 떠 있는 채로 남지 않게 한다.
  // 패널 자체의 데이터/렌더 로직(admin.js/import.js/supervision.js)은 전혀 건드리지 않으며,
  // 여기서는 기존 열기/닫기 버튼과 동일하게 표시 여부(inline style)만 되돌린다.
  if ((previousTab === 'alert' || previousTab === 'more') && tab !== previousTab) {
    ['admin-panel', 'upload-panel', 'supervision-panel'].forEach(id => {
      const panelEl = document.getElementById(id);
      if (panelEl) panelEl.style.display = 'none';
    });
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
      // STEP15-C.2: initMap()보다 먼저 data-mobile-tab을 적용해, 모바일에서 Kakao 지도가
      // display:none인 #map-container(크기 0) 위에 생성되지 않도록 한다(흰 화면의 실제 원인 — 아래 보고 참고).
      // PC에서는 이 속성이 어떤 CSS에도 영향을 주지 않으므로 PC 동작은 그대로다.
      {
        const appElForInitialTab = document.getElementById('app');
        if (appElForInitialTab) appElForInitialTab.dataset.mobileTab = state.mobileActiveTab || 'map';
      }
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
  state.selectedDongs = [];
  state.amountFilter = 'all';
  state.siteInspectionFilter = 'all';
  state.siteAccidentReportFilter = 'all';
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
  const dongFilterOptions = document.getElementById('site-dong-filter-options');
  const dongFilterEl = document.getElementById('site-dong-filter');
  const locationMsg = document.getElementById('location-message');
  if (searchInput) searchInput.value = '';
  if (sortSelect) sortSelect.value = 'default';
  if (dongFilterOptions) dongFilterOptions.innerHTML = ''; // renderDongOptions()가 다음 로그인 때 다시 채운다.
  if (dongFilterEl) dongFilterEl.open = false;
  const dongFilterLabel = document.getElementById('site-dong-filter-label');
  if (dongFilterLabel) dongFilterLabel.textContent = '관할';
  // 사용자 요청: 공사금액/점검/산재표도 관할과 동일한 details+radio 팝오버가 되었으므로,
  // <select>.value 초기화 대신 각 details의 "전체" radio를 다시 체크하고 라벨/강조 표시를
  // 되돌린다(bindSearchAndSort()가 이미 로그인 시 1회만 바인딩되어 있어, 여기서는 시각적
  // 상태만 리셋하면 다음 렌더 시 state 값과 다시 일치한다).
  [
    ['site-amount-filter', '공사금액'],
    ['site-inspection-filter', '점검'],
    ['site-accident-report-filter', '산재표'],
  ].forEach(([detailsId, defaultLabel]) => {
    const detailsEl = document.getElementById(detailsId);
    if (!detailsEl) return;
    detailsEl.open = false;
    detailsEl.dataset.active = 'false';
    const allRadio = detailsEl.querySelector('input[type="radio"][value="all"]');
    if (allRadio) allRadio.checked = true;
    const labelEl = document.getElementById(`${detailsId}-label`);
    if (labelEl) labelEl.textContent = defaultLabel;
  });
  if (locationMsg) locationMsg.textContent = '';
  // STEP14.5-B. 즐겨찾기만보기 토글과 검색 지우기(×) 버튼 표시 상태 초기화.
  state.favoriteOnly = false;
  const favFilterBtn = document.getElementById('site-favorite-filter-btn');
  if (favFilterBtn) favFilterBtn.classList.remove('active');
  const searchClearBtn = document.getElementById('site-search-clear-btn');
  if (searchClearBtn) searchClearBtn.style.display = 'none';
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

  // STEP15-E.6: upload-panel은 admin-panel과 달리 전체가 매번 다시 그려지지 않으므로
  // (upload-history/upload-preview만 부분 갱신) 정적 닫기 버튼을 1회만 바인딩한다.
  // #btn-supervision-close와 동일하게 패널의 표시 여부만 되돌린다(새 상태/로직 없음).
  const btnUploadClose = document.getElementById('btn-upload-close');
  if (btnUploadClose) {
    btnUploadClose.addEventListener('click', () => {
      document.getElementById('upload-panel').style.display = 'none';
    });
  }

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

  // STEP15-E.1. 모바일 헤더 벨 버튼 — 새 로직 없이 기존 "알림" 하단 탭과 완전히 동일하게
  // activateMobileTab('alert')만 호출한다(하단 탭 버튼을 눌렀을 때와 동작이 100% 같다).
  const mobileHeaderAlertBtn = document.getElementById('mobile-header-alert-btn');
  if (mobileHeaderAlertBtn) {
    mobileHeaderAlertBtn.addEventListener('click', () => activateMobileTab('alert'));
  }

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

// STEP16. Service Worker 등록. 상대경로('./sw.js')를 써서 GitHub Pages의 /gangnam-safety-v2/
// 하위 경로에서도 절대경로(루트 기준) 가정 없이 그대로 동작하게 한다. window 'load' 이후에
// 등록해 초기 로딩(지도/데이터 조회 등)과 경쟁하지 않도록 하고, 등록 자체가 실패해도(구형
// 브라우저, 권한 문제 등) catch로 흡수해 console.warn만 남긴다 — 로그인/지도 등 앱의 핵심
// 기능은 Service Worker 등록 성공 여부와 무관하게 항상 정상 동작해야 한다.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service Worker 등록 실패(앱 기능에는 영향 없음):', err);
    });
  });
}

async function bootstrap() {
  bindEvents();
  await loadCurrentProfile();
  routeByProfile();
}

bootstrap();
