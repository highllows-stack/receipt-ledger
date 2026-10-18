-- くらしのレシート v0.9 / 無料の修正学習機能
-- 実行前にJSONバックアップを取得してください。
-- 既存の家計簿、購入履歴、明細、月別配分を変更または削除しません。

create table if not exists public.product_learning_rules (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  match_key text not null check (char_length(match_key) between 1 and 200),
  raw_name text not null check (char_length(raw_name) between 1 and 300),
  preferred_name text not null check (char_length(preferred_name) between 1 and 300),
  canonical_name text not null check (char_length(canonical_name) between 1 and 300),
  major_category text not null check (char_length(major_category) between 1 and 100),
  minor_category text not null check (char_length(minor_category) between 1 and 100),
  origin text,
  storage_type text,
  source text not null default 'edit' check (source in ('edit','history','manual')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(ledger_id,match_key)
);

create index if not exists product_learning_rules_ledger_idx
  on public.product_learning_rules (ledger_id,updated_at desc);

alter table public.product_learning_rules enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_learning_rules' and policyname='learning_rules_read') then
    create policy learning_rules_read on public.product_learning_rules for select to authenticated
    using (public.ledger_role(ledger_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_learning_rules' and policyname='learning_rules_insert') then
    create policy learning_rules_insert on public.product_learning_rules for insert to authenticated
    with check (public.ledger_role(ledger_id) in ('owner','editor') and created_by=(select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_learning_rules' and policyname='learning_rules_update') then
    create policy learning_rules_update on public.product_learning_rules for update to authenticated
    using (public.ledger_role(ledger_id) in ('owner','editor'))
    with check (public.ledger_role(ledger_id) in ('owner','editor'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_learning_rules' and policyname='learning_rules_delete') then
    create policy learning_rules_delete on public.product_learning_rules for delete to authenticated
    using (public.ledger_role(ledger_id) in ('owner','editor'));
  end if;
end $$;

revoke all on public.product_learning_rules from anon;
grant select,insert,update,delete on public.product_learning_rules to authenticated;
