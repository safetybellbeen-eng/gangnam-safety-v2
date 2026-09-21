-- ============================================================
-- migrations/20260917_step12a_sites_provenance_and_business_start_no_unique.sql
-- STEP12-A: gnmap_v2_sites에 위치 provenance 컬럼 추가 + business_start_no partial UNIQUE
--
-- 대상: gnmap_v2_sites 컬럼/제약/인덱스만. gnmap_v2_* 외 다른 객체(V1 gnmap_* 포함)는 건드리지 않는다.
-- RPC/functions.sql/frontend/upload_history/데이터 INSERT는 이번 migration 범위가 아니다.
-- 재실행 안전(idempotent): 컬럼/제약/인덱스가 이미 있으면 건너뛴다.
-- ============================================================

-- ------------------------------------------------------------
-- 1) 위치 provenance 컬럼 4개 추가 (전부 nullable — UNRESOLVED 행은 lat/lng와 함께 전부 null 허용)
-- ------------------------------------------------------------
alter table gnmap_v2_sites
  add column if not exists location_quality text,
  add column if not exists geocode_method text,
  add column if not exists location_query text,
  add column if not exists matched_address text;

-- ------------------------------------------------------------
-- 2) location_quality CHECK constraint (재실행 안전을 위해 기존 것이 있으면 먼저 제거 후 재생성)
-- ------------------------------------------------------------
alter table gnmap_v2_sites
  drop constraint if exists gnmap_v2_sites_location_quality_check;

alter table gnmap_v2_sites
  add constraint gnmap_v2_sites_location_quality_check
  check (location_quality is null or location_quality in ('EXACT', 'ESTIMATED', 'APPROXIMATE', 'MANUAL', 'UNRESOLVED'));

-- ------------------------------------------------------------
-- 3) business_start_no partial UNIQUE index (NULL은 여러 개 허용, NOT NULL 값만 중복 방지)
-- business_start_no 컬럼 자체는 NOT NULL로 바꾸지 않는다 — 예외 데이터 가능성을 열어둔다.
-- 기존 gnmap_v2_sites_business_start_no_idx(일반 인덱스, schema.sql)는 그대로 둔다 — 이 migration은
-- 새 UNIQUE 인덱스만 추가하며 기존 인덱스를 변경/삭제하지 않는다.
-- ------------------------------------------------------------
drop index if exists gnmap_v2_sites_business_start_no_uidx;

create unique index gnmap_v2_sites_business_start_no_uidx
  on gnmap_v2_sites (business_start_no)
  where business_start_no is not null;
