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
  selectedDong: 'all',     // 'all' 또는 특정 dong 값 (단일 선택)
  amountFilter: 'all',     // 'all' | 'under-100m' | '100m-1b' | '1b-5b' | '5b-12b' | 'over-12b'
  favoriteSiteIds: new Set(), // 현재 로그인 사용자가 즐겨찾기한 site id 집합
  favoriteInFlight: new Set(), // 토글 요청이 진행 중인 site id (rapid click 중복 방지)
  siteNotes: new Map(),   // siteId -> gnmap_v2_site_notes 행 (id/site_id/content/updated_at). 없으면 키가 없음.
  noteInFlight: new Set(), // 저장/삭제 요청이 진행 중인 site id (동시 요청 중복 방지)
  currentLocation: null,     // { lat, lng } 사용자가 버튼을 눌러 가져온 현재 위치. 자동 추적 없음.
  currentLocationMarker: null, // 현재 위치 표시 객체 (사업장 marker와 분리 관리, location.js 전용)
  locationRequestInFlight: false, // Geolocation 요청 진행 중 여부 (버튼 중복 클릭 방지)
  adminUsers: [],          // gnmap_v2_profiles 목록 (admin.js loadUsers 결과). 관리자만 채워짐.
  adminUserInFlight: new Set(), // status/role 변경 요청이 진행 중인 userId (중복 RPC 호출 방지)
  adminMessage: '',          // 회원관리 패널에 표시할 최근 메시지(성공/실패/권한 없음 등)
  uploadParsedRows: [],       // excel.js 파싱+검증 결과 (아직 DB에 반영되지 않은 상태, STEP 11/12에서 사용)
                                // 각 행은 geocoding 진행 시 _geocodeStatus('PENDING'|'SUCCESS'|'NOT_FOUND'|'ERROR')와
                                // 성공 시 lat/lng, 실패 시 _geocodeError가 추가된다 (validation 필드는 그대로 유지).
  uploadDetectedForm: null,   // 'form1' | 'form2' | null (자동 판별 결과)
  uploadValidationSummary: null, // { total, validCount, warningCount, errorCount, invalidCount, duplicateCount } 요약
  geocodeInProgress: false,   // geocoding 버튼 중복 클릭 방지
  geocodeProgress: null,       // { total, done, success, notFound, error } geocoding 진행 상태
  keywordSearchInProgress: false, // STEP 11G. keyword 후보검색 버튼 중복 클릭 방지
  keywordSearchSummary: null      // { total, done, strong, weak, none, error } keyword 후보검색 결과 요약
};
