# Project skills for Claude Code

Claude Code loads every `<name>/SKILL.md` in this folder as a project skill, invoked as `/<name>` (for example `/research`, `/tdd`, `/grill-me`).

## Vendored: Matt Pocock's skills

- **Source:** https://github.com/mattpocock/skills at commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` (plugin `mattpocock-skills` v1.3.2).
- **License:** MIT, Copyright (c) 2026 Matt Pocock. See [`LICENSE-mattpocock-skills`](./LICENSE-mattpocock-skills).
- **Included:** the 27 skills listed in upstream `.claude-plugin/plugin.json` (`skills/engineering/*` and `skills/productivity/*`). Upstream's `in-progress`, `misc` and `deprecated` skills are not included, nor the per-skill `agents/openai.yaml` files (Codex metadata).
- **Local changes:**
  - `code-review` is renamed to `mp-code-review`, so it does not clash with Claude Code's built-in `/code-review`.
  - References to it in `implement`, `implement-spec`, `ask-matt` and `tdd` were updated to match.

Upstream suggests running `/setup-matt-pocock-skills` once per repo. It records the issue tracker, triage labels and domain-doc layout that skills such as `/triage`, `/to-tickets` and `/to-spec` rely on.

### Updating

1. Clone upstream: `git clone --depth 1 https://github.com/mattpocock/skills`.
2. For each path in its `.claude-plugin/plugin.json`, copy the skill folder here (skip `agents/`).
3. Re-apply the `code-review` → `mp-code-review` rename above.
4. Update the commit hash and version in this file.
