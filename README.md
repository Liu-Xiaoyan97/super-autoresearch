# ScientistTwo (reimplementation)

A faithful, runnable reimplementation of

> **ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI**
> Nam, Yoon, Pan, Wang, Meng, Ranganathan, Pfister — Google Cloud AI Research · [arXiv:2609.19644](https://arxiv.org/abs/2609.19644)

The paper is a **closed-loop, self-improving multi-agent research system**: one primitive
(`candidate → critic → refine`) is reused at every level, and the *only* thing allowed to promote a
hypothesis is a strictly better measurement against a **reproduced** baseline. Papers and codebases
are outputs, not the point — the loop is what makes the system improve itself.

| Paper | This repo |
|---|---|
| §3.1 limitations → seed ideas → novelty filter | `agents/limitations.py`, `agents/ideas.py` |
| §3.2 subset → critic → engineer → full-set | `agents/coding.py`, `agents/critics.py`, `agents/engineering.py`, `runtime/workspace.py` |
| §3.3 idea evolution from execution traces | `agents/ideas.py::IdeaEvolver`, `core/orchestrator.py` |
| §3.4 ablations + attribution | `agents/ablation.py` |
| §3.5 draft → peer review → rebuttal experiments | `agents/writing.py`, `agents/review.py` |
| §3.6 meta-review → idea refinement → re-draft | `agents/review.py::MetaReviewer`, `core/orchestrator.py` |
| §4.3 integrity audit (score / spec / refs / method–code) | `agents/integrity.py` |
| Listing 1 stage abstraction | `core/stage.py` |
| Appendix A.2 hyperparameters | `config.py` (every value annotated `[PAPER]` vs `[CHOICE]`) |

## What is added beyond the paper — exploration guidance

The paper lets the agent choose its own direction. Real labs cannot: they have a domain and a
strategy. `types.Problem` therefore carries a first-class steering layer:

```json
{
  "domain": "time series forecasting",
  "subfield": "zero-shot / retrieval-augmented",
  "directions": [
    {"id": "d1", "title": "spectral priors", "description": "DMD/FFT constraints",
     "keywords": ["DMD", "spectral"], "weight": 1.0, "must_include": false},
    {"id": "d2", "title": "safety gating", "description": "no-harm fallback",
     "weight": 0.8, "must_include": true}
  ],
  "forbidden": ["finetuning the backbone"]
}
```

Design constraints that keep this honest (see `docs/SPEC.md` §2b):

* guidance enters **generation only** — never a critic's arithmetic;
* `NoveltyChecker` reports `domain_fit`, and ranking is
  `novelty + guidance_weight · domain_fit` (set the weight to 0 to recover the paper's pure-novelty
  ordering);
* `must_include` becomes a hard gate when `strict_directions` is on;
* every `Idea` records `direction_ids`, and the manuscript must state which direction it advances;
* the offline simulator includes the `domain_fit` term, so guided vs. unguided runs differ in tests.

## Quick start (offline, no API key)

```bash
cd "/Users/liuxiaoyan/workspace/RSI "
export PYTHONPATH=src

python3 -m scientisttwo.cli run examples/ood_frozen_encoder.json --mock
python3 -m scientisttwo.cli inspect <run_id>
python3 -m scientisttwo.cli replay  <run_id>     # rebuilds decisions from traces.jsonl, no model calls
python3 -m pytest -q                             # fully offline suite
```

Every run writes `runs/<run_id>/`:

```
state.json        full research state at the end of the run
traces.jsonl      append-only log: every LLM call, every stage transition, every decision
artifacts/        final.json, manuscript.tex, ablation tables, review rounds
code/             baseline / subset / full-set codebase snapshots
```

## Pointing it at real models

```python
from scientisttwo.config import ScientistTwoConfig, ModelRoute
from scientisttwo.providers import build_provider

cfg = ScientistTwoConfig(
    model_routes={
        "default": ModelRoute(provider="kimi", model="kimi-k2-0905-preview"),
        "coding":  ModelRoute(provider="kimi", model="kimi-k2-0905-preview"),
    }
)
llm = build_provider(cfg, "openai")   # OpenAI-compatible endpoint, key from $KIMI_API_KEY
```

`runner="subprocess"` executes the repository for real; `runner="simulated"` is the deterministic
offline execution used by the tests.

## Reading order

1. `docs/SPEC.md` — the contract: invariants, state machine, frozen models, offline determinism rules.
2. `docs/analysis/*.md` — section-by-section extraction from the paper ([PAPER] vs [INFERENCE]).
3. `docs/ARCHITECTURE.md` — module ↔ agent ↔ paper-section map of the code as built.

## Fidelity: what the case study actually shows

The paper's worked example is **Procrustes-DS** (Appendix C). Its own cross-reference states:

> "For an example of a rebuttal report obtained through a simulated peer-review process, since
> **Procrustes-DS did not undergo this process**, the example of TABHARMONY is presented" — p.33

So the observed artifact chain for Procrustes-DS is: limitations → proposal → experiments →
ablations → critic feedback → reproduction/spec audits, plus a reviewer score (8.0 ScholarPeer /
6.5 Stanford, p.5). **No rebuttal round is shown for it.** The rebuttal/rebuttal-report artifacts
come from a *different* task (TABHARMONY).

Consequently, in this repo:

| Artifact | What it is |
|---|---|
| `examples/ood_frozen_encoder.json` | a **synthetic** fixture that borrows Procrustes-DS's task framing (OOD detection vs. a frozen encoder); its metrics are placeholders, not the paper's numbers |
| `examples/meta_refine.json` + `examples/mock_script.json` | a **synthetic continuation** used to exercise §3.5 rebuttal and §3.6 meta-refinement, which the paper illustrates only via TABHARMONY |
| `examples/abort_case.json` | synthetic dead-end used to test the "0 Good after K rounds" abort |

No fixture claims to reproduce a published run, and `final.json` always records
`runner: simulated` plus `accepted: false` unless every gate (review ≥ 8, meta `Accept`, clean
integrity audit) genuinely passes.

## Fidelity notes

* The paper's numbers (`86/107` improved, `+25.2%` mean relative gain, ScholarPeer/Stanford review
  scores) are **evaluation results of their infrastructure**, not reproducible here; this repo
  reproduces the *mechanism*, and every deviation is annotated.
* `docs/SPEC.md` marks each rule `[PAPER]` (quoted, with page) or `[CHOICE]` / `[INFERENCE]` /
  `[EXTENSION]`.
