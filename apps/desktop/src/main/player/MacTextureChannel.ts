import { randomBytes } from "node:crypto";
import { decode, load } from "koffi";

type Pointer = bigint;

const bindings = () => {
  const system = load("/usr/lib/libSystem.B.dylib");
  const surfaces = load("/System/Library/Frameworks/IOSurface.framework/IOSurface");
  const coreFoundation = load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  return {
    task: decode(system.symbol("mach_task_self_"), "uint32_t") as number,
    specialPort: system.func("int task_get_special_port(uint32_t, int, _Out_ uint32_t *)"),
    checkIn: system.func("int bootstrap_check_in(uint32_t, const char *, _Out_ uint32_t *)"),
    machMessage: system.func(
      "int mach_msg(void *, int, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t)",
    ),
    destroyMessage: system.func("void mach_msg_destroy(void *)"),
    modifyReferences: system.func("int mach_port_mod_refs(uint32_t, uint32_t, int, int)"),
    deallocate: system.func("int mach_port_deallocate(uint32_t, uint32_t)"),
    lookup: surfaces.func("void *IOSurfaceLookupFromMachPort(uint32_t)"),
    surfaceWidth: surfaces.func("size_t IOSurfaceGetWidth(void *)"),
    surfaceHeight: surfaces.func("size_t IOSurfaceGetHeight(void *)"),
    release: coreFoundation.func("void CFRelease(void *)"),
  };
};
let loaded: ReturnType<typeof bindings> | undefined;
const mach = (): ReturnType<typeof bindings> => {
  loaded ??= bindings();
  return loaded;
};

const taskBootstrapPort = 4;
const portRightReceive = 1;
// MACH_RCV_MSG | MACH_RCV_TIMEOUT, with the audit trailer that names the sending process.
const receiveOptions = 0x2 | 0x100 | (3 << 24);
const receiveTimedOut = 0x10004003;
const receiveTooLarge = 0x10004004;
// The helper's FrameMessage: header, body, one port descriptor, then the frame sequence.
const frameMessageId = 0x4c554d;
const frameMessageSize = 48;
const auditTrailerSize = 52;
const senderPidOffset = 40;

/**
 * Receives the helper's IOSurfaces. Each one is queued on this Mach port before the
 * helper writes the frame's stdout record, so it is read without waiting.
 */
export class MacTextureChannel {
  readonly name = `dev.lumen.desktop.video.${process.pid}.${randomBytes(8).toString("hex")}`;
  private port: number | null;
  private readonly buffer = Buffer.alloc(256);

  constructor() {
    const { task, specialPort, checkIn, deallocate } = mach();
    const bootstrap = [0];
    if (specialPort(task, taskBootstrapPort, bootstrap) !== 0)
      throw new Error("Cannot reach the macOS bootstrap server");
    const port = [0];
    const result = checkIn(bootstrap[0], this.name, port);
    deallocate(task, bootstrap[0] ?? 0);
    if (result !== 0 || !port[0]) throw new Error("Cannot open the video texture port");
    this.port = port[0];
  }

  import<T>(
    pid: number,
    frame: { readonly sequence: number; readonly width: number; readonly height: number },
    consume: (surface: Pointer) => T,
  ): T {
    if (this.port === null) throw new Error("The video texture port is closed");
    const {
      task,
      machMessage,
      destroyMessage,
      deallocate,
      lookup,
      surfaceWidth,
      surfaceHeight,
      release,
    } = mach();
    // Bounded by the port's queue limit: foreign and superseded messages are discarded.
    for (let attempt = 0; attempt < 8; attempt++) {
      const message = this.buffer.fill(0);
      const result = machMessage(message, receiveOptions, 0, message.length, this.port, 0, 0);
      if (result === receiveTooLarge) continue;
      if (result === receiveTimedOut) throw new Error("The video texture did not arrive");
      if (result !== 0) throw new Error(`Cannot receive the video texture (${result})`);
      const size = message.readUInt32LE(4);
      const valid =
        message.readUInt32LE(0) >>> 31 === 1 &&
        size === frameMessageSize &&
        message.readUInt32LE(20) === frameMessageId &&
        message.readUInt32LE(24) === 1 &&
        message.readUInt8(39) === 0 &&
        message.readUInt32LE(size + 4) >= auditTrailerSize;
      const sender = valid ? message.readUInt32LE(size + senderPidOffset) : 0;
      const sequence = valid ? Number(message.readBigUInt64LE(40)) : 0;
      if (!valid || sender !== pid || sequence !== frame.sequence) {
        destroyMessage(message);
        if (valid && sender === pid && sequence > frame.sequence)
          throw new Error("Video textures arrived out of order");
        continue;
      }
      const name = message.readUInt32LE(28);
      const surface = lookup(name) as Pointer | null;
      deallocate(task, name);
      if (!surface) throw new Error("Invalid video texture");
      try {
        if (
          Number(surfaceWidth(surface)) !== frame.width ||
          Number(surfaceHeight(surface)) !== frame.height
        )
          throw new Error("Video texture size does not match its frame");
        return consume(surface);
      } finally {
        release(surface);
      }
    }
    throw new Error("The video texture did not arrive");
  }

  dispose(): void {
    if (this.port === null) return;
    const { task, modifyReferences } = mach();
    // Releasing the receive right also discards queued messages and their surfaces.
    modifyReferences(task, this.port, portRightReceive, -1);
    this.port = null;
  }
}
