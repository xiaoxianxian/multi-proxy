#!/usr/bin/env python3
"""互通性验证 · python 侧（降级，不污染全局环境）

证明 JSON (canonical) <-> YAML (human view) 双向无损。
- 有 pyyaml：做 YAML <-> JSON 对象语义相等 + 结构校验。
- 若 python 缺 pyyaml / jsonschema：优雅降级为“仅结构校验 + 明确报错”，
  绝不全局 install（铁律：不动全局环境）。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
SPEC = "1.0.0"
REQUIRED = {
    "memory": ["specVersion", "entries"],
    "skill": ["specVersion", "entries"],
}


def load_yaml(p):
    try:
        import yaml  # noqa
    except ImportError:
        print(f"FAIL  yaml unavailable, skip {p} (not a blocker; node side is authoritative)")
        return None
    return yaml.safe_load(p.read_text())


def schema_like(doc, keys):
    """轻量结构校验（替代 jsonschema 缺失时的降级）。"""
    if not isinstance(doc, dict):
        return False, "root not object"
    for k in keys:
        if k not in doc:
            return False, f"missing {k!r}"
    if doc.get("specVersion") != SPEC:
        return False, f"specVersion != {SPEC}"
    if not isinstance(doc.get("entries"), list) or not doc["entries"]:
        return False, "entries missing/empty"
    for i, e in enumerate(doc["entries"]):
        if not isinstance(e, dict):
            return False, f"entry[{i}] not object"
        if e.get("id") == "" or e.get("id") is None:
            return False, f"entry[{i}] missing id"
    return True, ""


def main():
    fails = 0
    pairs = [("agent-memory", ["specVersion", "entries"]),
             ("skill", ["specVersion", "entries"])]
    for name, keys in pairs:
        json_doc = json.loads((HERE / f"{name}.json").read_text())
        yaml_doc = load_yaml(HERE / f"{name}.yaml")
        if yaml_doc is None:
            fails += 1
            continue

        # 1. JSON == YAML 语义相等（YAML 视图必须等价于 canonical JSON）
        eq = json_doc == yaml_doc
        print(f"{'PASS' if eq else 'FAIL'}  {name}: JSON == YAML (parsed)")
        if not eq:
            fails += 1
            print(f"    json={json_doc}\n    yaml={yaml_doc}")

        # 2. 结构校验（json + yaml 两视图都过）
        for label, d in (("json", json_doc), ("yaml", yaml_doc)):
            ok, why = schema_like(d, keys)
            print(f"{'PASS' if ok else 'FAIL'}  {name} ({label}): structure ok")
            if not ok:
                fails += 1
                print(f"    {why}")

        # 3. 负例：坏 specVersion 应被结构校验拒绝
        bad = json.loads(json.dumps(json_doc))
        bad["specVersion"] = "9.9.9"
        ok, _ = schema_like(bad, keys)
        print(f"{'PASS' if not ok else 'FAIL'}  {name}: bad specVersion rejected")
        fails += not (not ok)

    print()
    print("PYTHON: ALL PASS" if fails == 0 else f"PYTHON: {fails} FAILED")
    sys.exit(0 if fails == 0 else 1)


if __name__ == "__main__":
    main()
