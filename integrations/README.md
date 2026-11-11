# Optional adapters (not part of the RSI extension)

Everything under `integrations/` is a **separate adapter layer**:

- `src/rsi/` never imports it, never mentions a target project, and has no
  project-specific branch names or file paths.
- The extension's `package.json` exposes only `extensions/`, `skills/`, and
  `prompts/`; adapters are not loaded by Pi.
- The target project owns its benchmark harness. `scripts/setup-dfm-ssm.sh`
  copies `dfm_ssm/run_experiment.py` and `dfm_ssm/dfm_lm_eval.py` into the
  target repository's `rsi-bench` ref (`bench/rsi_dfm_train_eval.py`,
  `bench/dfm_lm_eval.py`).
- A `Problem` only describes the generic contract: `repo`, `repo_ref`, and
  `experiment_command` with `{scope}`, `{out}`, `{repo}`, `{commit}`.

To generate a new adapter from a Problem fixture, use the `rsi-adapter` skill:

```bash
python3 skills/rsi-adapter/scripts/scaffold_adapter.py \
  --problem examples/<project>.json \
  --repo /path/to/target \
  --name <project> \
  --out integrations/<project>
```

It writes a contract-compliant skeleton, `README.md`, `setup.sh`, and
`adapter.json`. Fill the `train` / `evaluate` / `parse_metrics` TODOs before a
real run; the scaffold intentionally fails closed rather than fabricating a
metric.

To integrate another project manually, add:

1. a git repository containing the project;
2. a benchmark command that writes `{"metrics": {...}}` to `--out`;
3. a `Problem` fixture with `repo`, `repo_ref`, and `experiment_command`.

No change to `src/rsi/` is required.
