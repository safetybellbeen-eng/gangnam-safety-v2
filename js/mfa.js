// 관리자 2단계 인증(MFA, TOTP 인증 앱 방식). Supabase Auth 기본 기능을 사용한다(추가 비용 없음).
// - 인증 앱(구글 OTP 등)을 등록한 관리자는 로그인 후 6자리 코드를 입력해야 앱에 들어올 수 있다.
// - 서버(DB)에서도 같은 조건을 확인한다: 등록한 관리자는 코드 인증(aal2) 없이는 is_gnmap_v2_admin()이
//   false라서 관리자 RPC/RLS가 거부된다(앱 화면을 우회해도 동일).
// - 아직 등록하지 않은 관리자에게는 로그인 때마다 등록 안내를 띄우되 "나중에"로 건너뛸 수 있다
//   (잠금 사고 방지). 폰 분실 시에는 Supabase 대시보드 > Authentication > Users에서 해당 계정의
//   MFA 요소를 삭제하면 다시 등록할 수 있다.
import { sb } from './api.js';
import { state } from './state.js';

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function injectStyle() {
  if (document.getElementById('mfa-style')) return;
  const st = document.createElement('style');
  st.id = 'mfa-style';
  st.textContent = `
  #mfa-overlay{position:fixed;inset:0;z-index:4000;background:rgba(8,18,38,.72);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Arial,'Noto Sans KR','Malgun Gothic',sans-serif}
  #mfa-overlay .mfa-box{background:#fff;color:#0b2358;border-radius:18px;width:min(420px,100%);max-height:94vh;overflow:auto;padding:24px 22px 20px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  #mfa-overlay *{box-sizing:border-box}
  #mfa-overlay h3{margin:0 0 6px;font-size:19px;font-weight:900}
  #mfa-overlay p{margin:0 0 12px;font-size:14px;line-height:1.6;color:#42536f}
  #mfa-overlay .mfa-qr{display:flex;justify-content:center;margin:10px 0}
  #mfa-overlay .mfa-qr img{width:180px;height:180px;border:1px solid #dbe4f3;border-radius:10px;padding:6px;background:#fff}
  #mfa-overlay .mfa-secret{font-family:monospace;font-size:13px;background:#f1f5fb;border-radius:8px;padding:8px 10px;word-break:break-all;user-select:all;margin-bottom:12px}
  #mfa-overlay input{width:100%;font-size:22px;letter-spacing:.3em;text-align:center;padding:12px;border:1.5px solid #c9d7ec;border-radius:10px;margin-bottom:8px;font-family:inherit}
  #mfa-overlay .mfa-err{color:#c0392b;font-size:13px;min-height:18px;margin-bottom:8px}
  #mfa-overlay .mfa-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
  #mfa-overlay button{border:1px solid #c9d7ec;background:#fff;color:#173467;font-weight:800;font-size:14.5px;border-radius:10px;padding:10px 16px;font-family:inherit;cursor:pointer}
  #mfa-overlay button.p{background:#0b5ee5;border-color:#0b5ee5;color:#fff}
  #mfa-overlay button.d{color:#c0392b;border-color:#e6b8b2}
  #mfa-overlay button:disabled{opacity:.55}
  `;
  document.head.appendChild(st);
}

function openBox(build) {
  injectStyle();
  const old = document.getElementById('mfa-overlay'); if (old) old.remove();
  const ov = el('div'); ov.id = 'mfa-overlay';
  const box = el('div', 'mfa-box'); ov.appendChild(box);
  document.body.appendChild(ov);
  build(box, () => ov.remove());
  return ov;
}

async function getAal() {
  const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  return data; // { currentLevel, nextLevel }
}

async function listVerifiedTotp() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return (data && data.totp) || []; // listFactors().totp는 verified 요소만 담는다.
}

// 6자리 코드를 받아 검증한다. 성공 시 true.
function codePrompt(box, { title, desc, onSubmit, extraButtons }) {
  box.textContent = '';
  box.appendChild(el('h3', '', title));
  box.appendChild(el('p', '', desc));
  const input = el('input'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'one-time-code';
  input.maxLength = 6; input.placeholder = '000000'; input.setAttribute('aria-label', '인증 코드 6자리');
  box.appendChild(input);
  const err = el('div', 'mfa-err'); box.appendChild(err);
  const row = el('div', 'mfa-row');
  (extraButtons || []).forEach(b => row.appendChild(b));
  const ok = el('button', 'p', '확인'); ok.type = 'button';
  row.appendChild(ok); box.appendChild(row);
  const submit = async () => {
    const code = input.value.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { err.textContent = '숫자 6자리를 입력해 주세요.'; return; }
    ok.disabled = true; err.textContent = '';
    try { await onSubmit(code); } catch (e) { err.textContent = e && e.message ? '코드가 올바르지 않거나 시간이 지났습니다. 다시 입력해 주세요.' : '인증에 실패했습니다.'; ok.disabled = false; input.value = ''; input.focus(); }
  };
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  setTimeout(() => input.focus(), 50);
}

// 등록 화면: 이미 시도하다 만 미인증 요소는 먼저 지우고 새로 만든다.
async function enrollFlow(box, done) {
  box.textContent = '';
  box.appendChild(el('h3', '', '2단계 인증 등록'));
  box.appendChild(el('p', '', '준비 중입니다…'));
  try {
    const { data: lf } = await sb.auth.mfa.listFactors();
    const all = (lf && lf.all) || [];
    for (const f of all) { if (f.status !== 'verified') { await sb.auth.mfa.unenroll({ factorId: f.id }); } }
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `gnmap-${Date.now()}` });
    if (error) throw error;
    box.textContent = '';
    box.appendChild(el('h3', '', '2단계 인증 등록'));
    box.appendChild(el('p', '', '① 휴대폰에서 인증 앱(Google Authenticator, Microsoft Authenticator 등)을 열고 QR을 스캔하세요. ② 앱에 표시된 6자리 코드를 입력하면 등록이 끝납니다.'));
    const qr = el('div', 'mfa-qr'); const img = el('img'); img.alt = '2단계 인증 QR 코드'; img.src = data.totp.qr_code; qr.appendChild(img); box.appendChild(qr);
    box.appendChild(el('p', '', 'QR 스캔이 안 되면 앱에 아래 키를 직접 입력하세요.'));
    box.appendChild(el('div', 'mfa-secret', data.totp.secret));
    const factorId = data.id;
    const cancel = el('button', '', '취소'); cancel.type = 'button';
    cancel.addEventListener('click', async () => { try { await sb.auth.mfa.unenroll({ factorId }); } catch (e) { /* 무시 */ } done(false); });
    const holder = el('div'); box.appendChild(holder);
    codePrompt(holder, {
      title: '', desc: '앱에 표시된 6자리 코드',
      extraButtons: [cancel],
      onSubmit: async (code) => {
        const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
        if (e2) throw e2;
        box.textContent = '';
        box.appendChild(el('h3', '', '등록 완료'));
        box.appendChild(el('p', '', '다음 로그인부터 6자리 코드를 입력해야 합니다. 휴대폰을 바꾸거나 잃어버리기 전에 새 기기에 미리 등록해 두세요. 문제가 생기면 Supabase 대시보드에서 이 계정의 2단계 인증 요소를 삭제하면 다시 등록할 수 있습니다.'));
        const r = el('div', 'mfa-row'); const b = el('button', 'p', '확인'); b.type = 'button'; b.addEventListener('click', () => done(true)); r.appendChild(b); box.appendChild(r);
      },
    });
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('h3', '', '등록할 수 없습니다'));
    box.appendChild(el('p', '', '2단계 인증을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    const r = el('div', 'mfa-row'); const b = el('button', 'p', '닫기'); b.type = 'button'; b.addEventListener('click', () => done(false)); r.appendChild(b); box.appendChild(r);
  }
}

// 로그인 직후 관리자에게 호출한다. true = 앱 진입 허용, false = 인증 실패/취소(호출부가 로그아웃 처리).
export function runAdminMfaGate() {
  return new Promise(async (resolve) => {
    let aal;
    try { aal = await getAal(); } catch (e) { resolve(true); return; } // 상태를 못 읽으면 막지 않는다(서버가 실제 권한을 제한).
    if (aal.currentLevel === 'aal2') { resolve(true); return; }
    if (aal.nextLevel === 'aal2') {
      // 등록한 관리자: 코드 입력 필수.
      let factors = [];
      try { factors = await listVerifiedTotp(); } catch (e) { /* 아래에서 처리 */ }
      const factor = factors[0];
      if (!factor) { resolve(false); return; }
      openBox((box, close) => {
        const logout = el('button', '', '로그아웃'); logout.type = 'button';
        logout.addEventListener('click', () => { close(); resolve(false); });
        codePrompt(box, {
          title: '관리자 2단계 인증',
          desc: '인증 앱에 표시된 6자리 코드를 입력해 주세요.',
          extraButtons: [logout],
          onSubmit: async (code) => {
            const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
            if (error) throw error;
            close(); resolve(true);
          },
        });
      });
      return;
    }
    // 아직 등록 안 한 관리자: 등록 안내(건너뛰기 가능).
    openBox((box, close) => {
      box.appendChild(el('h3', '', '관리자 2단계 인증을 등록하세요'));
      box.appendChild(el('p', '', '관리자 계정은 회원·사업장 정보를 모두 다룹니다. 비밀번호가 유출돼도 인증 앱의 6자리 코드가 없으면 로그인할 수 없도록 2단계 인증을 켤 수 있습니다. 약 1분 걸립니다.'));
      const row = el('div', 'mfa-row');
      const later = el('button', '', '나중에'); later.type = 'button';
      later.addEventListener('click', () => { close(); resolve(true); });
      const go = el('button', 'p', '지금 등록'); go.type = 'button';
      go.addEventListener('click', () => { enrollFlow(box, (ok) => { close(); resolve(true); }); });
      row.appendChild(later); row.appendChild(go); box.appendChild(row);
    });
  });
}

// 메뉴의 "2단계 인증 설정": 등록/해제.
export async function openMfaSettings() {
  if (!state.profile) return;
  let aal, factors = [];
  try { aal = await getAal(); factors = await listVerifiedTotp(); } catch (e) { aal = null; }
  openBox((box, close) => {
    box.appendChild(el('h3', '', '관리자 2단계 인증'));
    if (factors.length) {
      box.appendChild(el('p', '', '현재 사용 중입니다. 로그인할 때마다 인증 앱의 6자리 코드를 입력해야 합니다.'));
      const row = el('div', 'mfa-row');
      const off = el('button', 'd', '사용 해제'); off.type = 'button';
      const closeBtn = el('button', 'p', '닫기'); closeBtn.type = 'button';
      closeBtn.addEventListener('click', close);
      off.addEventListener('click', () => {
        if (!aal || aal.currentLevel !== 'aal2') { box.insertBefore(el('p', 'mfa-err', '코드 인증을 마친 로그인 상태에서만 해제할 수 있습니다. 다시 로그인해 주세요.'), row); return; }
        codePrompt(box, {
          title: '2단계 인증 해제', desc: '해제하려면 현재 인증 앱의 6자리 코드를 입력하세요.',
          extraButtons: [Object.assign(el('button', '', '취소'), { type: 'button', onclick: close })],
          onSubmit: async (code) => {
            const f = factors[0];
            const { error: e1 } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
            if (e1) throw e1;
            const { error: e2 } = await sb.auth.mfa.unenroll({ factorId: f.id });
            if (e2) throw e2;
            box.textContent = ''; box.appendChild(el('h3', '', '해제되었습니다'));
            const r = el('div', 'mfa-row'); const b = el('button', 'p', '확인'); b.type = 'button'; b.addEventListener('click', close); r.appendChild(b); box.appendChild(r);
          },
        });
      });
      row.appendChild(off); row.appendChild(closeBtn); box.appendChild(row);
    } else {
      box.appendChild(el('p', '', '아직 사용하지 않고 있습니다. 등록하면 로그인 시 인증 앱의 6자리 코드가 필요합니다.'));
      const row = el('div', 'mfa-row');
      const closeBtn = el('button', '', '닫기'); closeBtn.type = 'button'; closeBtn.addEventListener('click', close);
      const go = el('button', 'p', '등록하기'); go.type = 'button';
      go.addEventListener('click', () => enrollFlow(box, () => close()));
      row.appendChild(closeBtn); row.appendChild(go); box.appendChild(row);
    }
  });
}
