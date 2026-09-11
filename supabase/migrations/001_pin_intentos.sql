-- Bloqueo por intentos fallidos de PIN en la Edge Function comprobantes-cel.
-- Una fila por IP de origen. La función (service_role) la lee/escribe; RLS
-- habilitado sin políticas = nadie más la toca (ni anon ni authenticated).
create table if not exists public.pin_intentos (
  ip              text primary key,
  fallidos        integer     not null default 0,
  primer_fallo    timestamptz not null default now(),
  bloqueado_hasta timestamptz,
  actualizado     timestamptz not null default now()
);
alter table public.pin_intentos enable row level security;
comment on table public.pin_intentos is
  'comprobantes-cel: intentos fallidos de PIN por IP (5 fallos en 15 min => bloqueo 15 min)';
