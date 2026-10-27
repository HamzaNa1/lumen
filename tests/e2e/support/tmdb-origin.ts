const upstream = process.env.LUMEN_E2E_TMDB_ORIGIN;
if (upstream) {
  const fetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.themoviedb.org" || url.hostname === "image.tmdb.org")
        return fetch(new URL(url.pathname + url.search, upstream), init);
      return fetch(input, init);
    },
    fetch,
  );
}
