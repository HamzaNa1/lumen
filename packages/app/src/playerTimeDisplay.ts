import type { PlayerTimeDisplay } from "@lumen/ui";

export const PLAYER_TIME_DISPLAY_STORAGE_KEY = "lumen.playerTimeDisplay";

export const readPlayerTimeDisplay = (): PlayerTimeDisplay => {
  try {
    return localStorage.getItem(PLAYER_TIME_DISPLAY_STORAGE_KEY) === "duration"
      ? "duration"
      : "remaining";
  } catch {
    return "remaining";
  }
};

export const writePlayerTimeDisplay = (display: PlayerTimeDisplay): void => {
  try {
    localStorage.setItem(PLAYER_TIME_DISPLAY_STORAGE_KEY, display);
  } catch {
    // Storage is unavailable (private browsing, blocked site data): the choice lasts the page.
  }
};
