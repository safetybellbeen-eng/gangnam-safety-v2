-- STEP18 (이미 운영 DB에 적용됨 — 기록용). V2 전용(gnmap_v2_*) 객체만 변경한다.
-- 1) 관리자 전용 RPC의 비로그인(anon) 호출 권한 회수 (함수 내부 관리자 검사는 그대로 유지)
revoke execute on function public.gnmap_v2_set_user_status(uuid, text), public.gnmap_v2_set_user_role(uuid, text),
  public.gnmap_v2_delete_rejected_profile(uuid), public.gnmap_v2_import_sites(jsonb), public.gnmap_v2_get_last_upload_at() from anon;
-- 2) 엑셀 내보내기 이력(승인된 사용자 누구나 자기 내보내기를 기록)
create or replace function public.gnmap_v2_log_export(p_count integer, p_scope text)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select name into v_name from public.gnmap_v2_profiles where id = auth.uid() and status = 'approved';
  if v_name is null then raise exception '승인된 사용자만 기록할 수 있습니다.'; end if;
  insert into public.gnmap_v2_audit_logs(actor_id, actor_name, action, target_name, detail)
  values (auth.uid(), v_name, 'sites_export', left(coalesce(p_scope, ''), 100), jsonb_build_object('count', greatest(coalesce(p_count, 0), 0)));
end $$;
revoke all on function public.gnmap_v2_log_export(integer, text) from public, anon;
grant execute on function public.gnmap_v2_log_export(integer, text) to authenticated;
-- 3) 관리자 MFA 서버 강제는 적용했다가 사용자 결정으로 철회함(gnmap_v2_mfa_ok 삭제, is_gnmap_v2_admin 원래 정의로 복원). 앱 코드에도 MFA 없음.
