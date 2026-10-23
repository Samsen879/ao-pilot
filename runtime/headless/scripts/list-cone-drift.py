#!/usr/bin/env python3
"""Read-only JSONL inventory for local backup; never stages or writes files.

Usage: python3 runtime/headless/scripts/list-cone-drift.py WORKTREE
Includes ignored files, unlike WIP save (which respects .gitignore). SHA256 for
symlinks hashes the target bytes; regular files hash their contents. Keep this
private inventory locally: paths may contain sensitive names.
"""
import argparse
import ast
import hashlib
import json
import os
import pathlib
import subprocess


def inventory(worktree):
    root = pathlib.Path(worktree).resolve(strict=True)

    def git(*args):
        return subprocess.check_output(
            ["git", "-C", str(root), *args], env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
        ).decode("utf-8", "surrogateescape").strip("\n")

    if git("config", "--bool", "core.sparseCheckout") != "true":
        raise ValueError("worktree does not use sparse checkout")
    if git("config", "--bool", "core.sparseCheckoutCone") != "true":
        raise ValueError("cone-mode sparse checkout required")
    dirs = []
    for line in git("-c", "core.quotePath=false", "sparse-checkout", "list").splitlines():
        if line.startswith('"'):
            # Git C quoting uses octal escapes for control bytes.
            line = ast.literal_eval(line)
        if line:
            dirs.append(line.rstrip("/"))

    def in_cone(name):
        parent = name.rsplit("/", 1)[0] if "/" in name else ""
        return not parent or any(
            d == "." or name == d or name.startswith(d + "/") or d.startswith(parent + "/")
            for d in dirs
        )

    def fail_walk(error):
        raise error

    for base, subdirs, files in os.walk(root, followlinks=False, onerror=fail_walk):
        if pathlib.Path(base) == root:
            subdirs[:] = [d for d in subdirs if d != ".git"]
            files = [f for f in files if f != ".git"]
        links = [d for d in subdirs if os.path.islink(os.path.join(base, d))]
        subdirs[:] = sorted(d for d in subdirs if d not in links)
        for leaf in sorted(files + links):
            full = pathlib.Path(base) / leaf
            name = full.relative_to(root).as_posix()
            if in_cone(name):
                continue
            digest = hashlib.sha256()
            if full.is_symlink():
                digest.update(os.fsencode(os.readlink(full)))
                kind = "symlink"
            elif full.is_file():
                with full.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                kind = "file"
            else:
                raise ValueError("cannot inventory special file: " + name)
            yield {"path": name, "sha256": digest.hexdigest(), "kind": kind}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("worktree")
    args = parser.parse_args()
    for row in inventory(args.worktree):
        print(json.dumps(row, ensure_ascii=True, sort_keys=True))
