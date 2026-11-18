import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "./Runtime";

export const useClientVersions = () => {
  const { versions } = useRuntime();
  return useQuery({ queryKey: ["client-versions"], queryFn: versions, staleTime: Infinity });
};
