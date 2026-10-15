import { parseProduct, productCompatibilityTests } from "./lib/products";
import { repositoryRoot, run } from "./lib/releases";
import { verifyTestOwnership } from "./lib/verification";
import { withReleasedCounterpart } from "./lib/verification-workspace";

const product = parseProduct(process.argv[2]);
verifyTestOwnership(repositoryRoot);
withReleasedCounterpart(product, (workspace) => {
  run(process.execPath, ["test", ...productCompatibilityTests(product)], workspace);
});
