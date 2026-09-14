// state.js — STEP 6A. 공용 애플리케이션 상태.
export const state = {
  user: null,          // auth.users 세션 사용자
  profile: null,        // gnmap_v2_profiles 행 (role/status 포함)
  map: null,             // kakao.maps.Map 인스턴스 (중복 초기화 방지용, approved일 때만 생성)
  markers: [],           // kakao.maps.Marker 인스턴스 배열 (재조회 시 정리 후 재생성)
  sites: [],              // 원본 사업장 목록 (STEP 5A loadActiveSites 결과). 검색/정렬로 이 배열을 직접 변경하지 않는다.
  selectedSiteId: null,   // 현재 선택된 사업장 id (목록/마커 클릭으로 갱신)
  siteMarkers: new Map(), // siteId -> kakao.maps.Marker (마커 재검색 없이 클릭 시 즉시 매칭)
  searchQuery: '',        // 검색어 (site_name/company_name/address/dong 대상)
  sortMode: 'default'     // 'default' | 'name-asc' | 'company-asc' | 'amount-desc' | 'amount-asc'
};
