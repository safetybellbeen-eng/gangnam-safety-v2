// geocoding.js — STEP 11 최종 보완. Supabase Edge Function(gnmap-v2-geocode) 호출만 담당.
// Kakao REST API를 직접 호출하지 않는다. REST Key는 이 파일에도, 어떤 frontend 파일에도 존재하지 않는다.
import { sb } from './api.js';
import { state } from './state.js';

const CONCURRENCY = 4; // 브라우저에서 대량 동시 호출을 피하기 위한 제한 (양식2 1,244건 대응)

// 단일 주소 1건을 Edge Function에 넘겨 좌표를 조회한다.
// 반환값은 Edge Function 응답 계약을 그대로 전달한다: { success, lat, lng, matchedAddress } | { success:false, reason }
//
// sb.functions.invoke는 Edge Function이 비2xx(4xx/5xx)를 반환하면 data=null, error=FunctionsHttpError를
// 던지므로(Supabase JS 표준 동작), 이 경우 error.context(Response)에서 JSON 본문을 다시 읽어
// 우리가 만든 reason(INVALID_REQUEST/UNAUTHORIZED/FORBIDDEN/KAKAO_API_ERROR 등)을 복원한다.
// context를 읽지 못하는 순수 네트워크/예외 상황에서만 INTERNAL_ERROR로 처리한다.
// JWT/API key/원본 민감 오류 body는 UI/console에 내보내지 않는다.
async function geocodeAddress(address) {
  try {
    const { data, error } = await sb.functions.invoke('gnmap-v2-geocode', {
      body: { address },
    });
    if (error) {
      if (error.context && typeof error.context.json === 'function') {
        try {
          const body = await error.context.json();
          if (body && typeof body.reason === 'string') {
            return { success: false, reason: body.reason };
          }
        } catch (_parseErr) {
          // 본문을 JSON으로 못 읽으면 아래 기본값(INTERNAL_ERROR)으로 폴백.
        }
      }
      return { success: false, reason: 'INTERNAL_ERROR' };
    }
    return data;
  } catch (_e) {
    return { success: false, reason: 'INTERNAL_ERROR' };
  }
}

// STEP 11G. Kakao keyword search 호출. Edge Function의 mode:'keyword' 경로를 사용한다.
// 반환값: { success:true, candidates:[{placeName, addressName, roadAddressName, lat, lng}, ...] } | { success:false, reason }
// 이 함수는 후보 목록만 가져온다 — 어떤 좌표도 여기서 확정/적용하지 않는다.
//
// STEP 11G-LIVE-DEBUG: 운영에서 keyword 요청이 전부 ERROR로 나오는 원인을 확인하기 위한 최소 계측.
// console에는 query와 reason(및 에러 종류 이름)만 남기고, JWT/API key/Authorization/원본 응답 body는 절대 출력하지 않는다.
async function geocodeKeyword(query) {
  try {
    const { data, error } = await sb.functions.invoke('gnmap-v2-geocode', {
      body: { mode: 'keyword', query },
    });
    if (error) {
      // error.context가 없으면 Edge Function까지 도달하지 못한 상태(FunctionsFetchError/FunctionsRelayError 등
      // 네트워크·CORS·타임아웃류)일 가능성이 높다 — 이 경우와 "Edge Function이 응답은 했지만 body.reason이
      // 없거나 파싱 실패"한 경우를 구분해서 남긴다.
      if (error.context && typeof error.context.json === 'function') {
        try {
          const body = await error.context.json();
          if (body && typeof body.reason === 'string') {
            console.warn('[keyword geocode] query:', query, '| reason:', body.reason);
            return { success: false, reason: body.reason };
          }
          console.warn('[keyword geocode] query:', query, '| reason: (응답 body에 reason 필드 없음)');
        } catch (_parseErr) {
          console.warn('[keyword geocode] query:', query, '| reason: (응답 body JSON 파싱 실패)');
        }
      } else {
        console.warn('[keyword geocode] query:', query, '| reason: (error.context 없음 — 네트워크 단계에서 실패, errorName:', error.name || error.constructor?.name, ', message:', error.message, ')');
      }
      return { success: false, reason: 'INTERNAL_ERROR' };
    }
    return data;
  } catch (e) {
    console.warn('[keyword geocode] query:', query, '| reason: (예외 발생, name:', e?.name, ')');
    return { success: false, reason: 'INTERNAL_ERROR' };
  }
}

// STEP 11H-3. 행정안전부(JUSO) 도로명주소 정규화 호출. Edge Function의 mode:'juso' 경로를 사용한다.
// 반환값: { success:true, candidates:[{roadAddr, jibunAddr, zipNo, admCd}, ...] } | { success:false, reason }
// JUSO는 주소 정규화 전용이며 좌표를 반환하지 않는다 — 좌표는 정규화된 roadAddr로 KAKAO_JUSO 단계(geocodeAddress)를
// 별도로 호출해야 얻는다. 이 함수 자체는 좌표를 반환/적용하지 않는다.
async function geocodeJuso(query) {
  try {
    const { data, error } = await sb.functions.invoke('gnmap-v2-geocode', {
      body: { mode: 'juso', query },
    });
    if (error) {
      if (error.context && typeof error.context.json === 'function') {
        try {
          const body = await error.context.json();
          if (body && typeof body.reason === 'string') {
            console.warn('[juso normalize] query:', query, '| reason:', body.reason);
            return { success: false, reason: body.reason };
          }
          console.warn('[juso normalize] query:', query, '| reason: (응답 body에 reason 필드 없음)');
        } catch (_parseErr) {
          console.warn('[juso normalize] query:', query, '| reason: (응답 body JSON 파싱 실패)');
        }
      } else {
        console.warn('[juso normalize] query:', query, '| reason: (error.context 없음 — 네트워크 단계에서 실패, errorName:', error.name || error.constructor?.name, ')');
      }
      return { success: false, reason: 'INTERNAL_ERROR' };
    }
    return data;
  } catch (e) {
    console.warn('[juso normalize] query:', query, '| reason: (예외 발생, name:', e?.name, ')');
    return { success: false, reason: 'INTERNAL_ERROR' };
  }
}

// 동일 정규화 주소는 같은 파일 내에서 1회만 호출하고 결과를 재사용한다 (불필요한 Kakao 호출 절감).
function normalizeForCache(address) {
  return (address || '').trim();
}

// ------------------------------------------------------------
// STEP 11D. 안전한 주소 정제 (원본 문자열의 정보만 사용, 새로 추론/생성하지 않음).
//
// 규칙(매우 보수적):
// 1) 우편번호 괄호 "(NNNNN)"는 항상 제거 가능 (검색에 불필요, 정보 손실 없음).
// 2) 도로명주소 패턴("OO로"/"OO길" + 숫자)이 있는 경우에만 정제를 시도한다.
//    도로명 패턴이 없는 지번주소(예: "논현동 106-7")는 그 자체가 정상 검색 후보이므로 건드리지 않는다.
// 3) 도로명+건물번호(예: "밤고개로15길 20") 뒤에 오는 나머지 텍스트만 정제 대상으로 본다.
//    - 그 나머지가 "(동명)" 형태의 괄호 하나뿐이면, 그 괄호까지만 남기고 이후를 제거한다
//      (동명은 도로명주소와 함께 있어도 무해하거나 오히려 보조 정보가 되므로 보존).
//    - 그 나머지에 괄호 뒤로 추가 텍스트(예: "업무시설용지 B1-3BL")가 붙어 있으면,
//      그 추가 텍스트만 제거한다(괄호 안 동명은 유지).
//    - 콤마로 구분된 복수 필지 정보("208-8, 208-15")는 통째로 보존한다 — 임의로 자르지 않는다.
// 4) 위 조건에 해당하지 않으면(정제할 안전한 지점을 찾지 못하면) 원본을 그대로 반환한다.
//
// 반환값이 원본과 동일(trim 기준)하면 "정제해도 달라지지 않음"을 뜻하며,
// 호출부(runGeocodingForParsedRows)는 이 경우 LEVEL 2 재검색을 시도하지 않는다.
export function normalizeAddressForGeocoding(address) {
  if (!address) return address;

  // 1) 우편번호 괄호 제거
  let a = String(address).replace(/^\(\d{5}\)\s*/, '').trim();
  a = a.replace(/\s+/g, ' ');

  // 2) 도로명주소 패턴이 없으면 정제하지 않는다 (지번주소는 그대로 보존).
  const roadMatch = a.match(/[가-힣0-9]+(로|길)\s*\d+(-\d+)?/);
  if (!roadMatch) return a;

  const roadEndIndex = roadMatch.index + roadMatch[0].length;
  const head = a.slice(0, roadEndIndex).trim(); // "서울 강남구 밤고개로15길 20"
  const tail = a.slice(roadEndIndex).trim();     // 도로명주소 뒤에 남은 나머지

  if (!tail) return a; // 뒤에 아무것도 없으면 정제할 게 없음

  // 3) 뒤에 남은 부분이 "(동명)"으로 시작하는 괄호인지 확인.
  const parenMatch = tail.match(/^\(([^)]*)\)/);
  if (parenMatch) {
    const parenContent = parenMatch[1].trim();
    // 괄호 안이 콤마 없는 순수 동명(예: "자곡동")이면, 그 괄호까지는 보존하고 그 뒤만 제거.
    const isPureDong = /^[가-힣0-9]+동$/.test(parenContent) && !parenContent.includes(',');
    if (isPureDong) {
      return `${head} (${parenContent})`;
    }
    // 괄호 안에 콤마로 복수 필지가 섞여 있으면(예: "논현동208-8, 208-15") 임의로 자르지 않고
    // 안전하게 정제할 지점을 찾지 못한 것으로 보고 원본을 그대로 반환한다.
    return a;
  }

  // 괄호가 아예 없이 도로명주소 뒤에 바로 사업설명 문구가 붙은 경우
  // (예: "학동로 426 강남구청 관할 강남구관내") — 도로명주소까지만 남긴다.
  return head;
}

// ------------------------------------------------------------
// STEP 11E. 핵심 도로명주소(core road address)만 추출한다 — LEVEL 3 전용.
// normalizeAddressForGeocoding과 달리 동명(괄호)조차 보존하지 않고, 순수 "시/구 + 도로명 + 건물번호"만 남긴다
// (Kakao 공식 가이드상 주소검색은 상세주소를 뺀 핵심 도로명주소가 가장 매칭률이 높음).
// 원본에 실제로 존재하는 도로명+건물번호 문자열만 그대로 사용한다 — 새 주소를 추론/생성하지 않는다.
// 도로명 패턴이 명확하지 않으면(지번주소 등) null을 반환해 LEVEL 3를 skip하게 한다.
export function extractCoreRoadAddress(address) {
  if (!address) return null;

  let a = String(address).replace(/^\(\d{5}\)\s*/, '').trim();
  a = a.replace(/\s+/g, ' ');

  // "서울(특별시)? 강남구" 같은 시/구 접두부를 도로명 앞까지 포함해서 찾는다.
  // 도로명 패턴 자체가 없으면(지번주소 등) 핵심주소를 안전하게 추출할 수 없으므로 null.
  const roadMatch = a.match(/[가-힣0-9]+(로|길)\s*\d+(-\d+)?/);
  if (!roadMatch) return null;

  const roadEndIndex = roadMatch.index + roadMatch[0].length;
  const core = a.slice(0, roadEndIndex).trim();

  return core || null;
}

// state.uploadParsedRows 중 ERROR가 아니고 address가 있는 행만 대상으로 geocoding을 순차/제한동시 실행한다.
// concurrency는 4로 제한하며, 한 행의 실패가 나머지 행 처리를 막지 않는다.
// LEVEL 1(원본 주소) 실패 시에만, 정제주소가 원본과 실질적으로 다른 경우 LEVEL 2(정제주소)를 재시도한다.
// onProgress(progress)는 매 행 완료마다 호출되어 UI가 진행상황을 갱신할 수 있게 한다.
export async function runGeocodingForParsedRows(onProgress) {
  const targets = state.uploadParsedRows.filter(
    row => row._validation !== 'ERROR' && row.address
  );

  // 시작 즉시 대상 전체를 PENDING으로 표시한다 (기존 validation 필드는 그대로 둔다).
  targets.forEach(row => {
    row._geocodeStatus = 'PENDING';
    row._geocodeError = null;
    row._geocodeMethod = null;
    row._locationQuality = null;
    row._geocodeSearchedAddress = null;
  });

  const progress = { total: targets.length, done: 0, success: 0, notFound: 0, error: 0 };
  state.geocodeProgress = progress;
  if (typeof onProgress === 'function') onProgress({ ...progress });

  // normalizedAddress -> Promise<result>. 결과 값이 아니라 "진행 중인 Promise 자체"를 캐시해서,
  // concurrency=4 상황에서 같은 주소가 동시에 여러 worker에 의해 cache miss되는 race를 막는다.
  // LEVEL 1(원본)과 LEVEL 2(정제)는 서로 다른 문자열이므로 같은 캐시를 그대로 공유해도 안전하며,
  // 동일 정제주소를 여러 행이 필요로 하는 경우에도 실제 호출은 1회만 발생한다.
  const inFlight = new Map();

  function getOrCreate(address) {
    const key = normalizeForCache(address);
    let promise = inFlight.get(key);
    if (!promise) {
      promise = geocodeAddress(address);
      inFlight.set(key, promise);
    }
    return promise;
  }

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const row = targets[cursor];
      cursor++;

      const originalWithoutZip = normalizeForCache(row.address).replace(/^\(\d{5}\)\s*/, '').replace(/\s+/g, ' ').trim();

      // LEVEL 1: 원본 주소
      row._geocodeSearchedAddress = row.address;
      const originalResult = await getOrCreate(row.address);

      if (originalResult.success) {
        row.lat = originalResult.lat;
        row.lng = originalResult.lng;
        row._geocodeStatus = 'SUCCESS';
        row._geocodeError = null;
        row._geocodeMethod = 'ORIGINAL';
        row._locationQuality = 'EXACT';
        progress.success++;
        progress.done++;
        if (typeof onProgress === 'function') onProgress({ ...progress });
        continue;
      }

      // LEVEL 2: 정제주소가 원본과 실질적으로 다를 때만 재시도한다.
      // 단순 우편번호 제거만으로 달라진 경우는 LEVEL 1과 실질적으로 같은 검색이므로 제외한다.
      const normalizedAddress = normalizeAddressForGeocoding(row.address);
      const normalizedIsDifferent = normalizeForCache(normalizedAddress) !== originalWithoutZip;

      let level2Result = null;
      if (normalizedIsDifferent) {
        row._geocodeSearchedAddress = normalizedAddress;
        level2Result = await getOrCreate(normalizedAddress);
        if (level2Result.success) {
          row.lat = level2Result.lat;
          row.lng = level2Result.lng;
          row._geocodeStatus = 'SUCCESS';
          row._geocodeError = null;
          row._geocodeMethod = 'NORMALIZED';
          row._locationQuality = 'ESTIMATED';
          progress.success++;
          progress.done++;
          if (typeof onProgress === 'function') onProgress({ ...progress });
          continue;
        }
      }

      // LEVEL 3: 핵심 도로명주소. ORIGINAL/NORMALIZED와 실질적으로 다를 때만 재시도한다(중복 호출 방지).
      const coreAddress = extractCoreRoadAddress(row.address);
      const coreIsDifferentFromOriginal = coreAddress && normalizeForCache(coreAddress) !== originalWithoutZip;
      const coreIsDifferentFromNormalized =
        coreAddress && (!normalizedIsDifferent || normalizeForCache(coreAddress) !== normalizeForCache(normalizedAddress));

      let level3Result = null;
      if (coreAddress && coreIsDifferentFromOriginal && coreIsDifferentFromNormalized) {
        row._geocodeSearchedAddress = coreAddress;
        level3Result = await getOrCreate(coreAddress);
        if (level3Result.success) {
          row.lat = level3Result.lat;
          row.lng = level3Result.lng;
          row._geocodeStatus = 'SUCCESS';
          row._geocodeError = null;
          row._geocodeMethod = 'CORE_ADDRESS';
          row._locationQuality = 'ESTIMATED';
          progress.success++;
          progress.done++;
          if (typeof onProgress === 'function') onProgress({ ...progress });
          continue;
        }
      }

      // 모든 레벨 실패. 마지막으로 실제 호출했던 결과(있다면 LEVEL3, 없으면 LEVEL2, 없으면 LEVEL1)를 기준으로 상태를 정한다.
      const lastResult = level3Result || level2Result || originalResult;
      if (lastResult.reason === 'NOT_FOUND') {
        row._geocodeStatus = 'NOT_FOUND';
        row._geocodeError = 'NOT_FOUND';
        row._geocodeMethod = null;
        row._locationQuality = 'UNRESOLVED';
        progress.notFound++;
      } else {
        row._geocodeStatus = 'ERROR';
        row._geocodeError = lastResult.reason || 'ERROR';
        row._geocodeMethod = null;
        row._locationQuality = 'UNRESOLVED';
        progress.error++;
      }

      progress.done++;
      if (typeof onProgress === 'function') onProgress({ ...progress });
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  return progress;
}

// 원본 주소에서 "동" 이름을 안전하게 추출한다. 새 정보를 추론하지 않고, 원본에 이미 있는 "OO동" 패턴만 사용한다.
// 우선 괄호 안 동명("(논현동)")을 찾고, 없으면 "강남구 OO동" 형태(지번주소에서 괄호 없이 쓰이는 경우)를 찾는다.
// 둘 다 실패하면 null (query 생성 시 동 없이 site_name+강남구로만 구성).
function extractDongFromAddress(address) {
  if (!address) return null;
  const s = String(address);
  const parenMatch = s.match(/\(([가-힣]{1,4}동)/);
  if (parenMatch) return parenMatch[1];
  const afterGuMatch = s.match(/구\s+([가-힣]{1,4}동)(?=[\s\d]|$)/);
  if (afterGuMatch) return afterGuMatch[1];
  return null;
}

// keyword query 생성. 1순위: 동+site_name. 동을 못 찾으면 site_name+강남구.
function buildKeywordQuery(row) {
  const dong = extractDongFromAddress(row.address);
  const site = row.site_name || row.company_name || '';
  if (!site) return null;
  return dong ? `${dong} ${site}` : `${site} 강남구`;
}

// 후보 하나를 검증해 MATCH(강남구+원본 동 일치) / WEAK(강남구는 맞지만 동 불일치 또는 동 모름)로 분류한다.
// site_name과 place_name의 문자열 유사도는 참고 점수로만 쓰고 이 분류에는 반영하지 않는다(자동확정 방지).
// row 전체를 STRONG_CANDIDATE로 볼지는 이 함수가 아니라 호출부에서 MATCH 개수를 세어 판단한다
// (MATCH 후보가 여럿이면 어느 것이 맞는지 모호하므로 row 전체를 WEAK로 낮춘다).
function classifyCandidate(candidate, originalDong) {
  const addr = candidate.roadAddressName || candidate.addressName || '';
  const isGangnam = addr.includes('강남구');
  if (!isGangnam) return null; // 강남구가 아니면 후보로도 보지 않는다.

  if (originalDong && addr.includes(originalDong)) {
    return 'MATCH';
  }
  // 동 불일치, 또는 원본 동을 알 수 없는 경우(추출 실패) 모두 WEAK로 취급한다.
  return 'WEAK';
}

// UNRESOLVED 행에 대해 keyword search를 1건씩 실행하고, 후보 목록/상태를 row에 저장한다.
// row._keywordQuery, row._keywordCandidates(최대 3개, 각 candidateStatus 포함), row._keywordSearchStatus를 채운다.
// concurrency=CONCURRENCY로 제한하며, in-flight 캐시(같은 query 재사용)도 동일하게 적용한다.
// targetRow를 넘기면 그 행 1건만 대상으로 실행한다(개별 "위치 후보 찾기" 버튼용).
export async function runKeywordCandidateSearch(onProgress, targetRow) {
  // STEP 11G-LIVE-DEBUG: keyword 검색 시작 시점의 세션 상태를 확인한다.
  // 토큰 값 자체는 절대 출력하지 않고, 세션 존재 여부와 만료 예정 시각만 기록한다 —
  // address geocoding이 끝난 뒤 한참 지나 keyword 버튼을 누르는 흐름이라 세션 만료 가능성을 배제하기 위함.
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      console.warn('[keyword geocode] 세션 없음 — 로그인 만료 가능성');
    } else {
      const expiresAt = session.expires_at ? new Date(session.expires_at * 1000).toISOString() : '(알 수 없음)';
      const nowIso = new Date().toISOString();
      console.warn('[keyword geocode] 세션 확인됨. 만료 예정:', expiresAt, '| 현재 시각:', nowIso);
    }
  } catch (_e) {
    console.warn('[keyword geocode] 세션 확인 중 오류 발생');
  }

  const targets = targetRow
    ? [targetRow]
    : state.uploadParsedRows.filter(row => row._locationQuality === 'UNRESOLVED');

  targets.forEach(row => {
    row._keywordQuery = null;
    row._keywordCandidates = null;
    row._keywordSearchStatus = 'PENDING';
    row._keywordSearchError = null;
  });

  const progress = { total: targets.length, done: 0, strong: 0, weak: 0, none: 0, error: 0 };
  if (typeof onProgress === 'function') onProgress({ ...progress });

  const inFlight = new Map();
  function getOrCreate(query) {
    const key = (query || '').trim();
    let p = inFlight.get(key);
    if (!p) {
      p = geocodeKeyword(query);
      inFlight.set(key, p);
    }
    return p;
  }

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const row = targets[cursor];
      cursor++;

      const query = buildKeywordQuery(row);
      row._keywordQuery = query;

      if (!query) {
        row._keywordSearchStatus = 'NO_CANDIDATE';
        row._keywordCandidates = [];
        progress.none++;
        progress.done++;
        if (typeof onProgress === 'function') onProgress({ ...progress });
        continue;
      }

      const result = await getOrCreate(query);
      const originalDong = extractDongFromAddress(row.address);

      if (!result.success) {
        if (result.reason === 'NOT_FOUND') {
          row._keywordSearchStatus = 'NO_CANDIDATE';
          row._keywordCandidates = [];
          progress.none++;
        } else {
          // STEP 11G-LIVE-DEBUG: 실제 reason을 row에 남겨 UI에서 원인을 바로 확인할 수 있게 한다.
          row._keywordSearchStatus = 'ERROR';
          row._keywordSearchError = result.reason || 'UNKNOWN';
          row._keywordCandidates = [];
          progress.error++;
        }
        progress.done++;
        if (typeof onProgress === 'function') onProgress({ ...progress });
        continue;
      }

      const classified = result.candidates.map(c => ({
        ...c,
        candidateStatus: classifyCandidate(c, originalDong),
      })).filter(c => c.candidateStatus !== null);

      row._keywordCandidates = classified;

      // row 전체를 STRONG으로 보는 조건: "강남구+원본 동이 일치하는 유효 후보(MATCH)가 정확히 1건"일 때만.
      // MATCH가 2건 이상이면 어느 후보가 맞는지 모호하므로 자동으로 명확하다고 판단하지 않고 WEAK로 낮춘다.
      // 원본 동을 추출하지 못한 경우(classifyCandidate가 MATCH를 만들 수 없음)도 자연히 WEAK로 남는다.
      const matchCount = classified.filter(c => c.candidateStatus === 'MATCH').length;

      if (matchCount === 1) {
        row._keywordSearchStatus = 'STRONG_CANDIDATE';
        progress.strong++;
      } else if (classified.length > 0) {
        row._keywordSearchStatus = 'WEAK_CANDIDATE';
        progress.weak++;
      } else {
        row._keywordSearchStatus = 'NO_CANDIDATE';
        progress.none++;
      }

      progress.done++;
      if (typeof onProgress === 'function') onProgress({ ...progress });
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  return progress;
}

// ------------------------------------------------------------
// STEP 11H-1. Kakao LOT(지번) 복구 실험. 기존 ORIGINAL/NORMALIZED/CORE가 모두 실패해
// UNRESOLVED로 남은 행 중, 원본 문자열에 지번이 명시적으로 존재하는 행에 한해서만
// "서울 강남구 {법정동} {지번}" 형태로 Kakao address 검색(geocodeAddress, 기존 함수 재사용)을 재시도한다.
// 새 provider/API/Edge Function 분기는 추가하지 않는다 — address geocoding 경로만 재사용.
// ------------------------------------------------------------

// 원본 주소에서 법정동을 추출한다 (STEP 11G extractDongFromAddress와 동일 규칙, 새 정보 추론 없음).
function extractDongForLot(address) {
  return extractDongFromAddress(address);
}

// 원본 주소에 명시적으로 존재하는 지번(본번 또는 본번-부번)만 추출한다.
// 동명 뒤에 바로 이어지는 숫자 패턴만 지번 후보로 인정한다(도로명 앞 건물번호와 혼동 방지 목적으로
// 항상 "동명 문자열이 실제로 등장하는 지점 이후"에서만 찾는다). 추측/생성 없음 — 원본에 없으면 빈 배열.
//
// 대표 패턴 3가지:
//  - LOT_SINGLE: 동명 바로 뒤 지번 1개만 등장 (예: "(논현동)11-17")
//  - LOT_MULTI: 동명 뒤 콤마로 구분된 지번 여러 개 (예: "논현동 150-4,150-10")
//  - LOT_REPRESENTATIVE: "지번 외 N필지" 패턴에서 대표지번만 (예: "신사동 532-8외 2필지")
// 이 함수는 세 경우 모두 "동명 등장 이후 최초로 나오는 연속된 지번 나열"만 파싱하고,
// "외 N필지"의 N필지 자체는 번호가 없으므로 생성하지 않는다.
//
// 안전 규칙(콤마 구분 지번 검증): 각 콤마 구분 token은 독립적으로 완전한 지번이어야 한다.
// 첫 번째 token은 본번 또는 본번-부번을 허용하지만, 두 번째 이후 token은 반드시 본번-부번
// (하이픈 포함) 형태여야 채택한다. "111-5,6"처럼 두 번째 token이 부번만 있는 축약 표기("6")는
// 그 자체로 완전한 지번인지 불확실하고, "111-6"으로 보정하는 것도 원본에 없는 추론이므로
// 이런 불완전한 token을 만나면 그 이후는 모두 버리고 그 앞까지("111-5")만 채택한다.
function extractLotNumbersFromAddress(address, dong) {
  if (!address || !dong) return [];

  const dongIndex = address.indexOf(dong);
  if (dongIndex === -1) return [];

  // 동명 직후부터 텍스트를 본다. 괄호/공백/콤마는 건너뛰고, 지번 패턴(본번 또는 본번-부번)이
  // 연속해서 콤마로 나열되는 구간만 수집한다. 지번이 아닌 문자(한글 등)가 나오면 그 지점에서 중단한다.
  const afterDong = address.slice(dongIndex + dong.length);

  // 선행 공백/괄호/콤마 등 구분자만 건너뛴다 (예: "도곡동, 547-1"처럼 동명 직후 콤마가 오는 경우도 있음).
  const cleaned = afterDong.replace(/^[),\s]*/, '');

  const lotListMatch = cleaned.match(/^(\d{1,5}(?:-\d{1,4})?(?:\s*,\s*\d{1,5}(?:-\d{1,4})?)*)/);
  if (!lotListMatch) return [];

  const rawTokens = lotListMatch[1].split(',').map(s => s.trim()).filter(Boolean);

  const lots = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i];
    const isFullLot = /^\d{1,5}-\d{1,4}$/.test(token); // 본번-부번(하이픈 포함) 완전한 지번
    const isPlainNumber = /^\d{1,5}$/.test(token);       // 하이픈 없는 순수 본번

    if (i === 0) {
      // 첫 번째 token은 본번 또는 본번-부번 둘 다 허용.
      if (isFullLot || isPlainNumber) {
        lots.push(token);
      } else {
        break; // 첫 token부터 지번 형태가 아니면 더 볼 필요 없음.
      }
    } else {
      // 두 번째 이후 token은 반드시 하이픈 있는 완전한 지번만 허용.
      // 불완전한(부번만 있는 축약) token을 만나면 그 지점에서 나열 자체를 중단한다 — 이후 token도 버린다.
      if (isFullLot) {
        lots.push(token);
      } else {
        break;
      }
    }
  }

  return lots;
}

// 위 3개 함수를 조합해 이 행에 대한 LOT 검색주소 목록을 만든다.
// 반환: string[] (검색 시도 순서대로). 지번을 찾지 못하면 빈 배열(LOT 대상 아님).
export function buildLotQueries(row) {
  const dong = extractDongForLot(row.address);
  if (!dong) return [];

  const lots = extractLotNumbersFromAddress(row.address, dong);
  if (lots.length === 0) return [];

  // LOT_MULTI/LOT_REPRESENTATIVE 모두 "원본에 명시된 지번을 순서대로" 검색한다.
  // 대표지번만 있는 경우(예: "532-8외 2필지")는 lots가 1개뿐이므로 자연히 그 1건만 검색된다.
  return lots.map(lot => `서울 강남구 ${dong} ${lot}`);
}

// UNRESOLVED 행(_locationQuality === 'UNRESOLVED') 중 LOT 검색주소를 만들 수 있는 행만 대상으로,
// 명시된 지번을 순서대로 하나씩 시도한다 — 하나라도 성공하면 그 지점에서 멈춘다(요구사항 3번).
// 모든 지번이 NOT_FOUND면 UNRESOLVED 유지. 이미 SUCCESS인 행(163건)은 targets에 포함되지 않으므로 건드리지 않는다.
export async function runKakaoLotRecovery(onProgress) {
  const targets = state.uploadParsedRows.filter(
    row => row._locationQuality === 'UNRESOLVED' && buildLotQueries(row).length > 0
  );

  targets.forEach(row => {
    row._lotQueries = buildLotQueries(row);
    row._lotStatus = 'PENDING';
    row._lotError = null;
  });

  const progress = { total: targets.length, done: 0, success: 0, notFound: 0, error: 0 };
  if (typeof onProgress === 'function') onProgress({ ...progress });

  // 같은 LOT 검색주소를 여러 행이 시도할 가능성은 낮지만, 다른 cascade 단계와 동일한 안전장치로
  // in-flight Promise 캐시를 그대로 적용한다(중복 호출 방지).
  const inFlight = new Map();
  function getOrCreate(address) {
    const key = normalizeForCache(address);
    let p = inFlight.get(key);
    if (!p) {
      p = geocodeAddress(address);
      inFlight.set(key, p);
    }
    return p;
  }

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const row = targets[cursor];
      cursor++;

      let succeeded = false;
      let lastReason = null;

      // 요구사항 3: 첫 번째 지번 성공 시 종료, 실패 시 다음 명시적 지번을 순서대로 시도.
      for (const lotQuery of row._lotQueries) {
        const result = await getOrCreate(lotQuery);
        if (result.success) {
          row.lat = result.lat;
          row.lng = result.lng;
          row._geocodeStatus = 'SUCCESS';
          row._geocodeError = null;
          row._geocodeMethod = 'KAKAO_LOT';
          row._locationQuality = 'ESTIMATED'; // EXACT로 분류하지 않는다(요구사항 6).
          row._geocodeSearchedAddress = lotQuery;
          row._lotSuccessfulQuery = lotQuery;
          row._lotMatchedAddress = result.matchedAddress ?? null;
          row._lotStatus = 'SUCCESS';
          succeeded = true;
          progress.success++;
          break;
        }
        // NOT_FOUND가 아닌(네트워크/API 오류) 경우와 구분해서 기록한다(요구사항 7).
        lastReason = result.reason;
      }

      if (!succeeded) {
        if (lastReason && lastReason !== 'NOT_FOUND') {
          row._lotStatus = 'ERROR';
          row._lotError = lastReason;
          progress.error++;
        } else {
          row._lotStatus = 'NOT_FOUND';
          progress.notFound++;
        }
        // 모든 LOT 시도가 실패하면 UNRESOLVED 유지 — _locationQuality/_geocodeStatus를 바꾸지 않는다.
      }

      progress.done++;
      if (typeof onProgress === 'function') onProgress({ ...progress });
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  return progress;
}

// ------------------------------------------------------------
// STEP 11H-3. JUSO(행정안전부) 주소 정규화 실험.
// 기존 cascade(ORIGINAL/NORMALIZED/CORE/LOT)가 모두 실패해 UNRESOLVED로 남은 행 중,
// 원본에 도로명+건물번호가 명시적으로 존재하는 행에 한해서만 JUSO로 정규화를 시도한다.
// JUSO는 좌표를 반환하지 않으므로, 여기서 lat/lng를 확정하거나 DB에 쓰지 않는다 — 정규화 결과(후보)만 저장한다.
// 좌표 확정(KAKAO_JUSO 단계)은 이번 STEP 범위가 아니다.
// ------------------------------------------------------------

// 원본 주소에서 JUSO query를 만든다. 도로명+건물번호가 있으면 그것을 우선 사용하고(ROAD 방식),
// 도로명이 없으면 STEP 11H-1과 동일한 규칙(extractDongFromAddress/extractLotNumbersFromAddress)으로
// 법정동+지번을 추출해 LOT 방식으로 대체한다 — 원본에 명시된 동+완전한 지번만 사용하며 새 지번을 추론하지 않는다.
// 둘 다 없으면 null(BLOCK/INSUFFICIENT 등 JUSO 대상 아님).
//
// buildJusoQuery가 반환하는 값에는 ROAD/LOT 구분이 필요하므로, 대신 buildJusoQueryInfo를 내부적으로 쓰고
// 이 함수는 하위 호환을 위해 query 문자열만 반환한다.
export function buildJusoQuery(row) {
  const info = buildJusoQueryInfo(row);
  return info ? info.query : null;
}

// query 문자열과 그 종류(ROAD|LOT)를 함께 반환한다. 검증 단계(compareJusoCandidate)에서
// ROAD/LOT 중 어느 규칙으로 후보를 검증해야 하는지 알아야 하므로 이 정보가 필요하다.
export function buildJusoQueryInfo(row) {
  if (!row || !row.address) return null;
  const address = String(row.address).replace(/^\(\d{5}\)\s*/, '').trim();

  const roadMatch = address.match(/([가-힣0-9]+(?:로|길))\s*(\d+(?:-\d+)?)/);
  if (roadMatch) {
    const buildingNoRaw = roadMatch[2];
    const [mainNo, subNo] = buildingNoRaw.split('-');
    return {
      query: `서울 강남구 ${roadMatch[1]} ${buildingNoRaw}`,
      type: 'ROAD',
      road: roadMatch[1],
      buildingMainNo: mainNo,
      buildingSubNo: subNo ?? null, // 부번이 원본에 없으면 null (0으로 임의 채우지 않음)
    };
  }

  const dong = extractDongFromAddress(address);
  if (!dong) return null;
  const lots = extractLotNumbersFromAddress(address, dong);
  if (lots.length === 0) return null;
  // LOT_MULTI/REPRESENTATIVE 모두 대표(첫) 지번만 사용한다(원본에 명시된 것만, 92301903847와 동일 원칙).
  const lotRaw = lots[0];
  const [lotMainNo, lotSubNo] = lotRaw.split('-');
  return {
    query: `서울 강남구 ${dong} ${lotRaw}`,
    type: 'LOT',
    dong,
    lotMainNo,
    lotSubNo: lotSubNo ?? null,
  };
}

// JUSO 후보 1건이 원본 query와 정확히 일치하는지 구조화 필드로 검증한다(includes 문자열 포함 비교 금지).
// ROAD: 시/구(강남구) + 도로명(rn) + 건물본번(buldMnnm) + 건물부번(buldSlno) 정확히 일치해야 VALID_MATCH.
// LOT: 시/구(강남구) + 법정동(emdNm) + 지번본번(lnbrMnnm) + 지번부번(lnbrSlno) 정확히 일치해야 VALID_MATCH.
// 부번이 원본에 없는 경우(subNo=null)는 후보의 부번이 없거나 '0'일 때만 일치로 본다(부번 임의 매칭 금지).
function isCandidateValidMatch(candidate, queryInfo) {
  if (!candidate) return false;
  const sggMatches = candidate.sggNm === '강남구';
  if (!sggMatches) return false;

  if (queryInfo.type === 'ROAD') {
    const roadMatches = candidate.rn === queryInfo.road;
    const mainMatches = String(candidate.buldMnnm) === String(queryInfo.buildingMainNo);
    const candidateSub = candidate.buldSlno;
    const subMatches = queryInfo.buildingSubNo === null
      ? (candidateSub === null || candidateSub === undefined || String(candidateSub) === '0')
      : String(candidateSub) === String(queryInfo.buildingSubNo);
    return roadMatches && mainMatches && subMatches;
  }

  if (queryInfo.type === 'LOT') {
    const dongMatches = candidate.emdNm === queryInfo.dong;
    const mainMatches = String(candidate.lnbrMnnm) === String(queryInfo.lotMainNo);
    const candidateSub = candidate.lnbrSlno;
    const subMatches = queryInfo.lotSubNo === null
      ? (candidateSub === null || candidateSub === undefined || String(candidateSub) === '0')
      : String(candidateSub) === String(queryInfo.lotSubNo);
    return dongMatches && mainMatches && subMatches;
  }

  return false;
}

// UNRESOLVED 행(_locationQuality === 'UNRESOLVED') 중 JUSO query를 만들 수 있는 행만 대상으로 한다.
// JUSO 결과를 받은 뒤 구조화 필드로 후보를 검증해 MATCHED(정확히 1건 일치)/AMBIGUOUS(2건 이상 일치)/
// NO_MATCH(일치 0건)/NOT_FOUND(JUSO 결과 자체 없음)/ERROR로 분류한다.
// _jusoStatus==='SUCCESS'라는 단순 판정은 더 이상 쓰지 않는다 — 검증 결과만으로 상태를 정한다.
// _locationQuality/_geocodeStatus/lat/lng는 이 함수에서 변경하지 않는다(좌표 확정은 KAKAO_JUSO 단계).
export async function runJusoNormalize(onProgress) {
  const targets = state.uploadParsedRows.filter(
    row => row._locationQuality === 'UNRESOLVED' && buildJusoQueryInfo(row) !== null
  );

  targets.forEach(row => {
    const info = buildJusoQueryInfo(row);
    row._jusoQuery = info.query;
    row._jusoQueryInfo = info;
    row._jusoStatus = 'PENDING';
    row._jusoError = null;
    row._jusoCandidates = null;
    row._jusoMatchedCandidate = null;
  });

  const progress = { total: targets.length, done: 0, matched: 0, ambiguous: 0, noMatch: 0, notFound: 0, error: 0 };
  if (typeof onProgress === 'function') onProgress({ ...progress });

  const inFlight = new Map();
  function getOrCreate(query) {
    const key = (query || '').trim();
    let p = inFlight.get(key);
    if (!p) {
      p = geocodeJuso(query);
      inFlight.set(key, p);
    }
    return p;
  }

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const row = targets[cursor];
      cursor++;

      const result = await getOrCreate(row._jusoQuery);

      if (!result.success) {
        if (result.reason === 'NOT_FOUND') {
          row._jusoStatus = 'NOT_FOUND';
          row._jusoCandidates = [];
          progress.notFound++;
        } else {
          row._jusoStatus = 'ERROR';
          row._jusoError = result.reason || 'UNKNOWN';
          row._jusoCandidates = [];
          progress.error++;
        }
        progress.done++;
        if (typeof onProgress === 'function') onProgress({ ...progress });
        continue;
      }

      row._jusoCandidates = result.candidates;
      const validMatches = result.candidates.filter(c => isCandidateValidMatch(c, row._jusoQueryInfo));

      if (validMatches.length === 1) {
        row._jusoStatus = 'MATCHED';
        row._jusoMatchedCandidate = validMatches[0];
        progress.matched++;
      } else if (validMatches.length >= 2) {
        row._jusoStatus = 'AMBIGUOUS';
        progress.ambiguous++;
      } else {
        row._jusoStatus = 'NO_MATCH';
        progress.noMatch++;
        // STEP11 JUSO 진단 로그: 검증에 실패한 경우에만(NOT_FOUND 40건은 제외) 원본/keyword/candidates/queryInfo를 남긴다.
        console.log('[JUSO NO_MATCH]', {
          originalAddress: row.address,
          keyword: row._jusoQuery,
          candidates: row._jusoCandidates,
          queryInfo: row._jusoQueryInfo,
        });
      }

      progress.done++;
      if (typeof onProgress === 'function') onProgress({ ...progress });
    }
  }

  const jusoWorkers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(jusoWorkers);

  return progress;
}

// ------------------------------------------------------------
// STEP 11H-4. KAKAO_JUSO 단계 — JUSO가 "구조화 필드로 검증해 확정한(MATCHED)" 도로명/지번주소로
// Kakao 주소검색(mode:'address')을 재시도해 좌표를 확정한다.
// JUSO 검색결과 1위를 그대로 쓰지 않는다 — row._jusoMatchedCandidate(검증을 통과한 유일한 후보)만 사용한다.
// AMBIGUOUS(검증 통과 후보 2건 이상)나 NO_MATCH는 이 단계에 절대 들어오지 않는다(targets 필터에서 제외).
// ------------------------------------------------------------

// 대상은 반드시 _jusoStatus === 'MATCHED'이고 _jusoMatchedCandidate가 존재하는 행만 허용한다.
// 성공 시 row.lat/lng, _geocodeMethod='KAKAO_JUSO', _locationQuality='ESTIMATED'로 갱신한다(EXACT 아님).
// 1차: matchedCandidate.roadAddrPart1(없으면 roadAddr)로 시도. 그 결과가 NOT_FOUND이고 jibunAddr가 있으면
// 2차로 jibunAddr를 시도한다. 첫 성공에서 종료. 둘 다 실패하면 UNRESOLVED 유지.
export async function runKakaoJusoRecovery(onProgress) {
  const targets = state.uploadParsedRows.filter(
    row => row._locationQuality === 'UNRESOLVED' &&
      row._jusoStatus === 'MATCHED' &&
      row._jusoMatchedCandidate
  );

  targets.forEach(row => {
    row._kakaoJusoStatus = 'PENDING';
    row._kakaoJusoError = null;
    row._jusoKakaoQuery = null;
    row._jusoKakaoMatchedAddress = null;
  });

  const progress = { total: targets.length, done: 0, success: 0, notFound: 0, error: 0 };
  if (typeof onProgress === 'function') onProgress({ ...progress });

  const inFlight = new Map();
  function getOrCreate(address) {
    const key = (address || '').trim();
    let p = inFlight.get(key);
    if (!p) {
      p = geocodeAddress(address);
      inFlight.set(key, p);
    }
    return p;
  }

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const row = targets[cursor];
      cursor++;

      const matched = row._jusoMatchedCandidate;
      const primaryAddress = matched.roadAddrPart1 || matched.roadAddr;

      let finalResult = null;
      let finalQuery = null;

      if (primaryAddress) {
        const primaryResult = await getOrCreate(primaryAddress);
        if (primaryResult.success) {
          finalResult = primaryResult;
          finalQuery = primaryAddress;
        } else if (primaryResult.reason === 'NOT_FOUND' && matched.jibunAddr) {
          // 1차(도로명) NOT_FOUND이고 지번주소가 있으면만 2차로 시도한다. 성공/실패 여부와 관계없이
          // 이 2차 결과가 최종 결과가 된다(추가 fallback 없음).
          finalResult = await getOrCreate(matched.jibunAddr);
          finalQuery = matched.jibunAddr;
        } else {
          finalResult = primaryResult;
          finalQuery = primaryAddress;
        }
      } else if (matched.jibunAddr) {
        // 도로명 주소 자체가 없으면 지번주소로만 시도.
        finalResult = await getOrCreate(matched.jibunAddr);
        finalQuery = matched.jibunAddr;
      } else {
        finalResult = { success: false, reason: 'NOT_FOUND' };
        finalQuery = null;
      }

      row._jusoKakaoQuery = finalQuery;

      if (finalResult.success) {
        row.lat = finalResult.lat;
        row.lng = finalResult.lng;
        row._geocodeStatus = 'SUCCESS';
        row._geocodeError = null;
        row._geocodeMethod = 'KAKAO_JUSO';
        row._locationQuality = 'ESTIMATED'; // EXACT로 분류하지 않는다.
        row._geocodeSearchedAddress = finalQuery;
        row._jusoKakaoMatchedAddress = finalResult.matchedAddress ?? null;
        row._kakaoJusoStatus = 'SUCCESS';
        progress.success++;
      } else if (finalResult.reason === 'NOT_FOUND') {
        // 두 주소(도로명/지번) 모두 NOT_FOUND — UNRESOLVED 유지.
        row._kakaoJusoStatus = 'NOT_FOUND';
        progress.notFound++;
      } else {
        // API/network 오류 — NOT_FOUND와 구분해서 기록, UNRESOLVED 유지.
        row._kakaoJusoStatus = 'ERROR';
        row._kakaoJusoError = finalResult.reason || 'UNKNOWN';
        progress.error++;
      }

      progress.done++;
      if (typeof onProgress === 'function') onProgress({ ...progress });
    }
  }

  const kakaoJusoWorkers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(kakaoJusoWorkers);

  return progress;
}

// ------------------------------------------------------------
// STEP11 APPROXIMATE 진단 전용 (일회성). 운영 cascade/state/DB/UI와 완전히 분리된 진단 함수.
// 목적: UNRESOLVED 대표 ROAD 5건에 대해 기존 geocodeKeyword(mode:'keyword', 신규 API 아님)만으로
// "인근 대표 위치"를 실제로 확보할 수 있는지 확인한다. 좌표를 row에 적용하지 않고, DB에 쓰지 않는다.
// ------------------------------------------------------------

// 원본 주소에서 district/dong/roadName/buildingMainNo/buildingSubNo를 구조화 추출한다.
// buildJusoQueryInfo의 ROAD 파싱 로직과 동일한 원칙(원본에 실제 있는 도로명+건물번호만 사용, 추측 금지)을
// 진단 전용으로 복제한 것이며, 운영 함수(buildJusoQueryInfo)는 그대로 둔다(수정하지 않음).
function extractApproximateStructure(address) {
  const clean = String(address || '').replace(/^\(\d{5}\)\s*/, '').trim();
  const dong = extractDongFromAddress(clean); // 기존 함수 재사용(수정 없음)
  const roadMatch = clean.match(/([가-힣0-9]+(?:로|길))\s*(\d+)(?:-(\d+))?/);
  if (!roadMatch) return null;
  return {
    district: '강남구',
    dong: dong || null,
    roadName: roadMatch[1],
    buildingMainNo: roadMatch[2],
    buildingSubNo: roadMatch[3] || null,
  };
}

// Kakao가 반환한 addressName/roadAddressName 문자열에서 구/도로명/건물번호를 정규식으로 파싱한다.
// Edge Function이 구조화 필드(rn/sggNm 등)를 주지 않으므로(keyword mode는 문자열만 반환) 여기서 직접 분해한다.
function parseKakaoAddressString(addrString) {
  if (!addrString) return null;
  const guMatch = addrString.match(/([가-힣]+시)?\s*강남구/);
  const roadMatch = addrString.match(/([가-힣0-9]+(?:로|길))\s*(\d+)(?:-(\d+))?/);
  return {
    isGangnam: !!guMatch,
    roadName: roadMatch ? roadMatch[1] : null,
    buildingMainNo: roadMatch ? roadMatch[2] : null,
    buildingSubNo: roadMatch ? (roadMatch[3] || null) : null,
  };
}

// 후보 1건을 원본 구조와 대조해 판정한다. district+roadName이 정확히 일치해야 후보로 인정하고,
// 그 중 건물본번/부번까지 일치하면 EXACT, 아니면(같은 도로 위 다른 번지) APPROXIMATE로 구분한다.
// 문자열 includes가 아니라 파싱된 필드끼리 정확히 비교한다(다른 구/다른 도로는 즉시 탈락).
function classifyApproximateCandidate(candidate, originalStructure) {
  const parsed = parseKakaoAddressString(candidate.roadAddressName) || parseKakaoAddressString(candidate.addressName);
  if (!parsed) return 'REJECTED';
  if (!parsed.isGangnam) return 'REJECTED';
  if (!parsed.roadName || parsed.roadName !== originalStructure.roadName) return 'REJECTED';

  const mainMatches = parsed.buildingMainNo === originalStructure.buildingMainNo;
  const subMatches = originalStructure.buildingSubNo === null
    ? (parsed.buildingSubNo === null)
    : parsed.buildingSubNo === originalStructure.buildingSubNo;

  if (mainMatches && subMatches) return 'EXACT_CANDIDATE';
  return 'APPROXIMATE_CANDIDATE';
}

// 진단 전용 실행 함수. rows(5건)를 인자로 받아 결과 배열만 반환한다.
// row.lat/lng를 절대 설정하지 않고, state.uploadParsedRows를 건드리지 않는다(운영 데이터 미접근).
export async function runApproximateDiagnostic(rows) {
  const results = [];

  for (const row of rows) {
    const structure = extractApproximateStructure(row.address);
    if (!structure) {
      results.push({
        business_start_no: row.business_start_no,
        original_address: row.address,
        query: null,
        candidateCount: 0,
        validCount: 0,
        verdict: 'REJECTED',
        candidates: [],
      });
      continue;
    }

    const query = `서울 ${structure.district} ${structure.roadName} ${structure.buildingMainNo}${structure.buildingSubNo ? '-' + structure.buildingSubNo : ''}`;
    const result = await geocodeKeyword(query); // 기존 함수 그대로 재사용(수정 없음)

    if (!result.success) {
      results.push({
        business_start_no: row.business_start_no,
        original_address: row.address,
        query,
        candidateCount: 0,
        validCount: 0,
        verdict: result.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'REJECTED',
        candidates: [],
      });
      continue;
    }

    const classified = result.candidates.map(c => ({
      ...c,
      verdict: classifyApproximateCandidate(c, structure),
    }));
    const validOnes = classified.filter(c => c.verdict === 'EXACT_CANDIDATE' || c.verdict === 'APPROXIMATE_CANDIDATE');
    const exactOnes = validOnes.filter(c => c.verdict === 'EXACT_CANDIDATE');
    const approxOnes = validOnes.filter(c => c.verdict === 'APPROXIMATE_CANDIDATE');

    let verdict;
    if (validOnes.length === 0) verdict = 'REJECTED';
    else if (validOnes.length >= 2) verdict = 'AMBIGUOUS'; // 구조검증 통과 후보가 2건 이상이면 자동확정 금지
    else if (exactOnes.length === 1) verdict = 'EXACT_CANDIDATE';
    else verdict = 'APPROXIMATE_CANDIDATE';

    results.push({
      business_start_no: row.business_start_no,
      original_address: row.address,
      query,
      candidateCount: result.candidates.length,
      validCount: validOnes.length,
      verdict,
      candidates: classified,
    });
  }

  return results;
}
