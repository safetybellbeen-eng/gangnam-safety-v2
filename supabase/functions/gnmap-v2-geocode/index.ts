// supabase/functions/gnmap-v2-geocode/index.ts
// STEP 11 — Browser → Edge Function → Kakao Local REST API geocoding.
// KAKAO_REST_API_KEY는 여기(서버)에서만 읽는다. 절대 frontend에 노출하지 않는다.
// 이 함수는 좌표 조회만 한다. gnmap_v2_sites DB 반영(INSERT/UPDATE)은 하지 않는다(STEP 12 범위).

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

  const address = (body as { address?: unknown })?.address;
  if (typeof address !== 'string') {
    return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
  }
  const trimmed = address.trim();
  if (trimmed === '' || trimmed.length > MAX_ADDRESS_LENGTH) {
    return jsonResponse({ success: false, reason: 'INVALID_REQUEST' }, 400, origin);
  }

  // ---- 4) Kakao Local REST API 주소 검색 ----
  const kakaoKey = Deno.env.get('KAKAO_REST_API_KEY');
  if (!kakaoKey) {
    console.error('KAKAO_REST_API_KEY 환경변수 누락');
    return jsonResponse({ success: false, reason: 'INTERNAL_ERROR' }, 500, origin);
  }

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
