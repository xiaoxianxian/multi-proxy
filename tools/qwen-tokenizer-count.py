#!/usr/bin/env python3
"""数 token：给 `node tools/token-estimate-calibrate.js --truth=qwen` 用。

   python3 tools/qwen-tokenizer-count.py <tokenizer.json> <corpus.json>

stdin/argv2 = JSON 字符串数组；stdout = JSON 数字数组（每个文本的 token 数）。
用 HF `tokenizers` 而不是 transformers —— 后者为数个 token 要拖一整个模型栈。

为什么单独写一个 py 文件：node 侧没有 qwen 分词器，而**别为了数 token 去起模型**
（本机 MLX 27B 起一次几秒、还占 18GB）。tokenizer.json 跟模型一起存在，
拿它数就好，推理完全不参与。
"""

import json
import sys

from tokenizers import Tokenizer

tokenizer_file = sys.argv[1]
corpus_file = sys.argv[2]

tk = Tokenizer.from_file(tokenizer_file)
with open(corpus_file, encoding="utf-8") as f:
    texts = json.load(f)

# add_special_tokens=False：我们数的是「这段文本本身占多少 token」，
# 不含 BOS/EOS 这类协议开销，跟 gpt-tokenizer.countTokens 的口径对齐。
counts = [len(tk.encode(text, add_special_tokens=False).ids) for text in texts]
print(json.dumps(counts))
