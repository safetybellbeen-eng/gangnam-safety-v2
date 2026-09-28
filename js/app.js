// app.js — STEP 3B. 인증 흐름 최소 테스트 UI 연결.
// 지도/사업장 등 실제 기능은 이후 STEP에서 추가한다 (CLAUDE.md 12절: 대규모 UI 금지).
import { state } from './state.js';
import { signUp, signIn, signOut, loadCurrentProfile, isApproved, isAdmin, hasActiveSession, verifySignupCode, checkIdExists, checkLoginLock, translateAuthError } from './auth.js';
import { initMap, clearMarkers, renderGangnamBoundaries, assignDongToSites, renderHqMarker } from './map.js';
import { loadActiveSites } from './sites.js';
import { loadFavorites } from './favorites.js';
import { loadNotes } from './notes.js';
import { renderSiteList, selectSite, closeDetail, bindSearchAndSort, renderDongOptions, renderAdminPanel, handleExcelFileSelect, renderUploadHistoryPanel, renderUploadMobileHost, renderSupervisionPanel, renderSupervisionMobileHost, renderMobileRouteView, renderMobileMoreMenu, getAppSettings, restoreRoutePlanFromStorage, setFavoriteTabView, renderHeaderUploadDate, setSiteSearchMode } from './ui.js';
import { requestCurrentLocation, clearCurrentLocationMarker } from './location.js';

const VIEWS = [
  'view-login', 'view-signup', 'view-signup-done',
  'view-pending', 'view-rejected', 'view-disabled', 'view-approved'
];

// "아이디 저장"/"자동 로그인" 체크박스용 localStorage 키. 서버/DB와 무관한 프론트 전용 편의
// 기능이며, 이메일 문자열과 '1'/없음 플래그만 저장한다(비밀번호는 절대 저장하지 않는다).
const REMEMBER_EMAIL_KEY = 'gnmap_v2_remember_email';
const AUTO_LOGIN_KEY = 'gnmap_v2_auto_login';

// STEP15-B. 모바일 "즐겨찾기" 탭에 들어가기 직전의 state.favoriteOnly 값을 임시 보관한다.
// (탭을 벗어나면 사용자가 PC/모바일 공용 즐겨찾기 토글로 실제 선택해둔 값으로 복원 — 다른 필터는 건드리지 않는다.)
let mobileFavoriteOnlyBackup = null;

// STEP16.8(잠금 카운트다운). 로그인/회원가입 인증번호 잠금 메시지에 공통으로 쓰는 실시간
// mm:ss 카운트다운. 같은 엘리먼트에 중복으로 걸리지 않도록 이전 타이머를 추적해 정리한다.
const activeLockCountdowns = new WeakMap();
function startLockCountdown(el, lockedUntilIso, prefix, onExpire) {
  if (activeLockCountdowns.has(el)) clearInterval(activeLockCountdowns.get(el));
  const lockedUntilMs = new Date(lockedUntilIso).getTime();
  function tick() {
    const remainingMs = lockedUntilMs - Date.now();
    if (remainingMs <= 0) {
      clearInterval(timer);
      activeLockCountdowns.delete(el);
      el.textContent = '';
      if (onExpire) onExpire();
      return;
    }
    const mm = Math.floor(remainingMs / 60000);
    const ss = Math.floor((remainingMs % 60000) / 1000);
    el.textContent = `${prefix} ${mm}:${String(ss).padStart(2, '0')} 후 다시 시도해주세요.`;
  }
  tick();
  const timer = setInterval(tick, 1000);
  activeLockCountdowns.set(el, timer);
}

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
    setFavoriteTabView('favorites'); // 사용자 요청: 즐겨찾기 탭에 새로 들어올 때는 항상 "즐겨찾기 현장" 내부 탭부터 시작한다.
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

  // STEP16.33: 사용자 요청 — "현장" 탭은 검색모드 컨트롤 자체가 없고(css/mobile.css가 숨김)
  // 항상 등록된 사업장(현장/업체명/주소)만 검색되어야 한다. 지도 탭에서 "주소/장소명" 모드로
  // 전환해 두었더라도 현장 탭에 들어오면 항상 "현장/업체명"으로 되돌린다(이미 그 모드면
  // setSiteSearchMode 내부에서 아무 것도 하지 않는다).
  if (tab === 'site') {
    setSiteSearchMode('site', 'site-list');
  }

  // 지도 탭으로 복귀(또는 최초 진입) 시, display:none 상태였던 동안 틀어진 지도 크기를 보정한다(재초기화 아님).
  // STEP15-C.1: kakao.maps.event.trigger(map,'relayout')는 relayout을 실제로 트리거하지 않는 잘못된
  // 호출이었다(흰 화면 원인) — Kakao Maps SDK가 제공하는 실제 인스턴스 메서드 map.relayout()으로 수정.
  if (tab === 'map' && state.map && typeof state.map.relayout === 'function') {
    state.map.relayout();
    state.map.setCenter(state.map.getCenter()); // relayout 직후 타일이 흰 화면으로 남는 것을 방지(중심 재설정으로 강제 리드로우)
  }

  // STEP16.13. 경로 탭: "경로 만들기" 화면(state.routePlanSiteIds 기준)을 다시 그린다.
  // 탭을 벗어났다 돌아와도 선택 현장은 유지되고, 항상 이 화면(plan)부터 시작한다
  // (activateMobileTab의 route-order-panel/route-detail-panel 닫기 로직과 세트).
  if (tab === 'route') {
    renderMobileRouteView('mobile-route-content');
  }

  // STEP15-D. 알림 탭: 전용 알림 데이터가 없으므로 기존 감독일정 상황판을 그대로 재사용한다.
  // 표시 위치/크기는 css/mobile.css의 #app[data-mobile-tab="alert"] 규칙이 전체화면으로 override한다.
  if (tab === 'alert') {
    renderSupervisionPanel('supervision-panel');
    renderSupervisionMobileHost();
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
    // 사용자 요청(즐겨찾기 탭 작업 중 발견): site-notes-panel/site-notes-write-panel이 이
    // 목록에 빠져 있어, 더보기 탭에서 현장 메모를 열어둔 채 다른 탭으로 이동하면 이 패널이
    // display:block으로 남아 있었다(더보기 탭 전용 position:fixed 스타일은 data-mobile-tab
    // 셀렉터라 탭을 벗어나면 더 이상 적용되지 않아, 일반 문서 흐름에 끼어들어 다른 화면
    // 레이아웃을 방해할 수 있었다). 다른 더보기 패널과 동일하게 여기서 함께 닫는다.
    ['admin-panel', 'upload-panel', 'supervision-panel', 'account-info-panel', 'app-settings-panel', 'password-change-panel', 'notification-settings-panel', 'site-notes-panel', 'site-notes-write-panel'].forEach(id => {
      const panelEl = document.getElementById(id);
      if (panelEl) panelEl.style.display = 'none';
    });
    // STEP16.5(모바일 감독일정관리): 다음에 다시 들어올 때는 항상 목록 화면부터 시작한다(등록/수정
    // 도중 상태로 남아있지 않도록). 사용자가 보던 월/선택 날짜/필터(supervisionMobileMonthCursor/
    // supervisionMobileSelectedDate/supervisionMobileStatusFilter/supervisionMobileTypeFilter)는 그대로 유지한다.
    state.supervisionMobileView = 'list';
    state.supervisionMobileSelectedId = null;
  }

  // STEP16.13(모바일 "경로" 탭). "방문 순서"/"경로 상세" 패널은 "경로" 탭 안에서만 열리므로,
  // 다른 탭으로 이동할 때 열려 있으면 닫는다. routePlanSiteIds(선택한 현장 목록)는 여기서
  // 지우지 않는다 — "탭을 이동해도 선택 현장이 사라지면 안 된다"는 요구사항 때문에 경로
  // 탭으로 돌아오면 그대로 이어서 보여야 한다. routeMobileView만 'plan'(첫 화면)으로 되돌려
  // 다음에 경로 탭에 들어오면 항상 "경로 만들기" 화면부터 시작하게 한다.
  if (previousTab === 'route' && tab !== previousTab) {
    ['route-order-panel', 'route-detail-panel'].forEach(id => {
      const panelEl = document.getElementById(id);
      if (panelEl) panelEl.style.display = 'none';
    });
    state.routeMobileView = 'plan';
  }
}

function showView(id) {
  VIEWS.forEach(v => {
    // (버그 수정) 활성 뷰는 인라인 'block'을 강제하지 않고 스타일시트가 결정하도록 비워둔다.
    // #view-approved는 모바일에서 css/mobile.css가 display:flex로 세로 레이아웃을 잡는데,
    // 여기서 항상 'block'을 강제하면(구버전) 그 flex 레이아웃이 절대 적용되지 못해
    // #view-approved에 !important를 붙여야 했고, 그 결과 로그인 등 다른 화면이 떠 있을 때도
    // (인라인 'none'이 !important보다 밀려) #view-approved가 항상 화면 아래에 빈 상태로
    // flex 표시되어 로그인 화면 아래로 화면 높이만큼 빈 스크롤 영역이 생기는 문제가 있었다.
    // 비활성 뷰는 기존대로 인라인 'none'으로 확실히 숨긴다.
    document.getElementById(v).style.display = (v === id) ? '' : 'none';
  });
}

function clearError(el) {
  // 이전에 이 엘리먼트에 걸어둔 잠금 카운트다운이 있으면 먼저 멈춘다 — 그렇지 않으면
  // 타이머가 1초마다 계속 textContent를 덮어써서 새로 표시하려는 메시지를 지워버린다.
  if (activeLockCountdowns.has(el)) {
    clearInterval(activeLockCountdowns.get(el));
    activeLockCountdowns.delete(el);
  }
  el.textContent = '';
}

// 로그인 직후 profile.status에 따라 화면을 분기한다.
// 보안 판단(누가 실제로 데이터에 접근 가능한가)은 RLS가 하고, 이 분기는 안내 화면 표시 목적일 뿐이다.
// STEP16.6(모바일 앱 설정 "지도 시작 위치"). location.js의 requestCurrentLocation()은
// state.map이 이미 있어야 마커를 찍을 수 있어 지도 생성 "이전" 시점에는 재사용할 수 없으므로,
// 여기서는 좌표만 필요한 최소한의 별도 1회 조회를 직접 수행한다(마커/상태 갱신 없음, 순수
// 좌표 조회). 설정이 'current'가 아니거나 Geolocation을 못 쓰면 즉시 null(→ 기존 GANGNAM_CENTER
// 폴백)로 resolve한다. 절대 reject하지 않아 initMap 체인이 끊기지 않는다.
function resolvePreferredMapStartCenter() {
  const settings = getAppSettings();
  if (settings.mapStartLocation !== 'current' || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        finish({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      () => { clearTimeout(timer); finish(null); },
      { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 }
    );
  });
}

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
      // STEP16.28: 상단 헤더의 "가장 최근 엑셀 업로드 일시" 배지 — 지도/사업장 로딩과 무관한
      // 부가 정보라 await 없이 별도로 요청한다(실패해도 헤더 배지만 숨겨질 뿐 나머지 화면에
      // 영향 없음, renderHeaderUploadDate 내부에서 에러를 흡수).
      renderHeaderUploadDate();
      // STEP15-C.2: initMap()보다 먼저 data-mobile-tab을 적용해, 모바일에서 Kakao 지도가
      // display:none인 #map-container(크기 0) 위에 생성되지 않도록 한다(흰 화면의 실제 원인 — 아래 보고 참고).
      // PC에서는 이 속성이 어떤 CSS에도 영향을 주지 않으므로 PC 동작은 그대로다.
      {
        const appElForInitialTab = document.getElementById('app');
        if (appElForInitialTab) appElForInitialTab.dataset.mobileTab = state.mobileActiveTab || 'map';
      }
      // approved 상태에서만 지도를 초기화한다. pending/rejected/disabled는 여기 도달하지 않는다.
      // 지도 초기화가 끝난 뒤에만 사업장을 조회해 마커/목록을 그린다. 조회 실패해도 지도는 유지된다.
      // STEP16.6(모바일 앱 설정 "지도 시작 위치"): 설정이 'current'일 때만 initMap 전에 짧게
      // (최대 4초) 위치를 시도해 그 좌표를 초기 중심으로 넘긴다 — 실패/시간초과해도 기존처럼
      // GANGNAM_CENTER로 자동 폴백하므로 지도 초기화 자체가 지연/실패하지 않는다.
      resolvePreferredMapStartCenter()
        .then((startCenter) => initMap('map-container', startCenter))
        // STEP16.28: 지도 초기화 직후 "커맨드센터"(강남지청) 고정 마커를 1회 요청한다. 내부에서
        // 주소를 지오코딩해 좌표를 얻는 비동기 작업이라 여기서 await하지 않고(체인을 지연시키지
        // 않음) 결과가 오면 지도 위에 직접 표시된다.
        .then((map) => { renderHqMarker(); return map; })
        // STEP16.20: renderGangnamBoundaries()(경계선 그리기, 내부에서 경계 GeoJSON을 fetch)를
        // 사업장 조회와 병렬로 실행한다 — 서로 의존하지 않고, 둘 다 끝난 뒤 assignDongToSites()가
        // 이미 로드된 경계 데이터를 재사용(캐시된 Promise)해 즉시 판정할 수 있게 하기 위함이다.
        .then(() => Promise.all([loadActiveSites(), loadFavorites(), loadNotes(), renderGangnamBoundaries()]))
        .then(async ([sites]) => {
          state.sites = sites;
          // STEP16.20: gnmap_v2_sites.dong이 전부 NULL이라(§map.js 상단 설명), 좌표 기준으로
          // 강남구 14개 법정동에 배정한다. 이 값으로 기존 "관할" 체크박스 필터(renderDongOptions/
          // getDongOptions, js/sites.js)와 목록/지도 마커가 함께 동작한다 — 새 필터 UI를 만들지 않는다.
          await assignDongToSites(state.sites);
          // STEP16.16: 경로 탭에서 저장해둔 선택 현장/출발지를 복원한다. 반드시 아래
          // activateMobileTab()보다 먼저 호출해야 한다 — 그 안에서 route 탭이면 바로
          // renderMobileRouteView()를 그리는데, 그 렌더 함수가 시작할 때 현재 state를
          // 그대로 저장(saveRoutePlanState)해버리므로 복원 전에 렌더가 먼저 일어나면
          // 저장된 값이 빈 상태로 덮어써진다.
          restoreRoutePlanFromStorage();
          renderDongOptions(); // state.sites 기준으로 동 select 옵션을 채운 뒤 이벤트 바인딩
          bindSearchAndSort('site-list');
          renderSiteList('site-list'); // 내부에서 marker도 함께 렌더한다 (getFilteredSortedSites 기준, 즐겨찾기 별표 포함)
          activateMobileTab(state.mobileActiveTab || 'map'); // STEP15-B. 모바일 하단 탭 초기 표시 상태 적용(PC에서는 CSS로 무효화됨)
          // STEP16.6(모바일 앱 설정 "현재 위치 자동 표시"): 켜져 있으면 기존 수동 버튼과 동일한
          // requestCurrentLocation()을 지도 준비 직후 1회 자동 호출한다(새 위치 로직 없음).
          // 기본값 false라 이 설정을 건드리지 않은 사용자는 기존 동작(버튼 클릭 시에만) 그대로다.
          if (getAppSettings().autoShowLocation) {
            requestCurrentLocation();
          }
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
  state.currentLocationAddress = null;
  state.locationRequestInFlight = false;
  state.routeStartMode = null;
  state.routePlanSiteIds = [];
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
  const dongFilterOptions = document.getElementById('site-dong-filter-options');
  const dongFilterEl = document.getElementById('site-dong-filter');
  const locationMsg = document.getElementById('location-message');
  if (searchInput) searchInput.value = '';
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
  // 사용자 요청(STEP16.22): "기본순서" 정렬도 위 3개와 동일한 details+radio가 됐다(이전
  // <select id="site-sort-select"> 참조는 그 엘리먼트가 사라져 아무 효과가 없던 죽은 코드였다).
  // neutralValue가 'all'이 아니라 'default'라 위 forEach와 값만 다르게 별도 처리한다.
  const sortFilterEl = document.getElementById('site-sort-filter');
  if (sortFilterEl) {
    sortFilterEl.open = false;
    sortFilterEl.dataset.active = 'false';
    const defaultRadio = sortFilterEl.querySelector('input[type="radio"][value="default"]');
    if (defaultRadio) defaultRadio.checked = true;
    const sortLabelEl = document.getElementById('site-sort-filter-label');
    if (sortLabelEl) sortLabelEl.textContent = '기본순서';
  }
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

// 사용자 요청(3): 사업장 상세정보 패널 상단 터치바를 아래로 스와이프하면 닫힌다.
// Pointer Events로 마우스/터치를 통합 처리하고, 드래그 중에는 손가락을 따라 패널을
// translateY로 즉시 이동시켜(따라오는 느낌) 실제 바텀시트처럼 보이게 한다.
function bindDetailPanelSwipeToClose() {
  const panel = document.getElementById('site-detail-panel');
  if (!panel) return;
  const HANDLE_ZONE = 28; // 핸들이 보이는 상단 영역(px). 이 안에서 시작한 드래그만 인정한다.
  const CLOSE_THRESHOLD = 70; // 이 이상 내리면 닫힘으로 판정한다.
  let dragging = false;
  let startY = 0;
  let dy = 0;

  panel.addEventListener('pointerdown', (e) => {
    if (panel.style.display === 'none') return;
    const rect = panel.getBoundingClientRect();
    if (e.clientY - rect.top > HANDLE_ZONE) return; // 핸들 영역 밖이면 무시(본문 스크롤/버튼 유지)
    dragging = true;
    startY = e.clientY;
    dy = 0;
    panel.style.transition = 'none';
    if (panel.setPointerCapture) panel.setPointerCapture(e.pointerId);
  });
  panel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault(); // 드래그 중 배경 페이지가 같이 스크롤되지 않도록 한다.
    dy = e.clientY - startY;
    if (dy < 0) dy = 0; // 위로는 끌리지 않는다(닫기 전용 제스처).
    panel.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    if (dy > CLOSE_THRESHOLD) {
      closeDetail();
    } else {
      panel.style.transform = '';
    }
    dy = 0;
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);
}

function bindEvents() {
  document.getElementById('show-signup').addEventListener('click', () => showView('view-signup'));
  document.getElementById('show-login').addEventListener('click', () => showView('view-login'));
  // 로그인 화면 우상단 "회원가입 >" 링크. 기존 show-signup과 동일한 화면 전환만 재사용한다(신규 로직 없음).
  const signupTop = document.getElementById('mobile-login-signup-top');
  if (signupTop) signupTop.addEventListener('click', () => showView('view-signup'));

  // 비밀번호 표시/숨기기 토글. input의 type만 전환하고 값/검증은 그대로 둔다.
  const pwToggle = document.getElementById('mobile-login-password-toggle');
  if (pwToggle) {
    pwToggle.addEventListener('click', () => {
      const pwInput = document.getElementById('login-password');
      const showing = pwInput.type === 'text';
      pwInput.type = showing ? 'password' : 'text';
      pwToggle.classList.toggle('active', !showing);
    });
  }
  document.getElementById('signup-done-to-login').addEventListener('click', () => showView('view-login'));

  // STEP16.6(승인대기 화면 모바일 뒤로가기). 새 로직을 만들지 않고 기존 "로그인으로 이동"
  // 버튼의 클릭을 그대로 위임한다(#mobile-signup-back과 동일한 원칙).
  const signupDoneBack = document.getElementById('mobile-signupdone-back');
  if (signupDoneBack) {
    signupDoneBack.addEventListener('click', () => document.getElementById('signup-done-to-login').click());
  }

  // STEP16.8(상태 화면 뒤로가기). pending/rejected/disabled 화면의 뒤로가기 버튼은 새 로직 없이
  // 각 화면의 기존 "로그아웃" 버튼 클릭을 그대로 위임한다(#mobile-signupdone-back과 동일한 원칙).
  [['mobile-pending-back', 'logout-pending'], ['mobile-rejected-back', 'logout-rejected'], ['mobile-disabled-back', 'logout-disabled']]
    .forEach(([backId, targetId]) => {
      const backBtn = document.getElementById(backId);
      if (backBtn) backBtn.addEventListener('click', () => document.getElementById(targetId).click());
    });

  // 모바일 회원가입 화면 상단 뒤로가기 버튼. 새 로직을 만들지 않고 기존 "로그인으로
  // 돌아가기" 버튼(#show-login)의 클릭을 그대로 위임한다.
  const signupBack = document.getElementById('mobile-signup-back');
  if (signupBack) {
    signupBack.addEventListener('click', () => document.getElementById('show-login').click());
  }

  // 회원가입 비밀번호 표시/숨기기 토글. 로그인 화면과 동일한 원칙(type만 전환, 검증 로직 없음).
  const signupPwToggle = document.getElementById('mobile-signup-password-toggle');
  if (signupPwToggle) {
    signupPwToggle.addEventListener('click', () => {
      const pwInput = document.getElementById('signup-password');
      const showing = pwInput.type === 'text';
      pwInput.type = showing ? 'password' : 'text';
      signupPwToggle.classList.toggle('active', !showing);
    });
  }

  // 저장된 "아이디 저장"/"자동 로그인" 값을 로그인 화면에 반영(1회, bindEvents는 bootstrap에서
  // 한 번만 호출됨). 비밀번호는 저장하지 않으므로 이메일/체크박스 상태만 복원한다.
  const savedEmail = localStorage.getItem(REMEMBER_EMAIL_KEY);
  if (savedEmail) {
    document.getElementById('login-email').value = savedEmail;
    document.getElementById('mobile-login-remember').checked = true;
  }
  document.getElementById('mobile-login-autologin').checked = localStorage.getItem(AUTO_LOGIN_KEY) === '1';

  // 사용자 요청(3): 상세정보 패널 상단의 터치바(드래그 핸들)를 아래로 스와이프하면 닫힌다.
  // 패널 자체는 renderDetail()이 매번 innerHTML만 바꾸고 엘리먼트는 재사용하므로, 리스너는
  // 여기서 한 번만 바인딩한다. 드래그는 핸들이 보이는 상단 영역(패널 상단에서 28px 이내)에서
  // 시작할 때만 동작해 본문 스크롤/버튼 클릭과 충돌하지 않는다.
  bindDetailPanelSwipeToClose();

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
      renderUploadMobileHost(); // 모바일 "사업장 데이터 관리" TARGET UI. state를 그대로 다시 읽어 그린다.
    }
  });

  // STEP16.32: 정적 #btn-upload-close 버튼을 제거했다 — 닫기 동작은 이제 js/ui.js
  // renderUploadMobileHost가 그리는 buildSettingsSubHeader의 뒤로가기 버튼이 담당한다.

  document.getElementById('btn-supervision-panel').addEventListener('click', () => {
    // approved 사용자 전체가 조회 가능(등록/수정/삭제 버튼만 renderSupervisionPanel 내부에서 admin으로 제한).
    if (!isApproved()) return;
    const panel = document.getElementById('supervision-panel');
    const willOpen = panel.style.display === 'none';
    panel.style.display = willOpen ? 'block' : 'none';
    if (willOpen) {
      renderSupervisionPanel('supervision-panel');
      renderSupervisionMobileHost();
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
    renderUploadMobileHost(); // PC 미리보기(upload-preview)와 별개로 모바일 화면도 새 파싱 결과로 갱신한다.
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    clearError(errorEl);
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const remember = document.getElementById('mobile-login-remember').checked;
    const autoLogin = document.getElementById('mobile-login-autologin').checked;

    if (!email || !password) {
      errorEl.textContent = '아이디와 비밀번호를 입력해주세요.';
      return;
    }

    // STEP16.8(중복 제출 방지). 회원가입과 동일한 원칙 — 처리 중에는 버튼을 비활성화하고
    // "로그인 중..."으로 바꾼 뒤, 성공/실패 어느 경우든 finally에서 항상 복구한다.
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) {
      if (submitBtn.disabled) return;
      submitBtn.dataset.originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = '로그인 중...';
    }

    try {
      // STEP16.8(로그인 실패 5회 잠금). 실제 로그인을 시도하기 전에 먼저 잠금 여부를 확인해,
      // 이미 잠긴 계정이면 Supabase Auth 호출 자체를 생략하고 바로 안내한다.
      const lockStatus = await checkLoginLock(email);
      if (lockStatus.locked) {
        startLockCountdown(errorEl, lockStatus.lockedUntil, '로그인을 5회 잘못 시도하여 계정이 잠겼습니다.');
        return;
      }

      await signIn(email, password);
      if (remember) localStorage.setItem(REMEMBER_EMAIL_KEY, email);
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
      if (autoLogin) localStorage.setItem(AUTO_LOGIN_KEY, '1');
      else localStorage.removeItem(AUTO_LOGIN_KEY);
      routeByProfile();
    } catch (err) {
      const lockInfo = err && err.lockInfo;
      if (lockInfo && lockInfo.locked) {
        startLockCountdown(errorEl, lockInfo.lockedUntil, '로그인을 5회 잘못 시도하여 계정이 잠겼습니다.');
      } else {
        const base = translateAuthError(err, '로그인에 실패했습니다.');
        const left = lockInfo && lockInfo.attemptsLeft;
        errorEl.textContent = (left != null) ? `${base} (남은 시도 ${left}회)` : base;
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        if (submitBtn.dataset.originalText != null) submitBtn.textContent = submitBtn.dataset.originalText;
      }
    }
  });

  // STEP16.5(회원가입 필드 분리). 소속/이름을 별도 입력칸으로 나누되, DB(gnmap_v2_profiles.name)는
  // 컬럼 추가 없이 기존 단일 name 컬럼을 그대로 쓴다 — signUp 호출 시 "소속 이름" 형태로 합쳐서 전달한다.
  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('signup-error');
    clearError(errorEl);
    const org = document.getElementById('signup-org').value.trim();
    const name = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const passwordConfirm = document.getElementById('signup-password-confirm').value;
    const code = document.getElementById('signup-code').value.trim();

    // STEP16.5(필수값 검증). form에 novalidate를 적용해 브라우저 기본 유효성 검사 팝업 대신
    // 항상 한글 오류 메시지(errorEl)로 통일해서 보여준다 — 아래 개별 항목 검증들도 같은 이유.
    if (!org || !name || !email || !password || !passwordConfirm || !code) {
      errorEl.textContent = '모든 항목을 입력해주세요.';
      return;
    }

    // STEP16.5(아이디 형식 제한). 영문/숫자만, 4~20자 — 합성 이메일 로컬파트로 안전하게 쓰일 수 있는
    // 문자만 허용한다(공백/한글/특수문자 등으로 인한 가입 오류를 사전에 막음).
    const ID_PATTERN = /^[a-zA-Z0-9]{4,20}$/;
    if (!ID_PATTERN.test(email)) {
      errorEl.textContent = '아이디는 영문, 숫자로 4~20자로 입력해주세요.';
      return;
    }

    // STEP16.5(비밀번호 정책 강제). 영문/숫자/특수문자를 모두 포함한 8~20자.
    const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,20}$/;
    if (!PASSWORD_PATTERN.test(password)) {
      errorEl.textContent = '비밀번호는 영문, 숫자, 특수문자를 모두 포함하여 8~20자로 입력해주세요.';
      return;
    }

    if (password !== passwordConfirm) {
      errorEl.textContent = '비밀번호가 일치하지 않습니다.';
      return;
    }

    // STEP16.5(개인정보 수집·이용 동의).
    const privacyAgree = document.getElementById('signup-privacy-agree');
    if (privacyAgree && !privacyAgree.checked) {
      errorEl.textContent = '개인정보 수집·이용에 동의해주세요.';
      return;
    }

    // STEP16.5(중복 제출 방지). 요청이 끝날 때까지 제출 버튼을 비활성화해 중복 클릭으로 인한
    // 중복 요청(중복 가입 시도 등)을 막는다. 성공/실패 어느 경우든 finally에서 항상 복구한다.
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) {
      if (submitBtn.disabled) return;
      submitBtn.dataset.originalHtml = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.textContent = '처리 중...';
    }

    try {
      // STEP16.5(인증번호 5회 실패 잠금). verifySignupCode()는 이제 { ok, locked, lockedUntil,
      // attemptsLeft } 객체를 반환한다(과거의 boolean 반환에서 변경됨).
      const result = await verifySignupCode(code);
      if (result.locked) {
        if (result.lockedUntil) {
          startLockCountdown(errorEl, result.lockedUntil, '인증번호를 5회 잘못 입력하여 계정이 잠겼습니다.');
        } else {
          errorEl.textContent = '인증번호를 5회 잘못 입력하여 일정 시간 잠겼습니다. 잠시 후 다시 시도해주세요.';
        }
        return;
      }
      if (!result.ok) {
        const left = result.attemptsLeft;
        errorEl.textContent = (left != null)
          ? `인증번호가 올바르지 않습니다. (남은 시도 ${left}회)`
          : '인증번호가 올바르지 않습니다.';
        return;
      }
      await signUp(email, password, `${org} ${name}`.trim());
      // STEP16.8(가입 신청 상태확인 수단). 방금 신청한 소속/아이디를 완료 화면에 그대로 보여준다.
      const recapEl = document.getElementById('signup-done-recap');
      if (recapEl) recapEl.textContent = `${org} · 아이디: ${email}`;
      showView('view-signup-done');
    } catch (err) {
      errorEl.textContent = translateAuthError(err, '회원가입에 실패했습니다.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        if (submitBtn.dataset.originalHtml != null) submitBtn.innerHTML = submitBtn.dataset.originalHtml;
      }
    }
  });

  // STEP16.5(아이디 중복확인) + STEP16.8(아이디 형식 실시간 안내). 입력을 멈추고 400ms 후
  // 자동으로 확인한다. 형식(영문/숫자 4~20자)부터 즉시 검사해 서버까지 갈 필요가 없는
  // 오류는 바로 보여주고, 형식이 맞을 때만 중복확인 서버 호출을 한다.
  const SIGNUP_ID_PATTERN = /^[a-zA-Z0-9]{4,20}$/;
  const signupIdInput = document.getElementById('signup-email');
  const signupIdCheckMsg = document.getElementById('signup-id-check-msg');
  if (signupIdInput && signupIdCheckMsg) {
    let idCheckTimer = null;
    let idCheckToken = 0;
    signupIdInput.addEventListener('input', () => {
      const value = signupIdInput.value.trim();
      clearTimeout(idCheckTimer);
      if (!value) {
        signupIdCheckMsg.textContent = '';
        signupIdCheckMsg.className = 'mobile-signup-match-msg';
        return;
      }
      if (!SIGNUP_ID_PATTERN.test(value)) {
        signupIdCheckMsg.textContent = '영문, 숫자로 4~20자로 입력해주세요.';
        signupIdCheckMsg.className = 'mobile-signup-match-msg is-mismatch';
        ++idCheckToken; // 진행 중이던 중복확인 결과가 뒤늦게 와서 이 형식 오류를 덮어쓰지 않게 무효화.
        return;
      }
      signupIdCheckMsg.textContent = '확인 중...';
      signupIdCheckMsg.className = 'mobile-signup-match-msg is-checking';
      const myToken = ++idCheckToken;
      idCheckTimer = setTimeout(async () => {
        try {
          const exists = await checkIdExists(value);
          if (myToken !== idCheckToken) return; // 그 사이 입력이 더 바뀌었으면 이 결과는 버린다.
          signupIdCheckMsg.textContent = exists ? '이미 사용 중인 아이디입니다.' : '사용 가능한 아이디입니다.';
          signupIdCheckMsg.className = 'mobile-signup-match-msg ' + (exists ? 'is-mismatch' : 'is-match');
        } catch (err) {
          if (myToken !== idCheckToken) return;
          signupIdCheckMsg.textContent = '';
          signupIdCheckMsg.className = 'mobile-signup-match-msg';
        }
      }, 400);
    });
  }

  // STEP16.8(비밀번호 규칙 실시간 체크리스트). 제출 전에 타이핑하는 동안 각 규칙 충족
  // 여부를 실시간으로 표시한다(제출 시점 최종 검증 로직과는 별개 — 순수 UI 피드백).
  const signupPwForRules = document.getElementById('signup-password');
  const signupPwRulesEl = document.getElementById('signup-password-rules');
  if (signupPwForRules && signupPwRulesEl) {
    const RULES = {
      length: (v) => v.length >= 8 && v.length <= 20,
      letter: (v) => /[A-Za-z]/.test(v),
      digit: (v) => /\d/.test(v),
      special: (v) => /[^A-Za-z0-9]/.test(v),
    };
    signupPwForRules.addEventListener('input', () => {
      const value = signupPwForRules.value;
      signupPwRulesEl.querySelectorAll('li[data-rule]').forEach((li) => {
        const rule = RULES[li.dataset.rule];
        li.classList.toggle('is-met', !!(rule && rule(value)));
      });
    });
  }

  // 비밀번호/비밀번호 확인 실시간 일치 여부 표시. 검증 로직(제출 시 최종 비교)과는 별개로
  // 순수 UI 피드백만 담당하며, 값이 실제로 일치하는지는 제출 시 다시 한 번 확인한다.
  const signupPw = document.getElementById('signup-password');
  const signupPwConfirm = document.getElementById('signup-password-confirm');
  const signupPwMatchMsg = document.getElementById('signup-password-match-msg');
  if (signupPw && signupPwConfirm && signupPwMatchMsg) {
    const updateMatchMsg = () => {
      if (!signupPwConfirm.value) {
        signupPwMatchMsg.textContent = '';
        signupPwMatchMsg.className = 'mobile-signup-match-msg';
        return;
      }
      const match = signupPw.value === signupPwConfirm.value;
      signupPwMatchMsg.textContent = match ? '비밀번호가 일치합니다.' : '비밀번호가 일치하지 않습니다.';
      signupPwMatchMsg.className = 'mobile-signup-match-msg ' + (match ? 'is-match' : 'is-mismatch');
    };
    signupPw.addEventListener('input', updateMatchMsg);
    signupPwConfirm.addEventListener('input', updateMatchMsg);
  }

  // 회원가입 비밀번호 확인 표시/숨기기 토글 (본인 확인 필드용, 기존 비밀번호 토글과 동일한 원칙).
  const signupPwConfirmToggle = document.getElementById('mobile-signup-password-confirm-toggle');
  if (signupPwConfirmToggle) {
    signupPwConfirmToggle.addEventListener('click', () => {
      const pwInput = document.getElementById('signup-password-confirm');
      const showing = pwInput.type === 'text';
      pwInput.type = showing ? 'password' : 'text';
      signupPwConfirmToggle.classList.toggle('active', !showing);
    });
  }
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

// STEP15-F. 스플래시 화면 숨김. bootstrap()이 끝나(로그인 화면이든 지도 화면이든 어떤 화면을
// 보여줄지 결정된 뒤) 최소 노출 시간(너무 빨리 깜빡이며 사라지지 않도록)만큼 기다렸다가
// 페이드아웃한다. bootstrap()이 실패하거나 오래 걸려도 화면이 영원히 스플래시에 갇히지
// 않도록 별도의 최대 대기시간(SPLASH_MAX_MS) 안전장치를 둔다.
const SPLASH_MIN_MS = 900;
const SPLASH_MAX_MS = 4000;
let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  const splash = document.getElementById('mobile-splash');
  if (splash) splash.classList.add('mobile-splash-hide');
}

async function bootstrap() {
  const splashStartedAt = Date.now();
  setTimeout(hideSplash, SPLASH_MAX_MS);
  try {
    bindEvents();
    // "자동 로그인"을 체크하지 않고 로그인했던 경우, Supabase가 기본적으로 남겨둔 세션이
    // 있어도 앱 재시작 시 로그아웃시켜 로그인 화면부터 다시 시작하게 한다.
    if (localStorage.getItem(AUTO_LOGIN_KEY) !== '1' && (await hasActiveSession())) {
      await signOut();
    }
    await loadCurrentProfile();
    routeByProfile();
  } finally {
    const elapsed = Date.now() - splashStartedAt;
    setTimeout(hideSplash, Math.max(0, SPLASH_MIN_MS - elapsed));
  }
}

bootstrap();
