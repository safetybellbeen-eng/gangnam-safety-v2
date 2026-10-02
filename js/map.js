// map.js — STEP 4. Kakao Maps JS SDK 로드 및 기본 지도 초기화.
// REST API/geocoding/marker/GeoJSON 경계는 이번 STEP 범위가 아니다 (CLAUDE.md 준수).
import { CONFIG } from './config.js';
import { state } from './state.js';
import { isFavorite } from './favorites.js';

const GANGNAM_CENTER = { lat: 37.4979, lng: 127.0276 }; // 강남구 중심 좌표
const DEFAULT_LEVEL = 6;

let sdkLoadPromise = null;
let clusterer = null; // STEP14.5-B 2차. 마커 클러스터러 인스턴스(지도당 1개, 재사용).

// ============================================================
// STEP16.20: 강남구 경계선(1차) + 법정동 경계선(2차, 압구정/신사/청담/논현/삼성/역삼/대치/개포/
// 일원/수서/자곡/세곡/율현/도곡 14개) 표시, 사업장의 소속 동 판정(좌표 기준), 줌 레벨에 따른
// 핀/동 라벨 전환(밀집도 완화).
//
// 데이터 출처: southkorea/seoul-maps(Apache-2.0, https://github.com/southkorea/seoul-maps)의
// JUSO 2015 자료에서 강남구(SIG_CD/EMD_CD 접두 11680)만 추려 assets/data/에 저장했다
// (assets/data/gangnam-boundary.geojson=구 1개, gangnam-dong-boundary.geojson=동 14개).
// 법정동 단위이며 행정동(역삼1동/역삼2동 등) 세분화는 하지 않는다(사용자 확인).
//
// gnmap_v2_sites.dong 컬럼은 현재 전부 NULL이라(Excel import가 아직 이 값을 채우지 않음),
// DB 값을 신뢰하지 못하고 좌표(lat/lng)로 직접 판정한다. DB에 실제 값이 채워지는 날을 대비해
// 이미 값이 있는 사업장은 덮어쓰지 않는다(assignDongToSites 참고). 이 판정은 화면 표시/필터
// 용도로만 쓰고, DB에는 절대 다시 쓰지 않는다(사업장 데이터 수정 금지 원칙 유지).
let boundariesPromise = null;
let guPolygons = [];
let dongPolygonsData = []; // [{ name, polygon }]
let dongLabelOverlays = new Map(); // name -> CustomOverlay
let dongLabelContentByName = new Map(); // name -> label div (setContent로 통째로 갈아끼우면 클릭 리스너가 날아가 setContent 대신 textContent만 갱신)
let dongBoundsByName = new Map(); // name -> kakao.maps.LatLngBounds (라벨 클릭 시 그 동으로 확대하는 용도)
let zoomListenerBound = false;
const PIN_ZOOM_THRESHOLD = DEFAULT_LEVEL; // 이 레벨(기본 시작 배율) 이상으로 축소되면 핀 대신 동 이름+개수만 보여준다.

// 사용자 요청: 강남구 14개 법정동 중 어디에도 속하지 않는(=경계 밖 좌표) 사업장도 그냥
// 숨기지 않고 "그외"로 분류해 목록/관할 필터에서 확인할 수 있게 한다. js/sites.js의
// getDongOptions()/matchesDongs()는 이 문자열을 다른 동 이름과 똑같이(단순 문자열 비교) 다루므로
// 별도 처리 없이 그대로 필터링된다 — 값만 이 상수와 동일하게 맞추면 된다.
const OTHER_DONG_LABEL = '그외';

// 실제 카카오맵 SDK의 kakao.maps.MarkerClusterer에는 setMap() 메서드가 없다(공식 문서 기준
// addMarker(s)/removeMarker(s)/clear()/redraw() 등만 제공). 이전 버전에서 clusterer.setMap(null)로
// 핀을 숨기려 한 것은 실제 SDK에서 조용히 실패해(TypeError) "축소해도 핀이 안 사라진다"는 버그의
// 원인이었다 — clear()로 완전히 비우고 addMarkers()로 다시 채우는 방식으로 대체한다.
let lastValidMarkers = [];
let clustererShown = true;

// 단일 ring(닫힌 좌표 목록, [lng,lat][])에 대한 ray-casting 판정.
function rayCastRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi + Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// rings[0]=외곽선, rings[1..]=구멍(있으면 그 안은 제외). 강남구 동 경계에는 실질적으로
// 구멍이 없지만 GeoJSON 스펙을 안전하게 그대로 따른다.
function pointInPolygonRings(lng, lat, rings) {
  if (!rings || rings.length === 0 || !rayCastRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (rayCastRing(lng, lat, rings[i])) return false;
  }
  return true;
}

function pointInGeometry(lng, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygonRings(lng, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(rings => pointInPolygonRings(lng, lat, rings));
  return false;
}

function ringCentroid(ring) {
  let sx = 0, sy = 0;
  ring.forEach(([x, y]) => { sx += x; sy += y; });
  return { lng: sx / ring.length, lat: sy / ring.length };
}

// 라벨을 붙일 대표 좌표. 정확한 폴리곤 중심(무게중심)까지는 필요 없어 외곽선 꼭짓점의
// 단순 평균으로 근사한다(라벨 위치 용도로 충분). MultiPolygon이면 꼭짓점이 가장 많은
// (대체로 가장 넓은) 조각을 대표로 쓴다.
function geometryCentroid(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return ringCentroid(geometry.coordinates[0]);
  if (geometry.type === 'MultiPolygon') {
    let best = geometry.coordinates[0][0];
    geometry.coordinates.forEach(rings => { if (rings[0].length > best.length) best = rings[0]; });
    return ringCentroid(best);
  }
  return null;
}

function ringToPath(ring) {
  return ring.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
}

// kakao.maps.Polygon 1개는 구멍을 표현할 수 있지만(각 ring을 그대로 넘기면 됨), 여기서는
// 시각적으로 구멍을 낼 이유가 없어 각 폴리곤의 외곽선만 그린다.
function geometryToPaths(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [ringToPath(geometry.coordinates[0])];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(rings => ringToPath(rings[0]));
  return [];
}

function loadBoundaries() {
  if (boundariesPromise) return boundariesPromise;
  boundariesPromise = Promise.all([
    fetch('assets/data/gangnam-boundary.geojson').then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch('assets/data/gangnam-dong-boundary.geojson').then(r => (r.ok ? r.json() : null)).catch(() => null)
  ]).then(([gu, dong]) => ({ gu, dong }));
  return boundariesPromise;
}

// gnmap_v2_sites.dong이 비어 있는 사업장을, 좌표 기준으로 강남구 14개 법정동 중 하나에
// 배정한다(화면 표시/필터 전용 파생값 — DB에는 쓰지 않는다). 이미 dong 값이 있으면 그대로 둔다.
export async function assignDongToSites(sites) {
  if (!Array.isArray(sites) || sites.length === 0) return sites;
  const { dong } = await loadBoundaries();
  if (!dong || !Array.isArray(dong.features)) return sites;

  sites.forEach(site => {
    if (site.dong !== null && site.dong !== undefined && site.dong !== '') return;
    const lat = Number(site.lat);
    const lng = Number(site.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const match = dong.features.find(f => pointInGeometry(lng, lat, f.geometry));
    // 좌표는 있지만(=유효) 14개 동 어디에도 안 들어가면(예: 잘못된 지오코딩으로 강남구 밖 좌표)
    // null로 남기지 않고 "그외"로 표시한다 — 목록/관할 필터에서 확인 가능해야 하기 때문(사용자 요청).
    site.dong = match ? match.properties.name : OTHER_DONG_LABEL;
  });
  return sites;
}

function buildDongLabelContent(name, count) {
  const div = document.createElement('div');
  div.className = 'gnmap-dong-label';
  // 사용자 요청: 지도 탭 동 라벨에 "동이름 + 개소수"가 같이 보이던 걸 동이름만 보이게 한다.
  // count 인자/updateDongCounts()의 개소수 집계 로직 자체는 그대로 두고(다른 곳에서 다시
  // 쓸 수도 있어 계산은 유지), 화면에 표시만 안 하도록 한다.
  div.textContent = name;
  return div;
}

// renderMarkers()가 호출될 때마다(검색/필터 변경 포함) 현재 화면에 표시 중인 사업장 기준으로
// 동 라벨의 개수 표기를 갱신한다. 라벨을 지도에 붙이거나 뗄지는 이 함수가 아니라
// updateBoundaryDisplayForZoom()이 줌 레벨을 보고 결정한다.
// STEP16.21: overlay.setContent()로 div를 통째로 새로 갈아끼우면 그 div에 달아둔 클릭
// 리스너(동 이름 클릭 → 확대, focusOnDong)가 매번 사라진다. 그래서 여기서는 새 div를 만들지
// 않고, 처음 만들 때 저장해둔 기존 div(dongLabelContentByName)의 textContent만 바꾼다.
function updateDongCounts(sites) {
  if (dongLabelContentByName.size === 0) return;
  const counts = new Map();
  (sites || []).forEach(site => {
    if (!site.dong) return;
    counts.set(site.dong, (counts.get(site.dong) || 0) + 1);
  });
  // STEP16.34: 사용자 요청 — "현장/업체명" 검색모드에서 검색어를 입력했을 때는, 검색으로
  // 찾은 현장이 있는 동 이름 옆에 "N개소"를 표시해 어느 동에 결과가 있는지 바로 알 수 있게
  // 한다(줌 아웃 상태에서 핀이 숨겨져 있어도 라벨만으로 인지 가능). 검색어가 없거나
  // "주소/장소명" 모드일 때는 기존과 동일하게 동이름만 표시한다.
  const showSearchCounts = state.siteSearchMode !== 'address' && !!(state.searchQuery || '').trim();
  dongLabelContentByName.forEach((div, name) => {
    const count = counts.get(name) || 0;
    div.textContent = (showSearchCounts && count > 0) ? `${name} ${count}개소` : name;
  });
}

// 실제 kakao.maps.MarkerClusterer에는 setMap()이 없어(위 주석 참고), clear()로 클러스터러를
// 완전히 비우는 방식으로 "숨김"을, addMarkers()로 마지막 렌더 결과를 다시 채우는 방식으로
// "표시"를 구현한다. 중복 addMarkers 호출로 같은 마커가 겹쳐 쌓이지 않도록 clustererShown
// 플래그로 현재 상태를 추적해, 실제로 상태가 바뀔 때만 clear/addMarkers를 호출한다.
function setClustererShown(shown) {
  if (!clusterer || shown === clustererShown) return;
  if (shown) {
    clusterer.addMarkers(lastValidMarkers);
  } else {
    clusterer.clear();
  }
  clustererShown = shown;
}

// 사용자 피드백: 관할 현장이 많아 지도를 기본 배율로 보면 핀이 너무 빽빽해 복잡하다 —
// 기본 배율(PIN_ZOOM_THRESHOLD) 이상으로 축소된 상태에서는 개별 핀(클러스터러 포함)을
// 지도에서 떼고, 대신 동 경계 안에 "동이름 개수" 라벨만 보여준다. 사용자가 특정 동을
// 확인하려고 확대하면(레벨이 작아지면) 다시 핀이 나타난다. 경계선 자체(구/동 폴리곤)는
// 줌과 무관하게 항상 보인다.
// STEP16.21: 사용자가 "관할" 필터로 특정 동을 이미 골라놓은 상태라면(state.selectedDongs가
// 비어있지 않으면) 이미 결과가 좁혀져 있어 복잡할 이유가 없으므로, 줌과 무관하게 핀을
// 항상 보여준다(축소해도 사라지지 않음). 필터가 없는 기본 상태에서만 줌 기준 전환을 적용한다.
function updateBoundaryDisplayForZoom() {
  if (!state.map) return;
  const filterActive = Array.isArray(state.selectedDongs) && state.selectedDongs.length > 0;
  const zoomedOut = !filterActive && state.map.getLevel() >= PIN_ZOOM_THRESHOLD;

  setClustererShown(!zoomedOut);
  dongLabelOverlays.forEach(overlay => {
    overlay.setMap(zoomedOut ? state.map : null);
  });
}

// 동 라벨(예: "신사동 63") 클릭 시 그 동 경계 전체가 화면에 들어오도록 확대/이동한다.
// setBounds가 발생시키는 zoom_changed 이벤트로 updateBoundaryDisplayForZoom()이 자동 호출돼,
// 확대된 레벨이 PIN_ZOOM_THRESHOLD 미만이 되면 핀도 함께 다시 나타난다(별도 처리 불필요).
function focusOnDong(name) {
  if (!state.map) return;
  const bounds = dongBoundsByName.get(name);
  if (!bounds) return;
  state.map.setBounds(bounds, 24, 24, 24, 24);
}

// 강남구 경계(1차) + 법정동 14개 경계(2차)를 지도에 그린다. 여러 번 호출돼도 중복 생성하지
// 않는다(이미 그려져 있으면 건너뜀). state.map이 준비된 뒤(initMap 이후)에만 호출해야 한다.
export async function renderGangnamBoundaries() {
  if (!state.map) return;

  let gu, dong;
  try {
    ({ gu, dong } = await loadBoundaries());
  } catch (err) {
    console.error('경계 데이터 로드 실패:', err);
    return; // 경계 없이도 지도/마커 등 기존 기능은 그대로 동작해야 한다.
  }

  if (gu && Array.isArray(gu.features) && guPolygons.length === 0) {
    gu.features.forEach(f => {
      geometryToPaths(f.geometry).forEach(path => {
        const polygon = new kakao.maps.Polygon({
          path,
          strokeWeight: 2,
          strokeColor: '#16326b',
          strokeOpacity: 0.7,
          fillOpacity: 0
        });
        polygon.setMap(state.map);
        guPolygons.push(polygon);
      });
    });
  }

  if (dong && Array.isArray(dong.features) && dongPolygonsData.length === 0) {
    // 사용자 의견 반영(2026-10, PC 전용): 법정동 경계선(파란색)이 지도 위 도로/지하철 선과
    // 색이 비슷해 구분이 어렵다는 피드백 — PC(>768px)에서만 선을 더 굵고 점선으로 바꿔
    // 또렷하게 한다. js/ui.js의 isMobileViewport()와 동일한 768px 기준이며, 모바일은 이
    // 분기에 들어오지 않으므로 기존 실선/굵기가 그대로 유지된다(모바일 화면 불변).
    const isPcViewport = typeof window.matchMedia === 'function' && !window.matchMedia('(max-width: 768px)').matches;
    dong.features.forEach(f => {
      const name = f.properties.name;
      const bounds = new kakao.maps.LatLngBounds();
      // STEP16.21: "선이 잘 안 보인다"는 피드백으로 법정동 경계선 가시성을 높였다 — 굵기
      // 1→2, 불투명도 0.6→0.9, 구(강남구) 경계와 겹쳐도 구분되도록 더 선명한 파랑으로 변경.
      geometryToPaths(f.geometry).forEach(path => {
        const polygon = new kakao.maps.Polygon({
          path,
          strokeWeight: isPcViewport ? 3 : 2,
          strokeColor: '#2f6fed',
          strokeOpacity: 0.9,
          strokeStyle: isPcViewport ? 'shortdash' : 'solid',
          fillColor: '#5b8def',
          fillOpacity: 0.04
        });
        polygon.setMap(state.map);
        dongPolygonsData.push({ name, polygon });
        path.forEach(latlng => bounds.extend(latlng));
      });
      dongBoundsByName.set(name, bounds);

      const centroid = geometryCentroid(f.geometry);
      if (centroid && !dongLabelOverlays.has(name)) {
        // STEP16.21: 라벨("OO동 N")을 누르면 그 동으로 확대해서 관할을 바로 확인할 수 있게 한다.
        const content = buildDongLabelContent(name, 0);
        content.addEventListener('click', () => focusOnDong(name));
        dongLabelContentByName.set(name, content);

        const overlay = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(centroid.lat, centroid.lng),
          content,
          xAnchor: 0.5,
          yAnchor: 0.5,
          zIndex: 5
        });
        dongLabelOverlays.set(name, overlay); // map에 붙이는 건 updateBoundaryDisplayForZoom()이 줌 보고 결정.
      }
    });
  }

  if (!zoomListenerBound) {
    kakao.maps.event.addListener(state.map, 'zoom_changed', updateBoundaryDisplayForZoom);
    zoomListenerBound = true;
  }
  updateBoundaryDisplayForZoom();
}

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
// STEP16.19: 즐겨찾기 현장을 지도에서 구분할 수 있도록, 즐겨찾기면 핀 오른쪽 위에 작은
// 별 배지를 얹는다. 캔버스를 22→26폭으로 넓혀 배지가 핀 몸통과 겹치지 않게 하고, 그만큼
// anchor(offset.x)도 11→13으로 다시 계산해 핀 끝(바닥 중앙)이 실제 좌표를 계속 정확히
// 가리키게 한다(핀 자체 모양/크기는 기존과 동일, 좌우 여백만 추가됨).
function getQualityMarkerImage(locationQuality, favorite) {
  const color = QUALITY_MARKER_COLOR[locationQuality];
  if (!color) return null; // 매핑 없는 값(UNRESOLVED 등)은 커스텀 이미지를 만들지 않고 호출부에서 기본 마커로 폴백한다.

  const cacheKey = color + (favorite ? ':fav' : '');
  if (markerImageCache.has(cacheKey)) return markerImageCache.get(cacheKey);

  const badge = favorite
    ? '<circle cx="21" cy="6" r="6" fill="#fff" stroke="' + color + '" stroke-width="1"/>' +
      '<text x="21" y="9" font-size="9" text-anchor="middle" fill="#f5a623">★</text>'
    : '';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="30" viewBox="0 0 26 30">' +
    '<g transform="translate(2,0)">' +
    '<path d="M11 1C6.03 1 2 4.64 2 9.1c0 6.3 9 20.4 9 20.4s9-14.1 9-20.4C20 4.64 15.97 1 11 1z" fill="' + color + '"/>' +
    '<circle cx="11" cy="9.1" r="3.1" fill="#fff"/>' +
    '</g>' +
    badge +
    '</svg>';
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  const image = new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(26, 30),
    { offset: new kakao.maps.Point(13, 30) } // 핀 뾰족한 끝(바닥 중앙, 새 크기 기준)이 실제 좌표를 가리키도록 anchor 재조정.
  );
  markerImageCache.set(cacheKey, image);
  return image;
}

// 사용자 요청: 현재 선택되어 상세정보가 열려 있는 핀을 다른 핀과 구분되게 표시한다.
// 처음엔 location_quality 색(정확/중간/확인필요)을 유지하고 파란 테두리만 둘렀는데,
// "테두리 말고 핀 색 자체가 파란색이 되어야 시인성이 높다"는 피드백에 따라 location_quality와
// 무관하게 핀 전체(fill)를 정부 blue(--gnmap-blue와 동일한 #1a73e8)로 바꾼다 — 색상 하나만
// 쓰므로 더 이상 quality별로 캐시할 필요가 없다. 닫으면(closeDetail) getQualityMarkerImage()로
// 원래 크기/quality색으로 되돌린다.
// STEP16.19: 선택 핀도 즐겨찾기면 같은 방식(오른쪽 위 별 배지)으로 표시한다. 캔버스를
// 28→32폭으로 넓히고 anchor(offset.x)를 14→16으로 재계산해 핀 끝이 계속 정확히 가리키게 한다.
const selectedMarkerImageCache = new Map();
function getSelectedMarkerImage(favorite) {
  const cacheKey = favorite ? 'fav' : 'plain';
  if (selectedMarkerImageCache.has(cacheKey)) return selectedMarkerImageCache.get(cacheKey);

  const badge = favorite
    ? '<circle cx="26" cy="7" r="6.5" fill="#fff" stroke="#1a73e8" stroke-width="1"/>' +
      '<text x="26" y="10" font-size="10" text-anchor="middle" fill="#f5a623">★</text>'
    : '';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="38" viewBox="0 0 32 38">' +
    '<g transform="translate(2,0)">' +
    '<path d="M14 2.5C8.2 2.5 3.5 6.9 3.5 12.3c0 7.9 10.5 23.7 10.5 23.7s10.5-15.8 10.5-23.7C24.5 6.9 19.8 2.5 14 2.5z" fill="#1a73e8" stroke="#0d47a1" stroke-width="1.5"/>' +
    '<circle cx="14" cy="12.3" r="4.2" fill="#fff"/>' +
    '</g>' +
    badge +
    '</svg>';
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  const image = new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(32, 38),
    { offset: new kakao.maps.Point(16, 38) } // 뾰족한 끝이 좌표를 가리키도록(기본 핀과 동일한 원칙, 커진 크기에 맞춰 재계산).
  );
  selectedMarkerImageCache.set(cacheKey, image);
  return image;
}

// state.selectedSiteId에 해당하는 마커를 "선택됨" 이미지로 바꾼다. 마커가 아직 없거나
// (좌표 없음 등) 찾을 수 없으면 조용히 무시한다. renderMarkers()가 목록을 다시 그릴 때마다
// (검색/필터 변경 등) 호출해, 마커가 새로 만들어져도 선택 강조가 유지되게 한다.
export function highlightSelectedMarker() {
  const siteId = state.selectedSiteId;
  if (siteId === null || siteId === undefined) return;
  const marker = state.siteMarkers.get(siteId);
  if (!marker || typeof marker.setImage !== 'function') return;
  marker.setImage(getSelectedMarkerImage(isFavorite(siteId)));
}

// STEP16.19: 즐겨찾기 토글 직후 지도 위 해당 마커 한 개만 즉시 갱신한다(전체 재렌더 없이).
// 상세가 열려 선택된 마커라면 "선택됨" 이미지 기준으로, 아니면 quality 색 기준으로 갱신한다.
export function refreshFavoriteMarker(siteId) {
  if (siteId === null || siteId === undefined) return;
  const marker = state.siteMarkers.get(siteId);
  if (!marker || typeof marker.setImage !== 'function') return;
  const favorite = isFavorite(siteId);
  if (state.selectedSiteId === siteId) {
    marker.setImage(getSelectedMarkerImage(favorite));
    return;
  }
  const site = state.sites.find(s => s.id === siteId);
  const image = getQualityMarkerImage(site ? site.location_quality : null, favorite);
  if (image) marker.setImage(image);
}

// 특정 사업장의 마커를 원래(기본) 이미지로 되돌린다. 상세를 닫거나 다른 핀을 선택했을 때
// 이전 선택 마커의 강조를 해제하는 데 쓴다.
export function clearMarkerHighlight(siteId) {
  if (siteId === null || siteId === undefined) return;
  const marker = state.siteMarkers.get(siteId);
  if (!marker || typeof marker.setImage !== 'function') return;
  const site = state.sites.find(s => s.id === siteId);
  const image = getQualityMarkerImage(site ? site.location_quality : null, isFavorite(siteId));
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
    // STEP16.28: services 라이브러리 추가 — kakao.maps.services.Geocoder(주소→좌표, 커맨드센터
    // 마커용)와 kakao.maps.services.Places(키워드/주소 검색, 검색창의 "일반 주소" 검색용)를
    // 프론트에서 바로 쓰기 위함이다. 둘 다 Kakao Maps JS SDK 키(appkey, 이미 공개되어 있는 JS
    // 키)로 동작하며 REST API Key(비공개, Edge Function 전용)는 전혀 사용하지 않는다.
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${CONFIG.KAKAO_JS_KEY}&libraries=services,clusterer&autoload=false`;
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
// startCenter: STEP16.6(모바일 앱 설정 "지도 시작 위치"). { lat, lng }가 주어지면 강남구 기본
// 좌표 대신 그 위치를 초기 중심으로 쓴다. 생략하거나 유효하지 않으면 기존 동작(GANGNAM_CENTER)
// 그대로 — 기존 호출부(startCenter 없이 호출)의 동작은 전혀 바뀌지 않는다.
export async function initMap(containerId, startCenter) {
  if (state.map) return state.map;

  await loadKakaoSdk();

  const container = document.getElementById(containerId);
  if (!container) throw new Error(`지도 컨테이너를 찾을 수 없습니다: ${containerId}`);

  const validOverride = startCenter
    && Number.isFinite(startCenter.lat) && Number.isFinite(startCenter.lng)
    && startCenter.lat >= -90 && startCenter.lat <= 90
    && startCenter.lng >= -180 && startCenter.lng <= 180;
  const center = validOverride ? startCenter : GANGNAM_CENTER;

  state.map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(center.lat, center.lng),
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

// ============================================================
// STEP16.28-1: "커맨드센터"(서울강남지청, 성담빌딩) 고정 마커.
// - 일반 사업장 마커와 달리 클러스터러에 넣지 않고 지도에 직접 붙인다 — 확대/축소로 클러스터링
//   되거나 숨겨지지 않고 항상 그대로 보인다(사용자 요청: "확대하든 축소하든 잘 보일 수 있도록").
// - 좌표는 하드코딩하지 않고 kakao.maps.services.Geocoder로 주소를 직접 조회해 정확한 좌표를
//   쓴다(loadKakaoSdk에서 추가한 services 라이브러리 사용). 최초 1회만 조회하고 이후에는
//   캐시된 마커를 재사용한다(initMap이 지도당 1회만 호출되므로 사실상 앱 생명주기 동안 1회).
// - 사업장 데이터(gnmap_v2_sites)와는 무관한 순수 지도 표시 요소이며 DB에 저장하지 않는다.
// ============================================================
const HQ_ADDRESS = '서울 강남구 테헤란로 411';
const HQ_LABEL = '지청'; // 사용자 요청: "강남지청 (커맨드센터)"에서 "커맨드센터" 표현을 빼고 "지청"으로만 표시.
let hqMarker = null;
let hqLabelOverlay = null;
let hqRenderRequested = false;

function buildHqMarkerImage() {
  // 일반 사업장 핀(24x35 내외)보다 눈에 띄게 크고 색이 다른 별 모양 마커 — 확대/축소와 무관하게
  // 클러스터러 밖에서 항상 단독으로 렌더링되므로, 배지 형태의 진한 남색 별 아이콘으로 구분한다.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="58" viewBox="0 0 48 58">
      <path d="M24 2C13 2 4 11 4 22c0 15 20 34 20 34s20-19 20-34C44 11 35 2 24 2Z" fill="#0b2f6b" stroke="#ffffff" stroke-width="2"/>
      <circle cx="24" cy="22" r="12" fill="#ffffff"/>
      <path d="M24 13.5l2.47 5.01 5.53.8-4 3.9.94 5.5L24 25.99l-4.94 2.72.94-5.5-4-3.9 5.53-.8L24 13.5Z" fill="#0b2f6b"/>
    </svg>
  `.trim();
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  return new kakao.maps.MarkerImage(src, new kakao.maps.Size(48, 58), { offset: new kakao.maps.Point(24, 58) });
}

export function renderHqMarker() {
  if (!state.map || hqRenderRequested) return;
  hqRenderRequested = true;

  if (!window.kakao || !kakao.maps.services || !kakao.maps.services.Geocoder) {
    console.warn('[커맨드센터 마커] kakao.maps.services를 사용할 수 없습니다(SDK 로드 옵션 확인 필요).');
    return;
  }

  const geocoder = new kakao.maps.services.Geocoder();
  geocoder.addressSearch(HQ_ADDRESS, (result, status) => {
    if (status !== kakao.maps.services.Status.OK || !result || !result[0]) {
      console.warn('[커맨드센터 마커] 주소 지오코딩 실패:', HQ_ADDRESS, status);
      return;
    }
    const lat = Number(result[0].y);
    const lng = Number(result[0].x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const position = new kakao.maps.LatLng(lat, lng);

    if (hqMarker) hqMarker.setMap(null);
    hqMarker = new kakao.maps.Marker({
      position,
      image: buildHqMarkerImage(),
      map: state.map, // 클러스터러가 아닌 지도에 직접 부착 — 항상 표시.
      zIndex: 999
    });

    if (hqLabelOverlay) hqLabelOverlay.setMap(null);
    const labelEl = document.createElement('div');
    labelEl.className = 'hq-marker-label';
    labelEl.textContent = HQ_LABEL;
    hqLabelOverlay = new kakao.maps.CustomOverlay({
      position,
      content: labelEl,
      yAnchor: 2.55, // 마커 핀 꼭대기 위에 라벨이 오도록
      zIndex: 1000
    });
    hqLabelOverlay.setMap(state.map);
  });
}

// ============================================================
// STEP16.28-2: 검색창의 "일반 주소" 검색 — kakao.maps.services.Places(키워드 검색)를 그대로
// 프론트에서 호출한다. REST API Key(비공개)를 쓰는 gnmap-v2-geocode Edge Function(관리자 전용,
// Excel import 좌표 확인용)과는 완전히 별개이며, 여기서는 JS SDK 공개 키만 사용하므로 일반
// 사용자도 바로 쓸 수 있다. Promise로 감싸 ui.js에서 await로 쓰기 쉽게 한다.
// ============================================================
export function searchPlacesKeyword(query) {
  return new Promise((resolve) => {
    if (!window.kakao || !kakao.maps.services || !kakao.maps.services.Places) {
      resolve([]);
      return;
    }
    const places = new kakao.maps.services.Places();
    places.keywordSearch(query, (result, status) => {
      if (status !== kakao.maps.services.Status.OK || !Array.isArray(result)) {
        resolve([]);
        return;
      }
      resolve(result.map(r => ({
        name: r.place_name || r.address_name || query,
        roadAddress: r.road_address_name || '',
        address: r.address_name || '',
        lat: Number(r.y),
        lng: Number(r.x)
      })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)));
    });
  });
}

// ============================================================
// STEP16.30-1: 주소/장소 검색 결과를 클릭하면 지도에 임시 핀으로 표시한다(사용자 요청).
// 등록된 사업장 마커(state.markers/클러스터러)와는 완전히 별개이며, 클러스터러에도 넣지 않고
// 지도에 직접 붙인다(HQ 마커와 같은 방식) — 검색 결과는 항상 1개만 유지하고, 새로 클릭하면
// 이전 핀을 지우고 새 위치로 교체한다. 사업장 데이터(gnmap_v2_sites)에는 전혀 저장하지 않는다.
// ============================================================
let addressSearchPinMarker = null;

export function showAddressSearchPin(lat, lng) {
  if (!state.map) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  clearAddressSearchPin();
  const position = new kakao.maps.LatLng(lat, lng);
  addressSearchPinMarker = new kakao.maps.Marker({
    position,
    map: state.map, // 클러스터러가 아닌 지도에 직접 부착 — 항상 표시.
    zIndex: 800
  });
  state.map.panTo(position);
}

export function clearAddressSearchPin() {
  if (addressSearchPinMarker) {
    addressSearchPinMarker.setMap(null);
    addressSearchPinMarker = null;
  }
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
    const qualityImage = getQualityMarkerImage(site.location_quality, isFavorite(site.id));
    if (qualityImage) markerOptions.image = qualityImage;

    const marker = new kakao.maps.Marker(markerOptions);

    if (typeof onMarkerClick === 'function') {
      kakao.maps.event.addListener(marker, 'click', () => onMarkerClick(site.id));
    }

    state.markers.push(marker);
    state.siteMarkers.set(site.id, marker);
    validMarkers.push(marker);
  });

  // STEP16.21: clearMarkers()가 이미 clusterer.clear()를 호출했으므로(아래 clearMarkers 참고)
  // clustererShown을 일단 false로 맞춰두고, lastValidMarkers를 최신 목록으로 갱신한 뒤
  // updateBoundaryDisplayForZoom()이 현재 줌/필터 상태에 맞게 다시 채울지 말지 결정하게 한다.
  lastValidMarkers = validMarkers;
  clustererShown = false;
  if (!clusterer) {
    // clusterer가 아직 없는 예외 상황(이론상 initMap 이후에는 항상 존재) 대비 폴백.
    validMarkers.forEach(marker => marker.setMap(state.map));
  }

  // 검색/필터가 바뀌어 마커가 전부 새로 만들어져도(위 clearMarkers()+새 Marker), 현재
  // 선택된 사업장(state.selectedSiteId)이 새 목록에도 있으면 선택 강조를 다시 입힌다.
  highlightSelectedMarker();

  // STEP16.20: 검색/필터 결과가 바뀔 때마다 동 라벨의 "OO동 N" 개수 표기도 함께 갱신한다.
  // 라벨을 지도에 보이거나 숨기는 결정은 줌 레벨(updateBoundaryDisplayForZoom)의 몫이라 여기선
  // sites가 비어도(마커가 0개여도) 항상 호출해 카운트를 0으로 정확히 반영한다.
  updateDongCounts(sites || []);

  // STEP16.21: 마커를 다시 그릴 때마다(검색/필터 변경 포함) 현재 줌 레벨 + 관할 필터 활성 여부
  // 기준으로 클러스터러/동 라벨 표시 상태를 다시 맞춘다(clear() 직후이므로 항상 필요).
  updateBoundaryDisplayForZoom();
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

// ------------------------------------------------------------
// STEP16.13(모바일 "경로" 탭 — 방문 순서/경로 상세 전용 미니맵).
//
// state.map(메인 지도 탭 전용, 컨테이너에 고정)과는 완전히 분리된 별도 kakao.maps.Map
// 인스턴스를 쓴다 — Kakao SDK는 여러 Map 인스턴스를 동시에 지원하므로 안전하다.
// 컨테이너 id별로 인스턴스를 1개만 만들어 재사용한다(§37: 중복 초기화/리스너 누적 방지).
// 실제 경로선(polyline)이나 거리/시간 계산은 절대 하지 않는다 — 승인된 축소 범위는
// "현재 위치 + 사용자가 정한 순서의 번호 마커"만 지도에 표시하는 것까지다(가짜 경로 금지).
const routeMaps = new Map(); // containerId -> { map, markers: kakao.maps.Marker[] }

// 색상별이 아니라 "번호"별로 캐시한다(방문 순서가 바뀌면 같은 site라도 번호가 바뀔 수 있음).
const routeNumberMarkerImageCache = new Map();

function getRouteNumberMarkerImage(number) {
  if (routeNumberMarkerImageCache.has(number)) return routeNumberMarkerImageCache.get(number);

  const label = String(number);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">' +
    '<path d="M15 1C7.8 1 2 6.6 2 13.4c0 9 13 23.6 13 23.6s13-14.6 13-23.6C28 6.6 22.2 1 15 1z" fill="#16326b"/>' +
    '<circle cx="15" cy="13.4" r="10.5" fill="#fff"/>' +
    '<text x="15" y="18" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#16326b">' + label + '</text>' +
    '</svg>';
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  const image = new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(30, 38),
    { offset: new kakao.maps.Point(15, 38) }
  );
  routeNumberMarkerImageCache.set(number, image);
  return image;
}

// 현재 위치 표시용(사업장 번호 마커와 구분되는 파란 점). location.js의 state.currentLocationMarker
// (메인 지도 전용 kakao.maps.Circle)와는 별개로, 경로 미니맵에서만 쓰는 가벼운 MarkerImage다.
let currentLocationMarkerImage = null;
function getCurrentLocationMarkerImage() {
  if (currentLocationMarkerImage) return currentLocationMarkerImage;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
    '<circle cx="11" cy="11" r="8" fill="#1a73e8" stroke="#fff" stroke-width="3"/>' +
    '</svg>';
  const src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  currentLocationMarkerImage = new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(22, 22),
    { offset: new kakao.maps.Point(11, 11) }
  );
  return currentLocationMarkerImage;
}

// containerId에 해당하는 경로 미니맵을 생성하거나(이미 있으면) 재사용해 반환한다.
// center가 유효하면 그 위치를, 아니면 강남구 기본 중심을 초기 중심으로 쓴다.
export async function initRouteMap(containerId, center) {
  await loadKakaoSdk();

  let entry = routeMaps.get(containerId);
  if (entry) return entry.map;

  const container = document.getElementById(containerId);
  if (!container) throw new Error(`경로 지도 컨테이너를 찾을 수 없습니다: ${containerId}`);

  const validCenter =
    center && Number.isFinite(center.lat) && Number.isFinite(center.lng) &&
    center.lat >= -90 && center.lat <= 90 && center.lng >= -180 && center.lng <= 180;
  const c = validCenter ? center : GANGNAM_CENTER;

  const map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(c.lat, c.lng),
    level: DEFAULT_LEVEL
  });

  routeMaps.set(containerId, { map, markers: [] });
  return map;
}

// 지도 컨테이너 크기가 나중에(패널이 display:none→block으로 바뀐 뒤) 확정되는 경우
// Kakao 지도가 이전 크기 기준으로 렌더링된 상태로 남을 수 있어, 패널을 열 때 relayout이 필요하다.
export function relayoutRouteMap(containerId) {
  const entry = routeMaps.get(containerId);
  if (!entry) return;
  entry.map.relayout();
}

export function clearRouteMarkers(containerId) {
  const entry = routeMaps.get(containerId);
  if (!entry) return;
  entry.markers.forEach(marker => marker.setMap(null));
  entry.markers = [];
}

// currentLocation({lat,lng}|null)과 orderedSites(방문 순서대로 정렬된, 좌표가 유효한 사업장 배열)로
// 번호 마커를 그린다. 기존 마커는 모두 지운 뒤 새로 그린다. 경로선(polyline)은 그리지 않는다
// (승인된 축소 범위 — 실제 도로 경로 geometry가 없으므로 가짜 직선/곡선을 긋지 않는다).
// onMarkerClick(site.id)를 주입받으면 사업장 마커 클릭 시 호출한다.
export function renderRouteMarkers(containerId, currentLocation, orderedSites, onMarkerClick) {
  const entry = routeMaps.get(containerId);
  if (!entry) return;

  clearRouteMarkers(containerId);

  const bounds = new kakao.maps.LatLngBounds();
  let hasPoint = false;

  const validLocation =
    currentLocation && Number.isFinite(currentLocation.lat) && Number.isFinite(currentLocation.lng) &&
    currentLocation.lat >= -90 && currentLocation.lat <= 90 &&
    currentLocation.lng >= -180 && currentLocation.lng <= 180;

  if (validLocation) {
    const position = new kakao.maps.LatLng(currentLocation.lat, currentLocation.lng);
    const marker = new kakao.maps.Marker({ position, image: getCurrentLocationMarkerImage() });
    marker.setMap(entry.map);
    entry.markers.push(marker);
    bounds.extend(position);
    hasPoint = true;
  }

  (orderedSites || []).forEach((site, index) => {
    const lat = Number(site.lat);
    const lng = Number(site.lng);
    const isValid =
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    if (!isValid) return; // 좌표 없는 사업장은 지도에 표시하지 않는다(§31 예외처리 — 목록/안내문에서 별도 처리)

    const position = new kakao.maps.LatLng(lat, lng);
    const marker = new kakao.maps.Marker({ position, image: getRouteNumberMarkerImage(index + 1) });
    if (typeof onMarkerClick === 'function') {
      kakao.maps.event.addListener(marker, 'click', () => onMarkerClick(site.id));
    }
    marker.setMap(entry.map);
    entry.markers.push(marker);
    bounds.extend(position);
    hasPoint = true;
  });

  if (hasPoint) {
    entry.map.setBounds(bounds, 40, 40, 40, 40);
  }
}

// 마커를 다시 그리지 않고, containerId의 경로 미니맵을 특정 사업장 좌표로만 이동시킨다.
// "경로 상세" 화면의 "지도에서 보기" 버튼처럼 목록에서 지도로 시선을 유도할 때 쓴다.
export function panToRouteSite(containerId, site) {
  const entry = routeMaps.get(containerId);
  if (!entry || !site) return;
  const lat = Number(site.lat);
  const lng = Number(site.lng);
  const isValid =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  if (!isValid) return;
  entry.map.panTo(new kakao.maps.LatLng(lat, lng));
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
