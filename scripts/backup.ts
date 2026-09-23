import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const databasePath = process.env.LUMEN_DATABASE_PATH ?? "./data/lumen.sqlite";
const dataDir = process.env.LUMEN_DATA_DIR ?? "./data";
const outputDir = process.argv[2] ?? join(dataDir, "backups");
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const destination = join(outputDir, `lumen-${stamp}.sqlite`);
await mkdir(outputDir, { recursive: true });
const processHandle = Bun.spawn(["sqlite3", databasePath, `.backup '${destination.replaceAll("'", "''")}'`], { stdout: "inherit", stderr: "inherit" });
const exitCode = await processHandle.exited;
if (exitCode !== 0) throw new Error(`sqlite3 backup failed with exit code ${exitCode}`);
console.log(JSON.stringify({ database: databasePath, backup: destination, bytes: (await Bun.file(destination).size) }));
