-- STEP19: 공유 현장 메모 (gnmap_v2_shared_notes) — V2 전용 객체만 추가한다. V1 gnmap_* 및 기존 gnmap_v2_site_notes(개인 메모)는 변경하지 않는다.
-- 승인된 모든 사용자가 읽을 수 있고, 작성자 본인만 수정/삭제(관리자는 삭제만) 가능. 1현장에 여러 건(댓글형).

create table if not exists public.gnmap_v2_shared_notes (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.gnmap_v2_sites(id) on delete restrict,
  author_id uuid not null default auth.uid() references auth.users(id) on delete set null,
  author_name text not null default '',
  content text not null check (char_length(btrim(content)) between 1 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists gnmap_v2_shared_notes_site_idx on public.gnmap_v2_shared_notes (site_id, created_at desc);

-- 작성자 정보는 클라이언트 값을 믿지 않고 서버에서 채운다(작성자 사칭 방지). 수정 시에는 내용 외 컬럼 변경 차단.
create or replace function public.gnmap_v2_shared_notes_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.author_id := auth.uid();
    select coalesce(p.name, '') into new.author_name from public.gnmap_v2_profiles p where p.id = auth.uid();
    new.author_name := coalesce(new.author_name, '');
    new.content := btrim(new.content);
    new.created_at := now();
    new.updated_at := now();
  else
    new.id := old.id; new.site_id := old.site_id; new.author_id := old.author_id;
    new.author_name := old.author_name; new.created_at := old.created_at;
    new.content := btrim(new.content);
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke all on function public.gnmap_v2_shared_notes_guard() from public, anon, authenticated;

drop trigger if exists gnmap_v2_shared_notes_guard_trg on public.gnmap_v2_shared_notes;
create trigger gnmap_v2_shared_notes_guard_trg
  before insert or update on public.gnmap_v2_shared_notes
  for each row execute function public.gnmap_v2_shared_notes_guard();

alter table public.gnmap_v2_shared_notes enable row level security;

create policy gnmap_v2_shared_notes_select_approved
  on public.gnmap_v2_shared_notes for select
  using (is_gnmap_v2_approved());

create policy gnmap_v2_shared_notes_insert_own
  on public.gnmap_v2_shared_notes for insert
  with check (is_gnmap_v2_approved());

create policy gnmap_v2_shared_notes_update_own
  on public.gnmap_v2_shared_notes for update
  using (author_id = auth.uid() and is_gnmap_v2_approved())
  with check (author_id = auth.uid() and is_gnmap_v2_approved());

create policy gnmap_v2_shared_notes_delete_own_or_admin
  on public.gnmap_v2_shared_notes for delete
  using ((author_id = auth.uid() and is_gnmap_v2_approved()) or is_gnmap_v2_admin());

revoke all on public.gnmap_v2_shared_notes from anon;
grant select, insert, update, delete on public.gnmap_v2_shared_notes to authenticated;
