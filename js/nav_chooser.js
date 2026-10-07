// "길찾기" 공통 팝업 — 카카오맵 / 네이버지도 중 선택해서 연다.
// 카카오: 웹 링크(PC·모바일 공통). 네이버: 모바일은 네이버 지도 앱 URL Scheme(nmap://route/car,
// 출발지 생략 = 현재 위치), 앱이 없으면 스토어로 이동. PC는 앱 호출이 안 되므로 네이버 지도 웹 검색을 연다.
// 사업장 데이터/DB와 무관한 순수 링크 이동이다.

const NAVER_ANDROID_PKG = 'com.nhn.android.nmap';
const NAVER_IOS_STORE = 'https://itunes.apple.com/app/id311867728?mt=8';
const TMAP_ANDROID_PKG = 'com.skt.tmap.ku';
const TMAP_IOS_STORE = 'https://itunes.apple.com/app/id431589174?mt=8';

// 모바일/TWA(화면 폭 768px 이하)에서만 T맵 항목을 보여준다.
function isMobileLike() {
  return window.innerWidth <= 768;
}

function kakaoUrl(name, lat, lng) {
  return `https://map.kakao.com/link/to/${encodeURIComponent(name || '목적지')},${lat},${lng}`;
}

function appName() {
  return encodeURIComponent(location.hostname || 'gangnam-safety');
}

function naverQuery(name, lat, lng) {
  return `dlat=${lat}&dlng=${lng}&dname=${encodeURIComponent(name || '목적지')}&appname=${appName()}`;
}

// 주소 앞/뒤의 우편번호 제거 — 예: "(06292) 서울 강남구 …", "[06292] 서울…", "06292 서울…", "135-080 서울…"
// 네이버 지도 검색은 우편번호가 붙으면 결과를 못 찾는다.
export function stripPostalCode(addr) {
  let t = String(addr || '').trim();
  t = t.replace(/^[\(\[\{]?\s*\d{3}-?\d{2,3}(?![\d가-힣])\s*[\)\]\}]?[\s,]*/, '');
  t = t.replace(/[\s,]*[\(\[\{]\s*\d{3}-?\d{2,3}(?![\d가-힣])\s*[\)\]\}]\s*$/, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

function openNaver(name, lat, lng, address) {
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  if (isAndroid) {
    // 인텐트 URL: 앱이 없으면 Google Play로 자동 이동한다.
    location.href = `intent://route/car?${naverQuery(name, lat, lng)}#Intent;scheme=nmap;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=${NAVER_ANDROID_PKG};end`;
    return;
  }
  if (isIOS) {
    const clickedAt = Date.now();
    location.href = `nmap://route/car?${naverQuery(name, lat, lng)}`;
    // 앱이 열리면 페이지가 백그라운드로 가므로 타이머가 늦게 돈다 — 빨리 돌면 미설치로 보고 App Store로.
    setTimeout(() => { if (Date.now() - clickedAt < 2000 && !document.hidden) location.href = NAVER_IOS_STORE; }, 1500);
    return;
  }
  // PC: 네이버 지도 웹에서 해당 위치(주소 또는 이름)를 검색해 보여준다.
  window.open(`https://map.naver.com/p/search/${encodeURIComponent(stripPostalCode(address) || name || '')}`, '_blank', 'noopener,noreferrer');
}

// T맵: 공식 문서가 없어 널리 쓰이는 형식(tmap://route?goalname&goalx(경도)&goaly(위도))을 쓴다.
// 안드로이드는 인텐트 URL(앱 없으면 Play 스토어), iOS는 rGo* 형식 + 타이머로 App Store 안내.
function openTmap(name, lat, lng) {
  const ua = navigator.userAgent || '';
  const n = encodeURIComponent(name || '목적지');
  if (/Android/i.test(ua)) {
    location.href = `intent://route?goalname=${n}&goalx=${lng}&goaly=${lat}#Intent;scheme=tmap;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=${TMAP_ANDROID_PKG};end`;
    return;
  }
  const clickedAt = Date.now();
  location.href = `tmap://route?rGoName=${n}&rGoX=${lng}&rGoY=${lat}`;
  setTimeout(() => { if (Date.now() - clickedAt < 2000 && !document.hidden) location.href = TMAP_IOS_STORE; }, 1500);
}

let root = null;

function ensureUi() {
  if (root) return root;
  const style = document.createElement('style');
  style.textContent = `
#nav-chooser{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Noto Sans KR","Segoe UI",sans-serif}
#nav-chooser[hidden]{display:none!important}
.nc-back{position:absolute;inset:0;background:rgba(10,24,46,.55)}
.nc-box{position:relative;width:340px;max-width:calc(100vw - 32px);background:#fff;border-radius:18px;padding:22px 20px 16px;box-shadow:0 20px 60px rgba(8,30,70,.35);box-sizing:border-box}
.nc-title{margin:0 0 4px;font-size:18px;font-weight:800;color:#0b2358}
.nc-dest{margin:0 0 16px;font-size:13px;color:#61779c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nc-opt{display:flex;align-items:center;gap:12px;width:100%;height:56px;margin:0 0 10px;padding:0 16px;border:1px solid #dbe5f3;border-radius:14px;background:#fff;font-family:inherit;font-size:16px;font-weight:700;color:#16233b;cursor:pointer;text-align:left}
.nc-opt:hover{background:#f5f9ff}
.nc-badge{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;flex:none}
.nc-tmap .nc-badge{background:#ef3340;color:#fff}
.nc-kakao .nc-badge{background:#fee500;color:#3b1e1e}
.nc-naver .nc-badge{background:#03c75a;color:#fff}
.nc-cancel{display:block;width:100%;height:42px;border:0;background:transparent;color:#7b889c;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
@media (max-width:768px){
  #nav-chooser{align-items:flex-end}
  .nc-box{width:100%;max-width:none;border-radius:20px 20px 0 0;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
}`;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.id = 'nav-chooser';
  root.hidden = true;
  document.body.appendChild(root);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) root.hidden = true; });
  return root;
}

// name: 목적지 이름, lat/lng: 좌표, address: (선택) PC 네이버 검색용 주소
export function openDirections(name, lat, lng, address) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  const el = ensureUi();
  const close = () => { el.hidden = true; };
  el.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'nc-back';
  back.addEventListener('click', close);
  const box = document.createElement('div');
  box.className = 'nc-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', '길찾기 지도 선택');
  box.innerHTML = '<h3 class="nc-title">길찾기</h3><p class="nc-dest"></p>';
  box.querySelector('.nc-dest').textContent = `목적지: ${name || '-'}`;
  const mk = (cls, badge, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `nc-opt ${cls}`;
    b.innerHTML = `<span class="nc-badge">${badge}</span><span>${label}</span>`;
    b.addEventListener('click', () => { close(); fn(); });
    return b;
  };
  if (isMobileLike()) box.appendChild(mk('nc-tmap', 'T', 'T맵으로 보기', () => openTmap(name, lat, lng)));
  box.appendChild(mk('nc-kakao', 'K', '카카오맵으로 보기', () => window.open(kakaoUrl(name, lat, lng), '_blank', 'noopener,noreferrer')));
  box.appendChild(mk('nc-naver', 'N', '네이버지도로 보기', () => openNaver(name, lat, lng, address)));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'nc-cancel';
  cancel.textContent = '취소';
  cancel.addEventListener('click', close);
  box.appendChild(cancel);
  el.appendChild(back);
  el.appendChild(box);
  el.hidden = false;
}
