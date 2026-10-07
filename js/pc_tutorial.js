// PC(웹) 첫 로그인 튜토리얼: 환영 모달(시안 A) → 사이드 메뉴 스포트라이트 투어(시안 B).
// - 모바일/TWA(768px 이하)에서는 동작하지 않는다.
// - "봤는지" 여부는 사용자별로 이 브라우저(localStorage)에만 저장한다(DB 변경 없음).
// - 우측 상단 이름 메뉴의 "사용 가이드 다시 보기"에서 언제든 다시 볼 수 있다.
import { state } from './state.js';

const KEY_PREFIX = 'gnmap_v2_tutorial_done_';
const isDesktop = () => window.innerWidth >= 769;
const uid = () => (state.user && state.user.id) || (state.profile && state.profile.id) || 'anon';
const isDone = () => { try { return localStorage.getItem(KEY_PREFIX + uid()) === '1'; } catch (e) { return false; } };
const markDone = () => { try { localStorage.setItem(KEY_PREFIX + uid(), '1'); } catch (e) { /* 저장 불가 시 다음에 다시 표시될 뿐 */ } };

let root = null;
let resizeHandler = null;
let keyHandler = null;

function injectStyle() {
  if (document.getElementById('pc-tutorial-style')) return;
  const st = document.createElement('style');
  st.id = 'pc-tutorial-style';
  st.textContent = `
  #pc-tutorial{position:fixed;inset:0;z-index:2000;font-family:Arial,'Noto Sans KR','Malgun Gothic',sans-serif;color:#0b2358}
  #pc-tutorial *{box-sizing:border-box}
  #pc-tutorial .tt-dim{position:absolute;inset:0;background:rgba(8,22,56,.66)}
  #pc-tutorial .tt-hole{position:absolute;border-radius:10px;box-shadow:0 0 0 9999px rgba(8,22,56,.66),0 0 0 4px #4d9bff;transition:all .25s ease;pointer-events:none}
  #pc-tutorial .tt-pulse{position:absolute;width:20px;height:20px;border-radius:50%;background:#4d9bff;box-shadow:0 0 0 8px rgba(77,155,255,.35);pointer-events:none;transition:all .25s ease}
  #pc-tutorial .tt-block{position:absolute;inset:0}
  #pc-tutorial .tt-bubble{position:absolute;width:400px;background:#fff;border-radius:14px;padding:22px 24px 20px;box-shadow:0 18px 50px rgba(0,0,0,.4);transition:top .25s ease,left .25s ease}
  #pc-tutorial .tt-bubble:before{content:"";position:absolute;border:10px solid transparent}
  #pc-tutorial .tt-bubble.is-left:before{left:-10px;top:30px;border-left:0;border-right-color:#fff}
  #pc-tutorial .tt-bubble.is-below:before{top:-10px;right:36px;border-top:0;border-bottom-color:#fff}
  #pc-tutorial .tt-n{font-size:12.5px;font-weight:800;color:#0b63f6;margin-bottom:6px}
  #pc-tutorial .tt-bubble h2{font-size:20px;font-weight:900;margin:0 0 8px}
  #pc-tutorial .tt-bubble p{font-size:14px;line-height:1.65;color:#40557d;margin:0;white-space:pre-line}
  #pc-tutorial .tt-row{display:flex;justify-content:space-between;align-items:center;margin-top:18px}
  #pc-tutorial .tt-dots{display:flex;gap:7px;align-items:center}
  #pc-tutorial .tt-dots i{width:8px;height:8px;border-radius:50%;background:#cfdcf0}
  #pc-tutorial .tt-dots i.on{width:22px;border-radius:6px;background:#0b63f6}
  #pc-tutorial .tt-btn{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 16px;border-radius:8px;font-size:13.5px;font-weight:800;border:1px solid #c9d7ec;background:#fff;color:#173467;cursor:pointer;font-family:inherit}
  #pc-tutorial .tt-btn.p{background:#0b63f6;border-color:#0b63f6;color:#fff}
  #pc-tutorial .tt-btn:hover{filter:brightness(.96)}
  #pc-tutorial .tt-skip{position:absolute;right:24px;bottom:24px;background:#fff;border:0;border-radius:999px;padding:10px 18px;font-size:13.5px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer;color:#0b2358;font-family:inherit}
  /* 환영 모달 */
  #pc-tutorial .tw-modal{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:820px;max-width:94vw;height:470px;background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.4);display:flex;overflow:hidden}
  #pc-tutorial .tw-left{width:350px;background:linear-gradient(160deg,#0b2d6b,#1a5bd6);color:#fff;padding:38px 32px;display:flex;flex-direction:column}
  #pc-tutorial .tw-left h3{font-size:13px;opacity:.8;letter-spacing:.08em;margin:0 0 14px;font-weight:700}
  #pc-tutorial .tw-left h1{font-size:28px;line-height:1.35;font-weight:900;margin:0 0 14px}
  #pc-tutorial .tw-left p{font-size:14.5px;line-height:1.7;opacity:.92;margin:0}
  #pc-tutorial .tw-ill{margin-top:auto;height:130px;border-radius:14px;background:rgba(255,255,255,.12);position:relative;overflow:hidden}
  #pc-tutorial .tw-pin{position:absolute;width:24px;height:24px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.3)}
  #pc-tutorial .tw-right{flex:1;padding:36px 38px 30px;display:flex;flex-direction:column}
  #pc-tutorial .tw-right h2{font-size:22px;font-weight:900;margin:0 0 6px}
  #pc-tutorial .tw-sub{font-size:13.5px;color:#61779c;margin-bottom:14px}
  #pc-tutorial .tw-feat{display:flex;gap:14px;align-items:flex-start;padding:11px 0;border-bottom:1px solid #e8eef8}
  #pc-tutorial .tw-feat:last-of-type{border:0}
  #pc-tutorial .tw-ic{flex:0 0 36px;height:36px;border-radius:10px;background:#eaf2ff;color:#0b63f6;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px}
  #pc-tutorial .tw-feat b{display:block;font-size:14.5px;margin-bottom:2px}
  #pc-tutorial .tw-feat span{font-size:12.5px;color:#61779c;line-height:1.5}
  #pc-tutorial .tw-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between}
  #pc-tutorial .tw-chk{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#61779c;cursor:pointer;flex-direction:row}
  #pc-tutorial .tw-chk input{margin:0}
  `;
  document.head.appendChild(st);
}

function close(markAsDone) {
  if (markAsDone) markDone();
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
  resizeHandler = keyHandler = null;
  if (root) root.remove();
  root = null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildSteps() {
  const visible = (sel) => { const n = document.querySelector(sel); return !!n && n.getBoundingClientRect().width > 0; };
  const steps = [
    { sel: '.pc-nav-btn[data-pc-tab="map"]', title: '지도 — 핀 색으로 위치 정확도 확인', text: '핀 색은 사업장의 위험도가 아니라, 지도에 찍힌 위치를 얼마나 믿을 수 있는지를 뜻해요. 초록은 정확, 주황은 중간, 빨강은 낮음이에요. 핀이나 왼쪽 목록을 누르면 오른쪽에 상세 정보가 열려요.' },
    { sel: visible('#mobile-map-legend') ? '#mobile-map-legend' : '.pc-nav-btn[data-pc-tab="map"]', title: '핀 색, 더 자세히', text: '● 초록(정확): 등록된 주소 그대로 카카오 주소검색에서 바로 찾은 위치예요. 관리자가 직접 보정한 위치도 초록이에요.\n\n● 주황(중간): 주소 그대로는 못 찾아서 주소를 정리하거나(우편번호·상세 표기 제거) 핵심 도로명만 남겨 다시 찾은 위치예요. 대체로 맞지만 건물 위치와 조금 다를 수 있어요.\n\n● 빨강(낮음): 정확한 주소는 못 찾고 같은 도로 위의 대표 위치로 찍은 곳이에요. 실제 사업장과 떨어져 있을 수 있으니 방문 전 확인하세요.\n\n※ 목록에는 있는데 지도에 핀이 없다면 위치를 아예 못 찾은 사업장이에요.' },
    { sel: '#site-filter-row', title: '사업장 필터링 — 원하는 현장만 골라 보기', text: '관할(동)·공사금액·점검·산재표 필터를 조합해 대상 사업장만 추려요. 선택한 필터는 지도 핀과 목록·현장 탭 표에 함께 적용되고, “필터 초기화”로 한 번에 되돌릴 수 있어요.' },
    { sel: '.pc-global-search', title: '일반주소 검색', text: '도로명·지번·건물명을 입력하면 결과가 나와요. 결과를 누르면 지도에 핀이 찍히고, “주소복사”·“길찾기”도 쓸 수 있어요. 사업장 검색은 왼쪽 목록의 검색창에서 해요.', below: true },
    { sel: '.pc-nav-btn[data-pc-tab="site"]', title: '현장 — 표로 조회하고 지도에서 확인', text: '같은 필터·정렬로 사업장을 표로 찾고, 상세의 “지도보기” 버튼을 누르면 지도에서 바로 위치를 볼 수 있어요.' },
    { sel: '.pc-nav-btn[data-pc-tab="route"]', title: '경로 — 방문 순서 만들기', text: '방문할 현장을 담고 순서를 정하면 지도에 번호 핀으로 표시돼요. 방문 완료도 체크할 수 있어요.' },
    { sel: '.pc-nav-btn[data-pc-tab="favorite"]', title: '즐겨찾기 — 자주 가는 현장만 모아보기', text: '별(☆)을 눌러 등록한 현장만 표와 미니 지도로 확인해요.' },
    { sel: '.pc-nav-btn[data-pc-tab="supervision"]', title: '감독일정관리 — 달력으로 일정 관리', text: '감독 일정을 등록·수정하고 예정/진행/완료 현황을 한눈에 확인해요.' },
    { sel: '.pc-nav-btn[data-pc-tab="notes"]', title: '현장 메모 — 현장별 메모 작성', text: '점검 사항을 빠르게 입력하고 임시저장해요. 현장 상세의 “상세 메모” 버튼으로도 넘어올 수 있어요.' },
  ];
  if (visible('.pc-nav-btn[data-pc-tab="upload"]')) {
    steps.push({ sel: '.pc-nav-btn[data-pc-tab="upload"]', title: '사업장 데이터 관리 · 회원관리 (관리자)', text: '엑셀 업로드로 사업장 데이터를 갱신하고, 회원관리에서 가입 승인과 권한을 관리해요. 관리자 계정에만 보여요.' });
  }
  steps.push({ sel: '.pc-user-area', title: '내 정보 · 설정 · 가이드', text: '이름을 누르면 비밀번호 변경, 알림 설정, 앱 설정이 열려요. 이 안내는 “사용 가이드 다시 보기”에서 언제든 다시 볼 수 있어요.', below: true, last: true });
  return steps.filter(s => document.querySelector(s.sel));
}

function showWelcome(onStart) {
  root.innerHTML = '';
  root.appendChild(el('div', 'tt-dim'));
  const modal = el('div', 'tw-modal');
  const left = el('div', 'tw-left');
  left.appendChild(el('h3', '', '산업안전 순찰지도'));
  left.appendChild(el('h1', '', '처음 오셨네요!\n1분이면 핵심 기능을\n익힐 수 있어요'));
  left.lastChild.style.whiteSpace = 'pre-line';
  left.appendChild(el('p', '', '메뉴별로 어떤 일을 할 수 있는지\n빠르게 안내해 드릴게요.'));
  left.lastChild.style.whiteSpace = 'pre-line';
  const ill = el('div', 'tw-ill');
  [['50px', '64px', '#1f9d55'], ['115px', '34px', '#e8a21a'], ['170px', '78px', '#e5484d'], ['225px', '46px', '#1a73e8']].forEach(([l, t, c], i) => {
    const p = el('div', 'tw-pin'); p.style.cssText = `left:${l};top:${t};background:${c};${i === 3 ? 'width:32px;height:32px' : ''}`; ill.appendChild(p);
  });
  left.appendChild(ill);
  const right = el('div', 'tw-right');
  right.appendChild(el('h2', '', '이런 것들을 할 수 있어요'));
  right.appendChild(el('div', 'tw-sub', '왼쪽 메뉴를 하나씩 짚어 가며 설명해 드려요.'));
  [['●', '지도에서 한눈에', '핀 색으로 위치 정확도를 확인하고, 관할·공사금액·점검·산재표 필터로 원하는 사업장만 골라 봐요.'],
   ['↗', '경로 · 즐겨찾기', '방문할 현장을 담아 순서를 만들고, 자주 가는 현장은 즐겨찾기로 모아요.'],
   ['✎', '일정 · 메모', '감독일정을 달력으로 관리하고, 현장별 메모를 남겨요.']].forEach(([ic, b, s]) => {
    const f = el('div', 'tw-feat');
    f.appendChild(el('div', 'tw-ic', ic));
    const t = el('div'); t.appendChild(el('b', '', b)); t.appendChild(el('span', '', s)); f.appendChild(t);
    right.appendChild(f);
  });
  const foot = el('div', 'tw-foot');
  const chkLabel = el('label', 'tw-chk');
  const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = true;
  chkLabel.appendChild(chk); chkLabel.appendChild(document.createTextNode('다음부터 보지 않기'));
  const btns = el('div'); btns.style.cssText = 'display:flex;gap:8px';
  const skip = el('button', 'tt-btn', '건너뛰기'); skip.type = 'button';
  const start = el('button', 'tt-btn p', '둘러보기 시작 →'); start.type = 'button';
  skip.addEventListener('click', () => close(chk.checked));
  start.addEventListener('click', () => { markDone(); onStart(); }); // 시작하면 중간에 닫아도 다시 뜨지 않게 완료 처리
  btns.appendChild(skip); btns.appendChild(start);
  foot.appendChild(chkLabel); foot.appendChild(btns);
  right.appendChild(foot);
  modal.appendChild(left); modal.appendChild(right);
  root.appendChild(modal);
  start.focus();
}

function runTour() {
  const steps = buildSteps();
  if (!steps.length) { close(true); return; }
  let idx = 0;
  root.innerHTML = '';
  root.appendChild(el('div', 'tt-block'));
  const hole = el('div', 'tt-hole');
  const pulse = el('div', 'tt-pulse');
  const bubble = el('div', 'tt-bubble');
  const skip = el('button', 'tt-skip', '투어 건너뛰기 ✕'); skip.type = 'button';
  skip.addEventListener('click', () => close(true));
  root.appendChild(hole); root.appendChild(pulse); root.appendChild(bubble); root.appendChild(skip);

  function place() {
    const s = steps[idx];
    const target = document.querySelector(s.sel);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const pad = 4;
    hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    bubble.classList.toggle('is-below', !!s.below);
    bubble.classList.toggle('is-left', !s.below);
    const bw = 400;
    if (s.below) {
      pulse.style.cssText = `left:${r.left + r.width / 2 - 10}px;top:${r.bottom - 4}px;opacity:0`;
      bubble.style.left = Math.max(12, Math.min(window.innerWidth - bw - 12, r.right - bw)) + 'px';
      bubble.style.top = (r.bottom + 16) + 'px';
    } else {
      pulse.style.cssText = `left:${r.right - 24}px;top:${r.top + r.height / 2 - 10}px`;
      bubble.style.left = (r.right + 24) + 'px';
      // 긴 설명 말풍선(핀 색 상세 등)이 화면 아래로 잘리지 않도록 실제 높이 기준으로 맞춘다.
      bubble.style.top = Math.max(12, Math.min(window.innerHeight - Math.max(250, bubble.offsetHeight + 12), r.top + r.height / 2 - 40)) + 'px';
    }
  }
  function render() {
    const s = steps[idx];
    bubble.innerHTML = '';
    bubble.appendChild(el('div', 'tt-n', `${idx + 1} / ${steps.length}`));
    bubble.appendChild(el('h2', '', s.title));
    bubble.appendChild(el('p', '', s.text));
    const row = el('div', 'tt-row');
    const dots = el('div', 'tt-dots');
    steps.forEach((_, i) => dots.appendChild(el('i', i === idx ? 'on' : '')));
    const btns = el('div'); btns.style.cssText = 'display:flex;gap:8px';
    if (idx > 0) {
      const prev = el('button', 'tt-btn', '이전'); prev.type = 'button';
      prev.addEventListener('click', () => { idx -= 1; render(); });
      btns.appendChild(prev);
    }
    const next = el('button', 'tt-btn p', idx === steps.length - 1 ? '완료' : '다음'); next.type = 'button';
    next.addEventListener('click', () => { if (idx === steps.length - 1) close(true); else { idx += 1; render(); } });
    btns.appendChild(next);
    row.appendChild(dots); row.appendChild(btns);
    bubble.appendChild(row);
    place();
    next.focus();
  }
  resizeHandler = place;
  window.addEventListener('resize', resizeHandler);
  render();
}

export function startTutorial() {
  if (!isDesktop() || root) return;
  injectStyle();
  root = el('div');
  root.id = 'pc-tutorial';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  document.body.appendChild(root);
  keyHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(true); }
  };
  document.addEventListener('keydown', keyHandler, true);
  showWelcome(runTour);
}

// 첫 로그인(이 브라우저에서 아직 안 본 계정)일 때만 자동 시작한다.
export function maybeStartTutorial() {
  if (!isDesktop() || isDone()) return;
  setTimeout(() => { if (!isDone() && isDesktop()) startTutorial(); }, 1200);
}
