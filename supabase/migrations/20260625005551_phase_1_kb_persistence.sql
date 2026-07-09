-- Phase 1: lossless Safe Method knowledge-base persistence.
--
-- The WHS source of truth remains the JSON files under knowledge/. This migration
-- creates a private Supabase/Postgres schema that stores those files losslessly and
-- exposes queryable columns for deterministic retrieval. It deliberately does not add
-- embeddings; optional vector retrieval belongs to Phase 7.

create schema if not exists safe_method_kb;

revoke all on schema safe_method_kb from public;

create table if not exists safe_method_kb.kb_versions (
  kb_version text primary key,
  jurisdiction text not null,
  source_manifest jsonb not null,
  source_hash_sha256 text not null,
  loaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint kb_versions_jurisdiction_nsw check (jurisdiction = 'NSW'),
  constraint kb_versions_manifest_object check (jsonb_typeof(source_manifest) = 'object')
);

create table if not exists safe_method_kb.kb_source_files (
  kb_version text not null references safe_method_kb.kb_versions(kb_version) on delete cascade,
  table_name text not null,
  source_path text not null,
  jurisdiction text not null,
  source_meta jsonb not null,
  source_document jsonb not null,
  row_count integer not null,
  file_order integer not null,
  source_hash_sha256 text not null,
  loaded_at timestamptz not null default now(),
  primary key (kb_version, table_name),
  constraint kb_source_files_known_table check (
    table_name in (
      'schedule_1',
      'hrcw_trigger_map',
      'control_library',
      'hold_point_patterns'
    )
  ),
  constraint kb_source_files_jurisdiction_nsw check (jurisdiction = 'NSW'),
  constraint kb_source_files_row_count_non_negative check (row_count >= 0),
  constraint kb_source_files_positive_order check (file_order > 0),
  constraint kb_source_files_meta_object check (jsonb_typeof(source_meta) = 'object'),
  constraint kb_source_files_document_object check (jsonb_typeof(source_document) = 'object')
);

create table if not exists safe_method_kb.schedule_1 (
  kb_version text not null references safe_method_kb.kb_versions(kb_version) on delete cascade,
  jurisdiction text not null,
  ref text not null,
  item integer not null,
  category_title text not null,
  row_order integer not null,
  source_row jsonb not null,
  source_hash_sha256 text not null,
  primary key (kb_version, ref),
  constraint schedule_1_jurisdiction_nsw check (jurisdiction = 'NSW'),
  constraint schedule_1_ref_format check (ref ~ '^H[0-9]{2}$'),
  constraint schedule_1_item_matches_ref check (item = substring(ref from 2)::integer),
  constraint schedule_1_positive_order check (row_order > 0),
  constraint schedule_1_source_row_object check (jsonb_typeof(source_row) = 'object')
);

create unique index if not exists schedule_1_version_row_order_idx
  on safe_method_kb.schedule_1 (kb_version, row_order);

create table if not exists safe_method_kb.hrcw_trigger_map (
  kb_version text not null references safe_method_kb.kb_versions(kb_version) on delete cascade,
  jurisdiction text not null,
  package text not null,
  aliases jsonb not null,
  triggers jsonb not null,
  row_order integer not null,
  source_row jsonb not null,
  source_hash_sha256 text not null,
  primary key (kb_version, package),
  constraint hrcw_trigger_map_jurisdiction_nsw check (jurisdiction = 'NSW'),
  constraint hrcw_trigger_map_aliases_array check (jsonb_typeof(aliases) = 'array'),
  constraint hrcw_trigger_map_triggers_array check (jsonb_typeof(triggers) = 'array'),
  constraint hrcw_trigger_map_positive_order check (row_order > 0),
  constraint hrcw_trigger_map_source_row_object check (jsonb_typeof(source_row) = 'object')
);

create unique index if not exists hrcw_trigger_map_version_row_order_idx
  on safe_method_kb.hrcw_trigger_map (kb_version, row_order);

create table if not exists safe_method_kb.control_library (
  kb_version text not null references safe_method_kb.kb_versions(kb_version) on delete cascade,
  jurisdiction text not null,
  id text not null,
  hazard_type text not null,
  control text not null,
  levels jsonb not null,
  residual_floor text not null,
  linked_hold_point text,
  requires_rescue_readiness boolean,
  non_hrcw boolean,
  row_order integer not null,
  source_row jsonb not null,
  source_hash_sha256 text not null,
  primary key (kb_version, id),
  constraint control_library_jurisdiction_nsw check (jurisdiction = 'NSW'),
  constraint control_library_levels_array check (jsonb_typeof(levels) = 'array'),
  constraint control_library_residual_floor check (residual_floor in ('Low', 'Medium', 'High', 'Extreme')),
  constraint control_library_positive_order check (row_order > 0),
  constraint control_library_source_row_object check (jsonb_typeof(source_row) = 'object')
);

create unique index if not exists control_library_version_row_order_idx
  on safe_method_kb.control_library (kb_version, row_order);

create table if not exists safe_method_kb.hold_point_patterns (
  kb_version text not null references safe_method_kb.kb_versions(kb_version) on delete cascade,
  jurisdiction text not null,
  id text not null,
  title text not null,
  applies_to jsonb not null,
  precondition text not null,
  authority_roles jsonb not null,
  authority_text_pattern text not null,
  evidence_required text not null,
  release_type text not null,
  engineering_release boolean not null,
  row_order integer not null,
  source_row jsonb not null,
  source_hash_sha256 text not null,
  primary key (kb_version, id),
  constraint hold_point_patterns_jurisdiction_nsw check (jurisdiction = 'NSW'),
  constraint hold_point_patterns_applies_to_array check (jsonb_typeof(applies_to) = 'array'),
  constraint hold_point_patterns_authority_roles_array check (jsonb_typeof(authority_roles) = 'array'),
  constraint hold_point_patterns_release_type_whs check (release_type = 'WHS'),
  constraint hold_point_patterns_positive_order check (row_order > 0),
  constraint hold_point_patterns_source_row_object check (jsonb_typeof(source_row) = 'object')
);

create unique index if not exists hold_point_patterns_version_row_order_idx
  on safe_method_kb.hold_point_patterns (kb_version, row_order);

alter table safe_method_kb.kb_versions enable row level security;
alter table safe_method_kb.kb_source_files enable row level security;
alter table safe_method_kb.schedule_1 enable row level security;
alter table safe_method_kb.hrcw_trigger_map enable row level security;
alter table safe_method_kb.control_library enable row level security;
alter table safe_method_kb.hold_point_patterns enable row level security;

comment on schema safe_method_kb is
  'Private Safe Method knowledge-base schema. Source content remains in versioned knowledge/*.json files.';

comment on table safe_method_kb.kb_source_files is
  'Lossless source-file records used to prove that loaded KB rows round-trip back to the approved JSON.';
