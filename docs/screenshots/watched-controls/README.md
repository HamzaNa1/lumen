# Watched controls

Captured from the built Electron app against an isolated local Lumen server with sample media. Card captures focus one unwatched action with the keyboard; other unwatched actions stay hidden, while watched indicators remain visible. Mouse hover reveals the same action.

| Surface | Screenshot |
| --- | --- |
| Movie cards: focused action and persistent watched indicator | [Movie cards](movie-cards.jpg) |
| Season cards: focused action | [Season cards](season-cards.jpg) |
| Episode cards: focused action and watched indicators | [Episode cards](episode-cards.jpg) |
| Movie dialog | [Mark as watched](movie-dialog.jpg) · [Watched](movie-dialog-watched.jpg) |
| Season dialog | [Mark as watched](season-dialog.jpg) · [Watched episodes](season-dialog-watched.jpg) |
| Season dialog at minimum window width | [1024px window](season-dialog-small.jpg) |

Verified in Electron: movie/season/episode card actions through the real preload and IPC handlers; movie and season dialog actions; season completion after individual episode changes; undo; keyboard activation; hover/focus visibility; no accidental playback or dialog opening; and the 1024px layout. A simulated IPC failure verified pending controls, an error message, and re-enabled retry controls without changing watched state.

The server integration test covers a 105-episode season across pagination, resume clearing, Next Up and Home updates, individual-episode undo, movie completion, and denied library access.
