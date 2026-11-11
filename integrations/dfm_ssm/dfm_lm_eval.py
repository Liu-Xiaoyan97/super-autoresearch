#!/usr/bin/env python3
"""lm-eval wrapper for DFM-Mamba checkpoints (wikitext word perplexity).

Installed by integrations/dfm_ssm/setup.sh into the target repository's
`rsi-bench` ref as `bench/dfm_lm_eval.py`. It is not part of the RSI extension.

Usage (normally invoked by bench/rsi_dfm_train_eval.py):

  python bench/dfm_lm_eval.py --model dfm_mamba \
    --model_args pretrained=/path/checkpoint,device=cuda,batch_size=8 \
    --tasks wikitext --device cuda --batch_size 8 --output_path result.json
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F
from transformers import AutoTokenizer

from lm_eval.api.model import LM
from lm_eval.api.registry import register_model
from lm_eval.__main__ import cli_evaluate

from mamba_ssm.models.dfm import DFMMambaLMHeadModel


@register_model("dfm_mamba")
class DFMMambaLM(LM):
    """Causal log-likelihood of a DFM checkpoint's Mamba backbone."""

    def __init__(
        self,
        pretrained: str,
        device: str = "cuda",
        dtype: str = "float32",
        batch_size: int | str = 1,
        max_length: int | str = 2048,
        backend: str = "auto",
        flow_time: float | str | None = 1.0,
        **kwargs,
    ) -> None:
        del dtype, kwargs
        super().__init__()
        self._flow_time = None if flow_time in (None, "off", "none") else float(flow_time)
        self._device = torch.device(device)
        self._model = DFMMambaLMHeadModel.from_pretrained(
            pretrained, device=device, dtype=torch.float32, backend=backend
        ).eval()
        self.tokenizer = AutoTokenizer.from_pretrained(pretrained)
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token_id = self.tokenizer.eos_token_id
        self._batch_size = int(batch_size)
        self._max_length = int(max_length)

    @property
    def eot_token_id(self) -> int:
        return int(self.tokenizer.eos_token_id)

    @property
    def batch_size(self) -> int:
        return self._batch_size

    @property
    def max_length(self) -> int:
        return self._max_length

    @property
    def device(self) -> torch.device:
        return self._device

    @torch.no_grad()
    def _logits(self, input_ids: torch.Tensor) -> torch.Tensor:
        if self._flow_time is not None:
            logits = self._model(input_ids, self._flow_time).logits
        else:
            hidden = self._model.backbone(input_ids)
            logits = self._model.lm_head(hidden)
        return logits[..., : self._model.config.original_vocab_size].float()

    def _token_logprobs(self, input_ids: torch.Tensor) -> torch.Tensor:
        if input_ids.shape[1] < 2:
            return input_ids.new_zeros((0,), dtype=torch.float32)
        logits = self._logits(input_ids[:, :-1])
        targets = input_ids[:, 1:]
        logprobs = F.log_softmax(logits, dim=-1)
        return logprobs.gather(-1, targets.unsqueeze(-1)).squeeze(-1).reshape(-1)

    @torch.no_grad()
    def loglikelihood(self, requests):
        results = []
        for request in requests:
            context, continuation = getattr(request, "args", request)
            text = context + continuation
            ids = self.tokenizer(text, return_tensors="pt", add_special_tokens=False).input_ids
            ids = ids.to(self._device)
            context_ids = self.tokenizer(context, add_special_tokens=False).input_ids
            start = max(0, len(context_ids) - 1)
            if ids.shape[1] < 2 or start >= ids.shape[1] - 1:
                results.append((-math.inf, False))
                continue
            logits = self._logits(ids[:, :-1])
            logprobs = F.log_softmax(logits, dim=-1).gather(
                -1, ids[:, 1:].unsqueeze(-1)
            ).squeeze(-1).reshape(-1)
            total = float(logprobs[start:].sum().item())
            is_greedy = bool(torch.argmax(logits[0, start:], -1).eq(ids[0, start + 1 :]).all())
            results.append((total, is_greedy))
        return results

    @torch.no_grad()
    def loglikelihood_rolling(self, requests):
        results = []
        for request in requests:
            text = getattr(request, "args", request)[0]
            ids = self.tokenizer(text, return_tensors="pt", add_special_tokens=False).input_ids
            ids = ids.to(self._device)
            total = 0.0
            for offset in range(0, max(0, ids.shape[1] - 1), self._max_length):
                chunk = ids[:, offset : offset + self._max_length]
                if chunk.shape[1] < 2:
                    continue
                total += float(self._token_logprobs(chunk).sum().item())
            results.append(total)
        return results

    def generate_until(self, requests):
        raise NotImplementedError("wikitext word perplexity does not use generation")


if __name__ == "__main__":
    cli_evaluate()
