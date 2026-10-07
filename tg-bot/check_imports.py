"""Does every `from <our module> import <name>` actually resolve?

Written after a live outage: `_is_loopback` was moved out of bot/http_registry
into bridge/registry, every CALL site was updated, and one IMPORT was missed —
in tgbridge.py, inside a function. Nothing caught it. `py_compile` only parses,
and importing bot.handlers never executes a function-local import, so the bot
built, deployed, started, and died on its first registry call. The bridge was
down for the minutes it took to notice.

So this walks the AST instead of the import graph: every from-import of one of
OUR modules, at any nesting depth, is checked against what that module actually
defines. Static on purpose — it needs no dependencies and cannot itself fail to
run in an environment where the real ones are missing.

    python3 tg-bot/check_imports.py
"""
from __future__ import annotations

import ast
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OURS = ("bot", "bridge", "utils")


def _module_path(mod: str) -> str | None:
    rel = mod.replace(".", os.sep)
    for candidate in (os.path.join(ROOT, rel + ".py"), os.path.join(ROOT, rel, "__init__.py")):
        if os.path.isfile(candidate):
            return candidate
    return None


def _names_defined(path: str) -> set[str]:
    """Top-level names a module offers: defs, classes, assignments, re-exports."""
    tree = ast.parse(open(path, encoding="utf-8").read(), path)
    out: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                out.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.If):  # TYPE_CHECKING blocks and the like
            for inner in node.body:
                if isinstance(inner, (ast.Import, ast.ImportFrom)):
                    for alias in inner.names:
                        out.add(alias.asname or alias.name.split(".")[0])
    return out


def check() -> list[str]:
    problems: list[str] = []
    defined: dict[str, set[str]] = {}
    for dirpath, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if not d.startswith((".", "__"))]
        for name in files:
            if not name.endswith(".py") or name.startswith("."):
                continue
            path = os.path.join(dirpath, name)
            try:
                tree = ast.parse(open(path, encoding="utf-8").read(), path)
            except SyntaxError as exc:
                problems.append(f"{path}: {exc}")
                continue
            for node in ast.walk(tree):          # ast.walk: nested imports too
                if not isinstance(node, ast.ImportFrom) or node.level or not node.module:
                    continue
                if node.module.split(".")[0] not in OURS:
                    continue
                target = _module_path(node.module)
                if target is None:
                    problems.append(f"{os.path.relpath(path, ROOT)}:{node.lineno}: "
                                    f"no module {node.module}")
                    continue
                if target not in defined:
                    defined[target] = _names_defined(target)
                for alias in node.names:
                    if alias.name == "*" or alias.name in defined[target]:
                        continue
                    # `from bot import topics` imports a SUBMODULE, which is not
                    # a name in bot/__init__.py and is still perfectly valid.
                    if _module_path(f"{node.module}.{alias.name}"):
                        continue
                    problems.append(
                        f"{os.path.relpath(path, ROOT)}:{node.lineno}: "
                        f"{node.module} has no {alias.name!r}")
    return problems


if __name__ == "__main__":
    found = check()
    for line in found:
        print(line)
    print(f"import check: {'FAILED' if found else 'OK'} ({len(found)} problem(s))")
    sys.exit(1 if found else 0)
