# Lumen home page

Implement the section and selection behavior traced in [Jellyfin Home](jellyfin-home-page.md), using Lumen's existing movie, TV, and music catalog. Books, Live TV, and DVR are outside Lumen's current media support.

## Behavior

- Default section order: My Media, Continue watching, Continue listening, Next up, Latest media. Hide empty content rows.
- Persist each user's section order/enabled sections, library order, My Media exclusions, Latest exclusions, hide-watched preference (default on), and Next Up activity window (default 365 days). Settings belong to the authenticated account on its server.
- My Media displays accessible, enabled libraries in the preferred order, then by name. Hidden libraries remain browsable through the normal library navigation.
- Continue watching queries movies and episodes across the entire accessible catalog, including nested episodes, with saved non-completed progress; order by latest activity, limit 12. Continue listening does the same for tracks. Never derive these from a paginated library browse response.
- Next Up returns at most 24 episodes, one per recently active show, following the highest season/episode marked watched. Skip earlier gaps, unavailable episodes, specials, never-started shows, and a chosen next episode already in progress. Order by watched activity. A partially started show with no completed episode qualifies for candidate selection but its in-progress first episode stays in Continue watching.
- Latest creates one row per eligible library, newest added first, limited to 16 (30 for music). Hide completed video items by default. Group TV additions within 24 hours of the show's latest eligible addition into a series for multiple seasons, a season for a batch in one season of a multiseason show, otherwise a single episode or single-season series. Preserve date added when metadata changes.
- Latest exclusions also exclude libraries from Continue and Next Up, matching Jellyfin. My Media exclusions prevent that library's Latest row but do not independently suppress Continue or Next Up.
- Use playable, available sources for content rows; missing media must not displace available results. Enforce library grants and account isolation before selecting or limiting content.
- Preserve existing Lumen cards and navigation. Include show/season context for episode and season cards, handle loading/errors with retry, and refresh Home after playback and while library contents change.
- Lumen's music catalog currently exposes playable tracks; use track cards for music rather than introducing an album navigation model in this home-page change. Preserve Lumen's existing playback progress recording rules.

## Validation and review

User-confirmed test boundaries: authenticated HTTP API (home data, settings persistence/validation, permissions, playback-state changes), and the desktop ServerClient boundary. Use temporary real databases and assert API responses rather than internal calls.

Review baseline: task-start commit `c3e767b88b6e42b0c4a2fe957f5083da93c30c4f`. This document and the user request are the implementation spec. Run focused tests and typechecking during implementation, the full suite at the end, then Standards and Spec reviews before committing to the current branch.
