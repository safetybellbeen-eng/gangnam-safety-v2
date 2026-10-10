// 자동테스트 실행기: `npm test`
// 로컬 서버를 띄우고, 가짜 지도/가짜 DB 응답으로 핵심 화면 동작을 점검한다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startServer, launch, openLoggedIn, BASE, FAKE_KAKAO_SDK } from './helpers.mjs';

const require = createRequire(import.meta.url);
const results = [];
async function test(name, fn) {
  // 느린 서버(GitHub Actions)에서 가끔 생기는 타이밍 문제를 줄이려고 실패 시 1회만 다시 시도한다.
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await fn(); results.push([name, true]); console.log('PASS', name, attempt > 1 ? '(재시도 후 통과)' : ''); return; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 700)); }
  }
  results.push([name, false, lastErr.message]);
  console.log('FAIL', name, '-', lastErr.message);
  console.log(`::error title=테스트 실패::${name} - ${String(lastErr.message).split('\n')[0]}`);
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || ''} 기대=${b} 실제=${a}`); };
// meta-viewport 규칙 제외: 지도 핀치줌 시 화면이 깨지는 문제(사용자 요청)로 의도적으로 확대를 막고 있다.
const ok = (c, msg) => { if (!c) throw new Error(msg || 'assert'); };
const items = (page) => page.evaluate(() => document.querySelectorAll('#site-list .site-list-item').length);

const server = await startServer();
const browser = await launch();
try {
  // ── 소스 정적 점검 ──────────────────────────────────────────
  await test('일반 사용자 엑셀 내보내기 상한은 100행', async () => {
    ok(/EXPORT_MAX_ROWS_USER\s*=\s*100\b/.test(fs.readFileSync('js/ui.js', 'utf8')));
  });
  await test('MFA 코드가 남아 있지 않다', async () => {
    ok(!/mfa/i.test(fs.readFileSync('js/app.js', 'utf8')));
  });

  // ── PC 웹 ──────────────────────────────────────────────────
  {
    const { page, errors } = await openLoggedIn(browser, { width: 1400, height: 900 });
    await test('PC: 로그인 후 승인 화면 진입, JS 오류/CSP 위반 없음', async () => { eq(errors.length, 0, errors.join(' | ')); });
    await page.click('.pc-nav-btn[data-pc-tab="map"]'); await page.waitForTimeout(500);
    await test('PC: 행정동 "기본" 상태에서는 목록이 비어 있다', async () => {
      eq(await page.evaluate(() => window.__st.dongDefault), true); eq(await items(page), 0);
    });
    await test('PC: 행정동 "전체" 선택 시 목록 표시, "기본" 복귀 시 다시 비어 있음, 검색하면 표시', async () => {
      await page.click('#site-dong-filter-label'); await page.click('#site-dong-filter-clear'); await page.waitForTimeout(400);
      ok((await items(page)) > 0, '전체 선택 후 목록 없음');
      await page.click('#site-dong-filter-label'); await page.click('#site-dong-filter-default'); await page.waitForTimeout(400);
      eq(await items(page), 0, '기본 복귀');
      await page.fill('#site-search-input', '현장 3'); await page.waitForTimeout(500);
      ok((await items(page)) > 0, '검색 결과 없음');
      await page.fill('#site-search-input', '');
    });
    await test('PC: 즐겨찾기 "지도에서 보기"는 즐겨찾기 현장만 지도에 크게 보여준다', async () => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.click('.pc-nav-btn[data-pc-tab="favorite"]'); await page.waitForTimeout(500);
      await page.click('#pc-favorite-map-view-btn');
      await page.waitForFunction(() => document.querySelectorAll('#site-list .site-list-item').length === 3, null, { timeout: 5000 }).catch(() => {});
      const s = await page.evaluate(() => ({ tab: document.getElementById('app').dataset.pcTab, fo: window.__st.favoriteOnly, banner: !document.getElementById('pc-fav-map-banner').hidden, n: document.querySelectorAll('#site-list .site-list-item').length }));
      const diag = await page.evaluate(() => `favs=${window.__st.favoriteSiteIds.size} tab=${document.getElementById('app').dataset.pcTab} dongDefault=${window.__st.dongDefault}`);
      eq(s.tab, 'map'); eq(s.fo, true); eq(s.banner, true); eq(s.n, 3, diag + ' 목록 수');
      const big = await page.evaluate(() => Math.max(...(window.__mk || []).slice(-3).map((m) => (m._img && m._img.size ? m._img.size.h : 0))));
      ok(big >= 46, '보기 모드 핀이 커지지 않음(h=' + big + ')');
      await page.click('#pc-fav-map-banner-exit'); await page.waitForTimeout(400);
      eq(await page.evaluate(() => window.__st.favoriteOnly), false, '종료 후 즐겨찾기만 보기 해제');
      eq(await page.evaluate(() => !!window.__st.favMapBig), false, '종료 후 핀 크기 복귀');
    });
    await test('PC: 보기 모드에서 다른 탭으로 나가면 모드가 해제된다', async () => {
      await page.click('.pc-nav-btn[data-pc-tab="favorite"]'); await page.waitForTimeout(300);
      await page.click('#pc-favorite-map-view-btn'); await page.waitForTimeout(300);
      await page.click('.pc-nav-btn[data-pc-tab="site"]'); await page.waitForTimeout(400);
      eq(await page.evaluate(() => window.__st.favoriteOnly), false);
    });
    await test('PC: 경로 탭 "주변 사업장 핀 보기"는 기본 꺼짐, 켜면 관할별로 표시', async () => {
      await page.click('.pc-nav-btn[data-pc-tab="route"]'); await page.waitForTimeout(600);
      eq(await page.evaluate(() => !!window.__st.routeNearbyPins), false, '기본값');
      eq(await page.textContent('.route-nearby-count'), '꺼짐');
      await page.click('label.route-nearby-head'); await page.waitForTimeout(400);
      eq(await page.textContent('.route-nearby-count'), '29곳');
      await page.click('.route-nearby-chip[data-dong="역삼동"]'); await page.waitForTimeout(300);
      eq(await page.textContent('.route-nearby-count'), '14곳');
      await page.click('label.route-nearby-head'); await page.waitForTimeout(300);
      eq(await page.textContent('.route-nearby-count'), '꺼짐');
    });
    await test('PC: 접근성(axe) serious/critical 위반 없음', async () => {
      await page.click('.pc-nav-btn[data-pc-tab="map"]'); await page.waitForTimeout(400);
      const v = await page.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'], rules: { 'meta-viewport': { enabled: false } } })).violations.filter((x) => ['serious', 'critical'].includes(x.impact)).map((x) => x.id + ':' + x.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(',')));
      eq(v.length, 0, v.join(' / '));
    });
    await page.close();
  }

  // ── 모바일/TWA ─────────────────────────────────────────────
  {
    const { page, errors } = await openLoggedIn(browser, { width: 390, height: 800 });
    await test('모바일: 로그인 후 JS 오류/CSP 위반 없음', async () => { eq(errors.length, 0, errors.join(' | ')); });
    await page.click('[data-tab="map"]').catch(() => {}); await page.waitForTimeout(500);
    await test('모바일: 필터 줄이 한 줄에 들어오고 검색모드 라벨은 "검색"', async () => {
      const r = await page.evaluate(() => {
        const row = document.getElementById('site-filter-row');
        const kids = [...row.children].filter((c) => c.offsetParent !== null);
        const tops = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().top)));
        return { lines: tops.size, overflow: row.scrollWidth > row.clientWidth + 1, label: document.querySelector('#site-search-mode-filter summary')?.textContent.trim() };
      });
      eq(r.lines, 1, '줄 수'); eq(r.overflow, false, '가로 넘침'); eq(r.label, '검색');
    });
    await test('모바일: 기본 상태 빈 목록 + 안내문', async () => {
      eq(await items(page), 0);
      ok(await page.evaluate(() => !!document.querySelector('#site-list .site-list-hint')), '안내문 없음');
    });
    await test('모바일: 기타 필터(즐겨찾기/메모) 동작', async () => {
      await page.click('#site-etc-filter-label');
      await page.click('label:has(#site-etc-favorite)'); await page.waitForTimeout(400); eq(await items(page), 3, '즐겨찾기');
      await page.click('label:has(#site-etc-note)'); await page.waitForTimeout(400); eq(await items(page), 4, '즐겨찾기+메모');
      await page.click('label:has(#site-etc-favorite)'); await page.waitForTimeout(400); eq(await items(page), 2, '메모');
      await page.click('label:has(#site-etc-note)'); await page.waitForTimeout(400); eq(await items(page), 0, '해제');
    });
    await test('모바일: 공사금액 "자세히 설정"으로 억원 범위 직접 입력', async () => {
      await page.evaluate(() => { window.__st.dongDefault = false; window.__st.selectedDongs = []; });
      await page.click('#site-amount-filter-label'); await page.click('#site-amount-filter-custom-toggle');
      ok(await page.isVisible('#site-amount-filter-custom-apply'), '적용 버튼이 화면에 안 보임');
      await page.fill('#site-amount-filter-min-input', '10'); await page.fill('#site-amount-filter-max-input', '20');
      await page.click('#site-amount-filter-custom-apply'); await page.waitForTimeout(500);
      eq(await page.textContent('#site-amount-filter-label'), '10억~20억');
      eq(await items(page), 12, '10~20억 사업장 수');
      await page.evaluate(() => { window.__st.dongDefault = true; window.__st.amountFilter = 'all'; });
    });
    await test('모바일: 사용 가이드가 열린다', async () => {
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('gnmap:mobile-guide')));
      await page.waitForSelector('#m-tutorial', { timeout: 3000 });
      ok(/1\.\s/.test(await page.evaluate(() => document.getElementById('m-tutorial').innerText)), '1단계 제목 없음');
    });
    await test('모바일: 접근성(axe) serious/critical 위반 없음', async () => {
      await page.evaluate(() => document.getElementById('m-tutorial')?.remove());
      const v = await page.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'], rules: { 'meta-viewport': { enabled: false } } })).violations.filter((x) => ['serious', 'critical'].includes(x.impact)).map((x) => x.id + ':' + x.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(',')));
      eq(v.length, 0, v.join(' / '));
    });
    await page.close();
  }
  // ── 회원가입 완료 화면(PC 카드 / 모바일 기존 화면) ───────────────
  for (const [w, h, tag] of [[1400, 800, 'PC'], [390, 844, '모바일']]) {
    await test(`${tag}: 회원가입 신청 후 가입 완료 화면이 정상 표시되고 로그인으로 돌아간다`, async () => {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const errs = []; page.on('pageerror', (e) => errs.push(e.message));
      await page.addInitScript(FAKE_KAKAO_SDK);
      await page.route('https://kuphyemtyamglvyjpvwh.supabase.co/**', (r) => {
        const p = new URL(r.request().url()).pathname; const J = (o, st = 200) => r.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(o) });
        if (p === '/auth/v1/signup') return J({ id: 'u1', email: 'gildong01@x.local', aud: 'authenticated', role: 'authenticated', identities: [{}] });
        if (p.includes('/rpc/gnmap_v2_verify_signup_code')) return J({ ok: true });
        if (p.includes('/rpc/gnmap_v2_check_id_exists')) return J(false);
        if (p.startsWith('/auth/v1/')) return J({}, 401);
        return J([]);
      });
      await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-email', { state: 'visible' });
      await page.evaluate(() => { const sp = document.getElementById('mobile-splash'); if (sp) sp.style.display = 'none'; });
      await page.evaluate(() => { const e = [...document.querySelectorAll('#view-login button, #view-login a')].find((x) => /회원가입/.test(x.textContent) && x.offsetParent); e && e.click(); });
      await page.waitForSelector('#signup-form', { state: 'visible' });
      await page.selectOption('#signup-org', '강남지청'); await page.fill('#signup-name', '홍길동'); await page.fill('#signup-email', 'gildong01');
      await page.fill('#signup-password', 'Abcd1234!x'); await page.fill('#signup-password-confirm', 'Abcd1234!x'); await page.fill('#signup-code', '123456');
      await page.evaluate(() => { const c = document.getElementById('signup-privacy-agree'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.click('#signup-form button[type="submit"]'); await page.waitForTimeout(1000);
      const s = await page.evaluate(() => ({ card: document.getElementById('pc-signupdone-card').offsetParent !== null, id: document.getElementById('pc-signupdone-id').textContent, btn: document.getElementById('signup-done-to-login').offsetParent !== null }));
      eq(s.id, 'gildong01');
      if (w > 768) eq(s.card, true, 'PC 카드 미표시'); else { eq(s.card, false, '모바일에 PC 카드 노출'); eq(s.btn, true, '모바일 버튼 없음'); }
      await page.click(w > 768 ? '#pc-signupdone-to-login' : '#signup-done-to-login'); await page.waitForTimeout(400);
      ok(await page.evaluate(() => getComputedStyle(document.getElementById('view-login')).display !== 'none'), '로그인 화면 복귀 실패');
      eq(errs.length, 0, errs.join('|'));
      await page.close();
    });
  }

  // ── 감독일정 달력(PC): 감독/점검 색 구분, 담당자 이니셜, 장기 일정 띠, 미리보기 ──
  {
    const { page, errors } = await openLoggedIn(browser, { width: 1400, height: 900 });
    const ymd = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const row = (id, ty, a, b, m) => ({ id, title: id, supervision_type: ty, start_date: ymd(a), end_date: ymd(b), manager_name: m, status: 'scheduled' });
    const rows = [row('장기점검', 'inspection', -40, 40, '강남지청 김지훈'), row('집중감독', 'supervision', 0, 2, '강남지청 최영호'), row('현장점검', 'inspection', 0, 0, '강남지청 박세진')];
    await page.route('https://kuphyemtyamglvyjpvwh.supabase.co/rest/v1/gnmap_v2_supervisions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }));
    await page.click('.pc-nav-btn[data-pc-tab="supervision"]');
    await page.waitForSelector('.pc-sv-bar', { timeout: 10000 });
    await test('감독일정 달력: 감독/점검 색이 다르고 라벨이 있다', async () => {
      const c = await page.evaluate(() => ({
        sup: getComputedStyle(document.querySelector('.pc-sv-bar.is-kind-sup')).backgroundColor,
        ins: getComputedStyle(document.querySelector('.pc-sv-bar.is-kind-ins')).backgroundColor,
        tags: [...document.querySelectorAll('.pc-sv-bar .pc-sv-bar-tag')].map((x) => x.textContent),
      }));
      ok(c.sup !== c.ins, '감독/점검 색이 같다');
      ok(c.tags.includes('감독') && c.tags.includes('점검'), '라벨 누락');
    });
    await test('감독일정 달력: 담당자 이니셜, 장기 일정 띠, 감독/점검 건수', async () => {
      const r = await page.evaluate(() => ({
        av: document.querySelectorAll('.pc-sv-bar .pc-sv-av, .pc-sv-longchip .pc-sv-av').length,
        panelNames: [...document.querySelectorAll('.pc-sv-drow .pc-sv-av')].map((x) => x.textContent),
        longChips: document.querySelectorAll('.pc-sv-longchip').length,
        longInGrid: [...document.querySelectorAll('.pc-sv-bar .pc-sv-bar-title')].some((x) => x.textContent === '장기점검'),
        stat: document.querySelector('.pc-sv-stat-total .pc-sv-stat-sub')?.textContent || '',
      }));
      eq(r.av, 0, '달력 막대/띠에 담당자 이름이 표시됨');
      ok(r.panelNames.includes('영호') && r.panelNames.includes('세진'), '선택 날짜 패널 담당자 이름 누락 ' + r.panelNames);
      eq(r.longChips, 1, '장기 일정 띠');
      eq(r.longInGrid, false, '장기 일정이 달력 칸에도 그려짐');
      ok(/감독 1 · 점검 2/.test(r.stat), '건수 표시 ' + r.stat);
    });
    await test('감독일정 달력: 막대에 마우스를 올리면 미리보기가 뜨고 벗어나면 사라진다', async () => {
      await page.hover('.pc-sv-bar.is-kind-sup'); await page.waitForTimeout(150);
      ok(await page.evaluate(() => /집중감독/.test(document.querySelector('.pc-sv-tip')?.textContent || '')), '미리보기 없음');
      await page.mouse.move(5, 5); await page.waitForTimeout(150);
      eq(await page.locator('.pc-sv-tip').count(), 0, '미리보기 잔존');
    });
    await test('감독일정 달력: 선택 날짜 패널은 감독/점검으로 묶고, 일정을 누르면 상세 팝업이 열린다', async () => {
      const g = await page.evaluate(() => [...document.querySelectorAll('.pc-sv-dgroup-head')].map((x) => x.textContent));
      ok(g.some((x) => /^감독/.test(x)) && g.some((x) => /^점검/.test(x)), '묶음 제목 ' + g);
      await page.click('.pc-sv-drow:has-text("집중감독")'); await page.waitForTimeout(200);
      ok(await page.evaluate(() => /감독일정 상세/.test(document.querySelector('.pc-modal')?.textContent || '')), '상세 팝업 없음');
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    });
    await test('감독일정 달력: 우측에 "다른 날짜 일정"은 없고 "만료 예정"(5일 이내 진행 중)만 보인다', async () => {
      const r = await page.evaluate(() => ({ other: !!document.querySelector('.is-other-card'), exp: [...document.querySelectorAll('.pc-sv-exprow .pc-sv-drow-title')].map((x) => x.textContent), badge: document.querySelector('.pc-sv-expbadge')?.textContent || '' }));
      eq(r.other, false, '다른 날짜 일정 카드가 남아 있음');
      ok(r.exp.includes('집중감독') && r.exp.includes('현장점검') && !r.exp.includes('장기점검'), '만료 예정 목록 ' + r.exp); // 오늘 끝나는 일정도 포함, 40일 뒤 끝나는 장기 일정은 제외
    });
    await test('감독일정 달력: 담당자 칩으로 필터된다', async () => {
      await page.click('.pc-sv-mgrchip:has-text("최영호")'); await page.waitForTimeout(200);
      const t = await page.evaluate(() => [...document.querySelectorAll('.pc-sv-bar .pc-sv-bar-title')].map((x) => x.textContent));
      ok(new Set(t).size === 1 && t[0] === '집중감독', '필터 결과 ' + t); // 주를 넘어가는 일정은 막대가 두 개로 나뉘므로 제목 종류로 비교한다.
    });
    eq(errors.length, 0, errors.join(' | '));
    await page.close();
  }

} finally {
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['## 자동테스트 결과 ' + `${results.length - failed.length}/${results.length} 통과`, '', ...results.map((r) => (r[1] ? '- ✅ ' : '- ❌ ') + r[0] + (r[1] ? '' : ` — ${String(r[2]).split('\n')[0]}`))].join('\n');
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch (e) { /* 요약 기록 실패는 무시 */ }
}
process.exit(failed.length ? 1 : 0);
