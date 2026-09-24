import { load, struct, type LibraryHandle } from "koffi";

type NativePointer = bigint;
type Point = { readonly x: number; readonly y: number };
type Size = { readonly width: number; readonly height: number };
type Rect = { readonly origin: Point; readonly size: Size };

const PointType = struct("LumenPoint", { x: "double", y: "double" });
const SizeType = struct("LumenSize", { width: "double", height: "double" });
const RectType = struct("LumenRect", { origin: PointType, size: SizeType });

type Selector = (name: string) => NativePointer;
type SendPointer = (receiver: NativePointer, selector: NativePointer) => NativePointer;
type SendRect = (receiver: NativePointer, selector: NativePointer) => Rect;
type SendVoidBool = (receiver: NativePointer, selector: NativePointer, value: boolean) => void;
type SendVoidLong = (receiver: NativePointer, selector: NativePointer, value: number) => void;
type SendVoidPointer = (
  receiver: NativePointer,
  selector: NativePointer,
  value: NativePointer | null,
) => void;
type SendVoidPointerLong = (
  receiver: NativePointer,
  selector: NativePointer,
  value: NativePointer,
  order: number,
) => void;
type SendVoidRectBool = (
  receiver: NativePointer,
  selector: NativePointer,
  frame: Rect,
  display: boolean,
) => void;

export class MacMpvWindow {
  private readonly library: LibraryHandle;
  private readonly hostWindow: NativePointer;
  private readonly mpvWindow: NativePointer;
  private readonly selector: Selector;
  private readonly sendRect: SendRect;
  private readonly sendVoidPointer: SendVoidPointer;
  private readonly sendVoidRectBool: SendVoidRectBool;

  constructor(hostView: NativePointer, mpvWindow: NativePointer) {
    this.library = load("/usr/lib/libobjc.A.dylib");
    this.selector = this.library.func("sel_registerName", "void *", ["str"]) as Selector;
    const sendPointer = this.library.func("objc_msgSend", "void *", [
      "void *",
      "void *",
    ]) as SendPointer;
    this.sendRect = this.library.func("objc_msgSend", RectType, ["void *", "void *"]) as SendRect;
    this.sendVoidPointer = this.library.func("objc_msgSend", "void", [
      "void *",
      "void *",
      "void *",
    ]) as SendVoidPointer;
    const sendVoidPointerLong = this.library.func("objc_msgSend", "void", [
      "void *",
      "void *",
      "void *",
      "long",
    ]) as SendVoidPointerLong;
    this.sendVoidRectBool = this.library.func("objc_msgSend", "void", [
      "void *",
      "void *",
      RectType,
      "bool",
    ]) as SendVoidRectBool;

    this.hostWindow = sendPointer(hostView, this.selector("window"));
    this.mpvWindow = mpvWindow;
    const sendVoidLong = this.library.func("objc_msgSend", "void", [
      "void *",
      "void *",
      "unsigned long",
    ]) as SendVoidLong;
    const sendVoidBool = this.library.func("objc_msgSend", "void", [
      "void *",
      "void *",
      "bool",
    ]) as SendVoidBool;
    // mpv's --border=no only hides its title bar on macOS. The window
    // remains titled (and rounded) until we apply NSWindowStyleMaskBorderless.
    sendVoidLong(this.mpvWindow, this.selector("setStyleMask:"), 0);
    sendVoidBool(this.mpvWindow, this.selector("setHasShadow:"), false);
    sendVoidBool(this.mpvWindow, this.selector("setIgnoresMouseEvents:"), true);
    sendVoidBool(this.mpvWindow, this.selector("setMovable:"), false);
    sendVoidPointerLong(
      this.hostWindow,
      this.selector("addChildWindow:ordered:"),
      this.mpvWindow,
      1,
    );
    this.sync();
    this.show();
  }

  sync(): void {
    const frame = this.sendRect(this.hostWindow, this.selector("frame"));
    this.sendVoidRectBool(this.mpvWindow, this.selector("setFrame:display:"), frame, true);
  }

  show(): void {
    this.sendVoidPointer(this.mpvWindow, this.selector("orderFront:"), null);
  }

  dispose(): void {
    this.sendVoidPointer(this.hostWindow, this.selector("removeChildWindow:"), this.mpvWindow);
    this.sendVoidPointer(this.mpvWindow, this.selector("orderOut:"), null);
    this.library.unload();
  }
}
