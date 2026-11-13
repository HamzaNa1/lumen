import type { DirectoryListing } from "@lumen/contracts";
import { Button, formatBytes, TextField } from "@lumen/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, CircleAlert, FileAudio, FileVideo, Folder } from "lucide-react";
import { Fragment, useState } from "react";
import { errorMessage, plural } from "./format";
import { useRuntime } from "./Runtime";
import { useWorkspace } from "./Workspace";

export interface FolderSelection {
  readonly path: string;
  /** The path as shown, starting with ~ inside the server account's home folder. */
  readonly label: string;
  /** The library whose folder this one overlaps, which the server would reject. */
  readonly overlaps: string | null;
  readonly summary: string;
}

type Crumb = DirectoryListing["trail"][number];

export const folderName = (path: string): string =>
  path
    .split(/[\\/]/u)
    .filter((part) => part !== "")
    .at(-1) ?? path;

const summarize = (listing: DirectoryListing): string => {
  const audio = listing.files.filter((file) => file.kind === "audio").length;
  const parts = [
    listing.directories.length > 0 ? plural(listing.directories.length, "folder") : null,
    listing.files.length > audio ? plural(listing.files.length - audio, "video") : null,
    audio > 0 ? plural(audio, "track") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Empty" : parts.join(" · ");
};

/**
 * Browses folders on the server, starting in the server account's home folder. Opening a folder
 * selects it. Against a server that cannot list folders, the path is typed instead.
 */
export const useFolderPicker = ({
  start,
  replacing,
}: {
  /** The folder to open first; null opens the home folder without selecting it. */
  readonly start: string | null;
  /** The root being replaced, which the new folder may overlap. */
  readonly replacing?: string | undefined;
}): { readonly selection: FolderSelection | null; readonly view: React.ReactElement } => {
  const runtime = useRuntime();
  const { scope } = useWorkspace();
  const [open, setOpen] = useState(start);
  const [chosen, setChosen] = useState(start !== null);
  const [pendingTrail, setPendingTrail] = useState<readonly Crumb[]>([]);
  const [typed, setTyped] = useState("");
  const listing = useQuery({
    queryKey: [...scope, "admin", "directory", open],
    queryFn: () => runtime.admin.listDirectory(open),
    placeholderData: keepPreviousData,
    // Folders and the roots they overlap change between visits, so no listing outlives the dialog.
    gcTime: 0,
  });

  if (listing.data === null) {
    const path = typed.trim();
    return {
      selection: path === "" ? null : { path, label: path, overlaps: null, summary: "" },
      view: (
        <TextField
          label="Folder on the server"
          value={typed}
          placeholder="/media/movies"
          spellCheck={false}
          onValueChange={setTyped}
        />
      ),
    };
  }

  const current = listing.isPlaceholderData ? undefined : listing.data;
  const overlap = current?.overlaps?.rootId === replacing ? null : current?.overlaps;
  const selection =
    chosen && current !== undefined
      ? {
          path: current.path,
          label: current.trail.some((crumb) => crumb.path === current.home)
            ? `~${current.path.slice(current.home.length)}`
            : current.path,
          overlaps: overlap?.libraryName ?? null,
          summary: summarize(current),
        }
      : null;
  const shown = listing.data ?? null;
  const go = (path: string, trail: readonly Crumb[]): void => {
    setOpen(path);
    setChosen(true);
    setPendingTrail(trail);
  };
  const home = shown?.home ?? null;
  const trail = current?.trail ?? pendingTrail;
  const homeIndex = trail.findIndex((crumb) => crumb.path === home);
  const crumbs = homeIndex === -1 ? trail : trail.slice(homeIndex);
  const parent = current?.parent ?? null;
  const view = (
    <div className="folder-browser">
      <nav className="folder-browser-trail" aria-label="Folder path">
        <Button
          variant="icon"
          size="sm"
          aria-label="Up one folder"
          disabled={parent === null}
          onClick={() => (parent === null ? undefined : go(parent, trail.slice(0, -1)))}
        >
          <ArrowUp aria-hidden="true" size={15} />
        </Button>
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.path}>
            {index > 0 ? <ChevronRight aria-hidden="true" size={14} /> : null}
            <button
              type="button"
              className="folder-browser-crumb"
              aria-current={index === crumbs.length - 1 && chosen ? "location" : undefined}
              onClick={() => go(crumb.path, trail.slice(0, trail.indexOf(crumb) + 1))}
            >
              {homeIndex !== -1 && index === 0 ? "~" : crumb.name}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className={`folder-browser-items${listing.isPlaceholderData ? " is-pending" : ""}`}>
        {listing.isError ? (
          <div className="folder-browser-message" role="alert">
            <CircleAlert aria-hidden="true" size={16} />
            <span>{errorMessage(listing.error, "Couldn’t open this folder.")}</span>
            <Button
              size="sm"
              onClick={() => {
                setOpen(null);
                setChosen(false);
              }}
            >
              Go to home folder
            </Button>
          </div>
        ) : shown === null ? null : (
          <ul aria-label="Folder contents">
            {shown.directories.map((directory) => (
              <li key={directory.path}>
                <button
                  type="button"
                  className="folder-browser-item"
                  onClick={() => go(directory.path, [...trail, directory])}
                >
                  <Folder aria-hidden="true" size={16} />
                  <span className="folder-browser-name">{directory.name}</span>
                  <ChevronRight aria-hidden="true" size={15} />
                </button>
              </li>
            ))}
            {shown.files.map((file) => (
              <li key={file.name} className="folder-browser-item is-file">
                {file.kind === "audio" ? (
                  <FileAudio aria-hidden="true" size={16} />
                ) : (
                  <FileVideo aria-hidden="true" size={16} />
                )}
                <span className="folder-browser-name">{file.name}</span>
                <span className="folder-browser-size">{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
        )}
        {shown !== null &&
        !listing.isError &&
        !listing.isPlaceholderData &&
        shown.directories.length === 0 &&
        shown.files.length === 0 ? (
          <p className="folder-browser-message">No folders or media files here.</p>
        ) : null}
        {shown?.truncated === true && !listing.isError ? (
          <p className="folder-browser-message">
            This folder has more items than can be shown here.
          </p>
        ) : null}
      </div>
    </div>
  );
  return { selection, view };
};

/** What the selected folder means for the dialog's primary button, shown beside it. */
export const FolderSelectionNote = ({
  selection,
  hint,
}: {
  readonly selection: FolderSelection | null;
  readonly hint: string;
}): React.ReactElement => (
  <span className="dialog-actions-start folder-selection">
    {selection === null ? (
      <span className="folder-selection-hint">{hint}</span>
    ) : selection.overlaps !== null ? (
      <span className="folder-selection-warning">
        <CircleAlert aria-hidden="true" size={14} />
        Overlaps a folder in {selection.overlaps}
      </span>
    ) : (
      <code title={selection.path}>{selection.label}</code>
    )}
  </span>
);
