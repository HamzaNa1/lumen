import { type BrowserWindow, type Rectangle, screen } from "electron";
import { load, type LibraryHandle } from "koffi";

type Hwnd = number | bigint;
type CreateWindow = (
  extendedStyle: number,
  className: string,
  title: string,
  style: number,
  x: number,
  y: number,
  width: number,
  height: number,
  owner: Hwnd,
  menu: Hwnd,
  instance: Hwnd,
  parameter: Hwnd,
) => Hwnd;
type SetWindowPosition = (
  window: Hwnd,
  after: Hwnd,
  x: number,
  y: number,
  width: number,
  height: number,
  flags: number,
) => number;
type ShowWindow = (window: Hwnd, command: number) => number;
type DestroyWindow = (window: Hwnd) => number;

/** A video-only HWND without Chromium's compositor covering MPV's child window. */
export class WindowsMpvHost {
  private readonly library: LibraryHandle;
  private readonly handle: Hwnd;
  private readonly setWindowPosition: SetWindowPosition;
  private readonly showWindow: ShowWindow;
  private readonly destroyWindow: DestroyWindow;
  private destroyed = false;

  constructor(private readonly parent: BrowserWindow) {
    this.library = load("user32.dll");
    const createWindow = this.library.func(
      "uintptr_t __stdcall CreateWindowExW(uint32_t, str16, str16, uint32_t, int, int, int, int, uintptr_t, uintptr_t, uintptr_t, uintptr_t)",
    ) as CreateWindow;
    this.setWindowPosition = this.library.func(
      "int __stdcall SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32_t)",
    ) as SetWindowPosition;
    this.showWindow = this.library.func("int __stdcall ShowWindow(uintptr_t, int)") as ShowWindow;
    this.destroyWindow = this.library.func(
      "int __stdcall DestroyWindow(uintptr_t)",
    ) as DestroyWindow;
    this.handle = createWindow(
      0x08000080, // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
      "STATIC",
      "Lumen video",
      0x82000004, // WS_POPUP | WS_CLIPCHILDREN | SS_BLACKRECT
      0,
      0,
      1,
      1,
      parent.getNativeWindowHandle().readUInt32LE(0),
      0,
      0,
      0,
    );
    if (!this.handle) {
      this.library.unload();
      throw new Error("Could not create the Windows video surface");
    }
  }

  getNativeWindowHandle(): Buffer {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(this.handle));
    return handle;
  }

  setBounds(bounds: Rectangle): void {
    if (this.destroyed) return;
    // Electron reports DIP coordinates; HWNDs require physical screen pixels.
    const pixels = screen.dipToScreenRect(this.parent, bounds);
    this.setWindowPosition(this.handle, 0, pixels.x, pixels.y, pixels.width, pixels.height, 0x0014);
    // SWP_NOACTIVATE | SWP_NOZORDER
  }

  showInactive(): void {
    if (this.destroyed) return;
    // Raise above the owner without taking focus; the controls are raised next.
    this.setWindowPosition(this.handle, 0, 0, 0, 0, 0, 0x0053);
    // SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE
  }

  hide(): void {
    if (!this.destroyed) this.showWindow(this.handle, 0);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyWindow(this.handle);
    this.library.unload();
  }
}
