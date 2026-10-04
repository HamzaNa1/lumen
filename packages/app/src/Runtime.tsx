import type { LumenRuntime } from "@lumen/client/runtime";
import { createContext, type ReactNode, useContext } from "react";

const RuntimeContext = createContext<LumenRuntime | null>(null);

/** Gives the shared application its platform: desktop IPC or the browser. */
export const RuntimeProvider = ({
  runtime,
  children,
}: {
  readonly runtime: LumenRuntime;
  readonly children: ReactNode;
}): React.ReactElement => (
  <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
);

export const useRuntime = (): LumenRuntime => {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error("The application runtime has not been provided");
  return runtime;
};
