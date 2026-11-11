# Python reference implementation

This directory is the original, faithful Python implementation of ScientistTwo
(arXiv:2609.19644). The runnable product of this repository is now the
TypeScript Pi package in the repository root (`extensions/`, `src/rsi/`); this
tree is kept as the **executable specification** and parity reference.

Run it from this directory:

```bash
cd legacy/python
export PYTHONPATH=src
python3 -m scientisttwo.cli run ../../examples/ood_frozen_encoder.json --mock
python3 -m scientisttwo.cli inspect <run_id>
python3 -m scientisttwo.cli replay <run_id>
python3 -m pytest -q
```

Requires Python ≥ 3.11 and `pydantic>=2.6` (`pip install -e .[dev]`).

The TypeScript port preserves:

- the frozen field names and JSON artifact contract (`state.json`,
  `traces.jsonl`, `final.json`);
- the deterministic simulated-runner formula (CRC32, headroom compensation,
  80% positive gain calibration);
- the strict adoption gate (`isStrictlyBetter`), subset margin, engineering
  budget scope, ablation attribution model, and integrity checks;
- replay from traces alone, without a model or workspace.

Known intentional differences:

- offline mock synthesis is explicit and task-keyed instead of Python
  reflection; ids/values are deterministic but not byte-identical to Python;
- the TS mock's exact metrics can therefore differ from a Python run with the
  same seed (both remain deterministic);
- TypeScript tests replace the pytest suite at the repository root; Python
  tests remain runnable here for reference.
