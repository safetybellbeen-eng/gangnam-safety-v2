// map.js — STEP 4. Kakao Maps JS SDK 로드 및 기본 지도 초기화.
// REST API/geocoding/marker/GeoJSON 경계는 이번 STEP 범위가 아니다 (CLAUDE.md 준수).
import { CONFIG } from './config.js';
import { state } from './state.js';

const GANGNAM_CENTER = { lat: 37.4979, lng: 127.0276 }; // 강남구 중심 좌표
const DEFAULT_LEVEL = 6;

let sdkLoadPromise = null;
let clusterer = null; // STEP14.5-B 2차. 마커 클러스터러 인스턴스(지도당 1개, 재사용).

// SDK <script> 태그를 딱 1번만 생성한다 (중복 로드 방지).
// autoload=false로 로드한 뒤 kakao.maps.load()로 초기화 시점을 직접 제어한다 —
// GitHub Pages 등 정적 호스팅에서 SDK 로드 타이밍이 페이지 렌더링과 어긋나는 문제를 방지.
// STEP14.5-B 2차: 마커 클러스터링을 위해 clusterer 라이브러리만 추가 로드한다.
function loadKakaoSdk() {
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps) {
      resolve(window.kakao);
      return;
    }
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${CONFIG.KAKAO_JS_KEY}&libraries=clusterer&autoload=false`;
    script.onload = () => {
      window.kakao.maps.load(() => resolve(window.kakao));
    };
    script.onerror = () => reject(new Error('Kakao Maps SDK 로드 실패'));
    document.head.appendChild(script);
  });

  return sdkLoadPromise;
}

// approved 사용자에게만 호출되어야 한다 (app.js에서 상태 분기 후 호출).
// state.map이 이미 있으면 재생성하지 않는다 (중복 초기화 방지).
export async function initMap(containerId) {
  if (state.map) return state.map;

  await loadKakaoSdk();

  const container = document.getElementById(containerId);
  if (!container) throw new Error(`지도 컨테이너를 찾을 수 없습니다: ${containerId}`);

  state.map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(GANGNAM_CENTER.lat, GANGNAM_CENTER.lng),
    level: DEFAULT_LEVEL
  });

  // STEP14.5-B 2차: 지도 인스턴스당 클러스터러 1개만 생성해 재사용한다(마커 재렌더 때마다 재생성하지 않음).
  clusterer = new kakao.maps.MarkerClusterer({
    map: state.map,
    averageCenter: true,
    minLevel: DEFAULT_LEVEL
  });

  return state.map;
}

// 사업장 배열로 마커를 그린다. 기존 마커는 전부 정리한 뒤 새로 생성한다 (중복 방지, 재호출 가능).
// 각 마커 생성 시 클릭 리스너를 1회만 등록한다 — clearMarkers가 기존 마커를 먼저 지우므로
// 재호출해도 리스너가 누적되지 않는다. onMarkerClick은 ui.js의 selectSite를 주입받는다.
// STEP14.5-B 2차: 마커를 지도에 직접 붙이지 않고 클러스터러에 addMarkers로 붙인다.
// 클릭 리스너/state.markers/state.siteMarkers 등 기존 동작은 그대로 유지한다.
export function renderMarkers(sites, onMarkerClick) {
  clearMarkers();

  if (!state.map || !sites || sites.length === 0) return;

  const validMarkers = [];

  sites.forEach(site => {
    const lat = Number(site.lat);
    const lng = Number(site.lng);
    const isValid =
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 &&
      lng >= -180 && lng <= 180;

    if (!isValid) return; // 유효하지 않은 좌표는 마커를 생성하지 않고 skip

    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(lat, lng)
    });

    if (typeof onMarkerClick === 'function') {
      kakao.maps.event.addListener(marker, 'click', () => onMarkerClick(site.id));
    }

    state.markers.push(marker);
    state.siteMarkers.set(site.id, marker);
    validMarkers.push(marker);
  });

  if (clusterer) {
    clusterer.addMarkers(validMarkers);
  } else {
    // clusterer가 아직 없는 예외 상황(이론상 initMap 이후에는 항상 존재) 대비 폴백.
    validMarkers.forEach(marker => marker.setMap(state.map));
  }
}

export function clearMarkers() {
  if (clusterer) {
    clusterer.clear();
  }
  state.markers.forEach(marker => marker.setMap(null));
  state.markers = [];
  state.siteMarkers.clear();
}

// 선택된 사업장 좌표로 지도를 이동한다. 좌표가 유효하지 않으면 조용히 무시한다(앱이 죽지 않아야 함).
export function panToSite(site) {
  if (!state.map || !site) return;
  const lat = Number(site.lat);
  const lng = Number(site.lng);
  const isValid =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180;
  if (!isValid) return;
  state.map.panTo(new kakao.maps.LatLng(lat, lng));
}
