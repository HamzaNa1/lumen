# AGENTS.MD

## Early Development

- This project is still in early development. Breaking/big changes are allowed and encouraged if they result in a cleaner, more maintainable codebase.

## Task Completion Requirements

- `bun run check` must pass before considering tasks completed.
- You only have to run this command if you have made code/config changes to the repo.

## Core Priorities

1. Reliability first.
2. Keep behavior predictable under load and during failures.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

Code must be self explanatory, you should not need to explain code in `.md` docs, only decisions and the alternatives that were considered need to be explained in `.md` docs.
