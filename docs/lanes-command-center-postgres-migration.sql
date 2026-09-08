-- Command Center/Postgres lanes v2 ambiguity fence.
--
-- Apply this migration before enabling the HTTP worker. The finish endpoint
-- must run its action and run updates in one transaction. In particular, it
-- must not translate an unresolved external response into `failed`, and a
-- finish for a different action must not clear the run's ambiguity fence.

CREATE UNIQUE INDEX IF NOT EXISTS lane_v2_one_unresolved_action
  ON lane_v2_actions (run_id, stage)
  WHERE status IN ('pending', 'ambiguous');

CREATE OR REPLACE FUNCTION lane_v2_guard_ambiguous_action_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'ambiguous' AND NEW.status <> 'reconciled' THEN
    RAISE EXCEPTION 'action is already resolved'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lane_v2_ambiguous_action_transition
  ON lane_v2_actions;
CREATE TRIGGER lane_v2_ambiguous_action_transition
  BEFORE UPDATE OF status ON lane_v2_actions
  FOR EACH ROW
  EXECUTE FUNCTION lane_v2_guard_ambiguous_action_transition();

CREATE OR REPLACE FUNCTION lane_v2_preserve_ambiguous_action_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only authoritative reconciliation of the fenced action may clear the
  -- pointer. An unrelated action update, including a successful finish, must
  -- leave it intact. The endpoint's action/run CAS still provides the normal
  -- lost-update protection.
  IF OLD.ambiguous_action_id IS NOT NULL
     AND NEW.ambiguous_action_id IS NULL
     AND NOT EXISTS (
       SELECT 1
       FROM lane_v2_actions
       WHERE action_id = OLD.ambiguous_action_id
         AND status = 'reconciled'
     ) THEN
    NEW.ambiguous_action_id := OLD.ambiguous_action_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lane_v2_ambiguous_action_fence
  ON lane_v2_runs;
CREATE TRIGGER lane_v2_ambiguous_action_fence
  BEFORE UPDATE OF ambiguous_action_id ON lane_v2_runs
  FOR EACH ROW
  EXECUTE FUNCTION lane_v2_preserve_ambiguous_action_fence();
