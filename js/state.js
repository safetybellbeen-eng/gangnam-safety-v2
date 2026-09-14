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
  currentLocationMarker: null, // kakao.maps.Marker 현재 위치 표시 (사업장 marker와 분리 관리, location.js 전용)
  locationRequestInFlight: false // Geolocation 요청 진행 중 여부 (버튼 중복 클릭 방지)
};
