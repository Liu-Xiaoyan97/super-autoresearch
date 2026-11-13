#!/usr/bin/env python3
"""Render the RSI experiment lineage as a width-aware card tree.

Input is the generated lineage.json. Output is lineage.png and lineage.svg.
Each same-parent seed group is one node.  The tree is laid out in points, so
long labels wrap inside a card instead of colliding with a sibling, and the
canvas grows with both the number of leaves and the depth of the tree.

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
    from matplotlib.lines import Line2D
    from matplotlib.patches import FancyBboxPatch, Patch
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

CHAR_PT = 4.25          # approximate width of one 6.8pt character
TITLE_PT = 8.2          # title font size
DETAIL_PT = 6.6         # detail font size
TITLE_LINE = 10.5       # title line height in points
DETAIL_LINE = 8.0       # detail line height in points
WRAP_TITLE = 34
WRAP_DETAIL = 56
PAD_X = 10.0
PAD_Y = 8.0
ROW_GAP = 24.0
SIBLING_GAP = 14.0
MARGIN = 36.0
HEADER = 88.0
FOOTER = 82.0
MIN_CARD_W = 228.0


def wrap(text: str, width: int) -> list[str]:
    return textwrap.wrap(text.strip(), width=width, break_long_words=False, break_on_hyphens=False) or [""]


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: render_lineage.py lineage.json out_dir", file=sys.stderr)
        return 2
    source, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    data = json.loads(source.read_text(encoding="utf-8"))
    nodes = {node["id"]: dict(node) for node in data.get("nodes", [])}
    if not nodes:
        return 0

    # One card per seed group.  A project node is only a synthetic root; every
    # real node retains the grouped parent relation computed by ledger.ts.
    root = next((node_id for node_id, node in nodes.items() if node.get("parent") is None), None)
    if root is None:
        root = next(iter(nodes))
        nodes[root]["parent"] = None
    children: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for node_id, node in nodes.items():
        parent = node.get("parent")
        if parent in children and parent != node_id:
            children[parent].append(node_id)
    for kids in children.values():
        kids.sort(key=lambda node_id: str(nodes[node_id].get("label", node_id)))

    depth: dict[str, int] = {}

    def compute_depth(node_id: str, seen: set[str] | None = None) -> int:
        if node_id in depth:
            return depth[node_id]
        seen = set() if seen is None else seen
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

    # Text is wrapped before sizing.  Every card shares one width and one
    # maximal height, which makes the row spacing independent of node count.
    content: dict[str, dict[str, object]] = {}
    all_lines: list[str] = []
    for node_id, node in nodes.items():
        label = str(node.get("label") or node_id)
        core = str(node.get("core") or "").strip()
        detail = str(node.get("detail") or "").strip()
        title_lines = wrap(label, WRAP_TITLE)
        detail_lines = wrap(core, WRAP_DETAIL) + wrap(detail, WRAP_DETAIL) if core else wrap(detail, WRAP_DETAIL)
        all_lines.extend(title_lines)
        all_lines.extend(detail_lines)
        title_h = len(title_lines) * TITLE_LINE
        detail_h = len(detail_lines) * DETAIL_LINE
        content[node_id] = {
            "title": title_lines,
            "detail": detail_lines,
            "title_h": title_h,
            "detail_h": detail_h,
            "height": PAD_Y * 2 + title_h + 4 + detail_h,
        }

    card_w = max(MIN_CARD_W, max((len(line) for line in all_lines), default=1) * CHAR_PT + PAD_X * 2 + 24)
    card_h_max = max(float(item["height"]) for item in content.values())
    row_h = card_h_max + ROW_GAP

    # A parent card is centred over the horizontal span of its children.
    # Sibling subtrees never share columns, so cards cannot overlap.
    subtree_w: dict[str, float] = {}

    def measure(node_id: str) -> float:
        kids = [kid for kid in children.get(node_id, []) if depth.get(kid, 0) > depth.get(node_id, 0)]
        if kids:
            total = sum(measure(kid) for kid in kids) + SIBLING_GAP * (len(kids) - 1)
        else:
            total = 0.0
        subtree_w[node_id] = max(card_w, total)
        return subtree_w[node_id]

    x: dict[str, float] = {}

    def place(node_id: str, left: float) -> None:
        kids = [kid for kid in children.get(node_id, []) if depth.get(kid, 0) > depth.get(node_id, 0)]
        width = subtree_w[node_id]
        if not kids:
            x[node_id] = left + width / 2
            return
        total = sum(subtree_w[kid] for kid in kids) + SIBLING_GAP * (len(kids) - 1)
        child_left = left + (width - total) / 2
        for kid in kids:
            place(kid, child_left)
            child_left += subtree_w[kid] + SIBLING_GAP
        x[node_id] = (x[kids[0]] + x[kids[-1]]) / 2

    measure(root)
    place(root, 0.0)
    # Defensive fallback for malformed/disconnected input: never silently drop
    # a node from the picture.
    next_left = subtree_w[root] + SIBLING_GAP
    for node_id in nodes:
        if node_id not in x:
            subtree_w[node_id] = card_w
            place(node_id, next_left)
            next_left += card_w + SIBLING_GAP

    max_depth = max(depth.values(), default=0)
    tree_w = max(
        max(x.get(node_id, 0.0) + subtree_w.get(node_id, card_w) / 2 for node_id in nodes),
        card_w,
    )
    tree_w = max(tree_w, max(x.values(), default=0.0) + card_w / 2)
    canvas_w = max(720.0, tree_w + MARGIN * 2)
    canvas_h = HEADER + (max_depth + 1) * row_h + card_h_max + FOOTER

    fig = plt.figure(figsize=(canvas_w / 72.0, canvas_h / 72.0), facecolor="#f7f9fc")
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, canvas_w)
    ax.set_ylim(0, canvas_h)
    ax.axis("off")

    def top_of(node_id: str) -> float:
        return canvas_h - HEADER - depth[node_id] * row_h

    def bottom_of(node_id: str) -> float:
        return top_of(node_id) - float(content[node_id]["height"])

    # Draw edges first; every edge runs only through the gap between two rows.
    for node_id, node in nodes.items():
        parent = node.get("parent")
        if parent not in nodes or parent == node_id:
            continue
        px, cx = x[parent], x[node_id]
        pbottom = bottom_of(parent)
        ctop = top_of(node_id)
        mid = (pbottom + ctop) / 2
        dashed = node.get("edge") == "dashed"
        color = "#6f8fa8" if dashed else "#b2c2d1"
        linestyle = (0, (4, 3)) if dashed else "solid"
        ax.plot([px, px], [pbottom, mid], color=color, lw=1.2, linestyle=linestyle, zorder=1)
        ax.plot([px, cx], [mid, mid], color=color, lw=1.2, linestyle=linestyle, zorder=1)
        ax.plot([cx, cx], [mid, ctop], color=color, lw=1.2, linestyle=linestyle, zorder=1)

    for node_id, node in nodes.items():
        kind = str(node.get("kind") or "subset")
        color = COLORS.get(kind, "#187c91")
        item = content[node_id]
        top = top_of(node_id)
        height = float(item["height"])
        left = x[node_id] - card_w / 2
        bottom = top - height
        selected = bool(node.get("selected"))
        ax.add_patch(FancyBboxPatch(
            (left, bottom), card_w, height,
            boxstyle="round,pad=0,rounding_size=4",
            linewidth=2.2 if selected else 1.0,
            edgecolor="#d6a52a" if selected else color,
            facecolor="#ffffff",
            zorder=2,
        ))
        title_top = top - PAD_Y
        title_center = title_top - TITLE_LINE / 2
        ax.scatter(
            [left + 14], [title_center], s=44,
            facecolor="white" if kind == "pending" else color,
            edgecolor="#d6a52a" if selected else color,
            linewidth=1.7 if selected else 1.2, zorder=3,
        )
        ax.text(
            left + 25, title_top, "\n".join(item["title"]),
            fontsize=TITLE_PT, color="#22364b", va="top", ha="left",
            weight="bold", linespacing=1.05, zorder=4,
        )
        detail_top = title_top - float(item["title_h"]) - 4
        ax.text(
            left + PAD_X, detail_top, "\n".join(item["detail"]),
            fontsize=DETAIL_PT, color="#5f7085", va="top", ha="left",
            linespacing=1.2, zorder=4,
        )

    fig.text(0.03, 1 - 24 / canvas_h, "RSI Experiment Lineage", fontsize=20, weight="bold", color="#25364b")
    fig.text(
        0.03, 1 - 47 / canvas_h,
        "Top-down = inheritance. Each same-parent seed group is a node; a family is one model-definition blob, "
        "not a commit. Selected incumbent is ringed in gold.",
        fontsize=8.8, color="#526479",
    )
    legend = [
        Patch(color=COLORS["root"], label="project root"),
        Patch(color=COLORS["baseline"], label="baseline"),
        Patch(color=COLORS["candidate"], label="candidate"),
        Patch(color=COLORS["engineer"], label="engineer"),
        Patch(color=COLORS["full"], label="full experiment"),
        Patch(color=COLORS["ablation"], label="ablation"),
        Patch(color=COLORS["rebuttal"], label="rebuttal"),
    ]
    legend_handles = legend + [
        Line2D([0], [0], color="#6f8fa8", lw=1.2, linestyle=(0, (4, 3)), label="subset → full (dashed)"),
    ]
    fig.legend(handles=legend_handles, loc="lower left", bbox_to_anchor=(0.03, 0.012), ncol=4, frameon=False, fontsize=8.5)
    notes = data.get("family_rule", "")
    if notes:
        fig.text(0.03, 58 / canvas_h, "Family rule: " + notes, fontsize=7.8, color="#627287")
    warnings = data.get("parent_warnings") or []
    if warnings:
        fig.text(0.03, 19 / canvas_h, "Parent warnings: " + "; ".join(str(item) for item in warnings[:3]), fontsize=7.5, color="#a33b3b")

    out_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_dir / "lineage.png", dpi=160, facecolor=fig.get_facecolor(), bbox_inches="tight", pad_inches=0.2)
    fig.savefig(out_dir / "lineage.svg", facecolor=fig.get_facecolor(), bbox_inches="tight", pad_inches=0.2)
    plt.close(fig)
    print(f"rendered {out_dir / 'lineage.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
