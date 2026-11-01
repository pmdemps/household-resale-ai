-- Fix: GET /api/assistant?find= and ?item_id= answered 500 "cannot execute UPDATE in a read-only transaction".
-- 20261101040000 declared assistant_find_items and assistant_item STABLE. PostgREST runs STABLE/IMMUTABLE
-- functions in a read-only transaction, but every assistant_* function checks its key with
-- assistant_resolve_key, which records last_used_at (an UPDATE). Like every other assistant_* function,
-- these two must be VOLATILE.
alter function public.assistant_find_items(text, text) volatile;
alter function public.assistant_item(text, uuid) volatile;
