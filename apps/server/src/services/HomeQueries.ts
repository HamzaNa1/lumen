import { sql } from "drizzle-orm";

// Shared projection keeps every home query scoped to this viewer before ranking or limiting.
export const homeItems = (userId: string, libraryIds: ReadonlyArray<string>) => sql`
  SELECT i.id, i.library_id AS libraryId, i.parent_id AS parentId, i.title, i.kind,
    i.duration_seconds * 1000 AS durationMs, i.year, i.index_number AS indexNumber,
    i.added_at_ms AS addedAtMs,
    CASE WHEN w.completed = 1 THEN NULL ELSE w.position_seconds END AS resumePositionSeconds,
    coalesce(w.completed, 0) AS completed, w.updated_at_ms AS activity,
    CASE WHEN p.kind = 'show' THEN p.id WHEN p.kind = 'season' THEN g.id END AS showId,
    CASE WHEN p.kind = 'show' THEN p.title WHEN p.kind = 'season' THEN g.title END AS seriesTitle,
    CASE WHEN p.kind = 'season' THEN p.id END AS seasonId,
    CASE WHEN p.kind = 'season' THEN p.index_number ELSE 1 END AS seasonNumber,
    (SELECT a.artwork_id FROM catalog_item_artwork a
      WHERE a.item_id = i.id AND a.role IN ('poster', 'still')
      ORDER BY a.role LIMIT 1) AS artworkId,
    EXISTS (SELECT 1 FROM catalog_item_sources cs
      JOIN media_sources ms ON ms.id = cs.source_id AND ms.library_id = i.library_id
      JOIN tracks t ON t.source_id = ms.id AND t.library_id = i.library_id
      JOIN library_roots r ON r.id = ms.root_id AND r.is_enabled = 1
      LEFT JOIN media_source_availability av ON av.source_id = ms.id
      LEFT JOIN library_root_states rs ON rs.root_id = r.id
      WHERE cs.item_id = i.id AND coalesce(av.is_available, 1) = 1
        AND coalesce(rs.is_available, 1) = 1) AS available
  FROM catalog_items i
  LEFT JOIN item_watch_states w ON w.item_id = i.id AND w.user_id = ${userId}
  LEFT JOIN catalog_items p ON p.id = i.parent_id AND p.library_id = i.library_id
  LEFT JOIN catalog_items g ON g.id = p.parent_id AND g.library_id = i.library_id AND g.kind = 'show'
  WHERE i.library_id IN (${sql.join(
    libraryIds.map((id) => sql`${id}`),
    sql`, `,
  )})
`;

export const homeCardColumns = sql`id, libraryId, parentId, title, kind, durationMs, year,
  indexNumber, resumePositionSeconds, artworkId, seriesTitle, seasonNumber`;

export const nextUpQuery = (
  userId: string,
  libraryIds: ReadonlyArray<string>,
  cutoff: number,
) => sql`
  WITH items AS (${homeItems(userId, libraryIds)}),
  episodes AS (SELECT * FROM items WHERE kind = 'episode' AND showId IS NOT NULL AND seasonNumber > 0),
  active AS (
    SELECT showId, max(activity) AS lastActivity FROM episodes
    WHERE completed = 1 OR resumePositionSeconds > 0
    GROUP BY showId HAVING max(activity) >= ${cutoff}
  ),
  watched AS (
    SELECT *, row_number() OVER (PARTITION BY showId ORDER BY seasonNumber DESC, indexNumber DESC, id DESC) AS watchedRank
    FROM episodes WHERE completed = 1
  ),
  candidates AS (
    SELECT e.*, coalesce(w.activity, a.lastActivity) AS lastWatched,
      row_number() OVER (PARTITION BY e.showId ORDER BY e.seasonNumber, e.indexNumber, e.id) AS nextRank
    FROM episodes e JOIN active a ON a.showId = e.showId
    LEFT JOIN watched w ON w.showId = e.showId AND w.watchedRank = 1
    WHERE e.available = 1 AND e.completed = 0 AND e.indexNumber IS NOT NULL
      AND (w.id IS NULL OR e.seasonNumber > w.seasonNumber
        OR (e.seasonNumber = w.seasonNumber AND e.indexNumber > w.indexNumber))
  )
  SELECT ${homeCardColumns} FROM candidates
  WHERE nextRank = 1 AND coalesce(resumePositionSeconds, 0) = 0
  ORDER BY lastWatched DESC, id DESC LIMIT 24
`;

export const latestEpisodesQuery = (userId: string, libraryId: string) => sql`
  WITH items AS (${homeItems(userId, [libraryId])}),
  eligible AS (SELECT * FROM items
    WHERE kind = 'episode' AND available = 1 AND completed = 0),
  ranked AS (
    SELECT *, row_number() OVER (PARTITION BY coalesce(showId, id) ORDER BY addedAtMs DESC, id DESC) AS latestRank
    FROM eligible
  ),
  newest AS (SELECT * FROM ranked WHERE latestRank = 1 ORDER BY addedAtMs DESC, id DESC LIMIT 16),
  batches AS (
    SELECT n.id, count(*) AS episodeCount, count(DISTINCT coalesce(e.seasonId, e.showId)) AS seasonCount
    FROM newest n JOIN eligible e ON coalesce(e.showId, e.id) = coalesce(n.showId, n.id)
      AND e.addedAtMs >= n.addedAtMs - 86400000
    GROUP BY n.id
  ),
  representatives AS (
    SELECT n.addedAtMs AS latestAdded, n.id AS latestId,
      CASE
        WHEN n.showId IS NULL THEN n.id
        WHEN b.seasonCount > 1 THEN n.showId
        WHEN b.episodeCount > 1 OR (n.seasonId IS NOT NULL AND
          (SELECT count(*) FROM items e WHERE e.parentId = n.seasonId AND e.kind = 'episode') = 1)
        THEN CASE WHEN n.seasonId IS NOT NULL AND
          (SELECT count(*) FROM items s WHERE s.parentId = n.showId AND s.kind = 'season') > 1
          THEN n.seasonId ELSE n.showId END
        ELSE n.id
      END AS itemId
    FROM newest n JOIN batches b ON b.id = n.id
  )
  SELECT ${homeCardColumns} FROM items
  JOIN representatives r ON r.itemId = items.id
  ORDER BY r.latestAdded DESC, r.latestId DESC
`;
