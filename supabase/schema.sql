-- Regnskab: databaseskema
-- Kør hele filen i Supabase → SQL Editor → New query → Run.

create extension if not exists pgcrypto;

-- ───────────── Indstillinger (én række pr. bruger) ─────────────
create table if not exists settings (
  user_id         uuid primary key references auth.users on delete cascade,
  company_name    text default '',
  owner_name      text default '',
  address         text default '',
  zip_city        text default '',
  cvr             text default '',
  email           text default '',
  phone           text default '',
  bank_reg        text default '',
  bank_account    text default '',
  iban            text default '',
  vat_registered  boolean default false,
  default_vat_rate numeric default 0,
  payment_days    int default 14,
  -- Kørselssatser: tjek SKATs satser for det aktuelle år og ret dem i appen.
  km_rate         numeric default 3.94,
  km_rate_low     numeric default 2.28,
  km_threshold    int default 20000,
  invoice_footer  text default '',
  updated_at      timestamptz default now()
);

-- ───────────── Faste ture (hurtigknapper) ─────────────
create table if not exists routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  label       text not null,
  from_place  text default '',
  to_place    text default '',
  km          numeric not null check (km > 0),   -- én vej
  round_trip  boolean default false,
  purpose     text default '',
  sort        int default 0,
  created_at  timestamptz default now()
);

-- ───────────── Kørsel ─────────────
create table if not exists trips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  trip_date   date not null default current_date,
  from_place  text default '',
  to_place    text default '',
  km          numeric not null check (km > 0),
  purpose     text default '',
  created_at  timestamptz default now()
);
create index if not exists trips_user_date on trips (user_id, trip_date);

-- ───────────── Kunder ─────────────
create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  address     text default '',
  zip_city    text default '',
  cvr         text default '',
  email       text default '',
  created_at  timestamptz default now()
);

-- ───────────── Fakturaer ─────────────
create table if not exists invoices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  number           text not null,
  year             int  not null,
  seq              int  not null,
  customer_id      uuid references customers on delete set null,
  customer_name    text not null,
  customer_address text default '',
  customer_zip_city text default '',
  customer_cvr     text default '',
  customer_email   text default '',
  issue_date       date not null default current_date,
  due_date         date not null,
  status           text not null default 'draft' check (status in ('draft','sent','paid','cancelled')),
  sent_date        date,
  paid_date        date,
  lines            jsonb not null default '[]',
  vat_rate         numeric not null default 0,
  subtotal         numeric not null default 0,
  vat_amount       numeric not null default 0,
  total            numeric not null default 0,
  note             text default '',
  created_at       timestamptz default now(),
  unique (user_id, number)
);
create index if not exists invoices_user_status on invoices (user_id, status);

-- ───────────── Øvrige indtægter (uden faktura) ─────────────
create table if not exists income (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  income_date  date not null default current_date,
  source       text not null,
  amount       numeric not null,          -- inkl. moms
  vat_amount   numeric default 0,         -- heraf moms
  note         text default '',
  created_at   timestamptz default now()
);

-- ───────────── Bilag ─────────────
create table if not exists receipts (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  status        text not null default 'pending' check (status in ('pending','approved')),
  file_path     text,
  file_name     text,
  mime          text,
  vendor        text default '',
  receipt_date  date,
  total         numeric,                  -- altid i DKK
  vat_amount    numeric default 0,
  currency      text default 'DKK',
  orig_total    numeric,                  -- beløb i anden valuta, hvis bilaget ikke er i DKK
  category      text default '',
  note          text default '',
  extract_error text,
  created_at    timestamptz default now(),
  approved_at   timestamptz
);
create index if not exists receipts_user_status on receipts (user_id, status);

-- ───────────── Row Level Security: kun din egen data ─────────────
do $$
declare t text;
begin
  foreach t in array array['settings','routes','trips','customers','invoices','income','receipts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "own rows" on %I', t);
    execute format(
      'create policy "own rows" on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Opret indstillingsrække automatisk for nye brugere
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────── Fillager til bilag (privat) ─────────────
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts read own" on storage.objects;
create policy "receipts read own" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "receipts delete own" on storage.objects;
create policy "receipts delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

-- Upload sker via Edge Function (service role), så der er ingen insert-policy.
