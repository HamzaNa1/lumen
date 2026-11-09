UPDATE scan_jobs SET status = 'cancelled', locked_at_ms = NULL, locked_by = NULL,
  available_at_ms = min(available_at_ms, unixepoch() * 1000),
  started_at_ms = max(coalesce(started_at_ms, 0), unixepoch() * 1000),
  finished_at_ms = max(coalesce(started_at_ms, 0), unixepoch() * 1000)
WHERE operation IN ('discover', 'cleanup') AND status IN ('queued', 'running');
--> statement-breakpoint
UPDATE scan_runs SET status = 'cancelled',
  started_at_ms = max(created_at_ms, coalesce(started_at_ms, 0), unixepoch() * 1000),
  finished_at_ms = max(created_at_ms, coalesce(started_at_ms, 0), unixepoch() * 1000)
WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE TEMP TABLE lumen_scan_run_stats (run_id text PRIMARY KEY, stats_json text NOT NULL);
--> statement-breakpoint
WITH pending AS MATERIALIZED (
  SELECT id FROM scan_runs NOT INDEXED WHERE stats_json IS NULL AND status IN ('succeeded', 'failed', 'cancelled')
), probes AS MATERIALIZED (
  SELECT run_id, source_id FROM scan_jobs NOT INDEXED
  WHERE operation = 'probe' AND run_id IN (SELECT id FROM pending)
), probe_sources AS MATERIALIZED (
  SELECT DISTINCT run_id, source_id FROM probes
), counts AS MATERIALIZED (
  SELECT run_id, sum(discovered) AS discovered, sum(new) AS new, sum(changed) AS changed,
    sum(moved) AS moved, sum(unchanged) AS unchanged, sum(skipped) AS skipped,
    sum(missing) AS missing, sum(probes) AS probes
  FROM (
    SELECT s.run_id, 1 AS discovered, s.change = 'new' AS new, s.change = 'changed' AS changed,
      s.change = 'moved' AS moved, s.change = 'unchanged' AS unchanged,
      p.source_id IS NULL AS skipped,
      0 AS missing, 0 AS probes FROM server_scan_seen s NOT INDEXED
    LEFT JOIN probe_sources p ON p.run_id = s.run_id AND p.source_id = s.source_id
    WHERE s.run_id IN (SELECT id FROM pending)
    UNION ALL
    SELECT run_id, 0, 0, 0, 0, 0, 0, 1, 0 FROM server_scan_missing NOT INDEXED
    WHERE run_id IN (SELECT id FROM pending)
    UNION ALL
    SELECT run_id, 0, 0, 0, 0, 0, 0, 0, 1 FROM probes
  ) GROUP BY run_id
)
INSERT INTO lumen_scan_run_stats(run_id, stats_json)
SELECT run_id, json_object(
  'discovered', discovered, 'new', new, 'changed', changed, 'moved', moved,
  'unchanged', unchanged, 'skipped', skipped, 'missing', missing, 'probesEnqueued', probes
) FROM counts;
--> statement-breakpoint
-- Explicitly index summaries: SQLite versions differ on indexing a materialized CTE here.
UPDATE scan_runs NOT INDEXED SET stats_json = coalesce((
  SELECT stats_json FROM lumen_scan_run_stats WHERE run_id = scan_runs.id
), '{"discovered":0,"new":0,"changed":0,"moved":0,"unchanged":0,"skipped":0,"missing":0,"probesEnqueued":0}')
WHERE stats_json IS NULL AND status IN ('succeeded', 'failed', 'cancelled');
--> statement-breakpoint
DROP TABLE lumen_scan_run_stats;
--> statement-breakpoint
DROP TABLE server_scan_seen;
--> statement-breakpoint
DROP TABLE server_scan_missing;
--> statement-breakpoint
DROP TABLE server_library_watch_state;
--> statement-breakpoint
DROP INDEX scan_runs_files_retention_idx;
--> statement-breakpoint
DROP INDEX scan_runs_jobs_retention_idx;
--> statement-breakpoint
DROP INDEX scan_runs_finished_idx;
--> statement-breakpoint
ALTER TABLE scan_runs DROP COLUMN files_pruned_at_ms;
--> statement-breakpoint
ALTER TABLE library_root_states DROP COLUMN scan_generation;
--> statement-breakpoint
ALTER TABLE libraries ADD COLUMN scan_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE media_sources ADD COLUMN device text;
--> statement-breakpoint
CREATE INDEX scan_runs_jobs_retention_idx ON scan_runs(jobs_pruned_at_ms, finished_at_ms, id) WHERE stats_json IS NOT NULL;
--> statement-breakpoint
CREATE INDEX scan_runs_finished_idx ON scan_runs(finished_at_ms, id) WHERE jobs_pruned_at_ms IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER library_root_added AFTER INSERT ON library_roots BEGIN
  UPDATE libraries SET scan_revision = scan_revision + 1 WHERE id = NEW.library_id;
END;
--> statement-breakpoint
CREATE TRIGGER library_root_removed AFTER DELETE ON library_roots BEGIN
  UPDATE libraries SET scan_revision = scan_revision + 1 WHERE id = OLD.library_id;
END;
--> statement-breakpoint
CREATE TRIGGER library_root_changed AFTER UPDATE OF path, is_enabled, library_id ON library_roots
WHEN OLD.path IS NOT NEW.path OR OLD.is_enabled IS NOT NEW.is_enabled OR OLD.library_id IS NOT NEW.library_id BEGIN
  UPDATE libraries SET scan_revision = scan_revision + 1 WHERE id IN (OLD.library_id, NEW.library_id);
END;
--> statement-breakpoint
CREATE TRIGGER library_enabled_changed AFTER UPDATE OF is_enabled ON libraries
WHEN OLD.is_enabled IS NOT NEW.is_enabled BEGIN
  UPDATE libraries SET scan_revision = scan_revision + 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
DROP INDEX media_sources_library_relative_path_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX media_sources_root_relative_path_uq ON media_sources(root_id, relative_path);
