// "길찾기" 공통 팝업 — 카카오맵 / 네이버지도 중 선택해서 연다.
// 카카오: 웹 링크(PC·모바일 공통). 네이버: 모바일은 네이버 지도 앱 URL Scheme(nmap://route/car,
// 출발지 생략 = 현재 위치), 앱이 없으면 스토어로 이동. PC는 앱 호출이 안 되므로 네이버 지도 웹 검색을 연다.
// 사업장 데이터/DB와 무관한 순수 링크 이동이다.

const NAVER_ANDROID_PKG = 'com.nhn.android.nmap';
const NAVER_IOS_STORE = 'https://itunes.apple.com/app/id311867728?mt=8';
const TMAP_ANDROID_PKG = 'com.skt.tmap.ku';
const TMAP_IOS_STORE = 'https://itunes.apple.com/app/id431589174?mt=8';
const KAKAO_ANDROID_PKG = 'net.daum.android.map';
const KAKAO_IOS_STORE = 'https://itunes.apple.com/app/id304608425?mt=8';

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

// ---- 앱 실행 공통 처리 -------------------------------------------------------------
// 이전 방식(타이머로 "앱이 안 열렸다"고 추정해 스토어를 자동으로 여는 방식)은 iOS에서 "앱에서 열기"
// 확인창이 떠 있는 동안에도 스토어가 같이 열리는 문제가 있었다. 지금은 스토어를 자동으로 열지 않는다.
//  - Android(모바일/TWA): intent URL 한 번. 앱이 있으면 앱만 열리고, 없으면 크롬이 Play 스토어로 보낸다.
//  - iOS: URL Scheme 한 번. 몇 초 뒤에도 화면이 그대로면 "앱 설치" 안내 버튼만 띄우고, 누를 때만 스토어로 간다.
function ua() { return navigator.userAgent || ''; }
const isAndroid = () => /Android/i.test(ua());
const isIOS = () => /iPhone|iPad|iPod/i.test(ua());
const isMobileDevice = () => isAndroid() || isIOS();

function showInstallHint(label, storeUrl) {
  const old = document.getElementById('nc-install-hint');
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.id = 'nc-install-hint';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:10060;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:12px 14px;border-radius:14px;background:#0b2358;color:#fff;font:600 14px/1.4 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Noto Sans KR",sans-serif;box-shadow:0 10px 30px rgba(8,30,70,.35)';
  const msg = document.createElement('span');
  msg.textContent = `${label} 앱이 열리지 않았나요?`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '앱 설치';
  btn.style.cssText = 'flex:none;height:32px;padding:0 12px;border:0;border-radius:8px;background:#fff;color:#0b2358;font:800 13px inherit;cursor:pointer';
  btn.addEventListener('click', () => { bar.remove(); location.href = storeUrl; });
  const x = document.createElement('button');
  x.type = 'button';
  x.setAttribute('aria-label', '닫기');
  x.textContent = '✕';
  x.style.cssText = 'flex:none;border:0;background:transparent;color:#c9d6f2;font-size:14px;cursor:pointer';
  x.addEventListener('click', () => bar.remove());
  bar.append(msg, btn, x);
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 10000);
}

function launchApp({ androidUrl, iosUrl, storeUrl, label }) {
  if (isAndroid()) { location.href = androidUrl; return; }
  let left = false;
  const mark = () => { left = true; };
  const onVis = () => { if (document.hidden) mark(); };
  window.addEventListener('pagehide', mark, { once: true });
  window.addEventListener('blur', mark, { once: true });
  document.addEventListener('visibilitychange', onVis);
  location.href = iosUrl;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', mark);
    window.removeEventListener('blur', mark);
    if (!left && !document.hidden) showInstallHint(label, storeUrl);
  }, 2500);
}

function intentUrl(path, scheme, pkg) {
  return `intent://${path}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=${pkg};end`;
}

function openKakao(name, lat, lng) {
  if (!isMobileDevice()) { window.open(kakaoUrl(name, lat, lng), '_blank', 'noopener,noreferrer'); return; }
  // 카카오맵 앱 길찾기: kakaomap://route?ep=위도,경도&by=CAR (출발지 생략 = 현재 위치)
  const q = `ep=${lat},${lng}&by=CAR`;
  launchApp({
    androidUrl: intentUrl(`route?${q}`, 'kakaomap', KAKAO_ANDROID_PKG),
    iosUrl: `kakaomap://route?${q}`,
    storeUrl: KAKAO_IOS_STORE,
    label: '카카오맵',
  });
}

function openNaver(name, lat, lng, address) {
  if (!isMobileDevice()) {
    // PC: 네이버 지도 웹에서 해당 위치(주소 또는 이름)를 검색해 보여준다.
    window.open(`https://map.naver.com/p/search/${encodeURIComponent(stripPostalCode(address) || name || '')}`, '_blank', 'noopener,noreferrer');
    return;
  }
  launchApp({
    androidUrl: intentUrl(`route/car?${naverQuery(name, lat, lng)}`, 'nmap', NAVER_ANDROID_PKG),
    iosUrl: `nmap://route/car?${naverQuery(name, lat, lng)}`,
    storeUrl: NAVER_IOS_STORE,
    label: '네이버지도',
  });
}

// T맵: tmap://route?goalname&goalx(경도)&goaly(위도) (Android) / rGoName,rGoX,rGoY (iOS)
function openTmap(name, lat, lng) {
  const n = encodeURIComponent(name || '목적지');
  launchApp({
    androidUrl: intentUrl(`route?goalname=${n}&goalx=${lng}&goaly=${lat}`, 'tmap', TMAP_ANDROID_PKG),
    iosUrl: `tmap://route?rGoName=${n}&rGoX=${lng}&rGoY=${lat}`,
    storeUrl: TMAP_IOS_STORE,
    label: 'T맵',
  });
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
.nc-badge{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;box-sizing:border-box}
.nc-badge img{display:block;object-fit:contain}
.nc-kakao .nc-badge img{width:40px;height:40px}
.nc-tmap .nc-badge,.nc-naver .nc-badge{background:#fff;border:1px solid #e1e8f3}
.nc-tmap .nc-badge img{width:24px;height:24px}
.nc-naver .nc-badge img{width:28px;height:28px}
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
    b.innerHTML = `<span class="nc-badge"><img src="./assets/navicons/${badge}.png" alt="" width="40" height="40" decoding="async"></span><span>${label}</span>`;
    b.addEventListener('click', () => { close(); fn(); });
    return b;
  };
  if (isMobileLike()) box.appendChild(mk('nc-tmap', 'tmap', 'T맵으로 보기', () => openTmap(name, lat, lng)));
  box.appendChild(mk('nc-kakao', 'kakaomap', '카카오맵으로 보기', () => openKakao(name, lat, lng)));
  box.appendChild(mk('nc-naver', 'naver', '네이버지도로 보기', () => openNaver(name, lat, lng, address)));
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
