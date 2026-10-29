import { load } from "koffi";

/** HANDLE values remain pointer-sized integers; no JS Number conversion of native pointers. */
export class WindowsTextureHandles {
  private readonly library = load("kernel32.dll");
  private readonly open = this.library.func(
    "uintptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)",
  );
  private readonly duplicate = this.library.func(
    "int __stdcall DuplicateHandle(uintptr_t, uintptr_t, uintptr_t, _Out_ uintptr_t *, uint32_t, int, uint32_t)",
  );
  private readonly current = this.library.func("uintptr_t __stdcall GetCurrentProcess()");
  private readonly close = this.library.func("int __stdcall CloseHandle(uintptr_t)");

  import<T>(pid: number, source: string, consume: (handle: Buffer) => T): T {
    const processHandle = this.open(0x0040, 0, pid) as number | bigint;
    if (!processHandle) throw new Error("Cannot open video helper for texture sharing");
    const result: Array<number | bigint> = [0];
    try {
      if (!this.duplicate(processHandle, BigInt(source), this.current(), result, 0, 0, 2))
        throw new Error("Cannot duplicate video texture handle");
      const local = result[0];
      if (!local) throw new Error("Invalid duplicated video texture handle");
      try {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(BigInt(local));
        return consume(buffer);
      } finally {
        this.close(local);
      }
    } finally {
      this.close(processHandle);
    }
  }
}
