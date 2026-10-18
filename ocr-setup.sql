-- くらしのレシート v0.4 / OCR 認証ユーザーごとの利用制限と重複防止
-- 既存購入履歴を削除しません。Supabase SQL Editorで一度実行。

-- OCRの同一レシート重複登録を防ぐ（新規購入にのみ適用）
alter table public.purchases add column if not exists receipt_fingerprint text;
create unique index if not exists purchases_ledger_ocr_fingerprint_idx
  on public.purchases (ledger_id,receipt_fingerprint)
  where receipt_fingerprint is not null;

-- 利用回数。クライアントからの直接読み書きは禁止。
create table if not exists public.receipt_ocr_usage (
  month_key text not null,
  subject text not null,
  call_count integer not null default 0 check (call_count >= 0),
  primary key (month_key, subject)
);
alter table public.receipt_ocr_usage enable row level security;
revoke all on table public.receipt_ocr_usage from anon, authenticated;

-- 同時リクエストも一元カウント。月間プロジェクト全体500件、ユーザーごと100件。
-- UTC基準の月。呼び出し失敗分もカウントする（安全側）。
create or replace function public.claim_receipt_ocr_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := (select auth.uid());
  mm text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  user_subject text;
  global_count integer;
  user_count integer;
begin
  if account_id is null then return false; end if;
  user_subject := 'user:' || account_id::text;
  perform pg_catalog.pg_advisory_xact_lock(714572923);
  insert into public.receipt_ocr_usage(month_key,subject,call_count)
  values (mm, 'global', 0), (mm, user_subject, 0)
  on conflict (month_key,subject) do nothing;
  select call_count into global_count from public.receipt_ocr_usage
   where month_key=mm and subject='global';
  select call_count into user_count from public.receipt_ocr_usage
   where month_key=mm and subject=user_subject;
  if global_count >= 500 or user_count >= 100 then return false; end if;
  update public.receipt_ocr_usage set call_count=call_count+1
   where month_key=mm and subject in ('global',user_subject);
  return true;
end;
$$;
revoke all on function public.claim_receipt_ocr_quota() from public, anon;
grant execute on function public.claim_receipt_ocr_quota() to authenticated;
