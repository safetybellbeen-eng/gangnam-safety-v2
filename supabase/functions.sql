-- ============================================================
-- functions.sql — V2 (STEP 9 최종 보안 보강)
-- 관리자 승인/거절/비활성화 RPC.
-- gnmap_v2_profiles에는 UPDATE를 허용하는 RLS 정책이 없다(policies.sql 참조 —
-- 관리자를 포함해 어떤 역할도 테이블을 직접 UPDATE할 수 없음).
-- role/status 변경은 오직 이 RPC(SECURITY DEFINER, 내부에서 is_gnmap_v2_admin() 재검증)로만 가능하다.
-- 관리자는 자기 자신(p_user_id = auth.uid())의 status/role을 이 RPC로 변경할 수 없다 —
-- 프론트 disabled는 UX 보조일 뿐, 이 DB 체크가 최종 보안 경계다.
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

-- ------------------------------------------------------------
-- role 변경(예: 관리자 임명)도 동일하게 RPC로만 허용.
-- ------------------------------------------------------------
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
