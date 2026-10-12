// 속도 측정 도구(평소에는 화면에 아무것도 나타나지 않는다).
// 주소 뒤에 ?perf=1 을 붙여 열면(예: .../index.html?perf=1) 화면 왼쪽 아래에 단계별 소요 시간이 표시된다.
// 표시된 숫자를 "복사" 버튼으로 복사해 개발자에게 전달하면, 어디가 느린지 정확히 찾을 수 있다.
// 측정 기록은 메모리에만 남고 서버로 전송되지 않는다.
const ENABLED = (() => {
  try {
    if (/[?&]perf=1\b/.test(location.search)) { localStorage.setItem('gnmap_perf', '1'); return true; }
    if (/[?&]perf=0\b/.test(location.search)) { localStorage.removeItem('gnmap_perf'); return false; }
    return localStorage.getItem('gnmap_perf') === '1';
  } catch (e) { return false; }
})();

const marks = [];   // [이름, 페이지 시작 후 ms]
const spans = [];   // [이름, 걸린 ms]
let longTaskCount = 0;
let longTaskTotal = 0;
let panel = null;
let timer = null;

if (ENABLED && typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTaskCount++; longTaskTotal += e.duration; }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 지원하지 않는 브라우저는 무시 */ }
}

export function perfMark(name) {
  if (!ENABLED) return;
  marks.push([name, Math.round(performance.now())]);
  schedulePaint();
}

// 클릭 직후부터 화면이 실제로 그려질 때까지의 시간(탭 전환 체감 속도)을 잰다.
export function perfNextFrame(name) {
  if (!ENABLED) return;
  const t = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    spans.push([name, Math.round(performance.now() - t)]);
    schedulePaint();
  }));
}

function buildText() {
  const lines = [];
  const nav = performance.getEntriesByType('navigation')[0];
  lines.push(`기기: ${navigator.userAgent.replace(/\s+/g, ' ').slice(0, 90)}`);
  lines.push(`화면: ${innerWidth}x${innerHeight}, 네트워크: ${(navigator.connection && navigator.connection.effectiveType) || '-'}`);
  if (nav) lines.push(`문서 로드: DOMReady ${Math.round(nav.domContentLoadedEventEnd)}ms, load ${Math.round(nav.loadEventEnd)}ms`);
  lines.push('--- 단계(시작 후 ms) ---');
  let prev = 0;
  marks.forEach(([n, t]) => { lines.push(`${String(t).padStart(6)}  (+${t - prev})  ${n}`); prev = t; });
  if (spans.length) { lines.push('--- 탭 전환(ms) ---'); spans.forEach(([n, d]) => lines.push(`${String(d).padStart(6)}  ${n}`)); }
  lines.push(`--- 멈춤(50ms 이상 작업) ${longTaskCount}회, 합계 ${Math.round(longTaskTotal)}ms ---`);
  const res = performance.getEntriesByType('resource');
  const total = res.reduce((a, r) => a + (r.transferSize || 0), 0);
  lines.push(`--- 받은 파일 ${res.length}개, 전송 ${Math.round(total / 1024)}KB / 느린 요청 ---`);
  [...res].sort((a, b) => b.duration - a.duration).slice(0, 8).forEach((r) => {
    let n = r.name.replace(location.origin, '');
    try { const u = new URL(r.name); if (u.origin !== location.origin) n = u.host + u.pathname.slice(0, 40); } catch (e) { /* 그대로 */ }
    lines.push(`${String(Math.round(r.duration)).padStart(6)}  ${n.slice(0, 60)}`);
  });
  return lines.join('\n');
}

function schedulePaint() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; paint(); }, 400);
}

function paint() {
  if (!panel) {
    panel = document.createElement('div');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '속도 측정 결과');
    panel.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483000;max-width:min(560px,96vw);max-height:60vh;overflow:auto;background:rgba(10,20,40,.92);color:#e8f0ff;font:11px/1.45 monospace;padding:8px 10px;border-radius:8px;white-space:pre;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;white-space:normal';
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'font:12px sans-serif;padding:3px 10px;border-radius:5px;border:0;background:#2f80ed;color:#fff;cursor:pointer'; b.addEventListener('click', fn); return b; };
    bar.appendChild(mk('복사', () => { try { navigator.clipboard.writeText(buildText()); } catch (e) { /* 복사 불가 시 화면 캡처로 대체 */ } }));
    bar.appendChild(mk('닫기', () => { panel.remove(); panel = null; try { localStorage.removeItem('gnmap_perf'); } catch (e) { /* 무시 */ } }));
    panel.appendChild(bar);
    const pre = document.createElement('div'); pre.className = 'perf-text'; panel.appendChild(pre);
    document.body.appendChild(panel);
  }
  panel.querySelector('.perf-text').textContent = buildText();
}
