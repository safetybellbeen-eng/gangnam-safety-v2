// 모바일/TWA(768px 이하) 첫 로그인 사용가이드: 실제 화면 위 "터치 코치마크" 투어.
// - 실제 화면을 어둡게 하고 설명할 요소만 밝게 비춘 뒤 말풍선·손가락 표시로 안내한다.
// - "봤는지" 여부는 사용자별로 이 기기(localStorage)에만 저장한다(DB 변경 없음).
// - 더보기 > "사용 가이드 다시 보기"에서 언제든 다시 볼 수 있다.
// - PC(769px 이상)는 기존 pc_tutorial.js가 담당하므로 여기서는 동작하지 않는다.
import { state } from './state.js';

const KEY_PREFIX = 'gnmap_v2_mtutorial_done_';
const isMobile = () => window.innerWidth <= 768;
const uid = () => (state.user && state.user.id) || (state.profile && state.profile.id) || 'anon';
const isDone = () => { try { return localStorage.getItem(KEY_PREFIX + uid()) === '1'; } catch (e) { return false; } };
const markDone = () => { try { localStorage.setItem(KEY_PREFIX + uid(), '1'); } catch (e) { /* 저장 불가 시 다음에 다시 표시될 뿐 */ } };

const STEPS = [
  { sel: '#site-search-input', title: '현장 검색', text: '현장명·업체명·주소·동으로 바로 찾을 수 있어요. 무엇을 찾을지는 바로 아래 “검색” 버튼으로 정해요.', pos: 'below' },
  { sel: '#site-search-mode-filter', title: '“검색” 버튼 — 꼭 확인하세요', text: '“현장/업체명”은 등록된 사업장을 찾고, “주소/장소명”은 카카오 지도에서 일반 주소·건물을 찾아 지도에 표시해요. 원하는 결과가 안 나오면 이 버튼부터 확인하세요.', pos: 'below' },
  { sel: '#site-dong-filter', title: '관할(행정동) 선택', text: '처음에는 핀이 보이지 않아요. 관할에서 “전체” 또는 원하는 동을 고르면 핀과 목록이 나타나요. 공사금액·점검·산재표 필터도 함께 쓸 수 있어요.', pos: 'below' },
  { sel: '#site-etc-filter', title: '기타 — 즐겨찾기·메모만 보기', text: '“기타”에서 즐겨찾기나 메모를 체크하면 해당 사업장만 따로 보여요. 지도에는 일반 핀 대신 즐겨찾기는 별표, 메모는 메모 표시로 나타나고, 둘 다 있으면 둘 다 표시돼요.', pos: 'below' },
  { sel: '#mobile-map-legend', title: '핀 색 = 위치 정확도', text: '핀 색은 사업장의 위험도가 아니라, 지도에 찍힌 위치를 얼마나 믿을 수 있는지를 뜻해요.\n\n초록 = 정확 / 주황 = 중간 / 빨강 = 낮음\n\n핀을 누르면 현장 상세가 열리고 길찾기·즐겨찾기·메모를 쓸 수 있어요.', pos: 'below' },
  { sel: '#mobile-map-legend', title: '핀 색, 더 자세히', center: true, text: '● 초록(정확): 등록된 주소 그대로 카카오 주소검색에서 바로 찾은 위치예요. 관리자가 직접 보정한 위치도 초록이에요.\n\n● 주황(중간): 주소 그대로는 못 찾아서 주소를 정리하거나(우편번호·상세 표기 제거) 핵심 도로명만 남겨 다시 찾은 위치예요. 대체로 맞지만 건물 위치와 조금 다를 수 있어요.\n\n● 빨강(낮음): 정확한 주소는 못 찾고 같은 도로 위의 대표 위치로 찍은 곳이에요. 실제 사업장과 떨어져 있을 수 있으니 방문 전 확인하세요.\n\n※ 목록에는 있는데 지도에 핀이 없다면 위치를 아예 못 찾은 사업장이에요.', pos: 'below' },
  { sel: '#mobile-bottom-nav', title: '아래 탭으로 이동', text: '지도 · 현장(목록) · 경로(여러 현장 순서 짜기) · 즐겨찾기 · 더보기로 화면을 옮겨 다녀요.', pos: 'above' },
  { sel: '.mobile-tab-btn[data-tab="more"]', title: '가이드는 다시 볼 수 있어요', text: '더보기 > “사용 가이드 다시 보기”에서 언제든 이 안내를 다시 볼 수 있어요.', pos: 'above' },
];

let root = null, idx = 0, steps = [], resizeHandler = null, keyHandler = null;

function injectStyle() {
  if (document.getElementById('m-tutorial-style')) return;
  const st = document.createElement('style');
  st.id = 'm-tutorial-style';
  st.textContent = `
  #m-tutorial{position:fixed;inset:0;z-index:3000;font-family:Arial,'Noto Sans KR','Malgun Gothic',sans-serif;color:#0b2358;touch-action:manipulation}
  #m-tutorial *{box-sizing:border-box}
  #m-tutorial .mt-block{position:absolute;inset:0}
  #m-tutorial .mt-hole{position:absolute;border-radius:14px;box-shadow:0 0 0 9999px rgba(8,18,38,.7);outline:3px solid #fff;transition:all .25s ease;pointer-events:none}
  #m-tutorial .mt-hand{position:absolute;font-size:40px;line-height:1;filter:drop-shadow(0 3px 4px rgba(0,0,0,.45));pointer-events:none;transition:all .25s ease;animation:mt-tap 1.1s ease-in-out infinite}
  @keyframes mt-tap{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
  #m-tutorial .mt-hand.up{animation-name:mt-tap-up}
  @keyframes mt-tap-up{0%,100%{transform:rotate(180deg) translateY(0)}50%{transform:rotate(180deg) translateY(-6px)}}
  #m-tutorial .mt-tip{position:absolute;left:16px;right:16px;background:#fff;border-radius:18px;padding:18px 20px 16px;box-shadow:0 12px 30px rgba(0,0,0,.45);transition:top .25s ease}
  #m-tutorial .mt-tip h4{font-size:18px;font-weight:900;color:#16326b;margin:0 0 6px}
  #m-tutorial .mt-tip p{font-size:14.5px;line-height:1.6;color:#42536f;margin:0;white-space:pre-line}
  #m-tutorial .mt-ft{display:flex;justify-content:space-between;align-items:center;margin-top:14px}
  #m-tutorial .mt-skip{background:none;border:0;padding:8px 4px;font-size:13.5px;color:#7184a3;font-family:inherit}
  #m-tutorial .mt-no{color:#7184a3;font-size:13.5px}
  #m-tutorial .mt-btns{display:flex;gap:8px}
  #m-tutorial .mt-btn{border:1px solid #c9d7ec;background:#fff;color:#173467;font-weight:800;font-size:14.5px;border-radius:10px;padding:10px 18px;font-family:inherit}
  #m-tutorial .mt-btn.p{background:#0b5ee5;border-color:#0b5ee5;color:#fff}
  `;
  document.head.appendChild(st);
}

function visibleRect(sel) {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) ? r : null;
}

function close(markAsDone) {
  if (markAsDone) markDone();
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
  resizeHandler = keyHandler = null;
  if (root) root.remove();
  root = null;
}

function render() {
  if (!root) return;
  root.textContent = '';
  const step = steps[idx];
  // 가로 스크롤되는 필터 줄에서 화면 밖에 있는 항목(예: 기타)은 먼저 화면 안으로 옮긴다.
  try { const t = document.querySelector(step.sel); if (t && step.sel.startsWith('#site-')) t.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { /* 무시 */ }
  const r = step.center ? null : visibleRect(step.sel); // center: 긴 설명 단계는 대상을 가리지 않게 화면 가운데에 띄운다.
  const pad = 6;
  const vh = window.innerHeight;

  const block = document.createElement('div'); block.className = 'mt-block'; root.appendChild(block);
  const hole = document.createElement('div'); hole.className = 'mt-hole';
  if (r) {
    hole.style.left = Math.max(2, r.left - pad) + 'px';
    hole.style.top = Math.max(2, r.top - pad) + 'px';
    hole.style.width = Math.min(window.innerWidth - 4, r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';
  }
  root.appendChild(hole);

  const tip = document.createElement('div'); tip.className = 'mt-tip';
  const h = document.createElement('h4'); h.textContent = `${idx + 1}. ${step.title}`;
  const p = document.createElement('p'); p.textContent = step.text;
  const ft = document.createElement('div'); ft.className = 'mt-ft';
  const left = document.createElement('div');
  const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'mt-skip';
  skip.textContent = `${idx + 1} / ${steps.length} · 건너뛰기`;
  skip.addEventListener('click', () => close(true));
  left.appendChild(skip);
  const btns = document.createElement('div'); btns.className = 'mt-btns';
  if (idx > 0) {
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'mt-btn'; prev.textContent = '이전';
    prev.addEventListener('click', () => { idx--; render(); });
    btns.appendChild(prev);
  }
  const next = document.createElement('button'); next.type = 'button'; next.className = 'mt-btn p';
  next.textContent = idx === steps.length - 1 ? '시작하기' : '다음';
  next.addEventListener('click', () => { if (idx === steps.length - 1) close(true); else { idx++; render(); } });
  btns.appendChild(next);
  ft.appendChild(left); ft.appendChild(btns);
  tip.appendChild(h); tip.appendChild(p); tip.appendChild(ft);
  root.appendChild(tip);

  // 말풍선·손가락 위치: 대상이 화면 위쪽이면 아래에, 아래쪽이면 위에 둔다.
  const tipH = tip.offsetHeight;
  const hand = document.createElement('div'); hand.className = 'mt-hand'; hand.textContent = '👆';
  if (r) {
    const placeBelow = step.pos === 'below' && (r.bottom + pad + 20 + tipH + 16 < vh);
    if (placeBelow) {
      tip.style.top = (r.bottom + pad + 54) + 'px';
      hand.style.left = Math.min(window.innerWidth - 50, Math.max(8, r.left + Math.min(r.width / 2, 60))) + 'px';
      hand.style.top = (r.bottom + pad - 4) + 'px';
    } else {
      tip.style.top = Math.max(12, r.top - pad - tipH - 54) + 'px';
      hand.classList.add('up');
      hand.style.left = Math.min(window.innerWidth - 50, Math.max(8, r.left + r.width / 2 - 20)) + 'px';
      hand.style.top = (r.top - pad - 46) + 'px';
    }
    root.appendChild(hand);
  } else {
    tip.style.top = Math.max(12, (vh - tipH) / 2) + 'px';
  }
}

export function startMobileTutorial() {
  if (!isMobile() || root) return;
  // 지도 탭에서 시작해야 검색/필터/범례가 보인다.
  const mapTab = document.querySelector('.mobile-tab-btn[data-tab="map"]');
  const mapActive = mapTab && mapTab.classList.contains('active');
  if (mapTab && !mapActive) mapTab.click();
  setTimeout(() => {
    if (root) return;
    steps = STEPS.filter(s => visibleRect(s.sel));
    if (!steps.length) return;
    injectStyle();
    idx = 0;
    root = document.createElement('div'); root.id = 'm-tutorial';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '사용 가이드');
    document.body.appendChild(root);
    resizeHandler = () => { if (!isMobile()) close(false); else render(); };
    window.addEventListener('resize', resizeHandler);
    keyHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    document.addEventListener('keydown', keyHandler, true);
    render();
  }, mapActive ? 0 : 400);
}

export function maybeStartMobileTutorial() {
  if (!isMobile() || isDone()) return;
  setTimeout(() => { if (!isDone() && isMobile()) startMobileTutorial(); }, 1500);
}
