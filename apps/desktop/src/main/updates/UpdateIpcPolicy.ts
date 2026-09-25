export const isMainWindowFrame = (
  sender: unknown,
  senderFrame: unknown,
  window: { readonly webContents: { readonly mainFrame: unknown } },
): boolean => sender === window.webContents && senderFrame === window.webContents.mainFrame;
