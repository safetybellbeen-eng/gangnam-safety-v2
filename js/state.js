// state.js — STEP 7B. 공용 애플리케이션 상태.
export const state = {
  user: null,          // auth.users 세션 사용자
  profile: null,        // gnmap_v2_profiles 행 (role/status 포함)
  map: null,             // kakao.maps.Map 인스턴스 (중복 초기화 방지용, approved일 때만 생성)
  markers: [],           // kakao.maps.Marker 인스턴스 배열 (재조회 시 정리 후 재생성)
  sites: [],              // 원본 사업장 목록 (STEP 5A loadActiveSites 결과). 검색/필터/정렬로 이 배열을 직접 변경하지 않는다.
  selectedSiteId: null,   // 현재 선택된 사업장 id (목록/마커 클릭으로 갱신)
  siteMarkers: new Map(), // siteId -> kakao.maps.Marker (마커 재검색 없이 클릭 시 즉시 매칭)
  searchQuery: '',        // 검색어 (site_name/company_name/address/dong 대상)
  sortMode: 'default',    // 'default' | 'name-asc' | 'company-asc' | 'amount-desc' | 'amount-asc'
  selectedDongs: [],       // 사용자 요청: "관할" 필터. 복수 선택된 dong 값 배열. 빈 배열=전체(필터 없음).
  amountFilter: 'all',     // 'all' | 'under-5b' | '5b-12b' | 'over-12b' (사용자 요청: 50억/120억 기준 3구간)
  siteInspectionFilter: 'all',    // 사용자 요청: "점검" 필터(gnmap_v2_sites.supervision_count 기준). 'all' | 'yes' | 'no'.
  siteAccidentReportFilter: 'all', // 사용자 요청: "산재표" 필터(gnmap_v2_sites.accident_report_count 기준). 'all' | 'yes' | 'no'.
  favoriteSiteIds: new Set(), // 현재 로그인 사용자가 즐겨찾기한 site id 집합
  favoriteInFlight: new Set(), // 토글 요청이 진행 중인 site id (rapid click 중복 방지)
  siteNotes: new Map(),   // siteId -> gnmap_v2_site_notes 행 (id/site_id/content/created_at/updated_at). 없으면 키가 없음.
  noteInFlight: new Set(), // 저장/삭제 요청이 진행 중인 site id (동시 요청 중복 방지)
  // 모바일 "더보기 > 현장 메모" 화면 전용 상태(STEP16.23). 기존 site-detail 메모 CRUD/데이터는
  // 그대로 두고, 이 화면은 조회/검색/필터/작성 진입점만 새로 추가한다.
  siteNotesFilter: 'all',        // 'all' | 'recent-created' | 'recent-updated'
  siteNotesSearchQuery: '',      // 현장명/메모 내용 검색어
  siteNotesWriteSiteId: null,    // "현장 메모 작성" 화면에서 현재 선택된 site id (미선택 시 null)
  siteNotesWriteLocked: false,   // true면 목록 카드 클릭으로 진입(수정 전용) — 현장 선택 잠금 + 삭제 버튼 노출
  currentLocation: null,     // { lat, lng } 사용자가 버튼을 눌러 가져온 현재 위치. 자동 추적 없음.
  currentLocationMarker: null, // 현재 위치 표시 객체 (사업장 marker와 분리 관리, location.js 전용)
  locationRequestInFlight: false, // Geolocation 요청 진행 중 여부 (버튼 중복 클릭 방지)
  adminUsers: [],          // gnmap_v2_profiles 목록 (admin.js loadUsers 결과). 관리자만 채워짐.
  adminUserInFlight: new Set(), // status/role 변경 요청이 진행 중인 userId (중복 RPC 호출 방지)
  adminMessage: '',          // 회원관리 패널에 표시할 최근 메시지(성공/실패/권한 없음 등)
  adminLoadError: false,     // STEP16.5: 회원 목록 조회 자체가 실패했는지(0명인 것과 구분, 모바일 에러 상태용)
  adminMobileFilter: 'all',  // STEP16.5(모바일 회원관리): 'all' | 'pending' | 'approved' 탭 상태
  adminMobileQuery: '',      // STEP16.5(모바일 회원관리): 검색어(이름/이메일)
  uploadParsedRows: [],       // excel.js 파싱+검증 결과 (아직 DB에 반영되지 않은 상태, STEP 11/12에서 사용)
                                // 각 행은 geocoding 진행 시 _geocodeStatus('PENDING'|'SUCCESS'|'NOT_FOUND'|'ERROR')와
                                // 성공 시 lat/lng, 실패 시 _geocodeError가 추가된다 (validation 필드는 그대로 유지).
  uploadDetectedForm: null,   // 'form1' | 'form2' | null (자동 판별 결과)
  uploadValidationSummary: null, // { total, validCount, warningCount, errorCount, invalidCount, duplicateCount } 요약
  geocodeInProgress: false,   // geocoding 버튼 중복 클릭 방지
  geocodeProgress: null,       // { total, done, success, notFound, error } geocoding 진행 상태
  keywordSearchInProgress: false, // STEP 11G. keyword 후보검색 버튼 중복 클릭 방지
  keywordSearchSummary: null,     // { total, done, strong, weak, none, error } keyword 후보검색 결과 요약
  lotRecoveryInProgress: false,   // STEP 11H-1. Kakao LOT 복구 버튼 중복 클릭 방지
  lotRecoverySummary: null,       // { total, done, success, notFound, error } LOT 복구 결과 요약
  jusoNormalizeInProgress: false, // STEP 11H-3. JUSO 정규화 버튼 중복 클릭 방지
  jusoNormalizeSummary: null,     // { total, done, matched, ambiguous, noMatch, notFound, error } JUSO 검증 결과 요약
  kakaoJusoInProgress: false,     // STEP 11H-4. KAKAO_JUSO 좌표 확정 버튼 중복 클릭 방지
  kakaoJusoSummary: null,         // { total, done, success, notFound, error } KAKAO_JUSO 좌표 확정 결과 요약
  roadApproximateInProgress: false, // STEP11 운영. ROAD APPROXIMATE 버튼 중복 클릭 방지
  roadApproximateSummary: null,     // { total, done, success, notFound, error } ROAD APPROXIMATE 결과 요약
  uploadImportInProgress: false,    // STEP12-C. DB import(gnmap_v2_import_sites RPC) 버튼 중복 클릭 방지
  uploadImportResult: null,         // 마지막 RPC 응답 { success, history_id, total_rows, inserted, updated, review_count } | { success:false, message }
  uploadFileName: null,              // STEP12-C. RPC payload의 file_name에 쓸 현재 업로드 파일명
  importPreviewInProgress: false,    // STEP13. 사전 검증(신규/갱신 예정 계산) 중복 클릭 방지
  importPreview: null,               // { success, total, updateCount, insertCount } | { success:false, message }
  uploadHistoryList: [],             // STEP13. 최근 업로드 이력 목록
  uploadHistoryLoading: false,       // STEP13. 업로드 이력 조회 중 여부
  supervisions: [],                   // STEP14. gnmap_v2_supervisions 목록 (사업장 연결 없음, 캠페인 단위 상황판)
  supervisionFilter: 'all',           // STEP14. 감독일정 패널 상태 필터: 'all' | 'scheduled' | 'ongoing' | 'done' (프론트 표시만, DB/RLS 무관)
  favoriteOnly: false,                // STEP14.5-B. "즐겨찾기만 보기" 토글 — true면 getFilteredSortedSites가 favoriteSiteIds에 있는 사업장만 반환
  favoriteTabView: 'favorites',       // 사용자 요청: 모바일 "즐겨찾기" 탭 내부 탭 — 'favorites'(즐겨찾기 현장) | 'notes'(메모 있는 현장). 탭 진입 시 항상 'favorites'로 초기화.
  // 사용자 요청: 상단 필터에서 "확인필요" 토글/카운트를 제거하면서 reviewOnly도 함께 제거했다
  // (더 이상 화면 어디에서도 트리거되지 않음). location_quality 값 자체나 목록 카드의
  // "위치확인필요" 배지(site-list-review-badge)는 이 필터와 무관하게 그대로 유지된다.
  mobileActiveTab: 'map',             // STEP15-B. 모바일 하단 탭 현재 선택값: 'map'|'site'|'route'|'favorite'|'alert'|'more'. PC 화면에서는 사용하지 않음.
  uploadMobileTab: 'file',            // 모바일 "사업장 데이터 관리" 화면 내부 탭: 'file'(파일 업로드) | 'history'(업로드 이력). PC 화면에서는 사용하지 않음.
  // STEP16.5(모바일 감독일정관리): 아래 필드는 전부 화면 표시/탐색 상태일 뿐이며, DB/RLS와 무관하다.
  supervisionMobileView: 'list',       // 'list' | 'form' | 'detail'. PC 화면에서는 사용하지 않음.
  supervisionMobileFormOrigin: 'list', // form 화면의 '뒤로가기' 대상: 'list'(신규 등록) | 'detail'(상세에서 수정 진입)
  supervisionMobileMonthCursor: null,  // { year, month(0-11) } 표시 중인 달. null이면 렌더 시 오늘 기준으로 초기화.
  supervisionMobileSelectedDate: null, // 'YYYY-MM-DD'. null이면 렌더 시 오늘 날짜로 초기화.
  // 사용자 요청(추가 반영): 상단 quick filter는 "진행/예정/완료/전체"(status)로, 감독유형(점검/감독)은
  // 별도의 "필터(감독유형)"로 분리했다 — 두 축은 서로 독립적으로 AND 결합되어 목록/캘린더에 적용된다.
  supervisionMobileStatusFilter: 'all', // 'all' | 'scheduled' | 'ongoing' | 'done' (목록 상단 quick filter, 프론트 표시만)
  supervisionMobileTypeFilter: 'all',   // 'all' | 'inspection' | 'supervision' (감독유형 필터, 프론트 표시만)
  supervisionMobileSelectedId: null,    // 상세/수정 화면 대상 gnmap_v2_supervisions.id

  // STEP16.13(모바일 "경로" 탭 — 경로 만들기/방문 순서/경로 상세). 새 DB 테이블 없이 이 세션/
  // 클라이언트 state만으로 유지한다(§29). site id 배열이라 gnmap_v2_sites 삭제(is_active=false
  // 전환 등)로 목록에서 사라져도 렌더 시점에 state.sites와 대조해 걸러내면 되므로 별도 정리 로직이
  // 필요 없다. 탭을 벗어나도(더보기 등 다른 탭 이동) 값을 지우지 않아 "페이지 이동 때마다 선택
  // 현장이 사라지면 안 된다"는 요구를 만족한다.
  routePlanSiteIds: [],        // 방문할 현장으로 선택한 gnmap_v2_sites.id 배열. 순서 = 선택/드래그 순서.
  routeMobileView: 'plan',     // '경로' 탭 내부 화면: 'plan'(경로 만들기, #mobile-route-content) |
                                // 'order'(방문 순서, #route-order-panel) | 'detail'(경로 상세, #route-detail-panel)
  currentLocationAddress: null, // 역지오코딩으로 얻은 현재 위치 주소 문자열. 아직 조회 안 했거나 실패하면 null(가짜 주소 금지).
  routeStartMode: null          // STEP16.14: 경로 출발지(state.currentLocation)의 출처. 'gps'(현재 위치 버튼) |
                                 // 'manual'(주소 검색으로 선택) | null(아직 출발지를 정하지 않음). 표시 라벨 분기에만 쓴다.
};
