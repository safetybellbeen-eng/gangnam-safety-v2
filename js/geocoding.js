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

// state.uploadParsedRows 중 ERROR가 아니고 address가 있는 행만 대상으로 geocoding을 순차/제한동시 실행한다.
// concurrency는 4로 제한하며, 한 행의 실패가 나머지 행 처리를 막지 않는다.
// onProgress(progress)는 매 행 완료마다 호출되어 UI가 진행상황을 갱신할 수 있게 한다.
export async function runGeocodingForParsedRows(onProgress) {
  const targets = state.uploadParsedRows.filter(
    row => row._validation !== 'ERROR' && row.address
  );

  // 시작 즉시 대상 전체를 PENDING으로 표시한다 (기존 validation 필드는 그대로 둔다).
  targets.forEach(row => {
    row._geocodeStatus = 'PENDING';
    row._geocodeError = null;
  });

  const progress = { total: targets.length, done: 0, success: 0, notFound: 0, error: 0 };
  state.geocodeProgress = progress;
  if (typeof onProgress === 'function') onProgress({ ...progress });

  // normalizedAddress -> Promise<result>. 결과 값이 아니라 "진행 중인 Promise 자체"를 캐시해서,
  // concurrency=4 상황에서 같은 주소가 동시에 여러 worker에 의해 cache miss되는 race를 막는다.
  // 첫 worker가 Promise를 캐시에 넣는 순간 이후 worker들은 같은 Promise를 await하므로
  // 동일 정규화 주소는 실행 중 실제 Edge Function 호출이 정확히 1회만 발생한다 (실패 결과도 그 1회 실행 동안 공유).
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

      const result = await getOrCreate(row.address);

      if (result.success) {
        row.lat = result.lat;
        row.lng = result.lng;
        row._geocodeStatus = 'SUCCESS';
        row._geocodeError = null;
        progress.success++;
      } else if (result.reason === 'NOT_FOUND') {
        row._geocodeStatus = 'NOT_FOUND';
        row._geocodeError = 'NOT_FOUND';
        progress.notFound++;
      } else {
        row._geocodeStatus = 'ERROR';
        row._geocodeError = result.reason || 'ERROR';
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

