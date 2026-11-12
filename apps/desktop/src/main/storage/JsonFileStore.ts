import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";

/** A plain JSON value kept in a file between launches, falling back to defaults when it cannot be read. */
export class JsonFileStore<A> {
  private writing: Promise<void> | null = null;
  private unwritten = false;
  private failed = false;

  private constructor(
    private value: A,
    private readonly path: string | null,
    private readonly name: string,
  ) {}

  static async open<A>(options: {
    readonly path: string;
    readonly schema: Schema.Decoder<A, never>;
    readonly defaults: () => A;
    readonly name: string;
  }): Promise<JsonFileStore<A>> {
    try {
      const stored = Schema.decodeUnknownSync(options.schema)(
        JSON.parse(await readFile(options.path, "utf8")),
      );
      return new JsonFileStore(stored, options.path, options.name);
    } catch {
      // Nothing was kept yet, or what was kept is unreadable: start from the defaults.
      return new JsonFileStore(options.defaults(), options.path, options.name);
    }
  }

  /** A value that lasts only as long as the store. */
  static inMemory<A>(value: A): JsonFileStore<A> {
    return new JsonFileStore(value, null, "");
  }

  get current(): A {
    return this.value;
  }

  set(value: A): void {
    this.value = value;
    if (this.path === null) return;
    this.unwritten = true;
    this.writing ??= this.write(this.path);
  }

  /** Settles once everything set so far has been written or has failed to be, with which. */
  async saved(): Promise<boolean> {
    await this.writing;
    return !this.failed;
  }

  /** One write at a time, so a burst of changes ends with its last value on disk. */
  private async write(path: string): Promise<void> {
    try {
      while (this.unwritten) {
        this.unwritten = false;
        const temporary = `${path}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, JSON.stringify(this.value));
        await rename(temporary, path);
      }
      this.failed = false;
    } catch (cause) {
      this.failed = true;
      console.error(`Failed to save ${this.name}`, cause);
    } finally {
      this.writing = null;
    }
  }
}
