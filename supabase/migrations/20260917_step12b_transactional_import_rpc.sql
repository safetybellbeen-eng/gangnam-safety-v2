-- ============================================================
-- migrations/20260917_step12b_transactional_import_rpc.sql
-- STEP12-B: Transactional Excel Import RPC
--
-- 대상: gnmap_v2_sites(UPDATE/INSERT), gnmap_v2_upload_history(INSERT)만. gnmap_v2_* 외 다른 객체
-- (V1 gnmap_* 포함)는 절대 접근하지 않는다.
-- 이 파일은 신규 RPC 함수 1개만 추가한다 — 기존 functions.sql/policies.sql은 재작성하지 않는다.
-- 아직 Supabase 원격 DB에 적용하지 않는다. 검토 후 적용한다.
--
-- 설계 근거:
-- - business_start_no partial UNIQUE index(STEP12-A)와 jsonb_to_recordset 기반 INSERT ... ON CONFLICT
--   방식을 검토했으나, MANUAL 보호를 위해 UPDATE 시 "기존 행의 현재 location_quality 값"을 읽어
--   CASE 분기해야 하는데 ON CONFLICT DO UPDATE의 EXCLUDED/타겟 테이블 참조만으로는 이 로직이
--   장황해지고 partial index를 ON CONFLICT 타겟으로 지정할 때의 동작(WHERE 절 필요)까지 겹쳐
--   실수 위험이 커진다고 판단했다. 이 STEP은 안전성을 우선해 UPDATE + INSERT 분리 방식을 사용한다
--   (jsonb_to_recordset으로 set-based UPDATE/INSERT는 유지하되, ON CONFLICT는 사용하지 않는다).
-- ============================================================

create or replace function gnmap_v2_import_sites(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file_name text;
  v_source_form text;
  v_rows jsonb;
  v_row_count int;
  v_distinct_count int;
  v_update_count int := 0;
  v_insert_count int := 0;
  v_review_count int := 0;
  v_history_id bigint;
begin
  -- ---- 1) 권한 검증 (approved admin만) ----
  if not public.is_gnmap_v2_admin() then
    raise exception '관리자만 사업장 데이터를 가져올 수 있습니다.';
  end if;

  -- ---- 2) 최상위 구조 검증 ----
  v_file_name := p_payload ->> 'file_name';
  v_source_form := p_payload ->> 'source_form';
  v_rows := p_payload -> 'rows';

  if v_file_name is null or btrim(v_file_name) = '' then
    raise exception 'file_name이 없습니다.';
  end if;

  if v_source_form is null or btrim(v_source_form) = '' then
    raise exception 'source_form이 없습니다.';
  end if;

  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    raise exception 'rows는 JSON array여야 합니다.';
  end if;

  v_row_count := jsonb_array_length(v_rows);
  if v_row_count = 0 then
    raise exception 'rows가 비어 있습니다.';
  end if;

  -- ---- 3) rows를 레코드셋으로 펼쳐 임시 테이블에 적재 (set-based 처리 기반) ----
  -- on commit drop이므로 트랜잭션 종료 시 자동 삭제된다. 다만 같은 트랜잭션 내 중복 호출 등
  -- 예외적 상황을 대비해 생성 전 동일 이름 임시테이블을 먼저 정리한다.
  drop table if exists tmp_import_rows;

  create temporary table tmp_import_rows on commit drop as
  select *
  from jsonb_to_recordset(v_rows) as r(
    business_start_no text,
    industrial_accident_no text,
    corporate_no text,
    business_registration_no text,
    company_name text,
    site_name text,
    address text,
    dong text,
    amount bigint,
    period_start date,
    period_end date,
    accident_report_count int,
    supervision_count int,
    lat double precision,
    lng double precision,
    location_quality text,
    geocode_method text,
    location_query text,
    matched_address text
  );

  -- ---- 4) 행 단위 구조적 validation ----
  if exists (
    select 1 from tmp_import_rows
    where business_start_no is null or btrim(business_start_no) = ''
  ) then
    raise exception 'business_start_no가 없는 행이 있습니다. 모든 행은 business_start_no가 필요합니다.';
  end if;

  select count(distinct business_start_no) into v_distinct_count from tmp_import_rows;
  if v_distinct_count <> v_row_count then
    raise exception '배치 내 business_start_no가 중복된 행이 있습니다.';
  end if;

  if exists (
    select 1 from tmp_import_rows
    where location_quality is null
      or btrim(location_quality) = ''
      or location_quality not in ('EXACT', 'ESTIMATED', 'APPROXIMATE', 'MANUAL', 'UNRESOLVED')
  ) then
    raise exception 'location_quality는 EXACT/ESTIMATED/APPROXIMATE/MANUAL/UNRESOLVED 중 하나여야 합니다(빈 값 불가).';
  end if;

  if exists (
    select 1 from tmp_import_rows
    where (lat is null) <> (lng is null)
  ) then
    raise exception 'lat/lng는 둘 다 있거나 둘 다 없어야 합니다.';
  end if;

  if exists (
    select 1 from tmp_import_rows
    where lat is not null and (lat < -90 or lat > 90)
  ) then
    raise exception 'lat 값이 유효 범위(-90~90)를 벗어난 행이 있습니다.';
  end if;

  if exists (
    select 1 from tmp_import_rows
    where lng is not null and (lng < -180 or lng > 180)
  ) then
    raise exception 'lng 값이 유효 범위(-180~180)를 벗어난 행이 있습니다.';
  end if;

  -- location_quality별 좌표 존재 규칙:
  -- EXACT/ESTIMATED/APPROXIMATE/MANUAL은 lat/lng 둘 다 필수, UNRESOLVED는 lat/lng 둘 다 NULL이어야 한다.
  -- (위의 "lat/lng 둘 중 하나만 존재 금지" 및 범위 검증과는 별개로, location_quality와의 일관성을 검증한다.)
  if exists (
    select 1 from tmp_import_rows
    where location_quality in ('EXACT', 'ESTIMATED', 'APPROXIMATE', 'MANUAL')
      and (lat is null or lng is null)
  ) then
    raise exception 'EXACT/ESTIMATED/APPROXIMATE/MANUAL 행은 lat/lng가 반드시 있어야 합니다.';
  end if;

  if exists (
    select 1 from tmp_import_rows
    where location_quality = 'UNRESOLVED'
      and (lat is not null or lng is not null)
  ) then
    raise exception 'UNRESOLVED 행은 lat/lng가 반드시 NULL이어야 합니다.';
  end if;

  -- location_quality='UNRESOLVED'이면 lat/lng NULL 허용 — 위 두 검증(존재규칙)으로 이미 강제됨.

  -- ---- 5) UPDATE: business_start_no가 기존 gnmap_v2_sites에 이미 있는 행 ----
  -- MANUAL 보호: 기존 행의 location_quality='MANUAL'이면 위치 관련 6개 컬럼(lat/lng/location_quality/
  -- geocode_method/location_query/matched_address)은 기존값을 그대로 유지하고, 그 외 일반 Excel 데이터
  -- 컬럼은 항상 갱신한다. id는 절대 변경하지 않는다.
  -- source_form은 이제 "양식 소속"이 아니라 "이 사업장을 마지막으로 갱신한 import 양식"을 의미하므로
  -- UPDATE 시에도 항상 v_source_form으로 갱신한다 — 단 이 값을 이용해 is_active를 바꾸는 로직은 없다.
  with matched as (
    select s.id, t.*
    from tmp_import_rows t
    join gnmap_v2_sites s on s.business_start_no = t.business_start_no
  )
  update gnmap_v2_sites s
  set
    industrial_accident_no = m.industrial_accident_no,
    corporate_no = m.corporate_no,
    business_registration_no = m.business_registration_no,
    company_name = m.company_name,
    site_name = m.site_name,
    address = m.address,
    dong = m.dong,
    amount = m.amount,
    period_start = m.period_start,
    period_end = m.period_end,
    accident_report_count = m.accident_report_count,
    supervision_count = m.supervision_count,
    source_form = v_source_form,
    is_active = true,
    lat = case when s.location_quality = 'MANUAL' then s.lat else m.lat end,
    lng = case when s.location_quality = 'MANUAL' then s.lng else m.lng end,
    location_quality = case when s.location_quality = 'MANUAL' then s.location_quality else m.location_quality end,
    geocode_method = case when s.location_quality = 'MANUAL' then s.geocode_method else m.geocode_method end,
    location_query = case when s.location_quality = 'MANUAL' then s.location_query else m.location_query end,
    matched_address = case when s.location_quality = 'MANUAL' then s.matched_address else m.matched_address end,
    updated_at = now()
  from matched m
  where s.id = m.id;

  get diagnostics v_update_count = row_count;

  -- ---- 6) INSERT: business_start_no가 기존에 없는 신규 행 ----
  insert into gnmap_v2_sites (
    business_start_no, industrial_accident_no, corporate_no, business_registration_no,
    company_name, site_name, address, dong, amount, period_start, period_end,
    accident_report_count, supervision_count,
    lat, lng, location_quality, geocode_method, location_query, matched_address,
    source_form, is_active
  )
  select
    t.business_start_no, t.industrial_accident_no, t.corporate_no, t.business_registration_no,
    t.company_name, t.site_name, t.address, t.dong, t.amount, t.period_start, t.period_end,
    t.accident_report_count, t.supervision_count,
    t.lat, t.lng, t.location_quality, t.geocode_method, t.location_query, t.matched_address,
    v_source_form, true
  from tmp_import_rows t
  where not exists (
    select 1 from gnmap_v2_sites s where s.business_start_no = t.business_start_no
  );

  get diagnostics v_insert_count = row_count;

  -- ---- 7) review_count: 이번 batch의 business_start_no에 해당하는 gnmap_v2_sites 최종 상태 기준으로
  -- 계산한다(tmp_import_rows의 입력값이 아니라 실제 DB 반영 결과). MANUAL 보호로 인해 입력이
  -- APPROXIMATE/UNRESOLVED여도 기존 행이 MANUAL이면 실제로는 MANUAL로 유지되므로, 입력값만으로 세면
  -- 실제와 어긋날 수 있다 — 그래서 UPDATE/INSERT가 끝난 뒤 gnmap_v2_sites를 다시 조회해서 센다.
  select count(*) into v_review_count
  from gnmap_v2_sites s
  where s.business_start_no in (select business_start_no from tmp_import_rows)
    and s.location_quality in ('UNRESOLVED', 'APPROXIMATE');

  -- ---- 8) upload_history 기록 (같은 트랜잭션) ----
  -- 기존 gnmap_v2_upload_history에는 insert/update를 분리 기록할 컬럼이 없다(confirmed_rows/review_rows만
  -- 존재). confirmed_rows=처리 성공 건수(insert+update 합계), review_rows=이번 batch 대상 중 실제 DB
  -- 최종 상태가 UNRESOLVED/APPROXIMATE인 건수(MANUAL 보호 반영 후)로 기록한다.
  -- insert/update 세부 분리 기록이 필요하면 별도 schema 변경이 필요하다(미적용, 반환값 JSON에는 분리 포함).
  insert into gnmap_v2_upload_history (
    uploaded_by, uploaded_by_name, file_name, source_form,
    total_rows, confirmed_rows, review_rows
  )
  values (
    auth.uid(),
    (select name from gnmap_v2_profiles where id = auth.uid()),
    v_file_name,
    v_source_form,
    v_row_count,
    v_update_count + v_insert_count,
    v_review_count
  )
  returning id into v_history_id;

  return jsonb_build_object(
    'success', true,
    'history_id', v_history_id,
    'total_rows', v_row_count,
    'inserted', v_insert_count,
    'updated', v_update_count,
    'review_count', v_review_count
  );
end;
$$;

revoke all on function gnmap_v2_import_sites(jsonb) from public;
grant execute on function gnmap_v2_import_sites(jsonb) to authenticated;
