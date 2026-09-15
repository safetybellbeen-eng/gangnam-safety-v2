// excel.js — STEP 10. 엑셀 파싱 → 공식 식별번호 추출 → validation.
// CLAUDE.md 흐름: parsing → 식별번호 추출 → validation → geocoding(STEP 11) → RPC(STEP 12, 단일 트랜잭션).
// 이 파일은 파싱/검증까지만 담당한다. DB 반영(geocoding/RPC 호출)은 이번 STEP 범위가 아니다.
// SheetJS(xlsx)는 index.html에서 로드된 전역 XLSX를 사용한다.

// 두 양식을 자동 판별하기 위한 필수 컬럼 목록 (헤더에 전부 존재해야 해당 양식으로 판정).
const FORM1_REQUIRED = ['본사명', '사업장명', '산재관리번호', '사업개시번호', '공사금액', '공사기간'];
const FORM2_REQUIRED = ['사업장명', '사업현장명', '산재관리번호', '사업개시번호', '공사금액', '공사시작일', '공사종료일'];

function detectForm(headerRow) {
  const headerSet = new Set(headerRow.filter(h => h !== null && h !== undefined && h !== ''));
  const hasForm1 = FORM1_REQUIRED.every(col => headerSet.has(col));
  const hasForm2 = FORM2_REQUIRED.every(col => headerSet.has(col));
  if (hasForm1) return 'form1';
  if (hasForm2) return 'form2';
  return null;
}

// 공백/빈 값을 null로 정규화한 문자열 식별번호를 반환한다 (앞자리 0 손실 방지를 위해 항상 문자열로 다룬다).
function normalizeIdentifier(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// 금액을 안전하게 숫자로 변환한다.
// null/undefined/빈문자열/공백문자열은 null(Number('')===0 문제 방지).
// comma 포함 숫자문자열("123,456")은 comma 제거 후 변환. 그 외 숫자로 해석 불가능한 문자열("1억원")은 null.
function toSafeAmount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  const s = String(v).trim();
  if (s === '') return null;

  const withoutComma = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(withoutComma)) return null;

  const n = Number(withoutComma);
  return Number.isFinite(n) ? n : null;
}

// 실제 달력에 존재하는 날짜인지 검증한다 (윤년 2/29, 각 달의 말일 등 포함).
// JS Date는 존재하지 않는 날짜(예: 2/30)를 다음 달로 자동 보정하므로,
// 보정 후 연/월/일이 입력과 정확히 일치하는 경우에만 유효한 날짜로 인정한다.
function isValidCalendarDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// 엑셀 날짜 셀을 YYYY-MM-DD 문자열로 정규화한다. 실패(또는 실존하지 않는 날짜)하면 null.
// 지원 형식: Date 객체 / "YYYY.MM.DD"·"YYYY-MM-DD"·"YYYY/MM/DD" 구분자 문자열 / YYYYMMDD 8자리 정수 또는 숫자문자열
// 모든 형식에서 실제 달력 존재 여부(윤년 2/29, 각 달의 말일)를 동일하게 검증한다.
function normalizeDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = v.getMonth() + 1;
    const d = v.getDate();
    if (!isValidCalendarDate(y, m, d)) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // YYYYMMDD 8자리(숫자 타입 또는 구분자 없는 숫자문자열)를 우선 확인한다.
  const digitsOnly = String(v).trim();
  if (/^\d{8}$/.test(digitsOnly)) {
    const y = Number(digitsOnly.slice(0, 4));
    const m = Number(digitsOnly.slice(4, 6));
    const d = Number(digitsOnly.slice(6, 8));
    if (!isValidCalendarDate(y, m, d)) return null;
    return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
  }

  const s = String(v).trim();
  const match = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (match) {
    const [, yStr, mStr, dStr] = match;
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (!isValidCalendarDate(y, m, d)) return null;
    return `${yStr}-${mStr.padStart(2, '0')}-${dStr.padStart(2, '0')}`;
  }
  return null;
}

// 공사기간 문자열("2026.07.21 ~ 2026.10.18")에서 시작일/종료일을 각각 추출한다 (양식1용).
// "~" 하나만 구분자로 사용한다 — 날짜 자체에 포함된 하이픈("2026-07-21")과 충돌하지 않도록
// 이전의 [~\-] 분리 방식(하이픈도 구분자로 취급)을 제거했다.
function parsePeriodRange(v) {
  if (!v) return { start: null, end: null };
  const s = String(v);
  const parts = s.split('~').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    return { start: normalizeDate(parts[0]), end: normalizeDate(parts[1]) };
  }
  return { start: null, end: null };
}

function mapForm1Row(row) {
  const rawPeriod = row['공사기간'];
  const period = parsePeriodRange(rawPeriod);
  return {
    business_start_no: normalizeIdentifier(row['사업개시번호']),
    industrial_accident_no: normalizeIdentifier(row['산재관리번호']),
    corporate_no: normalizeIdentifier(row['법인번호']),
    business_registration_no: normalizeIdentifier(row['사업자등록번호']),
    company_name: String(row['본사명'] || '').trim(),
    site_name: String(row['사업장명'] || '').trim(),
    address: row['소재지(우편)'] ? String(row['소재지(우편)']).trim() : null,
    amount: toSafeAmount(row['공사금액']),
    period_start: period.start,
    period_end: period.end,
    accident_report_count: row['산재조사표(건)'] !== undefined && row['산재조사표(건)'] !== '' ? Number(row['산재조사표(건)']) : null,
    supervision_count: row['지도감독(건)'] !== undefined && row['지도감독(건)'] !== '' ? Number(row['지도감독(건)']) : null,
    source_form: 'form1',
    // 검증 단계에서만 쓰는 임시 필드: "원본에 값이 있었는데 파싱에 실패했는가"를 판별하기 위함.
    // 양식1은 공사기간 문자열 하나에서 시작/종료일을 함께 추출하므로 원본값도 동일하게 공유한다.
    _rawPeriodStart: rawPeriod,
    _rawPeriodEnd: rawPeriod
  };
}

function mapForm2Row(row) {
  const rawStart = row['공사시작일'];
  const rawEnd = row['공사종료일'];
  return {
    business_start_no: normalizeIdentifier(row['사업개시번호']),
    industrial_accident_no: normalizeIdentifier(row['산재관리번호']),
    corporate_no: normalizeIdentifier(row['법인등록번호']),
    business_registration_no: normalizeIdentifier(row['사업자등록번호']),
    company_name: String(row['사업장명'] || '').trim(),
    site_name: String(row['사업현장명'] || '').trim(),
    address: row['사업현장주소'] ? String(row['사업현장주소']).trim() : null,
    amount: toSafeAmount(row['공사금액']),
    period_start: normalizeDate(rawStart),
    period_end: normalizeDate(rawEnd),
    accident_report_count: null,
    supervision_count: null,
    source_form: 'form2',
    _rawPeriodStart: rawStart,
    _rawPeriodEnd: rawEnd
  };
}

// 원본 셀 값이 "존재했는지"를 판별한다 (빈 값 WARNING vs 값은 있는데 파싱 실패 ERROR를 구분하기 위함).
function hasRawValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

// 매핑된 행 1건을 3단계(VALID/WARNING/ERROR)로 검증한다.
// ERROR: business_start_no 없음 / site_name·company_name 모두 없음 / amount 음수 /
//        원본 날짜값은 있는데 파싱 실패 / period_start > period_end / batch 내 business_start_no 중복(parseExcelFile에서 후처리)
// WARNING: address 없음 / amount 없음 / corporate_no 없음 / period_start 없음 / period_end 없음
// ERROR가 하나라도 있으면 ERROR, 없고 WARNING이 있으면 WARNING, 둘 다 없으면 VALID.
function validateRow(row, rowIndex) {
  const errors = [];
  const warnings = [];

  if (!row.business_start_no) errors.push('사업개시번호 없음');
  if (!row.site_name && !row.company_name) errors.push('사업장명/업체명 모두 없음');
  if (row.amount !== null && row.amount < 0) errors.push('공사금액이 음수');

  // 날짜: 원본값이 있었는데 정규화 결과가 null이면 파싱 실패(ERROR), 원본 자체가 없으면 결측(WARNING).
  const startHasRaw = hasRawValue(row._rawPeriodStart);
  const endHasRaw = hasRawValue(row._rawPeriodEnd);
  if (row.period_start === null) {
    if (startHasRaw) errors.push('공사시작일 파싱 실패');
    else warnings.push('공사시작일 없음');
  }
  if (row.period_end === null) {
    if (endHasRaw) errors.push('공사종료일 파싱 실패');
    else warnings.push('공사종료일 없음');
  }
  if (row.period_start !== null && row.period_end !== null && row.period_start > row.period_end) {
    errors.push('공사시작일이 공사종료일보다 늦음');
  }

  if (!row.address) warnings.push('주소 없음');
  if (row.amount === null) warnings.push('공사금액 없음');
  if (!row.corporate_no) warnings.push('법인번호 없음');

  // 검증에만 쓰던 임시 필드는 결과 객체에서 제거한다(state에 불필요한 raw 데이터가 남지 않도록).
  const { _rawPeriodStart, _rawPeriodEnd, ...cleanRow } = row;

  const validation = errors.length > 0 ? 'ERROR' : (warnings.length > 0 ? 'WARNING' : 'VALID');

  return {
    ...cleanRow,
    _rowIndex: rowIndex,
    _errors: errors,
    _warnings: warnings,
    _validation: validation,
    _valid: validation !== 'ERROR'
  };
}

// File 객체를 읽어 파싱 → 매핑 → validation까지 수행하고 state에 결과를 채운다.
// DB 조회/반영은 하지 않는다 (RLS/네트워크 요청 없음, 순수 클라이언트 파싱).
export async function parseExcelFile(file, state) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) {
    state.uploadParsedRows = [];
    state.uploadDetectedForm = null;
    state.uploadValidationSummary = { total: 0, validCount: 0, warningCount: 0, errorCount: 0, invalidCount: 0, duplicateCount: 0 };
    return;
  }

  const headerRow = Object.keys(rows[0]);
  const form = detectForm(headerRow);
  state.uploadDetectedForm = form;

  if (!form) {
    state.uploadParsedRows = [];
    state.uploadValidationSummary = { total: rows.length, validCount: 0, warningCount: 0, errorCount: rows.length, invalidCount: rows.length, duplicateCount: 0 };
    return;
  }

  const mapper = form === 'form1' ? mapForm1Row : mapForm2Row;
  let mapped = rows.map((row, i) => validateRow(mapper(row), i));

  // 같은 파일 안에서 business_start_no가 중복되면 어느 행이 최종 반영될지 불명확해지므로
  // validation 단계에서 ERROR로 표시한다 (STEP 12 RPC도 동일 원칙으로 배치 내 중복을 거부할 예정).
  const seen = new Map();
  mapped.forEach(row => {
    if (!row.business_start_no) return;
    seen.set(row.business_start_no, (seen.get(row.business_start_no) || 0) + 1);
  });
  mapped = mapped.map(row => {
    if (row.business_start_no && seen.get(row.business_start_no) > 1) {
      const errors = [...row._errors, '배치 내 사업개시번호 중복'];
      return { ...row, _errors: errors, _validation: 'ERROR', _valid: false };
    }
    return row;
  });

  const validCount = mapped.filter(r => r._validation === 'VALID').length;
  const warningCount = mapped.filter(r => r._validation === 'WARNING').length;
  const errorCount = mapped.filter(r => r._validation === 'ERROR').length;
  const duplicateCount = mapped.filter(r => r._errors.includes('배치 내 사업개시번호 중복')).length;

  state.uploadParsedRows = mapped;
  state.uploadValidationSummary = {
    total: mapped.length,
    validCount,
    warningCount,
    errorCount,
    invalidCount: errorCount, // 기존 UI(invalidCount 참조)와의 호환을 위해 errorCount와 동일하게 유지
    duplicateCount
  };
}
