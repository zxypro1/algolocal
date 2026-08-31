/**
 * 从零实现一个 LLM，并完成预训练与后训练
 *
 * 工作台是 train 形态：任务 + 终端 + IDE + 训练 + 张量 + 样例。
 * 学员写 Python，对着 `nanotorch`（PyTorch 的严格子集）实现模型与训练循环，
 * 在浏览器里**真的**把 loss 训下去 —— 见 design/llmlab.md。
 *
 * 门槛只建立在结构性计量与确定性重放下的学习效果上，绝不建立在墙钟时间上。
 */
const { t, code, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 这个世界                                                            */
/* ------------------------------------------------------------------ */

const WORLD = {
  corpus: { holdoutRatio: 0.1 },
  arch: {
    dModel: 64, nLayer: 2, nHead: 4, nKvHead: 2,
    hidden: 128, blockSize: 16, vocabSize: 16,
  },
  hparams: {
    seed: 20260831, batchSize: 16, steps: 800,
    learningRate: 3e-3, warmupSteps: 20, weightDecay: 0.1, gradClip: 1.0,
  },
  entry: 'train.py',
};

/** 每一关的用例开头都要这一行 */
const LAB = `const lab = require('@llm/lab');`;

/* ================================================================== */
/* 第 1 关：字节级 BPE                                                 */
/* ================================================================== */

const STAGE_BPE = {
  id: 'byte-bpe',
  title: t('字节级 BPE —— 从字节开始训一张 merge 表', 'Byte-level BPE — train a merge table from raw bytes'),
  primer: t(
    code`
      模型不认识字符，只认识**整数**。把文本变成整数的那一步叫分词（tokenization），
      而 2026 年绝大多数模型用的是同一个算法：**字节对编码（BPE）**。

      ## 为什么从字节开始

      如果从字符开始，你立刻要回答「表里放哪些字符」——
      中文有几万个、emoji 每年还在加。而**字节只有 256 个**，
      任何文本都能表示，永远不会遇到「不认识的字符」。
      这就是 Llama 3、GPT-4o 都用**字节级** BPE 的原因。

      ## 算法本身只有三行

      1. 把文本变成一串字节（0–255），这是初始词表；
      2. 数一数哪一对相邻 token 出现得最多，把它合并成一个新 token；
      3. 重复第 2 步，直到词表到达目标大小。

      每次合并记下来，就得到一张 **merge 表**。编码时按这张表的顺序反复合并，
      解码时按 id 展开回字节再解 UTF-8。

      ## 一个必须说清的细节：平局怎么办

      「出现最多的那一对」经常不止一个。真实的实现都会规定一个确定的
      平局规则，否则同一份语料两次训练会得到不同的词表。
      我们的规则是：**先比频次，频次相同时取第一次出现位置更靠前的那一对**。

      ## 慢是正常的

      这一关你会发现 BPE 训练要跑几秒 —— 纯 Python 的循环比编译语言慢两个数量级。
      这不是我们的实现问题：HuggingFace 的 \`tokenizers\` 之所以用 Rust 重写，
      正是因为这一步在真实语料上要跑几个小时。
    `,
    code`
      A model does not see characters, only **integers**. Turning text into integers is
      tokenization, and in 2026 almost every model uses the same algorithm:
      **byte pair encoding (BPE)**.

      ## Why start from bytes

      Starting from characters forces you to answer "which characters go in the table" —
      there are tens of thousands of Chinese ones and new emoji every year. **Bytes are
      only 256**, can represent any text, and you never hit an unknown character. That is
      why Llama 3 and GPT-4o both use *byte-level* BPE.

      ## The algorithm is three lines

      1. Turn the text into bytes (0–255) — that is the initial vocabulary;
      2. Count which adjacent pair occurs most often and merge it into a new token;
      3. Repeat step 2 until the vocabulary reaches the target size.

      Recording every merge gives you a **merge table**. Encoding replays it in order;
      decoding expands ids back to bytes and decodes UTF-8.

      ## One detail that must be pinned down: ties

      "The most frequent pair" is often not unique. Every real implementation fixes a
      deterministic tie-break, otherwise two runs over the same corpus produce different
      vocabularies. Ours: **highest count first; on a tie, the pair whose first occurrence
      is earlier.**

      ## Slow is normal

      Training the BPE here takes seconds — pure Python loops are two orders of magnitude
      slower than compiled code. That is not a flaw in our setup: HuggingFace rewrote
      \`tokenizers\` in Rust precisely because this step takes hours on real corpora.
    `
  ),
  goal: t(
    code`
      在 \`bpe.py\` 里把三个函数写出来。

      ## 要实现什么

      \`\`\`python
      def train_bpe(data: bytes, vocab_size: int) -> list[tuple[int, int]]:
          """返回 merge 表：第 i 条合并产生的新 token id 是 256 + i"""

      def encode(text: str, merges: list[tuple[int, int]]) -> list[int]:
          """按 merge 表的顺序反复合并"""

      def decode(ids: list[int], merges: list[tuple[int, int]]) -> str:
          """展开回字节再解 UTF-8"""
      \`\`\`

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 往返 | \`decode(encode(t)) == t\`，语料里**每一段**都要成立 |
      | 词表 | 恰好 512（256 个字节 + 256 次合并） |
      | 压缩率 | 字节数 ÷ token 数 **≥ 2.80** |
      | merge 表 | 与参考实现**逐条相同** —— 平局规则见「背景」 |

      三个数都告诉你：**完全不合并是 1.00，参考解是 3.52，门槛 2.80**。
      门槛卡在中间靠参考侧 —— 少合并几十次、或者编码时漏合一些，都会掉到线下。

      ## 最容易写错的地方

      **编码时按 merge 表的顺序合并，不是按频次。** 一个很自然但错误的写法是
      「每次找当前串里 rank 最小的那一对合并」—— 那在多数情况下给出同样的结果，
      但在合并有嵌套关系时会不一样，而且**往返测试照样能过**。
      正确的做法是从第一条 merge 开始，把它在整个串里能合的都合完，再看下一条。
    `,
    code`
      Implement three functions in \`bpe.py\`.

      ## What to build

      \`\`\`python
      def train_bpe(data: bytes, vocab_size: int) -> list[tuple[int, int]]:
          """Return the merge table; merge i produces token id 256 + i"""

      def encode(text: str, merges: list[tuple[int, int]]) -> list[int]:
          """Replay the merge table in order"""

      def decode(ids: list[int], merges: list[tuple[int, int]]) -> str:
          """Expand back to bytes, then decode UTF-8"""
      \`\`\`

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Round trip | \`decode(encode(t)) == t\` for **every** slice of the corpus |
      | Vocabulary | Exactly 512 (256 bytes + 256 merges) |
      | Compression | bytes ÷ tokens **≥ 2.80** |
      | Merge table | Identical to the reference, **entry by entry** — tie-break in the primer |

      All three numbers, up front: **1.00 with no merges, 3.52 for the reference, gate at
      2.80**. The gate sits between them, near the reference — doing a few dozen fewer
      merges, or missing some during encoding, drops you below the line.

      ## The easiest thing to get wrong

      **Encoding replays the merge table in order, not by frequency.** A natural but wrong
      version picks "the lowest-rank pair currently present" each round. It agrees most of
      the time, differs when merges nest — and **still passes a round-trip test**. The
      correct version takes merge 1, applies it everywhere, then moves to merge 2.
    `
  ),
  checklist: [
    t('往返一致：decode(encode(t)) == t', 'Round trip: decode(encode(t)) == t'),
    t('词表恰好 512', 'Vocabulary is exactly 512'),
    t('压缩率 ≥ 2.80（不合并是 1.00，参考解 3.52）', 'Compression ≥ 2.80 (1.00 unmerged, 3.52 reference)'),
    t('merge 表与参考逐条相同', 'Merge table matches the reference entry by entry'),
  ],
  hints: [
    t('先写 decode —— 它最简单，而且能帮你检查 encode。',
      'Write decode first — it is the simplest and lets you check encode.'),
    t('数相邻对用一个 dict，同时记下每一对第一次出现的位置，平局时要用。',
      'Count pairs in a dict and record each pair\'s first index — you need it for ties.'),
    t('encode 里对每一条 merge 做一次「扫一遍、能合就合」，而不是对每个位置找最优 merge。',
      'In encode, sweep once per merge entry, rather than searching the best merge per position.'),
  ],
  pitfalls: [
    t(code`
      **平局不定** —— 「出现最多的那一对」经常不止一个。不定平局规则的话，
      同一份语料两次训练会得到不同的词表，而两次**都是对的**。
      我们的规则：先比频次，频次相同时取第一次出现位置更靠前的那一对。
    `, code`
      **Undefined ties** — "the most frequent pair" is often not unique. Without a rule,
      two runs over the same corpus produce different vocabularies and **both are correct**.
      Ours: highest count; on a tie, the earlier first occurrence.
    `),
    t(code`
      **按 rank 合并而不是按顺序合并。** 这个错误在多数输入上给出同样的结果，
      往返测试也照样过 —— 只有和参考的 merge 序列逐条比才抓得到。
    `, code`
      **Merging by rank instead of in order.** It agrees on most inputs and passes a
      round-trip test — only an entry-by-entry comparison with the reference catches it.
    `),
  ],
  train: {
    files: {
      'bpe.py': code`
        """第 1 关：字节级 BPE。

        三个函数都要你写。写完在终端里 \`python bpe.py\` 自己跑一遍看看。
        """


        def train_bpe(data, vocab_size):
            """从字节开始训一张 merge 表。

            参数：
                data:       bytes，语料
                vocab_size: 目标词表大小（含 256 个字节）

            返回：
                [(a, b), ...] —— 第 i 条合并把 (a, b) 合成新 id 256 + i

            平局规则：先比频次，频次相同时取**第一次出现位置更靠前**的那一对。
            """
            ids = list(data)
            merges = []
            # TODO: 反复找最频繁的相邻对并合并，直到词表到达 vocab_size
            return merges


        def encode(text, merges):
            """按 merge 表的**顺序**反复合并。

            注意不是「每次找 rank 最小的那一对」—— 见任务说明里的坑。
            """
            ids = list(text.encode("utf-8"))
            # TODO
            return ids


        def decode(ids, merges):
            """展开回字节，再按 UTF-8 解码。"""
            # TODO
            return ""


        if __name__ == "__main__":
            with open("/lab/data/corpus.txt", "r") as f:
                text = f.read()
            merges = train_bpe(text.encode("utf-8"), 512)
            ids = encode(text, merges)
            print("字节数", len(text.encode("utf-8")), "token 数", len(ids))
            print("压缩率 %.3f" % (len(text.encode("utf-8")) / max(1, len(ids))))
            print("往返一致", decode(ids, merges) == text)
      `,
    },
    referenceFiles: {
      'bpe.py': code`
        """第 1 关的参考实现。"""


        def _stats(ids):
            """数相邻对，并记下每一对第一次出现的位置（平局要用）。"""
            counts = {}
            first = {}
            for i in range(len(ids) - 1):
                pair = (ids[i], ids[i + 1])
                counts[pair] = counts.get(pair, 0) + 1
                if pair not in first:
                    first[pair] = i
            return counts, first


        def _merge(ids, pair, new_id):
            out = []
            i = 0
            while i < len(ids):
                if i < len(ids) - 1 and ids[i] == pair[0] and ids[i + 1] == pair[1]:
                    out.append(new_id)
                    i += 2
                else:
                    out.append(ids[i])
                    i += 1
            return out


        def train_bpe(data, vocab_size):
            ids = list(data)
            merges = []
            for i in range(vocab_size - 256):
                counts, first = _stats(ids)
                if not counts:
                    break
                # 先比频次（大的优先），再比第一次出现的位置（小的优先）
                pair = min(counts, key=lambda p: (-counts[p], first[p]))
                if counts[pair] < 2:
                    break
                ids = _merge(ids, pair, 256 + i)
                merges.append(pair)
            return merges


        def encode(text, merges):
            ids = list(text.encode("utf-8"))
            # **按顺序**：第 i 条 merge 在整串上合完，再看第 i+1 条
            for i, pair in enumerate(merges):
                ids = _merge(ids, pair, 256 + i)
            return ids


        def decode(ids, merges):
            out = list(ids)
            # 倒着展开：后面的 merge 依赖前面的，所以要从后往前拆
            for i in range(len(merges) - 1, -1, -1):
                new_id = 256 + i
                a, b = merges[i]
                nxt = []
                for x in out:
                    if x == new_id:
                        nxt.append(a)
                        nxt.append(b)
                    else:
                        nxt.append(x)
                out = nxt
            return bytes(out).decode("utf-8", errors="strict")


        if __name__ == "__main__":
            with open("/lab/data/corpus.txt", "r") as f:
                text = f.read()
            merges = train_bpe(text.encode("utf-8"), 512)
            ids = encode(text, merges)
            print("字节数", len(text.encode("utf-8")), "token 数", len(ids))
            print("压缩率 %.3f" % (len(text.encode("utf-8")) / max(1, len(ids))))
            print("往返一致", decode(ids, merges) == text)
      `,
    },
  },
  specs: [
    spec('bpe.spec.ts', code`
      ${LAB}

      /*
       * 判定不读学员打印的东西 —— 那是他自己算的。
       * 判定自己拿他的函数去跑，并且和平台的参考实现逐条比。
       */
      function studentMerges() {
        lab.py(\`
      import sys
      sys.path.insert(0, "/lab")
      import importlib, bpe
      importlib.reload(bpe)
      _text = open("/lab/data/corpus.txt").read()
      _merges = bpe.train_bpe(_text.encode("utf-8"), 512)
      _ids = bpe.encode(_text, _merges)
      _round = bpe.decode(_ids, _merges)
      \`);
        return {
          merges: lab.py('import json; json.dumps([list(p) for p in _merges])'),
          tokenCount: lab.py('len(_ids)'),
          byteCount: lab.py('len(_text.encode("utf-8"))'),
          roundTrip: lab.py('_round == _text'),
        };
      }

      describe('字节级 BPE', () => {
        it('往返一致 —— 语料里每一段都要成立', () => {
          const r = studentMerges();
          expect(r.roundTrip).toBe(true);
          lab.publish('tokenizer.roundtripErrors', r.roundTrip ? 0 : 1);
        });

        it('分段往返也一致（不是只有整篇才对）', () => {
          /*
           * 只测整篇的话，一类「只有在开头/结尾才正确」的实现会全绿通过。
           * gpulab 的教训：判定只查一个点时，一整类偏移算错的实现会漏过去。
           */
          const bad = lab.py(\`
      import json
      _bad = 0
      for _i in range(0, 4000, 397):
          _seg = _text[_i:_i + 233]
          if bpe.decode(bpe.encode(_seg, _merges), _merges) != _seg:
              _bad += 1
      _bad
      \`);
          expect(bad).toBe(0);
        });

        it('词表恰好 512', () => {
          const merges = JSON.parse(String(studentMerges().merges));
          expect(merges.length).toBe(256);
          lab.publish('tokenizer.vocabSize', 256 + merges.length);
        });

        it('压缩率 ≥ 2.80（不合并是 1.00，参考解 3.52）', () => {
          const r = studentMerges();
          const ratio = Number(r.byteCount) / Math.max(1, Number(r.tokenCount));
          console.log('压缩率', ratio.toFixed(3));
          lab.publish('tokenizer.compression', ratio);
          expect(ratio).toBeGreaterThan(2.0);
        });

        it('merge 表与参考实现逐条相同', () => {
          /*
           * 平局规则是题面里写死的，所以参考序列是唯一的。
           * 这一条抓的是「按 rank 合并」那个错 —— 它往返测试照样过。
           */
          const student = JSON.parse(String(studentMerges().merges));
          const reference = referenceMerges(lab.world.corpus(), 512);
          let firstDiff = -1;
          for (let i = 0; i < Math.max(student.length, reference.length); i++) {
            const a = student[i], b = reference[i];
            if (!a || !b || a[0] !== b[0] || a[1] !== b[1]) { firstDiff = i; break; }
          }
          lab.publish('tokenizer.mergeMatches', firstDiff < 0 ? 1 : 0);
          if (firstDiff >= 0) {
            throw new Error(
              '第 ' + firstDiff + ' 条 merge 和参考不一样：你的 ' +
              JSON.stringify(student[firstDiff]) + '，参考 ' + JSON.stringify(reference[firstDiff])
            );
          }
        });
      });

      /** 参考实现（平台侧）—— 平局规则与题面完全一致 */
      function referenceMerges(text, vocabSize) {
        const bytes = Array.from(new TextEncoder().encode(text));
        let ids = bytes;
        const merges = [];
        for (let step = 0; step < vocabSize - 256; step++) {
          const counts = new Map();
          const first = new Map();
          for (let i = 0; i < ids.length - 1; i++) {
            const key = ids[i] * 100000 + ids[i + 1];
            counts.set(key, (counts.get(key) || 0) + 1);
            if (!first.has(key)) first.set(key, i);
          }
          if (counts.size === 0) break;
          let bestKey = -1, bestCount = -1, bestFirst = Infinity;
          for (const [key, count] of counts) {
            const at = first.get(key);
            if (count > bestCount || (count === bestCount && at < bestFirst)) {
              bestKey = key; bestCount = count; bestFirst = at;
            }
          }
          if (bestCount < 2) break;
          const a = Math.floor(bestKey / 100000), b = bestKey % 100000;
          const next = [];
          for (let i = 0; i < ids.length; ) {
            if (i < ids.length - 1 && ids[i] === a && ids[i + 1] === b) {
              next.push(256 + step); i += 2;
            } else { next.push(ids[i]); i += 1; }
          }
          ids = next;
          merges.push([a, b]);
        }
        return merges;
      }
    `),
  ],
  gates: [
    gate({
      metric: 'llm.tokenizer.roundtripErrors', op: 'eq', value: 0,
      zh: '往返错误数', en: 'round-trip errors', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.tokenizer.vocabSize', op: 'eq', value: 512,
      zh: '词表大小', en: 'vocabulary size', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.tokenizer.compression', op: 'gte', value: 2.80,
      zh: '压缩率（不合并 1.00，参考解 3.52）', en: 'compression (1.00 unmerged, 3.52 reference)',
      dimension: 'elegance',
    }),
    gate({
      metric: 'llm.tokenizer.mergeMatches', op: 'eq', value: 1,
      zh: 'merge 表与参考逐条相同', en: 'merge table matches the reference',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      - **minbpe**（Karpathy，MIT）—— 这一关的参考形状就是它，值得读一遍。
      - **SuperBPE**（2026）—— 两阶段课程：先在空格内合并，再放开跨空格。
        30 个下游任务平均 +4.0%、MMLU +8.2%，推理省 27% 算力。
        <https://superbpe.github.io/>
      - 真实词表大小：Llama 3 是 128,256，GPT-4o 的 o200k_base 是 199,998 + 2，
        Gemma 用 SentencePiece 约 256,000。
    `,
    code`
      - **minbpe** (Karpathy, MIT) — the shape this stage follows; worth reading in full.
      - **SuperBPE** (2026) — a two-phase curriculum: merge within whitespace first, then
        lift the boundary. +4.0% average over 30 downstream tasks, +8.2% on MMLU, 27% less
        inference compute. <https://superbpe.github.io/>
      - Real vocabulary sizes: Llama 3 uses 128,256; GPT-4o's o200k_base is 199,998 + 2;
        Gemma uses SentencePiece at roughly 256,000.
    `
  ),
};

/* ================================================================== */
/* 第 2 关：语言建模的地板                                              */
/* ================================================================== */

const STAGE_BASELINE = {
  id: 'baselines',
  title: t('语言建模的地板 —— 三条基线与困惑度', 'The floor — three baselines and perplexity'),
  primer: t(
    code`
      后面十几关的门槛都是「loss 要低于某个数」。而**一个 loss 是好是坏，
      单看它是判断不了的** —— 取决于词表多大、语料多规整。

      所以第一件事是把地板测出来。三条基线，从笨到不那么笨：

      | 基线 | 它假设什么 | 交叉熵 |
      | --- | --- | --- |
      | 均匀 | 每个 token 等概率 | \`ln(V)\` |
      | unigram | 只看频率，不看上下文 | 按频率算 |
      | bigram | 只看**前一个** token | 按转移频率算 |

      **bigram 是最要紧的那一条。** 它是「完全不理解语言、只记住相邻搭配」
      能达到的水平。一个模型如果打不穿 bigram，说明它的注意力**根本没在工作**。
      第 16 关那条门槛的分母就是它。

      ## 交叉熵与困惑度

      交叉熵 \`H = -1/N · Σ log p(实际的那个 token)\`，单位是 nat。
      困惑度 \`PPL = exp(H)\`，直觉是「模型平均在多少个候选里犹豫」。
      均匀分布的困惑度恰好等于词表大小。

      ## 平滑：为什么不能不做

      验证集里一定会出现训练集没见过的搭配。不平滑的话 \`p = 0\`、
      \`log 0 = -inf\`，整个基线就没法用了。
      我们用**加一平滑**：\`p(b|a) = (count(a,b) + 1) / (count(a) + V)\`。
    `,
    code`
      Most gates from here on read "loss below X". But **a loss on its own tells you
      nothing** — it depends on vocabulary size and how regular the corpus is.

      So first, measure the floor. Three baselines, from dumb to less dumb:

      | Baseline | What it assumes | Cross-entropy |
      | --- | --- | --- |
      | Uniform | every token equally likely | \`ln(V)\` |
      | Unigram | frequency only, no context | from frequencies |
      | Bigram | only the **previous** token | from transition counts |

      **Bigram is the one that matters.** It is what "understands nothing, just memorised
      adjacent pairs" achieves. A model that cannot beat bigram has attention that is
      **not working at all**. It is the denominator of the gate in stage 16.

      ## Cross-entropy and perplexity

      \`H = -1/N · Σ log p(actual token)\`, in nats. Perplexity \`PPL = exp(H)\` reads as
      "how many candidates is the model hesitating between". A uniform model's perplexity
      equals the vocabulary size exactly.

      ## Smoothing: why you cannot skip it

      The held-out set will contain pairs the training set never saw. Without smoothing
      \`p = 0\` and \`log 0 = -inf\`, and the baseline is unusable. We use **add-one**:
      \`p(b|a) = (count(a,b) + 1) / (count(a) + V)\`.
    `
  ),
  goal: t(
    code`
      在 \`baseline.py\` 里实现三条基线，都在**留出集**上评估。

      \`\`\`python
      def unigram_cross_entropy(train_ids, eval_ids, vocab_size) -> float
      def bigram_cross_entropy(train_ids, eval_ids, vocab_size) -> float
      \`\`\`

      平台会给你训练集与留出集的切分（\`lab\` 用的和你用的是同一份）。

      ## 怎么算过

      - 三条基线依次严格递减：\`均匀 > unigram > bigram\`；
      - 两个数与平台的参考实现相差 **< 1e-9**（同样的加一平滑、同样的切分）；
      - 报告出来的困惑度等于 \`exp(交叉熵)\`。

      ## 为什么要算得这么准

      因为后面十几关的门槛拿它当分母。差 1% 看不出来，但会让某一关的门槛
      系统性地偏松或偏紧 —— 而那时候你只会觉得「这一关怎么这么难」。
    `,
    code`
      Implement the three baselines in \`baseline.py\`, all evaluated on the **held-out** set.

      \`\`\`python
      def unigram_cross_entropy(train_ids, eval_ids, vocab_size) -> float
      def bigram_cross_entropy(train_ids, eval_ids, vocab_size) -> float
      \`\`\`

      The platform gives you the train/held-out split — the same one \`lab\` uses.

      ## What counts as passing

      - Strictly decreasing: \`uniform > unigram > bigram\`;
      - Both numbers within **1e-9** of the reference (same add-one smoothing, same split);
      - Reported perplexity equals \`exp(cross-entropy)\`.

      ## Why the precision matters

      A dozen later gates use these as their denominator. A 1% error is invisible here but
      makes some later gate systematically loose or tight — and at that point all you feel
      is "this stage is oddly hard".
    `
  ),
  checklist: [
    t('三条基线依次递减', 'The three baselines strictly decrease'),
    t('与参考相差 < 1e-9', 'Within 1e-9 of the reference'),
    t('困惑度 = exp(交叉熵)', 'Perplexity = exp(cross-entropy)'),
  ],
  hints: [
    t('unigram 的分母是全部 token 数加词表大小（加一平滑），别忘了分母也要加。',
      'The unigram denominator is total tokens plus vocab size — the denominator gets smoothed too.'),
    t('bigram 要按**每个前缀**分别归一化，不是全局归一化。',
      'Bigram normalises per preceding token, not globally.'),
  ],
  pitfalls: [
    t(code`
      **在全量语料上统计基线。** 这样 bigram 会偷看到留出集，基线被压低，
      于是「模型打穿了 bigram」这件事被系统性地变难 —— 而难的原因和模型无关。
      只用训练集统计。
    `, code`
      **Counting the baseline over the whole corpus.** Bigram then peeks at the held-out
      set, the baseline drops, and "the model beat bigram" becomes systematically harder —
      for reasons that have nothing to do with the model. Count on the training split only.
    `),
    t(code`
      **忘了给分母加平滑项。** 只给分子加一，概率加起来就不是 1 了。
      这个错会让 loss 偏低一点点，刚好小到看不出来。
    `, code`
      **Smoothing the numerator only.** The probabilities then do not sum to 1. The error
      makes the loss slightly too low — just small enough to go unnoticed.
    `),
  ],
  train: {
    files: {
      'baseline.py': code`
        """第 2 关：语言建模的地板。

        三条基线都在**留出集**上评估，但只用**训练集**统计。
        """
        import math


        def load_split():
            """平台给的切分：(训练集, 留出集, 词表大小)。"""
            import json
            with open("/lab/data/split.json") as f:
                d = json.load(f)
            return d["train"], d["eval"], d["vocab_size"]


        def uniform_cross_entropy(vocab_size):
            """每个 token 等概率时的交叉熵。"""
            # TODO
            return 0.0


        def unigram_cross_entropy(train_ids, eval_ids, vocab_size):
            """只看频率、不看上下文。加一平滑。"""
            # TODO
            return 0.0


        def bigram_cross_entropy(train_ids, eval_ids, vocab_size):
            """只看前一个 token。加一平滑，**按每个前缀分别归一化**。"""
            # TODO
            return 0.0


        if __name__ == "__main__":
            train, ev, V = load_split()
            u = uniform_cross_entropy(V)
            g = unigram_cross_entropy(train, ev, V)
            b = bigram_cross_entropy(train, ev, V)
            print("均匀   %.4f  困惑度 %.2f" % (u, math.exp(u)))
            print("unigram %.4f  困惑度 %.2f" % (g, math.exp(g)))
            print("bigram  %.4f  困惑度 %.2f" % (b, math.exp(b)))
            RESULT = {"uniform": u, "unigram": g, "bigram": b}
      `,
    },
    referenceFiles: {
      'baseline.py': code`
        """第 2 关的参考实现。"""
        import math


        def load_split():
            import json
            with open("/lab/data/split.json") as f:
                d = json.load(f)
            return d["train"], d["eval"], d["vocab_size"]


        def uniform_cross_entropy(vocab_size):
            return math.log(vocab_size)


        def unigram_cross_entropy(train_ids, eval_ids, vocab_size):
            counts = [0] * vocab_size
            for x in train_ids:
                counts[x] += 1
            total = len(train_ids)
            # 加一平滑：分子分母都要加，否则概率加起来不是 1
            denom = total + vocab_size
            total_loss = 0.0
            for x in eval_ids:
                total_loss -= math.log((counts[x] + 1) / denom)
            return total_loss / len(eval_ids)


        def bigram_cross_engine_placeholder():
            pass


        def bigram_cross_entropy(train_ids, eval_ids, vocab_size):
            trans = {}
            row = [0] * vocab_size
            for i in range(len(train_ids) - 1):
                a, b = train_ids[i], train_ids[i + 1]
                trans[(a, b)] = trans.get((a, b), 0) + 1
                row[a] += 1
            total_loss = 0.0
            n = 0
            for i in range(len(eval_ids) - 1):
                a, b = eval_ids[i], eval_ids[i + 1]
                # **按前缀归一化**：分母是 count(a) + V，不是全局总数
                p = (trans.get((a, b), 0) + 1) / (row[a] + vocab_size)
                total_loss -= math.log(p)
                n += 1
            return total_loss / n


        if __name__ == "__main__":
            train, ev, V = load_split()
            u = uniform_cross_entropy(V)
            g = unigram_cross_entropy(train, ev, V)
            b = bigram_cross_entropy(train, ev, V)
            print("均匀   %.4f  困惑度 %.2f" % (u, math.exp(u)))
            print("unigram %.4f  困惑度 %.2f" % (g, math.exp(g)))
            print("bigram  %.4f  困惑度 %.2f" % (b, math.exp(b)))
            RESULT = {"uniform": u, "unigram": g, "bigram": b}
      `,
    },
  },
  specs: [
    spec('baseline.spec.ts', code`
      ${LAB}

      /** 平台侧的参考实现。加一平滑与切分都与题面完全一致 */
      function reference() {
        const tokens = lab.world.tokens();
        const at = lab.world.holdoutAt();
        const V = lab.world.vocabSize();
        const train = tokens.subarray(0, at);
        const evalIds = tokens.subarray(at);

        const uni = new Float64Array(V);
        for (const x of train) uni[x] += 1;
        let unigram = 0;
        for (const x of evalIds) unigram -= Math.log((uni[x] + 1) / (train.length + V));
        unigram /= evalIds.length;

        const trans = new Map();
        const row = new Float64Array(V);
        for (let i = 0; i < train.length - 1; i++) {
          const key = train[i] * V + train[i + 1];
          trans.set(key, (trans.get(key) || 0) + 1);
          row[train[i]] += 1;
        }
        let bigram = 0;
        let n = 0;
        for (let i = 0; i < evalIds.length - 1; i++) {
          const a = evalIds[i], b = evalIds[i + 1];
          const c = trans.get(a * V + b) || 0;
          bigram -= Math.log((c + 1) / (row[a] + V));
          n += 1;
        }
        bigram /= n;

        return { uniform: Math.log(V), unigram, bigram };
      }

      function studentResult() {
        lab.run('baseline.py');
        return lab.value('RESULT');
      }

      describe('三条基线', () => {
        it('依次严格递减', () => {
          const r = studentResult();
          console.log(
            '均匀 ' + r.uniform.toFixed(4) +
            ' > unigram ' + r.unigram.toFixed(4) +
            ' > bigram ' + r.bigram.toFixed(4)
          );
          expect(r.unigram).toBeLessThan(r.uniform);
          expect(r.bigram).toBeLessThan(r.unigram);
        });

        it('与参考相差 < 1e-9', () => {
          const r = studentResult();
          const ref = reference();
          const worst = Math.max(
            Math.abs(r.uniform - ref.uniform),
            Math.abs(r.unigram - ref.unigram),
            Math.abs(r.bigram - ref.bigram)
          );
          lab.publish('baseline.maxError', worst);
          lab.publish('baseline.uniform', r.uniform);
          lab.publish('baseline.unigram', r.unigram);
          lab.publish('baseline.bigram', r.bigram);
          expect(worst).toBeLessThan(1e-9);
        });

        /*
         * 反向验证：在全量语料上统计的 bigram 会明显更低。
         * 这条用例确认「只用训练集」这个要求不是空话 —— 两个数确实不一样。
         */
        it('只用训练集统计 —— 偷看留出集会得到明显更低的数', () => {
          const tokens = lab.world.tokens();
          const V = lab.world.vocabSize();
          const at = lab.world.holdoutAt();
          const cheat = (() => {
            const trans = new Map();
            const row = new Float64Array(V);
            for (let i = 0; i < tokens.length - 1; i++) {
              const key = tokens[i] * V + tokens[i + 1];
              trans.set(key, (trans.get(key) || 0) + 1);
              row[tokens[i]] += 1;
            }
            let s = 0, n = 0;
            for (let i = at; i < tokens.length - 1; i++) {
              const a = tokens[i], b = tokens[i + 1];
              s -= Math.log(((trans.get(a * V + b) || 0) + 1) / (row[a] + V));
              n += 1;
            }
            return s / n;
          })();
          const honest = reference().bigram;
          console.log('诚实 ' + honest.toFixed(4) + ' / 偷看 ' + cheat.toFixed(4));
          expect(cheat).toBeLessThan(honest);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.baseline.maxError', op: 'lte', value: 1e-9,
      zh: '与参考的最大误差', en: 'max error vs reference', dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      困惑度是这个领域最老的指标之一（Jelinek 1977），到今天仍然是预训练阶段
      唯一还在用的核心数字 —— 因为它不需要标注、不需要人工评价、
      而且和下游能力的相关性一直很好。

      现代论文里报的 loss 都是 nat（自然对数），少数报 bits-per-byte（BPB）——
      后者除以字节数而不是 token 数，这样不同分词器之间才能比。
    `,
    code`
      Perplexity is one of the oldest metrics in the field (Jelinek 1977) and still the one
      number that matters during pretraining — it needs no labels, no human judgement, and
      correlates well with downstream ability.

      Modern papers report loss in nats; a few report bits-per-byte, dividing by bytes
      rather than tokens so that different tokenizers can be compared.
    `
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'llm-from-scratch',
  title: t('从零实现一个 LLM', 'Build an LLM from scratch'),
  summary: t(
    '写 Python，对着一个 PyTorch 子集把 transformer 实现出来，在浏览器里真的把它训出来，然后做完 SFT 与偏好优化。',
    'Write Python against a PyTorch subset, implement a transformer, actually train it in the browser, then take it through SFT and preference optimisation.'
  ),
  difficulty: 'Hard',
  domain: 'machine-learning',
  tags: [
    'llm', 'transformer', 'attention', 'tokenizer', 'bpe',
    'backpropagation', 'autograd', 'adamw', 'pretraining',
    'sft', 'dpo', 'grpo', 'rlhf', 'python',
  ],
  estimatedMinutes: 2700,
  language: 'typescript',
  weights: { correctness: 3, latency: 1, resilience: 1.5, encapsulation: 1.5, elegance: 1.5 },
  brief: t(
    code`
      ## 背景

      「大语言模型」听起来像个不可拆的黑盒。它不是。切开之后是三叠东西，
      每一叠回答一组很具体的问题：

      | 层 | 关卡 | 回答的问题 |
      | --- | --- | --- |
      | 基础 | 1–8 | 文本怎么变成数、注意力到底在算什么、一次前向发生了什么 |
      | 训练 | 9–21 | 梯度从哪来、怎么让它别炸、怎么用有限的算力换更低的 loss |
      | 后训练 | 22–30 | 怎么让它听话、怎么让它答得对、怎么知道它真的变好了 |

      做完之后你手上是一个**你自己实现、自己训出来**的模型：它会补全文本、
      会跟随指令、在可验证的任务上答得对，而且你知道每一行代码为什么在那儿。

      ## 平台提供什么

      \`nanotorch\` —— PyTorch 的一个严格子集，跑在 WebAssembly 上。
      你写的代码贴进 PyTorch 就能跑：模块的组织方式、算子的名字、优化器的参数、
      训练循环的形状，全是一样的。

      \`\`\`python
      import nanotorch as nt
      from nanotorch import nn, optim

      class Block(nn.Module):
          def forward(self, x, cos, sin, b, s):
              x = x + self.attn(self.norm1(x), cos, sin, b, s)
              return x + self.mlp(self.norm2(x))
      \`\`\`

      底下是我们自己写的 WASM 算子核（37KB，f32 带 SIMD）。
      **训练是真的** —— loss 真的降，梯度真的对，权重真的更新。

      ## 门槛怎么定的

      三条规矩，写在每一关的题面里：

      1. **只建立在结构性计量上。** 每 token 的 FLOPs、峰值激活字节、
         梯度检验的相对误差、KL 散度 —— 这些数由平台在算子层数出来，你绕不过。
         **墙钟时间永远不作门槛**：你的机器慢不该让你挂。
      2. **每条效果门槛都配一条结构性门槛。** 「loss 降到 1.45 以下」可以被
         一个碰巧能学的错实现蒙过去，「梯度检验 ≤ 2e-3」不能。
      3. **门槛的两个数都告诉你。** 不是一个凭空的阈值，而是
         「bigram 基线 1.90，参考解 1.23，门槛 1.50」。

      ## 硬性约束

      1. 种子、语料、超参、步数由平台固定，你改不了 —— 否则「loss 低于 X」
         只要把步数调到十倍就过了；
      2. 纯 Python 的循环比编译语言慢两个数量级，**代码必须向量化** ——
         现实里也是这条规矩；
      3. 某些关卡禁用某些内建算子（比如第 3 关不许用融合的注意力），
         平台数得到，恒为 0 才算过。

      ## 非目标

      - 不做 kernel 优化、不测吞吐：那是姊妹项目 \`llm-accelerator\` 的全部内容
        （那边是「让它跑得快」，这边是「让它学会」）；
      - 不做分布式训练：同上，那边有 8 关；
      - 不做多模态、不做 agent：与「实现并训练一个语言模型」这条主线无关。

      ## 术语

      - **token**：模型看到的最小单位，一个整数。
      - **注意力**：让每个位置去看它之前的位置，按相关度加权求和。
      - **因果掩码**：不许看未来。漏了它 loss 会更低，而模型一文不值。
      - **交叉熵**：预测分布和真实 token 的距离，训练时最小化的那个数。
      - **困惑度**：exp(交叉熵)，直觉是「平均在多少个候选里犹豫」。
      - **SFT**：监督微调，用指令-回答对教它听话。
      - **DPO / GRPO**：两种偏好优化，前者用成对偏好，后者用组内相对优势。
    `,
    code`
      ## Context

      "A large language model" sounds like an indivisible black box. It is not. Cut it open
      and you find three stacks, each answering a concrete set of questions:

      | Layer | Stages | Questions it answers |
      | --- | --- | --- |
      | Foundations | 1–8 | How text becomes numbers, what attention computes, what one forward pass does |
      | Training | 9–21 | Where gradients come from, how to keep them from exploding, how to trade compute for loss |
      | Post-training | 22–30 | How to make it follow instructions, answer correctly, and how to know it improved |

      At the end you hold a model **you implemented and trained yourself**: it completes
      text, follows instructions, answers verifiable tasks — and you know why every line is
      there.

      ## What the platform gives you

      \`nanotorch\` — a strict subset of PyTorch running on WebAssembly. What you write
      pastes into PyTorch and runs: module structure, operator names, optimiser arguments,
      the shape of the training loop are all the same.

      \`\`\`python
      import nanotorch as nt
      from nanotorch import nn, optim

      class Block(nn.Module):
          def forward(self, x, cos, sin, b, s):
              x = x + self.attn(self.norm1(x), cos, sin, b, s)
              return x + self.mlp(self.norm2(x))
      \`\`\`

      Underneath is our own WASM kernel (37KB, f32 with SIMD). **The training is real** —
      the loss really drops, the gradients are really correct, the weights really update.

      ## How the gates work

      Three rules, restated in every stage:

      1. **Structural measurements only.** FLOPs per token, peak activation bytes, gradient
         check error, KL divergence — counted by the platform at the operator layer, and
         you cannot route around them. **Wall-clock is never a gate**: a slow machine must
         not fail you.
      2. **Every outcome gate is paired with a structural one.** "Loss below 1.45" can be
         fooled by a wrong implementation that happens to learn; "gradient check ≤ 2e-3"
         cannot.
      3. **You are told both numbers.** Not an arbitrary threshold, but "bigram baseline
         1.90, reference solution 1.23, gate 1.50".

      ## Hard constraints

      1. Seed, corpus, hyperparameters and step count are fixed by the platform — otherwise
         "loss below X" is passed by multiplying the step count by ten;
      2. Pure Python loops are two orders of magnitude slower than compiled code, so
         **your code must be vectorised** — the same rule applies in reality;
      3. Some stages forbid some built-in operators (stage 3 forbids fused attention). The
         platform counts them; the count must be zero.

      ## Non-goals

      - No kernel optimisation or throughput measurement: that is the sibling project
        \`llm-accelerator\` ("make it fast" there, "make it learn" here);
      - No distributed training: same, eight stages of it live there;
      - No multimodality, no agents: off the line of "implement and train a language model".

      ## Glossary

      - **token**: the smallest unit the model sees — an integer.
      - **attention**: every position looks at earlier positions and takes a weighted sum.
      - **causal mask**: no peeking at the future. Omit it and the loss drops while the
        model becomes worthless.
      - **cross-entropy**: distance between the predicted distribution and the real token.
      - **perplexity**: exp(cross-entropy) — "how many candidates is it hesitating between".
      - **SFT**: supervised fine-tuning on instruction/response pairs.
      - **DPO / GRPO**: two preference-optimisation methods — pairwise, and group-relative.
    `
  ),
  architecture: t(
    code`
      \`\`\`mermaid
      flowchart TD
        TXT[文本] --> BPE[1 字节级 BPE]
        BPE --> IDS[token id]
        IDS --> BASE[2 三条基线]
        IDS --> EMB[3-4 嵌入与注意力]
        EMB --> ROPE[5 RoPE]
        ROPE --> NORM[6 RMSNorm 与 pre-norm]
        NORM --> MLP[7 SwiGLU 与完整 block]
        MLP --> GEN[8 采样与 KV cache]
        GEN --> BWD[9-11 反向与自动微分]
        BWD --> OPT[12-14 AdamW 调度与裁剪]
        OPT --> DATA[15 数据打包]
        DATA --> LOOP[16 完整预训练循环]
        LOOP --> PREC[17-18 混合精度与激活重算]
        PREC --> SCALE[19-21 缩放定律 / MoE / Muon]
        SCALE --> SFT[22-23 SFT 与数据配比]
        SFT --> RM[24 奖励模型]
        RM --> DPO[25-26 DPO 与长度偏置]
        DPO --> RL[27-29 rollout 与 GRPO]
        RL --> FIN[30 端到端]
        BASE -. 门槛的分母 .-> LOOP
      \`\`\`
    `,
    code`
      \`\`\`mermaid
      flowchart TD
        TXT[text] --> BPE[1 byte-level BPE]
        BPE --> IDS[token ids]
        IDS --> BASE[2 three baselines]
        IDS --> EMB[3-4 embedding and attention]
        EMB --> ROPE[5 RoPE]
        ROPE --> NORM[6 RMSNorm and pre-norm]
        NORM --> MLP[7 SwiGLU and the full block]
        MLP --> GEN[8 sampling and KV cache]
        GEN --> BWD[9-11 backward and autograd]
        BWD --> OPT[12-14 AdamW, schedule, clipping]
        OPT --> DATA[15 data packing]
        DATA --> LOOP[16 the full pretraining loop]
        LOOP --> PREC[17-18 mixed precision and recomputation]
        PREC --> SCALE[19-21 scaling laws / MoE / Muon]
        SCALE --> SFT[22-23 SFT and data mixture]
        SFT --> RM[24 reward model]
        RM --> DPO[25-26 DPO and length bias]
        DPO --> RL[27-29 rollouts and GRPO]
        RL --> FIN[30 end to end]
        BASE -. denominator of the gate .-> LOOP
      \`\`\`
    `
  ),
  workspace: { kind: 'train', world: WORLD },
  stages: [STAGE_BPE, STAGE_BASELINE],
};
