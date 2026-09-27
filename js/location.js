// location.js — STEP 8. 브라우저 Geolocation API로 현재 위치를 가져와 지도에 표시.
// watchPosition/실시간 추적은 사용하지 않는다 (버튼 클릭 시 1회 요청만).
// 현재 위치 marker는 사업장 marker(state.markers/state.siteMarkers, map.js clearMarkers 대상)와
// 완전히 분리된 state.currentLocationMarker로 별도 관리한다.
//
// STEP16.19: 기존 파란 반투명 원(Circle)만으로는 사업장 핀/기타 파란 UI와 뒤섞여 가시성이
// 떨어진다는 지적에 따라, 흰 테두리가 있는 또렷한 점 + 방향(나침반) 표시를 CustomOverlay로
// 추가한다. 기존 Circle은 "대략적 위치 반경" 느낌만 남기고 옅게(반투명) 유지한다.
// 방향은 DeviceOrientationEvent(나침반)에서만 얻는다 — 기존 Geolocation은 1회성 호출이라
// position.coords.heading이 항상 null이기 때문. 이 API는 브라우저/기기별 지원이 제각각이고
// iOS는 버튼 클릭 등 사용자 제스처 안에서 명시적 권한 요청이 필요하다 — 지원하지 않거나
// 권한이 거부되면 방향 원뿔 없이 점만 표시한다(기존 기능은 그대로 동작, 방향은 "있으면 보너스").
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

// STEP16.19: 방향 원뿔(위 파일 상단 설명 참고) DOM 참조와 나침반 각도. 모듈 내부 전용 상태라
// state.js에 넣지 않는다(다른 화면이 참조할 이유가 없는 순수 렌더 디테일).
let currentLocationOverlay = null;
let headingConeEl = null;
let currentHeadingDeg = null;
let headingHandlerBound = null; // 'absolute' | 'relative' | null — 등록된 이벤트 이름 추적용.

function normalizeHeading(deg) {
  return ((deg % 360) + 360) % 360;
}

// 점(고정 크기) + 방향 원뿔을 담은 CustomOverlay 콘텐츠를 만든다. 원뿔은 방향 정보가 없으면
// opacity:0으로 숨겨 "점만" 있는 기존 느낌을 유지한다.
function buildLocationOverlayContent() {
  const wrap = document.createElement('div');
  wrap.className = 'gnmap-current-location-marker';
  wrap.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
    '<path class="gnmap-current-location-cone" d="M20 20 L11 3 A20 20 0 0 1 29 3 Z" style="opacity:0;"/>' +
    '<circle class="gnmap-current-location-dot" cx="20" cy="20" r="7"/>' +
    '</svg>';
  headingConeEl = wrap.querySelector('.gnmap-current-location-cone');
  return wrap;
}

function updateLocationOverlayHeading() {
  if (!headingConeEl) return;
  if (currentHeadingDeg === null) {
    headingConeEl.style.opacity = '0';
    return;
  }
  headingConeEl.style.opacity = '1';
  headingConeEl.style.transform = `rotate(${currentHeadingDeg}deg)`;
}

function handleOrientationEvent(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
    // iOS Safari: 이미 실제 나침반 방위각(진북 기준 시계방향)이라 그대로 쓴다.
    heading = event.webkitCompassHeading;
  } else if (event.absolute === true && typeof event.alpha === 'number') {
    // 표준(주로 Android): alpha는 반시계 방향 기준이라 시계방향 방위각으로 변환한다.
    heading = 360 - event.alpha;
  } else {
    return; // 절대 방위가 아닌 값(기준점이 기기마다 달라 신뢰 불가)은 무시하고 이전 상태를 유지한다.
  }
  currentHeadingDeg = normalizeHeading(heading);
  updateLocationOverlayHeading();
}

// 나침반(방향) 감지를 시작한다. 반드시 버튼 클릭 등 사용자 제스처 호출 스택 안에서 불러야
// iOS의 권한 팝업이 뜬다. 미지원 브라우저/거부된 경우 조용히 포기한다(점만 표시).
function startHeadingWatch() {
  if (headingHandlerBound || typeof window === 'undefined' || !window.DeviceOrientationEvent) return;

  const bind = () => {
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(eventName, handleOrientationEvent);
    headingHandlerBound = eventName;
  };

  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ Safari: 명시적 권한 필요.
    DeviceOrientationEvent.requestPermission()
      .then((result) => { if (result === 'granted') bind(); })
      .catch(() => { /* 거부/미지원 — 방향 없이 점만 표시(기존 동작 유지) */ });
  } else {
    bind();
  }
}

function stopHeadingWatch() {
  if (!headingHandlerBound) return;
  window.removeEventListener(headingHandlerBound, handleOrientationEvent);
  headingHandlerBound = null;
  currentHeadingDeg = null;
}

// 현재 위치 marker를 표시하거나, 이미 있으면 위치만 갱신한다 (중복 marker 생성 방지).
// STEP16.19: 기존 Circle(대략적 위치 반경, 옅게 유지)에 더해 흰 테두리 점 + 방향 원뿔을
// CustomOverlay로 얹는다 — 화면 픽셀 기준 고정 크기라 확대/축소해도 점 크기가 일정하다.
function placeCurrentLocationMarker(lat, lng) {
  const position = new kakao.maps.LatLng(lat, lng);

  if (state.currentLocationMarker) {
    state.currentLocationMarker.setPosition(position);
  } else {
    state.currentLocationMarker = new kakao.maps.Circle({
      center: position,
      radius: 15, // 미터 단위, "대략적 위치 반경" 느낌만 주는 옅은 배경
      strokeWeight: 1,
      strokeColor: '#1a73e8',
      strokeOpacity: 0.35,
      fillColor: '#1a73e8',
      fillOpacity: 0.12,
      map: state.map,
      zIndex: 9
    });
  }

  if (currentLocationOverlay) {
    currentLocationOverlay.setPosition(position);
  } else {
    currentLocationOverlay = new kakao.maps.CustomOverlay({
      position,
      content: buildLocationOverlayContent(),
      xAnchor: 0.5,
      yAnchor: 0.5,
      zIndex: 11
    });
    currentLocationOverlay.setMap(state.map);
  }
  updateLocationOverlayHeading();
}

// 지도가 폐기되기 전(로그아웃 등)에 호출해 현재 위치 표시 객체를 정리한다.
export function clearCurrentLocationMarker() {
  if (state.currentLocationMarker) {
    state.currentLocationMarker.setMap(null);
    state.currentLocationMarker = null;
  }
  if (currentLocationOverlay) {
    currentLocationOverlay.setMap(null);
    currentLocationOverlay = null;
  }
  headingConeEl = null;
  stopHeadingWatch();
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
          // STEP16.19: "현재 위치" 버튼 클릭(=사용자 제스처) 안에서만 나침반 권한을 요청할 수
          // 있어 여기서 호출한다. 이미 감지 중이면 startHeadingWatch() 내부에서 조용히 무시된다.
          startHeadingWatch();
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
