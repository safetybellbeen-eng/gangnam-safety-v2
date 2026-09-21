-- ============================================================
-- migrations/20260915_step9_admin_self_change_block.sql
-- STEP 9 최종 보안 보강: 관리자 자기 자신 status/role 변경 차단
--
-- 대상: gnmap_v2_set_user_status(uuid,text), gnmap_v2_set_user_role(uuid,text)
-- 이미 배포된 두 함수를 CREATE OR REPLACE로 갱신한다.
-- gnmap_v2_* 외 다른 객체는 변경하지 않는다.
-- ============================================================

create or replace function gnmap_v2_set_user_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_gnmap_v2_admin() then
    raise exception '관리자만 회원 상태를 변경할 수 있습니다.';
  end if;

  if p_user_id = auth.uid() then
    raise exception '자기 자신의 상태는 변경할 수 없습니다.';
  end if;

  if p_status not in ('pending', 'approved', 'rejected', 'disabled') then
    raise exception '유효하지 않은 상태값입니다: %', p_status;
  end if;

  update public.gnmap_v2_profiles
  set status = p_status
  where id = p_user_id;

  if not found then
    raise exception '대상 사용자를 찾을 수 없습니다.';
  end if;
end;
$$;

revoke all on function gnmap_v2_set_user_status(uuid, text) from public;
grant execute on function gnmap_v2_set_user_status(uuid, text) to authenticated;

create or replace function gnmap_v2_set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_gnmap_v2_admin() then
    raise exception '관리자만 회원 역할을 변경할 수 있습니다.';
  end if;

  if p_user_id = auth.uid() then
    raise exception '자기 자신의 역할은 변경할 수 없습니다.';
  end if;

  if p_role not in ('user', 'admin') then
    raise exception '유효하지 않은 역할값입니다: %', p_role;
  end if;

  update public.gnmap_v2_profiles
  set role = p_role
  where id = p_user_id;

  if not found then
    raise exception '대상 사용자를 찾을 수 없습니다.';
  end if;
end;
$$;

revoke all on function gnmap_v2_set_user_role(uuid, text) from public;
grant execute on function gnmap_v2_set_user_role(uuid, text) to authenticated;
