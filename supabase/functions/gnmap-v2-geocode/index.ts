// supabase/functions/gnmap-v2-geocode/index.ts
// STEP 11 — Browser → Edge Function → Kakao Local REST API geocoding.
// STEP 11G: mode:'keyword'로 Kakao 키워드검색(후보 목록 반환)도 지원한다. 인증/권한/CORS는 완전히 공유.
// STEP 11H-3: mode:'juso'로 행정안전부 도로명주소 API 정규화를 지원한다. 좌표는 반환하지 않는다
// (JUSO는 주소 정규화 전용 — 좌표는 정규화된 주소로 별도 mode:'address' 호출을 통해 얻는다, KAKAO_JUSO 단계).
// KAKAO_REST_API_KEY/JUSO_CONFM_KEY는 여기(서버)에서만 읽는다. 절대 frontend에 노출하지 않는다.
// 이 함수는 좌표/주소 조회만 한다. gnmap_v2_sites DB 반영(INSERT/UPDATE)은 하지 않는다(STEP 12 범위).
// keyword/juso 모드는 후보(또는 정규화 결과) 목록만 반환하며, 어떤 좌표도 자동으로 확정/저장하지 않는다.

// 허용 origin은 명시적으로 나열한다 (와일드카드 '*' 금지).
// TODO: 실제 GitHub Pages 배포 주소로 교체 필요 (예: https://<owner>.github.io)
const ALLOWED_ORIGINS = new Set([
  'https://safetybellbeen-eng.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

const MAX_ADDRESS_LENGTH = 300;

function corsHeaders(origin: string | null): Record<string, string> {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 405, origin);
  }

  // ---- 1) 인증: Authorization Bearer JWT 검증 ----
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ success: false, reason: 'UNAUTHORIZED' }, 401, origin);
  }
  const jwt = authHeader.slice('Bearer '.length);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('SUPABASE_URL/SUPABASE_ANON_KEY 환경변수 누락');
    return jsonResponse({ success: false, reason: 'INTERNAL_ERROR' }, 500, origin);
  }

  // 사용자 신원 확인: anon key + 요청의 JWT로 auth.getUser 호출 (service_role 미사용).
  let userId: string;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: supabaseAnonKey },
    });
    if (!userRes.ok) {
      return jsonResponse({ success: false, reason: 'UNAUTHORIZED' }, 401, origin);
    }
    const userData = await userRes.json();
    if (!userData?.id) {
      return jsonResponse({ success: false, reason: 'UNAUTHORIZED' }, 401, origin);
    }
    userId = userData.id;
  } catch (_e) {
    return jsonResponse({ success: false, reason: 'UNAUTHORIZED' }, 401, origin);
  }

  // ---- 2) 권한: DB 기준 gnmap_v2_profiles에서 role=admin AND status=approved 확인 ----
  // 클라이언트가 주장하는 admin 여부는 신뢰하지 않는다. PostgREST를 anon key + 사용자 JWT로 호출해
  // RLS(본인 또는 admin만 select 가능)를 그대로 통과시켜 본인 profile을 조회한다.
  let isAdminApproved = false;
  try {
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/gnmap_v2_profiles?id=eq.${userId}&select=role,status`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          apikey: supabaseAnonKey,
        },
      }
    );
    if (!profileRes.ok) {
      return jsonResponse({ success: false, reason: 'FORBIDDEN' }, 403, origin);
    }
    const rows = await profileRes.json();
    const profile = Array.isArray(rows) ? rows[0] : null;
    isAdminApproved = !!profile && profile.role === 'admin' && profile.status === 'approved';
  } catch (_e) {
    return jsonResponse({ success: false, reason: 'FORBIDDEN' }, 403, origin);
  }

  if (!isAdminApproved) {
    return jsonResponse({ success: false, reason: 'FORBIDDEN' }, 403, origin);
  }

  // ---- 3) 요청 바디 검증 ----
  let body: unknown;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
  }

  const modeRaw = (body as { mode?: unknown })?.mode;
  const mode = modeRaw === 'keyword' ? 'keyword' : (modeRaw === 'juso' ? 'juso' : 'address');

  if (mode === 'juso') {
    // ---- JUSO(행정안전부 도로명주소) 정규화 전용 경로 (STEP 11H-3) ----
    // 인증/권한/CORS는 위에서 이미 검증 완료. Kakao 키는 필요 없다.
    const query = (body as { query?: unknown })?.query;
    if (typeof query !== 'string') {
      return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
    }
    const trimmedQuery = query.trim();
    if (trimmedQuery === '' || trimmedQuery.length > MAX_ADDRESS_LENGTH) {
      return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
    }

    const jusoKey = Deno.env.get('JUSO_CONFM_KEY');
    if (!jusoKey) {
      console.error('JUSO_CONFM_KEY 환경변수 누락');
      return jsonResponse({ success: false, reason: 'INTERNAL_ERROR' }, 500, origin);
    }

    const jusoUrl =
      'https://business.juso.go.kr/addrlink/addrLinkApi.do?' +
      new URLSearchParams({
        confmKey: jusoKey,
        currentPage: '1',
        countPerPage: '5',
        keyword: trimmedQuery,
        resultType: 'json',
      }).toString();

    let jusoJson: any;
    try {
      const jusoRes = await fetch(jusoUrl);
      if (!jusoRes.ok) {
        const errorBody = await jusoRes.text().catch(() => '(응답 본문 읽기 실패)');
        console.error('JUSO API 오류 status:', jusoRes.status, '| body(앞 300자):', errorBody.slice(0, 300));
        return jsonResponse({ success: false, reason: 'JUSO_API_ERROR' }, 502, origin);
      }
      jusoJson = await jusoRes.json();
    } catch (e) {
      console.error('JUSO API 호출 실패:', e);
      return jsonResponse({ success: false, reason: 'JUSO_API_ERROR' }, 502, origin);
    }

    const common = jusoJson?.results?.common;
    if (!common) {
      console.error('JUSO API 응답에 results.common 없음. 응답 키:', jusoJson ? Object.keys(jusoJson) : '(jusoJson 없음)');
      return jsonResponse({ success: false, reason: 'JUSO_API_ERROR' }, 502, origin);
    }
    // JUSO 자체 에러코드(승인키 오류, 요청 파라미터 오류 등)는 API 키 값 자체를 노출하지 않는 범위에서
    // errorCode/errorMessage를 로그와 reason에 그대로 남긴다 — 42/42 전부 같은 실패라 원인 확인이 필요함(LIVE DEBUG).
    if (common.errorCode && common.errorCode !== '0') {
      console.error('JUSO API 에러코드:', common.errorCode, '| 에러메시지:', common.errorMessage);
      return jsonResponse(
        { success: false, reason: 'JUSO_API_ERROR', jusoErrorCode: common.errorCode, jusoErrorMessage: common.errorMessage ?? null },
        502,
        origin
      );
    }

    const jusoList = jusoJson?.results?.juso;
    if (!Array.isArray(jusoList) || jusoList.length === 0) {
      return jsonResponse({ success: false, reason: 'NOT_FOUND' }, 200, origin);
    }

    // 좌표는 포함하지 않는다 — JUSO는 정규화 전용, 좌표는 이후 KAKAO_JUSO 단계(mode:'address')에서 얻는다.
    // 상위 최대 5건만, 자동으로 1건을 확정하지 않고 후보 목록만 반환한다.
    // frontend가 원본 query와 기계적으로 정확히 대조(본번/부번 일치 등)할 수 있도록 구조화 필드를 그대로 전달한다.
    const candidates = jusoList.slice(0, 5).map((j: any) => ({
      roadAddr: j?.roadAddr ?? null,
      roadAddrPart1: j?.roadAddrPart1 ?? null,
      jibunAddr: j?.jibunAddr ?? null,
      zipNo: j?.zipNo ?? null,
      admCd: j?.admCd ?? null,
      siNm: j?.siNm ?? null,
      sggNm: j?.sggNm ?? null,
      emdNm: j?.emdNm ?? null,
      rn: j?.rn ?? null,
      buldMnnm: j?.buldMnnm ?? null,
      buldSlno: j?.buldSlno ?? null,
      lnbrMnnm: j?.lnbrMnnm ?? null,
      lnbrSlno: j?.lnbrSlno ?? null,
    }));

    return jsonResponse({ success: true, candidates }, 200, origin);
  }

  const kakaoKey = Deno.env.get('KAKAO_REST_API_KEY');
  if (!kakaoKey) {
    console.error('KAKAO_REST_API_KEY 환경변수 누락');
    return jsonResponse({ success: false, reason: 'INTERNAL_ERROR' }, 500, origin);
  }

  if (mode === 'keyword') {
    // ---- keyword search 전용 경로 (STEP 11G) ----
    // 기존 address 검색과 인증/권한 로직은 완전히 공유하며, 이 지점부터만 분기한다.
    const query = (body as { query?: unknown })?.query;
    if (typeof query !== 'string') {
      return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
    }
    const trimmedQuery = query.trim();
    if (trimmedQuery === '' || trimmedQuery.length > MAX_ADDRESS_LENGTH) {
      return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
    }

    const kakaoUrl =
      'https://dapi.kakao.com/v2/local/search/keyword.json?' +
      new URLSearchParams({ query: trimmedQuery, size: '3' }).toString();

    let kakaoJson: any;
    try {
      const kakaoRes = await fetch(kakaoUrl, {
        headers: { Authorization: `KakaoAK ${kakaoKey}` },
      });
      if (!kakaoRes.ok) {
        console.error('Kakao keyword API 오류 status:', kakaoRes.status);
        return jsonResponse({ success: false, reason: 'KAKAO_API_ERROR' }, 502, origin);
      }
      kakaoJson = await kakaoRes.json();
    } catch (e) {
      console.error('Kakao keyword API 호출 실패:', e);
      return jsonResponse({ success: false, reason: 'KAKAO_API_ERROR' }, 502, origin);
    }

    const documents = kakaoJson?.documents;
    if (!Array.isArray(documents) || documents.length === 0) {
      return jsonResponse({ success: false, reason: 'NOT_FOUND' }, 200, origin);
    }

    // 상위 최대 3건만, 좌표 검증을 통과한 것만 후보로 반환한다.
    // 자동으로 1건을 확정하지 않는다 — 후보 목록만 돌려주고 채택 여부는 frontend가 별도 규칙으로 판단.
    const candidates = documents.slice(0, 3).map((doc: any) => {
      const lat = Number(doc?.y);
      const lng = Number(doc?.x);
      const isValidCoord =
        Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
      if (!isValidCoord) return null;
      return {
        placeName: doc?.place_name ?? null,
        addressName: doc?.address_name ?? null,
        roadAddressName: doc?.road_address_name ?? null,
        lat,
        lng,
      };
    }).filter((c: unknown) => c !== null);

    if (candidates.length === 0) {
      return jsonResponse({ success: false, reason: 'NOT_FOUND' }, 200, origin);
    }

    return jsonResponse({ success: true, candidates }, 200, origin);
  }

  // ---- address 검색 경로 (기존 STEP 11 동작, 변경 없음) ----
  const address = (body as { address?: unknown })?.address;
  if (typeof address !== 'string') {
    return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
  }
  const trimmed = address.trim();
  if (trimmed === '' || trimmed.length > MAX_ADDRESS_LENGTH) {
    return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
  }

  // ---- 4) Kakao Local REST API 주소 검색 ----
  const kakaoUrl =
    'https://dapi.kakao.com/v2/local/search/address.json?' +
    new URLSearchParams({ query: trimmed }).toString();

  let kakaoJson: any;
  try {
    const kakaoRes = await fetch(kakaoUrl, {
      headers: { Authorization: `KakaoAK ${kakaoKey}` },
    });
    if (!kakaoRes.ok) {
      // Kakao 원본 오류 body/키 등은 client에 그대로 노출하지 않는다.
      console.error('Kakao API 오류 status:', kakaoRes.status);
      return jsonResponse({ success: false, reason: 'KAKAO_API_ERROR' }, 502, origin);
    }
    kakaoJson = await kakaoRes.json();
  } catch (e) {
    console.error('Kakao API 호출 실패:', e);
    return jsonResponse({ success: false, reason: 'KAKAO_API_ERROR' }, 502, origin);
  }

  const documents = kakaoJson?.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    return jsonResponse({ success: false, reason: 'NOT_FOUND' }, 200, origin);
  }

  const first = documents[0];
  // Kakao: x = longitude, y = latitude. 순서를 뒤집지 않는다.
  const lat = Number(first?.y);
  const lng = Number(first?.x);

  const isValidCoord =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180;

  if (!isValidCoord) {
    return jsonResponse({ success: false, reason: 'KAKAO_API_ERROR' }, 502, origin);
  }

  const matchedAddress: string | null =
    first?.road_address?.address_name ?? first?.address?.address_name ?? null;

  return jsonResponse({ success: true, lat, lng, matchedAddress }, 200, origin);
});
