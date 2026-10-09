Argument: `$ARGUMENTS`

Start or resume the requested phase. Read `CLAUDE.md`, `AGENTS.md`, `progress/STATUS.md`, decisions, latest handoff, and the matching `phases/` specification. Inspect git status and code. Verify the prior phase gate. Present a concrete plan listing files, dependencies, tests, risks, and acceptance criteria. Do not modify files until the user approves the plan. After approval, implement only the requested phase, run checks, update progress, and stop at the gate. If the argument is missing, use `/status` behavior and ask which phase to start.
