import { expect, test } from "bun:test";
import { exportPlaybackDiagnostics } from "../../apps/web/src/ExportDiagnostics";

for (const mode of ["unavailable", "denied", "allowed"] as const) {
  test(`diagnostic export handles ${mode} clipboard access on browser origins`, async () => {
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const created: string[] = [];
    let clicks = 0;
    let copies = 0;
    const link = {
      href: "",
      download: "",
      click: () => {
        clicks += 1;
      },
      remove: () => undefined,
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard:
          mode === "unavailable"
            ? undefined
            : {
                writeText: async (text: string) => {
                  expect(text).toBe('{"safe":true}');
                  if (mode === "denied") throw new Error("Clipboard denied");
                  copies += 1;
                },
              },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: (name: string) => {
          created.push(name);
          return link;
        },
        body: { append: () => undefined },
      },
    });
    try {
      await exportPlaybackDiagnostics('{"safe":true}');
      if (mode === "allowed") {
        expect(copies).toBe(1);
        expect(clicks).toBe(0);
      } else {
        expect(created).toEqual(["a"]);
        expect(clicks).toBe(1);
        expect(link.download).toBe("lumen-playback-diagnostics.json");
        const response = await fetch(link.href);
        expect(response.headers.get("content-type")).toStartWith("application/json");
        expect(await response.text()).toBe('{"safe":true}');
      }
    } finally {
      if (savedNavigator === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", savedNavigator);
      if (savedDocument === undefined) Reflect.deleteProperty(globalThis, "document");
      else Object.defineProperty(globalThis, "document", savedDocument);
    }
  });
}
