export const eventually = async (ready: () => boolean, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
};
