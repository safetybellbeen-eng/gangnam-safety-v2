-- ============================================================
-- policies.sql — V2 초안 (STEP 3)
-- 대상: gnmap_v2_* 테이블만. V1 gnmap_* 테이블은 일체 건드리지 않는다.
-- 이 파일은 아직 실행하지 않는다. 검토 후 적용한다.
-- ============================================================

-- ------------------------------------------------------------
-- 관리자 판정 함수 (RLS 정책 내부에서 재사용).
-- SECURITY DEFINER: RLS를 우회해 public.gnmap_v2_profiles를 직접 조회해야 하므로 필요.
-- search_path를 고정해 스키마 하이재킹을 방지.
-- role='admin'과 status='approved'를 모두 만족해야 관리자 권한 사용 가능
-- (disabled/rejected/pending 상태의 admin 계정은 권한을 쓸 수 없다).
-- ------------------------------------------------------------
create or replace function is_gnmap_v2_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(
    select 1 from public.gnmap_v2_profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.status = 'approved'
  );
$$;

revoke all on function is_gnmap_v2_admin() from public;
grant execute on function is_gnmap_v2_admin() to authenticated;

create or replace function is_gnmap_v2_approved()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(
    select 1 from public.gnmap_v2_profiles p
    where p.id = auth.uid() and p.status = 'approved'
  );
$$;

revoke all on function is_gnmap_v2_approved() from public;
grant execute on function is_gnmap_v2_approved() to authenticated;

-- ------------------------------------------------------------
-- 신규 가입 시 profile 자동 생성 트리거.
-- V1/V2는 같은 auth.users를 공유하므로, V2 가입 시 전달한
-- user metadata(app='gangnam-safety-v2')가 있는 경우에만 gnmap_v2_profiles를 생성한다.
-- V1 가입자(metadata 없음)는 이 트리거로 gnmap_v2_profiles에 생성되지 않는다.
-- 트리거 함수는 auth.users insert 시 Postgres가 내부적으로 호출하므로
-- PUBLIC/authenticated에 대한 별도 execute grant가 필요 없다 (오히려 열어두면 불필요한 직접 호출 허용).
-- ------------------------------------------------------------
create or replace function handle_gnmap_v2_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.raw_user_meta_data ->> 'app' = 'gangnam-safety-v2' then
    insert into public.gnmap_v2_profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function handle_gnmap_v2_new_user() from public;

drop trigger if exists on_auth_user_created_gnmap_v2 on auth.users;
create trigger on_auth_user_created_gnmap_v2
  after insert on auth.users
  for each row execute function handle_gnmap_v2_new_user();

-- ------------------------------------------------------------
-- gnmap_v2_profiles
-- SELECT: 본인 profile만 조회 가능. admin은 전체 조회 가능.
-- INSERT: 없음 — 가입 trigger(handle_gnmap_v2_new_user, SECURITY DEFINER)로만 생성됨.
-- UPDATE: 없음 — role/status 변경은 gnmap_v2_set_user_status/gnmap_v2_set_user_role
--         RPC(SECURITY DEFINER)로만 가능. admin을 포함해 어떤 역할도 테이블을 직접 UPDATE할 수 없음.
-- DELETE: 없음.
-- ------------------------------------------------------------
alter table gnmap_v2_profiles enable row level security;

create policy gnmap_v2_profiles_select_self
  on gnmap_v2_profiles for select
  using (id = auth.uid() or is_gnmap_v2_admin());

-- profile UPDATE는 RLS 정책을 열지 않는다. role/status 변경은 반드시
-- gnmap_v2_set_user_status / gnmap_v2_set_user_role RPC(SECURITY DEFINER)만 사용한다.
-- 관리자라도 테이블 직접 UPDATE 경로를 허용하지 않아 변경 경로를 RPC 하나로 강제한다.

-- profile insert는 트리거(handle_gnmap_v2_new_user, SECURITY DEFINER)로만 발생.
-- 클라이언트발 직접 insert는 막는다 (정책 없음 = 기본 거부).

-- ------------------------------------------------------------
-- gnmap_v2_sites
-- approved 사용자만 조회. 쓰기는 이 STEP에서 정책을 만들지 않는다
-- (엑셀 업로드/원자적 import는 STEP 12 RPC에서 SECURITY DEFINER로 처리 예정 —
--  일반 RLS insert/update 경로를 열어두면 import RPC 설계와 충돌 위험).
-- ------------------------------------------------------------
alter table gnmap_v2_sites enable row level security;

create policy gnmap_v2_sites_select_approved
  on gnmap_v2_sites for select
  using (is_gnmap_v2_approved() or is_gnmap_v2_admin());

-- ------------------------------------------------------------
-- gnmap_v2_favorites
-- 본인 것만 CRUD, 모든 동작에 approved 조건 적용.
-- pending/rejected/disabled 사용자는 기존 자기 데이터도 접근 불가해야 하므로
-- select/delete에도 is_gnmap_v2_approved()를 건다 (승인 취소 시 즉시 데이터 접근 차단).
-- site_id FK가 RESTRICT라 참조 무결성은 스키마 레벨에서 이미 보호됨.
-- ------------------------------------------------------------
alter table gnmap_v2_favorites enable row level security;

create policy gnmap_v2_favorites_select_own
  on gnmap_v2_favorites for select
  using (user_id = auth.uid() and is_gnmap_v2_approved());

create policy gnmap_v2_favorites_insert_own
  on gnmap_v2_favorites for insert
  with check (user_id = auth.uid() and is_gnmap_v2_approved());

create policy gnmap_v2_favorites_delete_own
  on gnmap_v2_favorites for delete
  using (user_id = auth.uid() and is_gnmap_v2_approved());

-- ------------------------------------------------------------
-- gnmap_v2_site_notes
-- 본인 것만 CRUD, 모든 동작에 approved 조건 적용.
-- ------------------------------------------------------------
alter table gnmap_v2_site_notes enable row level security;

create policy gnmap_v2_site_notes_select_own
  on gnmap_v2_site_notes for select
  using (user_id = auth.uid() and is_gnmap_v2_approved());

create policy gnmap_v2_site_notes_insert_own
  on gnmap_v2_site_notes for insert
  with check (user_id = auth.uid() and is_gnmap_v2_approved());

create policy gnmap_v2_site_notes_update_own
  on gnmap_v2_site_notes for update
  using (user_id = auth.uid() and is_gnmap_v2_approved())
  with check (user_id = auth.uid() and is_gnmap_v2_approved());

create policy gnmap_v2_site_notes_delete_own
  on gnmap_v2_site_notes for delete
  using (user_id = auth.uid() and is_gnmap_v2_approved());

-- ------------------------------------------------------------
-- gnmap_v2_upload_history
-- 조회: admin만. 쓰기: STEP 13 업로드 RPC에서 SECURITY DEFINER로 처리 예정,
-- 이 STEP에서는 일반 insert 정책을 열지 않는다.
-- ------------------------------------------------------------
alter table gnmap_v2_upload_history enable row level security;

create policy gnmap_v2_upload_history_select_admin
  on gnmap_v2_upload_history for select
  using (is_gnmap_v2_admin());

-- ------------------------------------------------------------
-- gnmap_v2_supervisions
-- sites와의 관계 미확정(STEP 14) 이지만 접근권한 자체는 이번 STEP 범위.
-- 조회: approved 사용자 전체. 쓰기: admin만.
-- ------------------------------------------------------------
alter table gnmap_v2_supervisions enable row level security;

create policy gnmap_v2_supervisions_select_approved
  on gnmap_v2_supervisions for select
  using (is_gnmap_v2_approved() or is_gnmap_v2_admin());

create policy gnmap_v2_supervisions_write_admin
  on gnmap_v2_supervisions for insert
  with check (is_gnmap_v2_admin());

create policy gnmap_v2_supervisions_update_admin
  on gnmap_v2_supervisions for update
  using (is_gnmap_v2_admin())
  with check (is_gnmap_v2_admin());

create policy gnmap_v2_supervisions_delete_admin
  on gnmap_v2_supervisions for delete
  using (is_gnmap_v2_admin());
