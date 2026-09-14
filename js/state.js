// state.js — STEP 4. 공용 애플리케이션 상태.
export const state = {
  user: null,     // auth.users 세션 사용자
  profile: null,  // gnmap_v2_profiles 행 (role/status 포함)
  map: null       // kakao.maps.Map 인스턴스 (중복 초기화 방지용, approved일 때만 생성)
};
