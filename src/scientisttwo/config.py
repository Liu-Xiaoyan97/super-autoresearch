"""All tunable knobs of the ScientistTwo pipeline.

Values marked [PAPER] are taken verbatim from the paper (section noted next to
them) and must not be changed. Values marked [CHOICE] are not specified by the
paper; they are documented defaults of this reimplementation.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

__all__ = ["ModelRoute", "ScientistTwoConfig", "DEFAULT_MODEL_ROUTES"]


class ModelRoute(BaseModel):
    """Which model runs which agent (Appendix A.2)."""

    provider: str = "mock"
    model: str = "mock-scientist"
    temperature: float = 0.2
    max_tokens: int = 8192


#: Appendix A.2: "we employ Gemini 3.6 Flash for all agents, except for the Idea
#: Experiment Coding Agent, the Ablation Study Agent, the Rebuttal Agent, and the
#: Draft Enhancer, which use Claude Code with Opus 4.8."
DEFAULT_MODEL_ROUTES: dict[str, ModelRoute] = {
    "default": ModelRoute(provider="mock", model="mock-scientist"),
    "coding": ModelRoute(provider="mock", model="mock-coder"),
    "ablation": ModelRoute(provider="mock", model="mock-coder"),
    "rebuttal": ModelRoute(provider="mock", model="mock-coder"),
    "draft_enhancer": ModelRoute(provider="mock", model="mock-coder"),
}


class ScientistTwoConfig(BaseModel):
    # ------------------------------------------------------------------ run
    run_id: str = "run"
    out_dir: str = "runs"
    seed: int = 7
    runner: Literal["simulated", "subprocess"] = "simulated"
    fail_fast: bool = False
    """raise instead of degrading when a stage crashes"""

    # ------------------------------------------- §3.1 idea generation
    n_seed: int = Field(default=8, ge=1)  # [CHOICE] N_seed
    max_limitation_rounds: int = Field(default=16, ge=1)  # [PAPER] A.2
    novelty_refs: int = Field(default=2, ge=0)  # [PAPER] A.2 ("two reference papers")
    min_novelty: float = 0.35  # [CHOICE] reject seeds below this score
    min_limitations: int = 3  # [CHOICE] verifier floor before accepting a set

    # ------------------------------------------- exploration guidance [EXTENSION]
    guidance_weight: float = Field(default=0.5, ge=0.0)
    """ranking score = novelty_score + guidance_weight * domain_fit (paper uses novelty only)"""
    min_domain_fit: float = Field(default=0.3, ge=0.0, le=1.0)
    """ideas below this alignment are dropped when the user supplied directions"""
    strict_directions: bool = False
    """if True, Problem.hard_directions() become hard gates instead of soft weights"""
    guidance_in_evolution: bool = True
    """feed domain + directions into §3.3 IdeaEvolver so refinements stay in scope"""

    # ------------------------------------------- §3.2 idea evaluation
    n0: int = Field(default=2, ge=1)  # [CHOICE] top-N0 seeds implemented in round 0
    max_eng_rounds: int = Field(default=2, ge=0)  # [PAPER] A.2
    subset_fraction: float = 0.25  # [CHOICE] benchmark subset size
    subset_margin: float = 0.02  # [CHOICE] required subset gain to scale up

    # ------------------------------------------- §3.3 idea refinement
    max_refine_rounds: int = Field(default=4, ge=1)  # [PAPER] A.2
    success_target: int = Field(default=4, ge=1)  # [PAPER] A.2
    n_evolved: int = Field(default=1, ge=0)  # [PAPER] A.2 ("one ... evolved idea")
    n_explore: int = Field(default=1, ge=0)  # [PAPER] A.2 ("one selected from the seed ideas")

    # ------------------------------------------- §3.4 ablations
    n_ablation_plans: int = Field(default=5, ge=1)  # [INFERENCE] §B reports "5-6 ablations per paper"; N_p itself is never stated
    max_ablation_rounds: int = Field(default=1, ge=0)  # [PAPER] A.2

    # ------------------------------------------- §3.5 drafting & review
    review_threshold: float = Field(default=8.0, ge=0)  # [PAPER] A.2
    review_scale_max: float = 10.0  # [PAPER] §3.5 (ICLR 1-10)
    max_peer_rounds: int = Field(default=2, ge=0)  # [PAPER] A.2 (Table 5 shows >2 rounds; A.2 wins)
    max_review_refinements: int = Field(default=1, ge=0)  # [PAPER] A.2
    venue_format: str = "iclr2025"  # [PAPER] A.2
    required_sections: list[str] = Field(
        default_factory=lambda: [
            "abstract",
            "introduction",
            "related_work",
            "method",
            "experiments",
            "ablation",
            "conclusion",
        ]
    )  # [CHOICE]

    # ------------------------------------------- §3.6 meta-review
    max_meta_rounds: int = Field(default=2, ge=0)  # [CHOICE] N_meta

    # ------------------------------------------- models & budget
    model_routes: dict[str, ModelRoute] = Field(default_factory=lambda: dict(DEFAULT_MODEL_ROUTES))
    max_llm_calls: int = 2000  # [CHOICE] hard stop
    max_experiments: int = 200  # [CHOICE] hard stop
    max_wall_time_s: float = 3600.0  # [CHOICE] hard stop

    def route(self, role: str) -> ModelRoute:
        return self.model_routes.get(role) or self.model_routes["default"]
