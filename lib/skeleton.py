"""Read {path: source} as JSON on stdin, print {path: skeleton} as JSON.

A skeleton keeps imports, module code, class and function signatures, and docstrings, and drops
function bodies. Files that do not parse are left out, so the caller sends them in full.
"""
import ast
import json
import sys


def skeleton(source: str) -> str:
    tree = ast.parse(source)

    def strip(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                doc = ast.get_docstring(child)
                child.body = ([ast.Expr(ast.Constant(doc))] if doc else []) + [ast.Expr(ast.Constant(...))]
            elif isinstance(child, ast.ClassDef):
                strip(child)

    strip(tree)
    return ast.unparse(tree)


out = {}
for path, source in json.load(sys.stdin).items():
    try:
        out[path] = skeleton(source)
    except (SyntaxError, ValueError, RecursionError):
        pass
json.dump(out, sys.stdout)
