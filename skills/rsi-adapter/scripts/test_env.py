#!/usr/bin/env python3
"""Create and populate the target-owned test environment.

The adapter manifest points at this environment through
`languages.python.python`; RSI never stores target test dependencies in its own
source tree. Run this inside the execution container so the venv matches the
Linux check worker.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


DEFAULT_VENV = ".rsi/venv"
AUTO_REQUIREMENTS = (
    ".rsi/test-requirements.txt",
    "requirements-test.txt",
    "requirements-dev.txt",
    "requirements.txt",
)


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _git_root(repo: Path) -> Path:
    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ValueError(f"not a git checkout: {repo}")
    root = Path(result.stdout.rstrip("\r\n")).resolve()
    if root != repo.resolve():
        raise ValueError("--repo must be the root of the target git checkout")
    return root


def _venv_python(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _write_gitignore(repo: Path, venv_dir: Path) -> None:
    rsi_dir = repo / ".rsi"
    if not _inside(rsi_dir, venv_dir):
        return
    rel = venv_dir.relative_to(rsi_dir).as_posix().rstrip("/") + "/"
    ignore = rsi_dir / ".gitignore"
    lines = ignore.read_text().splitlines() if ignore.exists() else []
    if rel not in lines:
        ignore.write_text("\n".join([*lines, rel, ""]))


def _requirements(repo: Path, explicit: list[str]) -> list[Path]:
    if explicit:
        files = [Path(value).expanduser() for value in explicit]
    else:
        files = [repo / value for value in AUTO_REQUIREMENTS]
        files = [file for file in files if file.is_file()][:1]
    out: list[Path] = []
    for file in files:
        resolved = file if file.is_absolute() else (repo / file)
        resolved = resolved.resolve()
        if not resolved.is_file():
            raise ValueError(f"requirements file does not exist: {file}")
        if not _inside(repo, resolved):
            raise ValueError(f"requirements file escapes target repository: {file}")
        out.append(resolved)
    return out


def setup_test_env(
    repo: str | Path,
    *,
    venv_rel: str = DEFAULT_VENV,
    requirements: list[str] | None = None,
    pip_args: list[str] | None = None,
    python_executable: str | None = None,
    recreate: bool = False,
) -> dict[str, str]:
    """Create the venv, install pytest and declared target dependencies."""
    root = _git_root(Path(repo).expanduser().resolve())
    venv_dir = (root / venv_rel).resolve()
    if not _inside(root, venv_dir):
        raise ValueError("--venv must stay inside the target repository")
    if venv_dir == root / ".git" or (root / ".git") in venv_dir.parents:
        raise ValueError("--venv must not be inside .git")

    if recreate and venv_dir.exists():
        import shutil
        shutil.rmtree(venv_dir)
    if not venv_dir.exists():
        creator = python_executable or sys.executable
        created = subprocess.run(
            [creator, "-m", "venv", "--symlinks", str(venv_dir)],
            cwd=root,
            text=True,
        )
        if created.returncode != 0:
            raise ValueError(f"venv creation failed with exit {created.returncode}; see output above")

    python = _venv_python(venv_dir)
    if not python.is_file():
        raise ValueError(f"venv has no Python executable: {python}")

    reqs = _requirements(root, requirements or [])
    command = [
        str(python),
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-cache-dir",
        *(pip_args or []),
        "pytest",
    ]
    for file in reqs:
        command.extend(["-r", str(file)])
    result = subprocess.run(command, cwd=root, text=True)
    if result.returncode != 0:
        raise ValueError(f"pip install failed with exit {result.returncode}; see output above")

    _write_gitignore(root, venv_dir)
    return {
        "repo": str(root),
        "venv": str(venv_dir),
        "venv_rel": venv_dir.relative_to(root).as_posix(),
        "python": str(python),
        "python_rel": python.relative_to(root).as_posix(),
        "requirements": ",".join(str(file) for file in reqs),
        "requirements_rel": [file.relative_to(root).as_posix() for file in reqs],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="target git checkout")
    parser.add_argument("--venv", default=DEFAULT_VENV, help="venv path relative to --repo")
    parser.add_argument("--requirements", action="append", default=[], help="requirements file; repeatable")
    parser.add_argument("--pip-arg", action="append", default=[], help="extra argument passed to pip install; repeatable")
    parser.add_argument("--venv-python", help="Python used to create the venv (default: current interpreter)")
    parser.add_argument("--recreate", action="store_true", help="delete and recreate an existing venv")
    args = parser.parse_args()
    try:
        result = setup_test_env(
            args.repo,
            venv_rel=args.venv,
            requirements=args.requirements,
            pip_args=args.pip_arg,
            python_executable=args.venv_python,
            recreate=args.recreate,
        )
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
