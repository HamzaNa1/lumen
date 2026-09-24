import { load, type LibraryHandle } from "koffi";

// Cocoa separates the main document window from the key window that receives
// keyboard input. Keep the app main while the controls receive keys, just as
// a native inspector does, without disabling keyboard access to the controls.
export class MacPlayerFocus {
  private readonly library: LibraryHandle;
  private readonly window: bigint;
  private readonly makeMainSelector: bigint;
  private readonly sendVoid: (receiver: bigint, selector: bigint) => void;

  constructor(parentView: Buffer) {
    this.library = load("/usr/lib/libobjc.A.dylib");
    const selector = this.library.func("sel_registerName", "void *", ["str"]);
    const sendPointer = this.library.func("objc_msgSend", "void *", ["void *", "void *"]);
    this.sendVoid = this.library.func("objc_msgSend", "void", ["void *", "void *"]);
    this.window = sendPointer(parentView.readBigUInt64LE(0), selector("window"));
    this.makeMainSelector = selector("makeMainWindow");
  }

  restoreMainWindow(): void {
    this.sendVoid(this.window, this.makeMainSelector);
  }

  dispose(): void {
    this.library.unload();
  }
}
