-- STEP17: 관리자 작업 감사로그 + 마지막 접속 시각 기록
-- V2 전용 객체만 추가한다(V1 객체/테이블은 건드리지 않음). 기존 RPC 본문은 수정하지 않고 트리거로 기록한다.

-- 1) 감사로그 테이블: 읽기는 관리자만, 쓰기는 아래 트리거/함수(SECURITY DEFINER)로만 가능.
create table if not exists public.gnmap_v2_audit_logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor_id    uuid,
  actor_name  text,
  action      text not null,
  target_id   uuid,
  target_name text,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists gnmap_v2_audit_logs_created_idx on public.gnmap_v2_audit_logs (created_at desc);
alter table public.gnmap_v2_audit_logs enable row level security;
revoke all on table public.gnmap_v2_audit_logs from anon, authenticated;
grant select on table public.gnmap_v2_audit_logs to authenticated;
drop policy if exists gnmap_v2_audit_select_admin on public.gnmap_v2_audit_logs;
create policy gnmap_v2_audit_select_admin on public.gnmap_v2_audit_logs
  for select to authenticated using (public.is_gnmap_v2_admin());

-- 2) 회원 상태/권한 변경, 회원 삭제 기록 (기존 RPC가 profiles를 바꿀 때 자동 기록)
create or replace function public.gnmap_v2_audit_profiles()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
begin
  select name into v_name from public.gnmap_v2_profiles where id = v_actor;
  if tg_op = 'DELETE' then
    insert into public.gnmap_v2_audit_logs(actor_id, actor_name, action, target_id, target_name, detail)
    values (v_actor, coalesce(v_name, 'system'), 'user_delete', old.id, old.name,
            jsonb_build_object('status', old.status, 'role', old.role));
    return old;
  end if;
  if new.status is distinct from old.status then
    insert into public.gnmap_v2_audit_logs(actor_id, actor_name, action, target_id, target_name, detail)
    values (v_actor, coalesce(v_name, 'system'), 'user_status_change', new.id, new.name,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.role is distinct from old.role then
    insert into public.gnmap_v2_audit_logs(actor_id, actor_name, action, target_id, target_name, detail)
    values (v_actor, coalesce(v_name, 'system'), 'user_role_change', new.id, new.name,
            jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  return new;
end $$;
revoke all on function public.gnmap_v2_audit_profiles() from public, anon, authenticated;

drop trigger if exists gnmap_v2_audit_profiles_upd on public.gnmap_v2_profiles;
create trigger gnmap_v2_audit_profiles_upd after update of status, role on public.gnmap_v2_profiles
  for each row execute function public.gnmap_v2_audit_profiles();
drop trigger if exists gnmap_v2_audit_profiles_del on public.gnmap_v2_profiles;
create trigger gnmap_v2_audit_profiles_del after delete on public.gnmap_v2_profiles
  for each row execute function public.gnmap_v2_audit_profiles();

-- 3) 엑셀 업로드(사업장 데이터 반영) 기록: 기존 업로드 이력 테이블에 행이 추가될 때 기록
create or replace function public.gnmap_v2_audit_upload()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.gnmap_v2_audit_logs(actor_id, actor_name, action, target_name, detail)
  values (new.uploaded_by, coalesce(new.uploaded_by_name, 'system'), 'sites_import', new.file_name,
          jsonb_build_object('total_rows', new.total_rows, 'confirmed_rows', new.confirmed_rows,
                             'review_rows', new.review_rows, 'source_form', new.source_form));
  return new;
end $$;
revoke all on function public.gnmap_v2_audit_upload() from public, anon, authenticated;
drop trigger if exists gnmap_v2_audit_upload_ins on public.gnmap_v2_upload_history;
create trigger gnmap_v2_audit_upload_ins after insert on public.gnmap_v2_upload_history
  for each row execute function public.gnmap_v2_audit_upload();

-- 4) 비밀번호 초기화(Edge Function으로 처리되어 DB 트리거가 없음): 관리자 확인 후 기록하는 함수.
create or replace function public.gnmap_v2_audit_log(p_action text, p_target_id uuid, p_target_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.is_gnmap_v2_admin() then
    raise exception '관리자만 기록할 수 있습니다.';
  end if;
  if p_action not in ('user_password_reset') then
    raise exception '허용되지 않은 작업 유형입니다.';
  end if;
  select name into v_name from public.gnmap_v2_profiles where id = auth.uid();
  insert into public.gnmap_v2_audit_logs(actor_id, actor_name, action, target_id, target_name)
  values (auth.uid(), v_name, p_action, p_target_id, left(p_target_name, 100));
end $$;
revoke all on function public.gnmap_v2_audit_log(text, uuid, text) from public, anon;
grant execute on function public.gnmap_v2_audit_log(text, uuid, text) to authenticated;

-- 5) 마지막 접속 시각: 로그인/앱 시작 시 앱이 호출(1시간 이내 중복 갱신 안 함). 장기 미접속 판정용.
create or replace function public.gnmap_v2_touch_login()
returns void language sql security definer set search_path = public as $$
  update public.gnmap_v2_profiles set last_login_at = now()
  where id = auth.uid() and (last_login_at is null or last_login_at < now() - interval '1 hour');
$$;
revoke all on function public.gnmap_v2_touch_login() from public, anon;
grant execute on function public.gnmap_v2_touch_login() to authenticated;

-- 6) 기존 계정의 마지막 접속 시각을 Auth의 마지막 로그인 시각으로 1회 보정(없는 경우만)
update public.gnmap_v2_profiles p set last_login_at = u.last_sign_in_at
from auth.users u where u.id = p.id and p.last_login_at is null and u.last_sign_in_at is not null;
