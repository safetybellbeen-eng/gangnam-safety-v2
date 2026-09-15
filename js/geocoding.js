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

      // LEVEL 1: 원본 주소
      const originalResult = await getOrCreate(row.address);

      if (originalResult.success) {
        row.lat = originalResult.lat;
        row.lng = originalResult.lng;
        row._geocodeStatus = 'SUCCESS';
        row._geocodeError = null;
        row._geocodeMethod = 'ORIGINAL';
        row._locationQuality = 'EXACT';
        progress.success++;
      } else {
        // LEVEL 2: 정제주소가 원본과 실질적으로 다를 때만 재시도한다.
        // 단순 우편번호 제거만으로 달라진 경우(예: "(06058) 서울특별시 강남구 논현동 106-7"
        // → "서울특별시 강남구 논현동 106-7")는 이미 LEVEL 1에서 트림/공백 처리된 것과 실질적으로
        // 같은 검색이므로 재시도 대상에서 제외한다 — 우편번호를 뺀 원본과 비교해서 판단한다.
        const originalWithoutZip = normalizeForCache(row.address).replace(/^\(\d{5}\)\s*/, '').replace(/\s+/g, ' ').trim();
        const normalizedAddress = normalizeAddressForGeocoding(row.address);
        const isDifferent = normalizeForCache(normalizedAddress) !== originalWithoutZip;

        let finalResult = originalResult;
        let usedNormalized = false;

        if (isDifferent) {
          finalResult = await getOrCreate(normalizedAddress);
          usedNormalized = true;
        }

        if (usedNormalized && finalResult.success) {
          row.lat = finalResult.lat;
          row.lng = finalResult.lng;
          row._geocodeStatus = 'SUCCESS';
          row._geocodeError = null;
          row._geocodeMethod = 'NORMALIZED';
          row._locationQuality = 'ESTIMATED';
          progress.success++;
        } else if (finalResult.reason === 'NOT_FOUND' || originalResult.reason === 'NOT_FOUND') {
          row._geocodeStatus = 'NOT_FOUND';
          row._geocodeError = 'NOT_FOUND';
          row._geocodeMethod = null;
          row._locationQuality = 'UNRESOLVED';
          progress.notFound++;
        } else {
          row._geocodeStatus = 'ERROR';
          row._geocodeError = finalResult.reason || originalResult.reason || 'ERROR';
          row._geocodeMethod = null;
          row._locationQuality = 'UNRESOLVED';
          progress.error++;
        }
      }

      progress.done++;
      if (typeof onProgress === 'function') onProgress({ ...progress });
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  return progress;
}

