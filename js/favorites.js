// favorites.js — STEP 7A. gnmap_v2_favorites 조회/추가/삭제.
// RLS가 본인 것만 select/insert/delete 가능하도록 이미 강제하지만,
// 여기서도 user_id를 항상 state.user.id(현재 로그인 사용자)로만 고정해서
// 다른 user_id를 조작할 수 있는 여지를 코드 레벨에서도 만들지 않는다.
import { sb } from './api.js';
import { state } from './state.js';

// 현재 로그인 사용자의 즐겨찾기만 조회해 state.favoriteSiteIds에 채운다.
// 실패 시 예외를 던지지 않고 빈 Set으로 남겨 앱이 죽지 않도록 한다.
export async function loadFavorites() {
  if (!state.user) {
    state.favoriteSiteIds = new Set();
    return;
  }

  const { data, error } = await sb
    .from('gnmap_v2_favorites')
    .select('id, site_id')
    .eq('user_id', state.user.id);

  if (error) {
    console.error('즐겨찾기 조회 실패:', error);
    state.favoriteSiteIds = new Set();
    return;
  }

  state.favoriteSiteIds = new Set((data || []).map(row => row.site_id));
}

export function isFavorite(siteId) {
  return state.favoriteSiteIds.has(siteId);
}

// DB 성공 후에만 state.favoriteSiteIds를 갱신한다 (실패 시 기존 상태 유지).
export async function addFavorite(siteId) {
  if (!state.user) return false;

  const { error } = await sb
    .from('gnmap_v2_favorites')
    .insert({ user_id: state.user.id, site_id: siteId });

  if (error) {
    // UNIQUE(user_id, site_id) 충돌(이미 즐겨찾기됨) 등 실패해도 앱이 깨지지 않도록 처리하고
    // 실제로 이미 즐겨찾기 상태라면 state를 그에 맞게 보정한다.
    console.error('즐겨찾기 추가 실패:', error);
    if (error.code === '23505') {
      state.favoriteSiteIds.add(siteId);
      return true;
    }
    return false;
  }

  state.favoriteSiteIds.add(siteId);
  return true;
}

// user_id + site_id 조건으로만 삭제한다 (본인 것만, 다른 user_id 삭제 불가).
export async function removeFavorite(siteId) {
  if (!state.user) return false;

  const { error } = await sb
    .from('gnmap_v2_favorites')
    .delete()
    .eq('user_id', state.user.id)
    .eq('site_id', siteId);

  if (error) {
    console.error('즐겨찾기 삭제 실패:', error);
    return false;
  }

  state.favoriteSiteIds.delete(siteId);
  return true;
}

// rapid click으로 같은 site에 대한 토글 요청이 중복 실행되지 않도록 favoriteInFlight로 방어한다.
export async function toggleFavorite(siteId) {
  if (state.favoriteInFlight.has(siteId)) return false;
  state.favoriteInFlight.add(siteId);

  try {
    if (isFavorite(siteId)) {
      return await removeFavorite(siteId);
    }
    return await addFavorite(siteId);
  } finally {
    state.favoriteInFlight.delete(siteId);
  }
}
