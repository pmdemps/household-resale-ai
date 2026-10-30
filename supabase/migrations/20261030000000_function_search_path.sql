-- Pin search_path on trigger functions (Supabase security advisor: function_search_path_mutable).
alter function public.set_updated_at() set search_path = public;
alter function public.notes_guard_update() set search_path = public;
