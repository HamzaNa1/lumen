# Media file trust boundary

The server trusts configured media-root ownership but treats filenames, metadata, subtitles, artwork, and media parser input as untrusted data. Sources are database-owned IDs, paths are canonicalized, symlink traversal is disabled by default, and ffprobe runs with argument arrays and bounded output.
