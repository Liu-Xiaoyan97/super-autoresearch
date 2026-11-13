#!/usr/bin/env python3
"""Render the RSI experiment lineage as an org-chart tree.

Input is the generated lineage.json. Output is lineage.png and lineage.svg.
The renderer is best effort: without matplotlib it exits successfully so the
durable JSON/Markdown/DOT ledger remains available.
"""
from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch
except Exception as exc:  # pragma: no cover - depends on host image
    print(f"lineage render skipped (matplotlib unavailable): {exc}", file=sys.stderr)
    raise SystemExit(0)


COLORS = {
    "root": "#6f5b8a",
    "family": "#4a6fa5",
    "baseline": "#187c91",
    "candidate": "#187c91",
    "engineer": "#c6811c",
    "subset": "#187c91",
    "full": "#0f6b46",
    "ablation": "#18865a",
    "rebuttal": "#c6811c",
    "selected": "#0f6b46",
    "pending": "#7c8794",
}


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: render_lineage.py lineage.json out_dir", file=sys.stderr)
        return 2
    source, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    data = json.loads(source.read_text(encoding="utf-8"))
    nodes = {node["id"]: dict(node) for node in data.get("nodes", [])}
    if not nodes:
        return 0
    root = next((node for node in nodes.values() if node.get("parent") is None), None)
    if root is None:
        root = next(iter(nodes.values()))
        root["parent"] = None
    children: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for node in nodes.values():
        parent = node.get("parent")
        if parent in children and parent != node["id"]:
            children[parent].append(node["id"])
    for node_id in children:
        children[node_id].sort()

    depth: dict[str, int] = {}
    def compute_depth(node_id: str, seen: set[str] | None = None) -> int:
        seen = set() if seen is None else seen
        if node_id in depth:
            return depth[node_id]
        if node_id in seen:
            depth[node_id] = 0
            return 0
        seen.add(node_id)
        parent = nodes[node_id].get("parent")
        value = 0 if parent not in nodes else compute_depth(parent, seen) + 1
        depth[node_id] = value
        return value
    for node_id in nodes:
        compute_depth(node_id)

    # Leaves get sequential columns; a parent is centred over its children.
    x: dict[str, float] = {}
    next_leaf = 0
    visiting: set[str] = set()
    def assign(node_id: str) -> float:
        nonlocal next_leaf
        if node_id in x:
            return x[node_id]
        if node_id in visiting:
            x[node_id] = float(next_leaf)
            next_leaf += 1
            return x[node_id]
        visiting.add(node_id)
        kids = [kid for kid in children.get(node_id, []) if depth.get(kid, 0) > depth.get(node_id, 0)]
        if not kids:
            x[node_id] = float(next_leaf)
            next_leaf += 1
        else:
            values = [assign(kid) for kid in kids]
            x[node_id] = sum(values) / len(values)
        visiting.discard(node_id)
        return x[node_id]
    assign(root["id"])
    for node_id in nodes:
        if node_id not in x:
            x[node_id] = float(next_leaf)
            next_leaf += 1

    max_depth = max(depth.values(), default=0)
    max_x = max(x.values(), default=0)
    spacing = 8.2
    fig = plt.figure(figsize=(max(16, (max_x + 1) * spacing * .82), max(12, (max_depth + 1) * 3.5 + 3.2)), facecolor="#f7f9fc")
    ax = fig.add_axes([0.035, 0.18, 0.93, 0.70])
    ax.set_xlim(-1.2, max_x * spacing + 9.0)
    ax.set_ylim(-max_depth * 3.0 - 3.2, 1.2)
    ax.axis("off")

    for node in nodes.values():
        parent = node.get("parent")
        if parent not in nodes or parent == node["id"]:
            continue
        x1, y1 = x[parent] * spacing, -depth[parent] * 3.0
        x2, y2 = x[node["id"]] * spacing, -depth[node["id"]] * 3.0
        mid = y2 + 0.45
        line_style = (0, (4, 3)) if node.get("edge") == "dashed" else "solid"
        line_color = "#6f8fa8" if node.get("edge") == "dashed" else "#b9c6d4"
        ax.plot([x1, x1], [y1, mid], color=line_color, lw=1.4, zorder=1, solid_capstyle="round", linestyle=line_style)
        ax.plot([x1, x2], [mid, mid], color=line_color, lw=1.4, zorder=1, solid_capstyle="round", linestyle=line_style)
        ax.plot([x2, x2], [mid, y2], color=line_color, lw=1.4, zorder=1, solid_capstyle="round", linestyle=line_style)

    for node in nodes.values():
        kind = node.get("kind", "subset")
        color = COLORS.get(kind, "#187c91")
        size = 135 if kind in ("root", "family") else 92
        xnode = x[node["id"]] * spacing
        ynode = -depth[node["id"]] * 1.1
        if kind == "family":
            ax.scatter([xnode], [ynode], s=size, marker="s", facecolor=color, edgecolor=color, zorder=3)
        else:
            ax.scatter([xnode], [ynode], s=size,
                       facecolor="white" if kind == "pending" else color,
                       edgecolor="#d6a52a" if node.get("kind") == "selected" else color,
                       linewidth=2.4 if node.get("kind") == "selected" else 1.6, zorder=3)
        label = str(node.get("label", node["id"]))
        detail = str(node.get("detail", ""))
        core = str(node.get("core", ""))
        label_lines = textwrap.wrap(label, width=30, break_long_words=False) or [label]
        detail_lines = textwrap.wrap((core + ("\n" if core else "") + detail), width=52, break_long_words=False) or [detail]
        ax.text(xnode + 0.28, ynode + 0.18, "\n".join(label_lines[:2]),
                fontsize=9.5, color="#22364b", va="center", ha="left", weight="bold", zorder=4)
        ax.text(xnode + 0.28, ynode - 0.34, "\n".join(detail_lines[:6]),
                fontsize=8.0, color="#5f7085", va="top", ha="left", zorder=4)

    fig.text(0.035, 0.962, "RSI Experiment Lineage (stump tree)", fontsize=22, weight="bold", color="#25364b")
    fig.text(0.035, 0.928,
             "Top-down = inheritance. A family is one model-definition blob; hyperparameter-only changes stay in the same family. "
             "Selected incumbent is ringed in gold.", fontsize=10, color="#526479")
    legend = [
        Patch(color=COLORS["root"], label="project root"),
        Patch(color=COLORS["baseline"], label="baseline"),
        Patch(color=COLORS["candidate"], label="candidate"),
        Patch(color=COLORS["engineer"], label="engineer"),
        Patch(color=COLORS["full"], label="full experiment"),
        Patch(color=COLORS["ablation"], label="ablation"),
        Patch(color=COLORS["rebuttal"], label="rebuttal"),
    ]
    fig.legend(handles=legend, loc="lower left", bbox_to_anchor=(0.035, 0.018), ncol=7, frameon=False, fontsize=9)
    from matplotlib.lines import Line2D
    fig.legend(handles=[Line2D([0], [0], color="#6f8fa8", lw=1.4, linestyle=(0, (4, 3)), label="subset → full (dashed)")],
               loc="lower right", bbox_to_anchor=(0.97, 0.018), frameon=False, fontsize=9)
    notes = data.get("family_rule", "")
    if notes:
        fig.text(0.035, 0.105, "Family rule: " + notes, fontsize=8.5, color="#627287")
    out_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_dir / "lineage.png", dpi=180, facecolor=fig.get_facecolor())
    fig.savefig(out_dir / "lineage.svg", facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"rendered {out_dir / 'lineage.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
