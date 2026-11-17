// Production hashes with argon2id at 64 MiB and three passes; a test server only needs a valid argon2id hash.
const hash = Bun.password.hash.bind(Bun.password);
Bun.password.hash = (password, options) =>
  hash(
    password,
    typeof options === "object" && options.algorithm === "argon2id"
      ? { ...options, memoryCost: 256, timeCost: 1 }
      : options,
  );
