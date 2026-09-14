// location.js — STEP 8. 브라우저 Geolocation API로 현재 위치를 가져와 지도에 표시.
// watchPosition/실시간 추적은 사용하지 않는다 (버튼 클릭 시 1회 요청만).
// 현재 위치 marker는 사업장 marker(state.markers/state.siteMarkers, map.js clearMarkers 대상)와
// 완전히 분리된 state.currentLocationMarker로 별도 관리한다.
import { state } from './state.js';

const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 30000
};

// 오류 종류별로 구분 가능한 메시지를 반환한다 (alert 미사용, 호출부가 UI에 표시).
function toErrorMessage(err) {
  if (!err) return '위치 확인에 실패했습니다.';
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return '위치 권한이 거부되었습니다.';
    case err.TIMEOUT:
      return '위치 확인 시간이 초과되었습니다.';
    case err.POSITION_UNAVAILABLE:
      return '위치 기능을 사용할 수 없습니다.';
    default:
      return '위치 확인 중 오류가 발생했습니다.';
  }
}

function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

// 현재 위치 marker를 표시하거나, 이미 있으면 위치만 갱신한다 (중복 marker 생성 방지).
// 사업장 marker(기본 Marker 아이콘)와 시각적으로 구분되도록 Circle(원)로 표시한다 —
// 이미지 asset/CustomOverlay 없이 Kakao Maps 기본 도형 객체만 사용.
function placeCurrentLocationMarker(lat, lng) {
  const position = new kakao.maps.LatLng(lat, lng);

  if (state.currentLocationMarker) {
    state.currentLocationMarker.setPosition(position);
    return;
  }

  state.currentLocationMarker = new kakao.maps.Circle({
    center: position,
    radius: 15, // 미터 단위, 사업장 marker와 구분되는 작은 원
    strokeWeight: 2,
    strokeColor: '#1a73e8',
    strokeOpacity: 0.9,
    fillColor: '#1a73e8',
    fillOpacity: 0.5,
    map: state.map,
    zIndex: 10
  });
}

// 지도가 폐기되기 전(로그아웃 등)에 호출해 현재 위치 표시 객체를 정리한다.
export function clearCurrentLocationMarker() {
  if (state.currentLocationMarker) {
    state.currentLocationMarker.setMap(null);
    state.currentLocationMarker = null;
  }
}

// 버튼 클릭 시에만 호출된다. 성공 시 { ok: true }, 실패 시 { ok: false, message } 반환.
export function requestCurrentLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ok: false, message: '위치 기능을 사용할 수 없습니다.' });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Number(position.coords.latitude);
        const lng = Number(position.coords.longitude);

        if (!isValidCoord(lat, lng)) {
          resolve({ ok: false, message: '위치 확인 중 오류가 발생했습니다.' });
          return;
        }

        state.currentLocation = { lat, lng };

        if (state.map) {
          placeCurrentLocationMarker(lat, lng);
          state.map.panTo(new kakao.maps.LatLng(lat, lng));
        }

        resolve({ ok: true });
      },
      (err) => {
        resolve({ ok: false, message: toErrorMessage(err) });
      },
      GEOLOCATION_OPTIONS
    );
  });
}
