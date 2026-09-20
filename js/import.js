// import.js — STEP12-C. Excel parsing/validation/geocoding 결과(state.uploadParsedRows)를
// gnmap_v2_import_sites RPC(STEP12-B, 이미 Supabase에 등록됨) payload로 변환해 호출한다.
// 기존 parsing/validation/geocoding 로직(excel.js, geocoding.js)은 이 파일에서 전혀 수정하지 않는다.
// DB DELETE/is_active=false 로직은 이 파일에 없다(RPC 자체가 그런 처리를 하지 않도록 설계됨, STEP12-B).
import { sb } from './api.js';
import { state } from './state.js';

// row 하나를 RPC payload의 row 스키마(DB 컬럼명)로 변환한다.
// _locationQuality/_geocodeMethod/_geocodeSearchedAddress/_matchedAddress -> DB 컬럼명 매핑.
// row.dong은 excel.js가 채우지 않는 필드라 null로 안전 변환한다(geocoding 내부 파생값과는 별개).
function mapRowToPayload(row) {
  return {
    business_start_no: row.business_start_no,
    industrial_accident_no: row.industrial_accident_no ?? null,
    corporate_no: row.corporate_no ?? null,
    business_registration_no: row.business_registration_no ?? null,
    company_name: row.company_name ?? null,
    site_name: row.site_name ?? null,
    address: row.address ?? null,
    dong: row.dong ?? null,
    amount: row.amount ?? null,
    period_start: row.period_start ?? null,
    period_end: row.period_end ?? null,
    accident_report_count: row.accident_report_count ?? null,
    supervision_count: row.supervision_count ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    location_quality: row._locationQuality ?? null,
    geocode_method: row._geocodeMethod ?? null,
    location_query: row._geocodeSearchedAddress ?? null,
    matched_address: row._matchedAddress ?? null,
  };
}

// state.uploadParsedRows 중 실제로 DB에 반영할 행만 추려 payload를 만든다.
// ERROR 행(business_start_no 없음 등 validation 실패)은 애초에 RPC로 보내지 않는다 —
// RPC 자체도 business_start_no 없는 행을 거부하도록 설계되어 있어(STEP12-B) 이중 방어된다.
export function buildImportPayload(fileName, sourceForm) {
  const validRows = state.uploadParsedRows.filter(row => row._validation !== 'ERROR');
  return {
    file_name: fileName,
    source_form: sourceForm,
    rows: validRows.map(mapRowToPayload),
  };
}

// RPC를 호출한다. DB write는 이 함수 호출 시점에만 발생한다(버튼을 눌러야만 실행, 자동 실행 없음).
// 반환값: { success:true, ...RPC 응답 } | { success:false, message }
export async function importSitesToDatabase(fileName, sourceForm) {
  const payload = buildImportPayload(fileName, sourceForm);

  if (payload.rows.length === 0) {
    return { success: false, message: 'DB에 반영할 유효한 행이 없습니다(전부 오류 상태).' };
  }

  try {
    const { data, error } = await sb.rpc('gnmap_v2_import_sites', { p_payload: payload });
    if (error) {
      console.error('gnmap_v2_import_sites RPC 실패:', error);
      return { success: false, message: error.message || 'DB 반영 중 오류가 발생했습니다.' };
    }
    return { success: true, ...data };
  } catch (e) {
    console.error('gnmap_v2_import_sites 호출 예외:', e);
    return { success: false, message: 'DB 반영 요청을 보내지 못했습니다.' };
  }
}

// STEP13-1/2: 업로드 직전 확인용 — 이번 batch의 business_start_no 목록을 현재 gnmap_v2_sites와
// 대조해 신규 예정/갱신 예정 건수를 계산한다. DB에 아무것도 쓰지 않는 순수 조회(SELECT)이며,
// RPC 호출 없이 이 함수만으로는 저장이 발생하지 않는다.
// 반환: { success:true, total, updateCount, insertCount } | { success:false, message }
export async function previewImportImpact(fileName, sourceForm) {
  const payload = buildImportPayload(fileName, sourceForm);
  const businessStartNos = payload.rows.map(r => r.business_start_no);

  if (businessStartNos.length === 0) {
    return { success: false, message: '대상 행이 없습니다.' };
  }

  try {
    const { data, error } = await sb
      .from('gnmap_v2_sites')
      .select('business_start_no')
      .in('business_start_no', businessStartNos);

    if (error) {
      console.error('사전 검증 조회 실패:', error);
      return { success: false, message: error.message || '사전 검증 조회에 실패했습니다.' };
    }

    const existingSet = new Set((data || []).map(r => r.business_start_no));
    const updateCount = businessStartNos.filter(no => existingSet.has(no)).length;
    const insertCount = businessStartNos.length - updateCount;

    return { success: true, total: businessStartNos.length, updateCount, insertCount };
  } catch (e) {
    console.error('사전 검증 조회 예외:', e);
    return { success: false, message: '사전 검증 조회 요청을 보내지 못했습니다.' };
  }
}

// STEP13-5/6: 관리자 화면에 표시할 최근 업로드 이력을 조회한다. RLS가 admin만 select를 허용한다.
export async function loadUploadHistory(limit = 10) {
  try {
    const { data, error } = await sb
      .from('gnmap_v2_upload_history')
      .select('id, uploaded_by_name, file_name, source_form, total_rows, confirmed_rows, review_rows, uploaded_at')
      .order('uploaded_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('업로드 이력 조회 실패:', error);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('업로드 이력 조회 예외:', e);
    return [];
  }
}
