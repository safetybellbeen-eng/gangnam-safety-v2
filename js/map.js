// map.js — STEP 4. Kakao Maps JS SDK 로드 및 기본 지도 초기화.
// REST API/geocoding/marker/GeoJSON 경계는 이번 STEP 범위가 아니다 (CLAUDE.md 준수).
import { CONFIG } from './config.js';
import { state } from './state.js';

const GANGNAM_CENTER = { lat: 37.4979, lng: 127.0276 }; // 강남구 중심 좌표
const DEFAULT_LEVEL = 6;

let sdkLoadPromise = null;

// SDK <script> 태그를 딱 1번만 생성한다 (중복 로드 방지).
// autoload=false로 로드한 뒤 kakao.maps.load()로 초기화 시점을 직접 제어한다 —
// GitHub Pages 등 정적 호스팅에서 SDK 로드 타이밍이 페이지 렌더링과 어긋나는 문제를 방지.
function loadKakaoSdk() {
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps) {
      resolve(window.kakao);
      return;
    }
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${CONFIG.KAKAO_JS_KEY}&autoload=false`;
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

  return state.map;
}
