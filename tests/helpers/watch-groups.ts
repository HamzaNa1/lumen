import type { GroupSnapshot } from "../../packages/contracts/src";
export const watchGroupSnapshot = (): GroupSnapshot => {
  const serverInstanceId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  return {
    serverInstanceId,
    groupId,
    membershipId: crypto.randomUUID(),
    name: "Friday movie night",
    rosterRevision: 1,
    members: [],
    playback: {
      type: "playback",
      state: {
        serverInstanceId,
        groupId,
        revision: 1,
        alignmentRevision: 1,
        playbackId: crypto.randomUUID(),
        media: {
          itemId: crypto.randomUUID(),
          trackId: crypto.randomUUID(),
          sourceId: crypto.randomUUID(),
          sourceGeneration: 1,
          durationMs: 120_000,
        },
        mode: "playing",
        anchorPositionMs: 5_000,
        anchorServerTimeMs: 0,
      },
    },
  };
};
