-- ============================================================
-- migrations/20260921_step14_supervisions_status_check.sql
-- STEP14: gnmap_v2_supervisions.status에 CHECK 제약 추가 (scheduled/ongoing/done만 허용)
--
-- 대상: gnmap_v2_supervisions 제약만. 다른 테이블/V1 gnmap_*는 건드리지 않는다.
-- site_id/FK 연결은 이번 STEP 범위가 아니므로 여기서 추가하지 않는다.
-- 재실행 안전(idempotent): 기존 동일 이름 제약이 있으면 먼저 제거 후 재생성한다.
--
-- 주의: 이 제약을 추가하기 전에, 기존 데이터 중 scheduled/ongoing/done이 아닌 status 값이
-- 있으면 ALTER TABLE ADD CONSTRAINT 자체가 실패한다. 아래 SELECT로 먼저 확인하고,
-- 위반 행이 있으면 이 migration을 실행하기 전에 그 값을 먼저 정리해야 한다.
-- ============================================================

-- 1) 제약 추가 전 확인용(참고용 주석 — 실행 결과가 0행이어야 안전하게 진행 가능):
-- select id, title, status from gnmap_v2_supervisions
--   where status is null or status not in ('scheduled', 'ongoing', 'done');

alter table gnmap_v2_supervisions
  drop constraint if exists gnmap_v2_supervisions_status_check;

alter table gnmap_v2_supervisions
  add constraint gnmap_v2_supervisions_status_check
  check (status in ('scheduled', 'ongoing', 'done'));
