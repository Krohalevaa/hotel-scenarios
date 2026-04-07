-- New database schema for Hotel Scenarios
-- Keeps authentication in Supabase Auth.
-- Application tables are reduced to 4 core tables:
-- 1) user_profiles
-- 2) hotel_scenarios
-- 3) hotel_source_data
-- 4) hotel_discovered_attractions

create extension if not exists pgcrypto;

-- Optional cleanup of old application tables.
-- Uncomment if you want to remove the previous schema first.
-- drop table if exists hotel_attractions cascade;
-- drop table if exists scenario_attractions cascade;
-- drop table if exists video_scripts cascade;
-- drop table if exists profiles cascade;

create table if not exists public.user_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    first_name text,
    last_name text,
    email text not null,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_profiles_email_unique unique (email)
);

create index if not exists idx_user_profiles_email on public.user_profiles(email);

create table if not exists public.hotel_scenarios (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.user_profiles(user_id) on delete cascade,
    contact_email text,
    hotel_url text not null,
    business_goal text,
    guest_preference text,
    city text,
    country text,
    language text not null default 'Russian',
    status text not null default 'new',
    hotel_name text,
    selected_place_categories jsonb not null default '[]'::jsonb,
    final_script text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint hotel_scenarios_status_check check (status in ('new', 'processing', 'completed', 'failed')),
    constraint hotel_scenarios_selected_place_categories_check check (jsonb_typeof(selected_place_categories) = 'array')
);

create index if not exists idx_hotel_scenarios_user_id on public.hotel_scenarios(user_id);
create index if not exists idx_hotel_scenarios_status on public.hotel_scenarios(status);
create index if not exists idx_hotel_scenarios_country on public.hotel_scenarios(country);
create index if not exists idx_hotel_scenarios_created_at on public.hotel_scenarios(created_at desc);
create index if not exists idx_hotel_scenarios_user_id_created_at on public.hotel_scenarios(user_id, created_at desc);

create table if not exists public.hotel_source_data (
    id bigserial primary key,
    scenario_id uuid not null unique references public.hotel_scenarios(id) on delete cascade,
    hotel_url text not null,
    hotel_name text,
    city text,
    country text,
    address text,
    latitude double precision,
    longitude double precision,
    attractions_found boolean not null default false,
    key_features jsonb not null default '[]'::jsonb,
    attraction_count integer not null default 0,
    selected_attraction_count integer not null default 0,
    search_radius_meters integer not null default 3000,
    selected_place_categories jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint hotel_source_data_key_features_check check (
        jsonb_typeof(key_features) = 'array'
        and jsonb_array_length(key_features) <= 5
    ),
    constraint hotel_source_data_selected_place_categories_check check (jsonb_typeof(selected_place_categories) = 'array')
);

create index if not exists idx_hotel_source_data_city on public.hotel_source_data(city);
create index if not exists idx_hotel_source_data_country on public.hotel_source_data(country);

create table if not exists public.hotel_discovered_attractions (
    id bigserial primary key,
    scenario_id uuid not null unique references public.hotel_scenarios(id) on delete cascade,
    hotel_name text,
    city text,
    country text,
    attraction_categories jsonb not null default '{}'::jsonb,
    selected_attractions jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    constraint hotel_discovered_attractions_categories_check check (jsonb_typeof(attraction_categories) = 'object'),
    constraint hotel_discovered_attractions_selected_attractions_check check (jsonb_typeof(selected_attractions) = 'array')
);

create unique index if not exists idx_hotel_discovered_attractions_scenario_id_unique
on public.hotel_discovered_attractions(scenario_id);

create index if not exists idx_hotel_discovered_attractions_scenario_id on public.hotel_discovered_attractions(scenario_id);
create index if not exists idx_hotel_discovered_attractions_hotel_name on public.hotel_discovered_attractions(hotel_name);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.set_updated_at();

drop trigger if exists trg_hotel_scenarios_updated_at on public.hotel_scenarios;
create trigger trg_hotel_scenarios_updated_at
before update on public.hotel_scenarios
for each row
execute function public.set_updated_at();

drop trigger if exists trg_hotel_source_data_updated_at on public.hotel_source_data;
create trigger trg_hotel_source_data_updated_at
before update on public.hotel_source_data
for each row
execute function public.set_updated_at();

alter table public.user_profiles enable row level security;
alter table public.hotel_scenarios enable row level security;
alter table public.hotel_source_data enable row level security;
alter table public.hotel_discovered_attractions enable row level security;

drop policy if exists "Users can read own profile" on public.user_profiles;
create policy "Users can read own profile"
on public.user_profiles
for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert own profile" on public.user_profiles;
create policy "Users can insert own profile"
on public.user_profiles
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own profile" on public.user_profiles;
create policy "Users can update own profile"
on public.user_profiles
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can read own scenarios" on public.hotel_scenarios;
create policy "Users can read own scenarios"
on public.hotel_scenarios
for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert own scenarios" on public.hotel_scenarios;
create policy "Users can insert own scenarios"
on public.hotel_scenarios
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own scenarios" on public.hotel_scenarios;
create policy "Users can update own scenarios"
on public.hotel_scenarios
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can read own source data" on public.hotel_source_data;
create policy "Users can read own source data"
on public.hotel_source_data
for select
using (
    exists (
        select 1
        from public.hotel_scenarios hs
        where hs.id = hotel_source_data.scenario_id
          and hs.user_id = auth.uid()
    )
);

drop policy if exists "Users can insert own source data" on public.hotel_source_data;
create policy "Users can insert own source data"
on public.hotel_source_data
for insert
with check (
    exists (
        select 1
        from public.hotel_scenarios hs
        where hs.id = hotel_source_data.scenario_id
          and hs.user_id = auth.uid()
    )
);

drop policy if exists "Users can update own source data" on public.hotel_source_data;
create policy "Users can update own source data"
on public.hotel_source_data
for update
using (
    exists (
        select 1
        from public.hotel_scenarios hs
        where hs.id = hotel_source_data.scenario_id
          and hs.user_id = auth.uid()
    )
)
with check (
    exists (
        select 1
        from public.hotel_scenarios hs
        where hs.id = hotel_source_data.scenario_id
          and hs.user_id = auth.uid()
    )
);

drop policy if exists "Users can read own discovered attractions" on public.hotel_discovered_attractions;
create policy "Users can read own discovered attractions"
on public.hotel_discovered_attractions
for select
using (
    exists (
        select 1
        from public.hotel_scenarios hs
        where hs.id = hotel_discovered_attractions.scenario_id
          and hs.user_id = auth.uid()
    )
);

drop policy if exists "Users can insert own discovered attractions" on public.hotel_discovered_attractions;
create policy "Users can insert own discovered attractions"
on public.hotel_discovered_attractions
for insert
with check (
    exists (
        select 1
        from public.hotel_scenarios hs
        where hs.id = hotel_discovered_attractions.scenario_id
          and hs.user_id = auth.uid()
    )
);

comment on table public.user_profiles is 'Application profile data. Authentication remains in Supabase Auth.';
comment on table public.hotel_scenarios is 'Generated hotel video scenarios and final scripts.';
comment on table public.hotel_source_data is 'Parsed source data collected by headless browser and geocoding pipeline.';
comment on table public.hotel_discovered_attractions is 'All discovered nearby attractions for a hotel scenario plus the subset selected for the final scenario.';
