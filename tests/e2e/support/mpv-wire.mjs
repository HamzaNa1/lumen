import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

// Delay or reject individual frames on the real MPV socket; decoding and the application stay live.
const connect = net.createConnection;
let mode = null;
let release = null;
let socket = null;
let write = null;
let nextId = -1;
const requests = new Map();
const probes = new Map();
const commands = [];
let captured = null;
globalThis.__lumenMpvWire = {
  arm(next) {
    mode = next;
    captured = null;
  },
  snapshot() {
    return { captured, commands };
  },
  release() {
    const pending = release;
    release = null;
    pending?.();
  },
  command(args) {
    if (!socket || !write) throw new Error("MPV socket is not connected");
    const id = nextId--;
    return new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(5000);
      const expired = () => {
        probes.delete(id);
        reject(new Error(`MPV probe timed out: ${args.join(" ")}`));
      };
      deadline.addEventListener("abort", expired, { once: true });
      probes.set(id, {
        resolve: (value) => {
          deadline.removeEventListener("abort", expired);
          resolve(value);
        },
        reject: (error) => {
          deadline.removeEventListener("abort", expired);
          reject(error);
        },
      });
      write(`${JSON.stringify({ command: args, request_id: id })}\n`, "utf8");
    });
  },
};
net.createConnection = (...args) => {
  const connected = connect(...args);
  if (typeof args[0] !== "string" || !args[0].includes("lumen-mpv-")) return connected;
  socket = connected;
  const originalWrite = connected.write.bind(connected);
  write = originalWrite;
  const emit = connected.emit.bind(connected);
  let incoming = "";
  connected.write = (chunk, ...rest) => {
    const frame = JSON.parse(String(chunk));
    requests.set(frame.request_id, frame.command);
    const speed = frame.command[0] === "set_property" && frame.command[1] === "speed";
    const entry = { command: frame.command, outcome: "sent" };
    commands.push(entry);
    if (speed && frame.command[2] !== 1 && (mode === "hold-speed" || mode === "fail-speed")) {
      captured = frame.command;
      const current = mode;
      mode = null;
      entry.outcome = current;
      if (current === "hold-speed")
        release = () => {
          entry.outcome = "released";
          originalWrite(chunk, ...rest);
        };
      else
        queueMicrotask(() =>
          emit(
            "data",
            `${JSON.stringify({ request_id: frame.request_id, error: "injected speed write failure" })}\n`,
          ),
        );
      return true;
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
      const probe = probes.get(frame.request_id);
      if (probe) {
        probes.delete(frame.request_id);
        if (frame.error && frame.error !== "success") probe.reject(new Error(frame.error));
        else probe.resolve(frame.data);
        continue;
      }
      const command = requests.get(frame.request_id);
      requests.delete(frame.request_id);
      if (mode === "hold-sample" && command?.[0] === "expand-text") {
        mode = null;
        captured = command;
        release = () => emit("data", `${line}\n`);
      } else emit("data", `${line}\n`);
    }
    return true;
  };
  return connected;
};
syncBuiltinESMExports();
