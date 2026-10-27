import { parseProduct } from "./lib/products";
import { run } from "./lib/releases";

parseProduct(process.argv[2]);
// E2E verification builds the candidate and a released counterpart in separate workspaces.
run(process.execPath, ["install", "--frozen-lockfile"]);
