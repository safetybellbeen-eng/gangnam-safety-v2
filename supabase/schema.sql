-- ============================================================
-- schema.sql — V2 최종안 (STEP 2, gnmap_v2_ 접두사 적용)
-- V1(motorrad-pulse)과 같은 Supabase 프로젝트를 공유하므로
-- 모든 테이블/인덱스/제약에 gnmap_v2_ 접두사를 붙여 V1과 분리한다.
-- 이 파일은 아직 실행하지 않는다. 검토 후 적용한다.
-- ============================================================

-- ------------------------------------------------------------
-- gnmap_v2_profiles: auth.users와 1:1. 승인 여부/역할 관리.
-- role/status는 CHECK로 값 제한. STEP 3에서 필요 시 값 목록 조정 가능.
-- ------------------------------------------------------------
create table gnmap_v2_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text,
  role text not null default 'user'
    check (role in ('user', 'admin')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'disabled')),
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- gnmap_v2_sites: 사업장 원장. id는 불변 PK — gnmap_v2_favorites/gnmap_v2_site_notes가 이 id를 참조.
-- 공식 식별번호는 전부 text. business_start_no는 아직 UNIQUE 미확정(STEP 10에서 실 데이터 검증 후 결정).
-- lat/lng는 nullable 유지 (지오코딩 실패 행 존재).
-- ------------------------------------------------------------
create table gnmap_v2_sites (
  id bigint generated always as identity primary key,

  -- 공식 식별번호 (전부 text, 앞자리 0 손실 방지)
  business_start_no text,
  industrial_accident_no text,   -- 산재관리번호
  corporate_no text,             -- 법인등록번호
  business_registration_no text, -- 사업자등록번호

  company_name text,
  site_name text,
  address text,
  lat double precision,
  lng double precision,
  dong text,
  amount bigint
    check (amount is null or amount >= 0),
  period_start date,
  period_end date,
  accident_report_count int
    check (accident_report_count is null or accident_report_count >= 0),
  supervision_count int
    check (supervision_count is null or supervision_count >= 0),
  source_form text,
  status text,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gnmap_v2_sites_period_check
    check (period_start is null or period_end is null or period_end >= period_start)
);

-- 매칭용 조회 인덱스 (UNIQUE 아님 — STEP 10에서 고유성 검증 후 별도 제약 추가 여부 결정)
create index gnmap_v2_sites_business_start_no_idx on gnmap_v2_sites(business_start_no);
create index gnmap_v2_sites_is_active_idx on gnmap_v2_sites(is_active);

-- ------------------------------------------------------------
-- gnmap_v2_favorites: 사용자별 즐겨찾기.
-- site_id FK는 RESTRICT — gnmap_v2_sites 삭제 시도 자체를 DB가 막아 하드 삭제 사고를 방지한다.
-- (V2는 site hard delete를 금지하고 is_active=false만 사용하므로,
--  즐겨찾기/메모가 남아있는 사업장은 애초에 delete가 불가능해야 한다.)
-- ------------------------------------------------------------
create table gnmap_v2_favorites (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  site_id bigint not null references gnmap_v2_sites(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (user_id, site_id)
);

-- ------------------------------------------------------------
-- gnmap_v2_site_notes: 사용자별 개인 메모. 1인 1사업장 1메모.
-- site_id FK는 gnmap_v2_favorites와 동일하게 RESTRICT.
-- ------------------------------------------------------------
create table gnmap_v2_site_notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  site_id bigint not null references gnmap_v2_sites(id) on delete restrict,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, site_id)
);

-- ------------------------------------------------------------
-- gnmap_v2_upload_history: 엑셀 업로드 이력. 업로드한 사용자가 삭제되어도 이력은 남긴다(set null).
-- ------------------------------------------------------------
create table gnmap_v2_upload_history (
  id bigint generated always as identity primary key,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text,
  file_name text,
  source_form text,
  total_rows int,
  confirmed_rows int,
  review_rows int,
  uploaded_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- gnmap_v2_supervisions: 지도감독/점검.
-- gnmap_v2_sites와의 관계는 미확정 상태로 둔다 (V1 실사용 방식을 STEP 14에서 확인 후 결정).
-- 이번 STEP에서는 site_id 컬럼/FK를 넣지 않는다 — 성급한 고정 방지.
-- 등록한 관리자가 삭제되어도 이력은 남긴다(set null).
-- ------------------------------------------------------------
create table gnmap_v2_supervisions (
  id bigint generated always as identity primary key,
  title text not null,
  manager_name text,
  start_date date not null,
  end_date date not null,
  status text not null default 'scheduled',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gnmap_v2_supervisions_date_check
    check (end_date >= start_date)
);
