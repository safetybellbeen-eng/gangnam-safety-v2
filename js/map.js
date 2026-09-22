// map.js — STEP 4. Kakao Maps JS SDK 로드 및 기본 지도 초기화.
// REST API/geocoding/marker/GeoJSON 경계는 이번 STEP 범위가 아니다 (CLAUDE.md 준수).
import { CONFIG } from './config.js';
import { state } from './state.js';

const GANGNAM_CENTER = { lat: 37.4979, lng: 127.0276 }; // 강남구 중심 좌표
const DEFAULT_LEVEL = 6;

let sdkLoadPromise = null;
let clusterer = null; // STEP14.5-B 2차. 마커 클러스터러 인스턴스(지도당 1개, 재사용).

// STEP15-E.1-2: location_quality별 마커 색상. 상세 패널(#site-detail-panel)의
// site-detail-quality-* 배지(js/ui.js)와 완전히 같은 색을 재사용해 "핀 색"과 "상세 배지 색"이
// 어긋나지 않게 한다. MANUAL(관리자 직접 확인)은 EXACT와 동일하게 "정확"(초록)으로 취급한다.
// UNRESOLVED는 매핑이 없고, 어차피 lat/lng가 없어 renderMarkers()의 좌표 유효성 검사에서
// 애초에 마커 자체가 생성되지 않는다(기존 원칙 그대로 유지).
const QUALITY_MARKER_COLOR = {
  EXACT: '#2e7d32',
  MANUAL: '#2e7d32',
  ESTIMATED: '#b7791f',
  APPROXIMATE: '#c0392b'
};

// 색상별 kakao.maps.MarkerImage를 1번만 만들어 재사용한다(같은 색을 매 렌더마다 다시 만들지 않음).
const markerImageCache = new Map();

// STEP15-E.1-2 후속(핀 슬림화): 기존 30×40의 굵은 물방울형 대신 22×30의 더 얇고 길쭉한
// 📍형 핀으로 변경. 머리(원) 지름을 캔버스 폭(22)보다 좁은 16으로 그려 양옆에 여백을 두는
// 방식으로 "얇음"을 만들고, 아래쪽 뾰족한 끝과 중앙 흰 원은 기존과 동일하게 유지한다.
// 그라데이션/그림자/테두리 등 장식은 추가하지 않는다. data URI(SVG)로 만들어 별도 이미지
// 파일을 관리하지 않고, 색상만 바뀐 버전을 즉시 만들 수 있게 한다.
function getQualityMarkerImage(locationQuality) {
  const color = QUALITY_MARKER_COLOR[locationQuality];
  if (!color) return null; // 매핑 없는 값(UNRESOLVED 등)은 커스텀 이미지를 만들지 않고 호출부에서 기본 마커로 폴백한다.

  if (markerImageCache.has(color)) return markerImageCache.get(color);

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30">' +
    '<path d="M11 1C6.03 1 2 4.64 2 9.1c0 6.3 9 20.4 9 20.4s9-14.1 9-20.4C20 4.64 15.97 1 11 1z" fill="' + color + '"/>' +
    '<circle cx="11" cy="9.1" r="3.1" fill="#fff"/>' +
    '</svg>';
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  const image = new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(22, 30),
    { offset: new kakao.maps.Point(11, 30) } // 핀 뾰족한 끝(바닥 중앙, 새 크기 기준)이 실제 좌표를 가리키도록 anchor 재조정.
  );
  markerImageCache.set(color, image);
  return image;
}

// 사용자 요청: 현재 선택되어 상세정보가 열려 있는 핀을 다른 핀과 구분되게 표시한다.
// 처음엔 location_quality 색(정확/중간/확인필요)을 유지하고 파란 테두리만 둘렀는데,
// "테두리 말고 핀 색 자체가 파란색이 되어야 시인성이 높다"는 피드백에 따라 location_quality와
// 무관하게 핀 전체(fill)를 정부 blue(--gnmap-blue와 동일한 #1a73e8)로 바꾼다 — 색상 하나만
// 쓰므로 더 이상 quality별로 캐시할 필요가 없다. 닫으면(closeDetail) getQualityMarkerImage()로
// 원래 크기/quality색으로 되돌린다.
let selectedMarkerImage = null;
function getSelectedMarkerImage() {
  if (selectedMarkerImage) return selectedMarkerImage;

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38">' +
    '<path d="M14 2.5C8.2 2.5 3.5 6.9 3.5 12.3c0 7.9 10.5 23.7 10.5 23.7s10.5-15.8 10.5-23.7C24.5 6.9 19.8 2.5 14 2.5z" fill="#1a73e8" stroke="#0d47a1" stroke-width="1.5"/>' +
    '<circle cx="14" cy="12.3" r="4.2" fill="#fff"/>' +
    '</svg>';
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  selectedMarkerImage = new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(28, 38),
    { offset: new kakao.maps.Point(14, 38) } // 뾰족한 끝이 좌표를 가리키도록(기본 핀과 동일한 원칙, 커진 크기에 맞춰 재계산).
  );
  return selectedMarkerImage;
}

// state.selectedSiteId에 해당하는 마커를 "선택됨" 이미지로 바꾼다. 마커가 아직 없거나
// (좌표 없음 등) 찾을 수 없으면 조용히 무시한다. renderMarkers()가 목록을 다시 그릴 때마다
// (검색/필터 변경 등) 호출해, 마커가 새로 만들어져도 선택 강조가 유지되게 한다.
export function highlightSelectedMarker() {
  const siteId = state.selectedSiteId;
  if (siteId === null || siteId === undefined) return;
  const marker = state.siteMarkers.get(siteId);
  if (!marker || typeof marker.setImage !== 'function') return;
  marker.setImage(getSelectedMarkerImage());
}

// 특정 사업장의 마커를 원래(기본) 이미지로 되돌린다. 상세를 닫거나 다른 핀을 선택했을 때
// 이전 선택 마커의 강조를 해제하는 데 쓴다.
export function clearMarkerHighlight(siteId) {
  if (siteId === null || siteId === undefined) return;
  const marker = state.siteMarkers.get(siteId);
  if (!marker || typeof marker.setImage !== 'function') return;
  const site = state.sites.find(s => s.id === siteId);
  const image = getQualityMarkerImage(site ? site.location_quality : null);
  if (image) marker.setImage(image);
}

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

    // STEP15-E.1-2: location_quality에 매핑된 색이 있으면 커스텀 핀 이미지를 쓰고,
    // 없으면(이론상 도달하지 않음) 기존 기본 파란 마커로 안전하게 폴백한다.
    const markerOptions = { position: new kakao.maps.LatLng(lat, lng) };
    const qualityImage = getQualityMarkerImage(site.location_quality);
    if (qualityImage) markerOptions.image = qualityImage;

    const marker = new kakao.maps.Marker(markerOptions);

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

  // 검색/필터가 바뀌어 마커가 전부 새로 만들어져도(위 clearMarkers()+새 Marker), 현재
  // 선택된 사업장(state.selectedSiteId)이 새 목록에도 있으면 선택 강조를 다시 입힌다.
  highlightSelectedMarker();
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

// 사용자 피드백: 지도 탭에서 상세 시트가 하단 일부를 가릴 때, 핀이 "실제로 보이는" 지도
// 영역(하단 hiddenBottomPx만큼 가려진 나머지 부분) 한가운데에 오도록 지도 중심을 맞춘다.
// panBy()의 좌/우 부호 규약에 기대지 않기 위해, 지도의 투영좌표(카카오맵 MapProjection —
// 값이 커질수록 남쪽/아래)를 직접 계산한다: 목표 좌표를 그대로 중심으로 두면(panToSite와
// 동일) 화면 정중앙(가려진 영역까지 포함한 전체 컨테이너 중앙)에 오므로, 중심을 목표 좌표보다
// hiddenBottomPx/2 만큼 "남쪽(투영좌표 y 증가 방향)"으로 옮기면 목표 좌표는 상대적으로
// 그만큼 "북쪽(화면 위)"에 렌더링되어 정확히 보이는 영역의 세로 중앙에 위치하게 된다.
// getProjection/panBy를 지원하지 않는 환경(테스트 스텁 등)에서는 기존 panToSite로 대체한다.
export function centerSiteInVisibleArea(site, hiddenBottomPx) {
  if (!state.map || !site) return;
  const lat = Number(site.lat);
  const lng = Number(site.lng);
  const isValid =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180;
  if (!isValid) return;

  const target = new kakao.maps.LatLng(lat, lng);
  const offsetPx = Number(hiddenBottomPx) / 2;

  if (!Number.isFinite(offsetPx) || offsetPx <= 0 || typeof state.map.getProjection !== 'function') {
    state.map.panTo(target);
    return;
  }

  try {
    const proj = state.map.getProjection();
    const point = proj.pointFromCoords(target);
    const shifted = new kakao.maps.Point(point.x, point.y + offsetPx);
    const newCenter = proj.coordsFromPoint(shifted);
    state.map.panTo(newCenter);
  } catch (err) {
    console.error('보이는 영역 중앙 정렬 실패, 기본 중앙 이동으로 대체:', err);
    state.map.panTo(target);
  }
}
