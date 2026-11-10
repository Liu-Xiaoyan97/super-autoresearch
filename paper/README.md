# Source paper

**ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI**
Jaehyun Nam, Jinsung Yoon, Yanzhou Pan, Yubo Wang, Rui Meng, Parthasarathy Ranganathan, Tomas Pfister
Google Cloud AI Research · arXiv:2609.19644 (2026-09-17)

The 26 MB PDF is kept on disk but **not tracked in git** (see `.gitignore`). To restore it:

```bash
curl -sL -o paper/2609.19644.pdf https://arxiv.org/pdf/2609.19644
pdftotext paper/2609.19644.pdf paper/paper.txt
```

Tracked files:

| File | Content |
|---|---|
| `paper.txt` | full document, layout-preserved (`pdftotext -layout`) |
| `body_raw.txt` | pages 1–18 (main paper body + experiments), plain reading order |
| `body.txt` / `body_raw2.txt` | intermediate extractions used while analysing |

The implementation is derived in `docs/analysis/*.md` (section-by-section extraction with
`[PAPER]` page citations vs `[INFERENCE]`) and frozen into `docs/SPEC.md`.
