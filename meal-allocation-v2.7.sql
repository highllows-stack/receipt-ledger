-- v2.7: Breakfast / lunch / dinner amount allocation per purchased item.
-- Safe to run more than once. Existing purchase rows and RLS policies remain intact.
ALTER TABLE public.purchase_items
  ADD COLUMN IF NOT EXISTS meal_allocations jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.purchase_items.meal_allocations IS
  'Meal amount allocation in yen: breakfast, lunch, dinner. Empty object means all dinner.';
