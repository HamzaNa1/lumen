import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

// Delay or reject individual frames on the real MPV socket; decoding and the application stay live.
const connect = net.createConnection;
let mode = null;
let decoderRestrictions = {};
let expectedSpeed = null;
let pendingHold = null;
let socket = null;
let write = null;
let nextProbeId = -1;
let nextEntryId = 0;
let connectionId = 0;
const commands = [];
const events = [];
const expired = [];
let captured = null;

const hold = (entry, send) => {
  if (pendingHold) throw new Error("Release the previous MPV fault before holding another frame");
  entry.outcome = "held";
  entry.heldAtMs = Date.now();
  captured = entry;
  const deadline = AbortSignal.timeout(4000);
  const finish = (outcome) => {
    deadline.removeEventListener("abort", expire);
    pendingHold = null;
    entry.outcome = outcome;
    entry.releasedAtMs = Date.now();
    send();
  };
  const expire = () => {
    expired.push(entry.id);
    finish("expired");
  };
  deadline.addEventListener("abort", expire, { once: true });
  pendingHold = () => finish("released");
};

globalThis.__lumenMpvWire = {
  restrictDecoders(value) {
    decoderRestrictions = value;
  },
  arm(next, speed = null) {
    if (mode || pendingHold) throw new Error("Release the previous MPV fault before arming");
    mode = next;
    expectedSpeed = speed;
    captured = null;
    return nextEntryId;
  },
  snapshot() {
    return { captured, commands, expired, events };
  },
  release() {
    mode = null;
    expectedSpeed = null;
    pendingHold?.();
  },
  command(args) {
    if (!socket || !write) throw new Error("MPV socket is not connected");
    const id = nextProbeId--;
    const connected = socket;
    return new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(5000);
      const cleanup = () => {
        deadline.removeEventListener("abort", expired);
        connected.probes.delete(id);
      };
      const expired = () => {
        cleanup();
        reject(new Error(`MPV probe timed out: ${args[0]}`));
      };
      deadline.addEventListener("abort", expired, { once: true });
      connected.probes.set(id, (frame) => {
        cleanup();
        if (frame.error && frame.error !== "success") reject(new Error(frame.error));
        else resolve(frame.data);
      });
      write(`${JSON.stringify({ command: args, request_id: id })}\n`, "utf8");
    });
  },
};
net.createConnection = (...args) => {
  const connected = connect(...args);
  if (typeof args[0] !== "string" || !args[0].includes("lumen-mpv-")) return connected;
  socket = connected;
  const connection = ++connectionId;
  const requests = new Map();
  connected.probes = new Map();
  const originalWrite = connected.write.bind(connected);
  write = originalWrite;
  const emit = connected.emit.bind(connected);
  let incoming = "";
  connected.write = (chunk, ...rest) => {
    const frame = JSON.parse(String(chunk));
    const speed = frame.command[0] === "set_property" && frame.command[1] === "speed";
    const entry = {
      id: ++nextEntryId,
      connection,
      requestId: frame.request_id,
      command: frame.command[0] === "loadfile" ? ["loadfile", "<redacted>"] : frame.command,
      sentAtMs: Date.now(),
      repliedAtMs: null,
      error: null,
      sample: null,
      heldAtMs: null,
      releasedAtMs: null,
      outcome: "sent",
    };
    requests.set(frame.request_id, entry);
    commands.push(entry);
    if (commands.length > 512) commands.shift();
    if (
      speed &&
      frame.command[2] !== 1 &&
      (expectedSpeed === null || frame.command[2] === expectedSpeed) &&
      (mode === "hold-speed" || mode === "fail-speed")
    ) {
      const current = mode;
      mode = null;
      if (current === "hold-speed") hold(entry, () => originalWrite(chunk, ...rest));
      else {
        // Arm the next correction before rejecting this one; recovery at speed 1 passes through.
        mode = "hold-speed";
        entry.outcome = "rejected";
        entry.error = "injected speed write failure";
        entry.repliedAtMs = Date.now();
        requests.delete(frame.request_id);
        queueMicrotask(() =>
          emit("data", `${JSON.stringify({ request_id: frame.request_id, error: entry.error })}\n`),
        );
      }
      return true;
    }
    if (frame.command[0] === "loadfile") {
      for (const [kind, codec] of Object.entries(decoderRestrictions)) {
        originalWrite(
          `${JSON.stringify({ command: ["set_property", kind === "video" ? "vd" : "ad", `${codec},-`] })}\n`,
          "utf8",
        );
      }
    }
    return originalWrite(chunk, ...rest);
  };
  connected.emit = (event, ...args) => {
    if (event !== "data") return emit(event, ...args);
    incoming += String(args[0]);
    while (incoming.includes("\n")) {
      const newline = incoming.indexOf("\n");
      const line = incoming.slice(0, newline);
      incoming = incoming.slice(newline + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.event === "log-message" || frame.event === "end-file") {
        events.push(frame);
        if (events.length > 64) events.shift();
      }
      const probe = connected.probes.get(frame.request_id);
      if (probe) {
        probe(frame);
        continue;
      }
      const entry = requests.get(frame.request_id);
      requests.delete(frame.request_id);
      if (entry) {
        entry.repliedAtMs = Date.now();
        entry.error = frame.error ?? "success";
        if (entry.command[0] === "expand-text") entry.sample = frame.data;
      }
      if (mode === "hold-sample" && entry?.command[0] === "expand-text") {
        mode = null;
        hold(entry, () => emit("data", `${line}\n`));
      } else emit("data", `${line}\n`);
    }
    return true;
  };
  return connected;
};
syncBuiltinESMExports();
