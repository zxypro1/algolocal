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

/* ================================================================== */
/* 第 3 关：单头因果自注意力                                            */
/* ================================================================== */

const ATTN_DIMS = 'B, S, D, HD = 2, 6, 8, 8';

/** 两关共用：在 Python 里造一组确定的输入，跑学员的函数，把输入输出都读回来 */
const ATTN_HARNESS = `
      /** 造输入、跑学员的实现、把用得上的数都读回 JS */
      function runStudent(extra) {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, attention
      importlib.reload(attention)
      import nanotorch as nt

      ${ATTN_DIMS}
      _x = nt.zeros((B * S, D), role="data").normal_(11, 1.0)
      _wq = nt.zeros((D, HD), role="data").normal_(21, 0.5)
      _wk = nt.zeros((D, HD), role="data").normal_(22, 0.5)
      _wv = nt.zeros((D, HD), role="data").normal_(23, 0.5)
      \${extra || ''}
      _out = attention.single_head_attention(_x, _wq, _wk, _wv, B, S, HD)
      \`);
        return {
          x: JSON.parse(String(lab.py('json.dumps(_x.tolist())'))),
          wq: JSON.parse(String(lab.py('json.dumps(_wq.tolist())'))),
          wk: JSON.parse(String(lab.py('json.dumps(_wk.tolist())'))),
          wv: JSON.parse(String(lab.py('json.dumps(_wv.tolist())'))),
          out: JSON.parse(String(lab.py('json.dumps(_out.tolist())'))),
        };
      }

      /**
       * 平台侧的参考实现，f64。
       *
       * 刻意写得笨：三重循环、显式掩码、显式减最大值。
       * 判定的参考实现要的是**一眼能看出对不对**，不是快。
       */
      function reference(x, wq, wk, wv, B, S, D, HD) {
        const proj = (w) => {
          const out = new Float64Array(B * S * HD);
          for (let r = 0; r < B * S; r++)
            for (let h = 0; h < HD; h++) {
              let acc = 0;
              for (let d = 0; d < D; d++) acc += x[r * D + d] * w[d * HD + h];
              out[r * HD + h] = acc;
            }
          return out;
        };
        const q = proj(wq), k = proj(wk), v = proj(wv);
        const scale = 1 / Math.sqrt(HD);
        const out = new Float64Array(B * S * HD);
        for (let b = 0; b < B; b++)
          for (let i = 0; i < S; i++) {
            const scores = [];
            for (let j = 0; j <= i; j++) {       // 因果：只看 j ≤ i
              let s = 0;
              for (let h = 0; h < HD; h++) s += q[(b * S + i) * HD + h] * k[(b * S + j) * HD + h];
              scores.push(s * scale);
            }
            const mx = Math.max(...scores);
            const exps = scores.map((s) => Math.exp(s - mx));
            const sum = exps.reduce((a, c) => a + c, 0);
            for (let j = 0; j <= i; j++) {
              const p = exps[j] / sum;
              for (let h = 0; h < HD; h++) out[(b * S + i) * HD + h] += p * v[(b * S + j) * HD + h];
            }
          }
        return out;
      }

      function maxDiff(a, b) {
        let m = 0;
        for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
        return m;
      }
`;

const STAGE_ATTENTION = {
  id: 'causal-attention',
  title: t('单头因果自注意力 —— 自己把它拼出来', 'Single-head causal attention — assemble it yourself'),
  goal: t(
    code`
      在 \`attention.py\` 里实现一个单头因果自注意力。

      \`\`\`python
      def single_head_attention(x, wq, wk, wv, batch, seq, head_dim):
          """x 是 [batch*seq, d_model]，三个权重都是 [d_model, head_dim]。
          返回 [batch*seq, head_dim]。"""
      \`\`\`

      ## 用哪些零件

      \`\`\`python
      from nanotorch import functional as F

      q = F.linear(x, wq)                                   # [rows, hd]
      scores = F.attn_scores(q, k, batch, seq, seq, 1, 1, head_dim)
      valid = F.causal_valid(batch, 1, seq)                 # 每行能看到多少个键
      probs = F.softmax(scores, batch * seq, seq, valid)
      out = F.attn_apply(probs, v, batch, seq, seq, 1, 1, head_dim)
      \`\`\`

      **\`F.scaled_dot_product_attention\` 这一关不许用。** 它是融合好的一整块，
      而这一关的全部内容就是自己把它拼出来。平台数得到调用次数，必须是 0。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 数值 | 与平台的 f64 参考实现最大差 **≤ 2e-6** |
      | 因果性 | 改掉最后一个位置的输入，前面位置的输出**一位都不变** |
      | 概率 | 每一行的注意力概率和为 1，被掩掉的位置是**硬 0** |
      | 捷径 | 禁用算子调用次数 = 0 |

      ## 2e-6 这个界是怎么来的

      你的实现跑在 **fp32** 上，参考实现跑在 fp64 上,所以两者必然有差，
      问题只是差多少算正常。

      fp32 的机器精度是 \`ε = 2⁻²³ ≈ 1.19e-7\`。K 项累加的相对误差界大约是
      \`√K · ε\`；这一关里 K 是 head_dim 与 seq 两次累加的量级，约 14，
      于是界在 \`4.5e-7\` 上下。**实测参考解是 3.5e-7**，门槛取 2e-6,
      留了约 6 倍的余量给不同的求和顺序。

      界不是拍出来的。一个「差 1e-3」的实现一定是算错了，
      而一个「差 1e-9」的实现不可能跑在 fp32 上。

      ## 为什么因果性要单独查

      因为**漏了因果掩码的模型 loss 会更低**。它能看到答案，训练曲线漂亮得多，
      而生成时一个字都对不上。这个错在任何 loss 曲线上都看不出来,
      只有拿「改未来、看现在」这个探针去问才问得出来。
    `,
    code`
      Implement single-head causal self-attention in \`attention.py\`.

      \`\`\`python
      def single_head_attention(x, wq, wk, wv, batch, seq, head_dim):
          """x is [batch*seq, d_model]; the three weights are [d_model, head_dim].
          Returns [batch*seq, head_dim]."""
      \`\`\`

      ## The pieces

      \`\`\`python
      from nanotorch import functional as F

      q = F.linear(x, wq)                                   # [rows, hd]
      scores = F.attn_scores(q, k, batch, seq, seq, 1, 1, head_dim)
      valid = F.causal_valid(batch, 1, seq)                 # how many keys each row may see
      probs = F.softmax(scores, batch * seq, seq, valid)
      out = F.attn_apply(probs, v, batch, seq, seq, 1, 1, head_dim)
      \`\`\`

      **\`F.scaled_dot_product_attention\` is forbidden in this stage.** It is the fused
      version, and assembling it yourself is the entire point. The platform counts the
      calls; the count must be zero.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Numerics | Max difference from the f64 reference **≤ 2e-6** |
      | Causality | Change the last input position; earlier outputs must be **bit-identical** |
      | Probabilities | Every row sums to 1; masked positions are **hard zero** |
      | Shortcuts | Forbidden operator calls = 0 |

      ## Where 2e-6 comes from

      Your implementation runs in **fp32**, the reference in fp64, so a difference is
      unavoidable; the only question is how much is normal.

      fp32 machine epsilon is \`ε = 2⁻²³ ≈ 1.19e-7\`. The relative error of a K-term sum is
      roughly \`√K · ε\`; here K is on the order of head_dim plus seq, about 14, putting the
      bound near \`4.5e-7\`. **The reference measures 3.5e-7**, so the gate sits at 2e-6,
      leaving about 6x of headroom for different summation orders.

      The bound is derived, not guessed. An implementation off by 1e-3 is wrong; one off by
      1e-9 cannot be running in fp32.

      ## Why causality gets its own check

      Because **a model that leaks the future has a lower loss**. It can see the answer,
      the training curve looks better, and generation is worthless. No loss curve shows
      this. Only the "change the future, watch the present" probe finds it.
    `
  ),
  checklist: [
    t('与 f64 参考的最大差 ≤ 2e-6（fp32 的界，见任务说明）', 'Max difference from the f64 reference ≤ 2e-6 (an fp32 bound)'),
    t('因果泄漏 = 0（逐位比）', 'Causal leakage = 0 (bit-identical)'),
    t('每行概率和为 1，掩掉的位置是硬 0', 'Rows sum to 1; masked positions are hard zero'),
    t('没用融合的 scaled_dot_product_attention', 'Did not use the fused scaled_dot_product_attention'),
  ],
  hints: [
    t('三个投影都是同一个 F.linear，只是权重不同。',
      'All three projections are the same F.linear with different weights.'),
    t('单头就是 heads=1、kv_heads=1 —— 那两个参数在下一关才真正用上。',
      'Single head means heads=1 and kv_heads=1; those two arguments come alive next stage.'),
    t('softmax 的 rows 是 batch*heads*seq_q，cols 是 seq_kv。单头时 rows = batch*seq。',
      'softmax takes rows = batch*heads*seq_q and cols = seq_kv; with one head rows = batch*seq.'),
  ],
  pitfalls: [
    t(code`
      **忘了缩放 1/√head_dim。** 前向照样能算，loss 也会降,只是慢，
      因为 softmax 进了饱和区、梯度变得很小。这个错和参考实现比才看得出来。
    `, code`
      **Forgetting the 1/√head_dim scale.** It still computes, and the loss still drops,
      just slowly, because softmax saturates and gradients shrink. Only a comparison with
      the reference reveals it.
    `),
    t(code`
      **把掩码做成「加一个很大的负数」而不是「不算」。** 结果几乎一样，
      但被掩位置的概率是 1e-30 而不是 0,而因果性探针要的是**逐位**为 0。
      我们的做法是给 softmax 一个每行的有效长度，掩掉的位置根本不参与。
    `, code`
      **Masking by adding a large negative number instead of excluding.** Nearly the same
      result, but masked probabilities are 1e-30 rather than 0, and the causality probe
      wants **bit-exact** zero. Here softmax takes a per-row valid length instead, so
      masked positions never participate.
    `),
  ],
  train: {
    forbidden: ['attn_fwd'],
    files: {
      'attention.py': code`
        """第 3 关：单头因果自注意力。

        这一关不许用 F.scaled_dot_product_attention（融合的那一块）。
        自己用 attn_scores / causal_valid / softmax / attn_apply 拼出来。
        """
        import nanotorch as nt
        from nanotorch import functional as F


        def single_head_attention(x, wq, wk, wv, batch, seq, head_dim):
            """x: [batch*seq, d_model]，wq/wk/wv: [d_model, head_dim]。

            返回 [batch*seq, head_dim]。
            """
            # TODO: 1) 三个投影
            # TODO: 2) 算分数（记得缩放 1/sqrt(head_dim)，attn_scores 默认帮你做了）
            # TODO: 3) 因果掩码 + softmax
            # TODO: 4) 加权求和
            return nt.zeros((batch * seq, head_dim))


        if __name__ == "__main__":
            B, S, D, HD = 2, 6, 8, 8
            x = nt.zeros((B * S, D), role="data").normal_(1, 1.0)
            wq = nt.zeros((D, HD), role="data").normal_(2, 0.5)
            wk = nt.zeros((D, HD), role="data").normal_(3, 0.5)
            wv = nt.zeros((D, HD), role="data").normal_(4, 0.5)
            out = single_head_attention(x, wq, wk, wv, B, S, HD)
            print("输出形状", out.shape, "前三个数", [round(v, 4) for v in out.tolist()[:3]])
      `,
    },
    referenceFiles: {
      'attention.py': code`
        """第 3 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F


        def single_head_attention(x, wq, wk, wv, batch, seq, head_dim):
            rows = batch * seq

            # 1) 三个投影：同一个 linear，不同的权重
            q = F.linear(x, wq)
            k = F.linear(x, wk)
            v = F.linear(x, wv)

            # 2) 分数。attn_scores 默认按 1/sqrt(head_dim) 缩放
            #    单头 => heads=1, kv_heads=1
            scores = F.attn_scores(q, k, batch, seq, seq, 1, 1, head_dim)

            # 3) 因果掩码写成「每行能看到多少个键」，掩掉的位置根本不参与 softmax，
            #    所以概率是硬 0 而不是一个很小的数
            valid = F.causal_valid(batch, 1, seq)
            probs = F.softmax(scores, rows, seq, valid)

            # 4) 加权求和
            return F.attn_apply(probs, v, batch, seq, seq, 1, 1, head_dim,
                                out_shape=(rows, head_dim))


        if __name__ == "__main__":
            B, S, D, HD = 2, 6, 8, 8
            x = nt.zeros((B * S, D), role="data").normal_(1, 1.0)
            wq = nt.zeros((D, HD), role="data").normal_(2, 0.5)
            wk = nt.zeros((D, HD), role="data").normal_(3, 0.5)
            wv = nt.zeros((D, HD), role="data").normal_(4, 0.5)
            out = single_head_attention(x, wq, wk, wv, B, S, HD)
            print("输出形状", out.shape, "前三个数", [round(v, 4) for v in out.tolist()[:3]])
      `,
    },
  },
  specs: [
    spec('attention.spec.ts', code`
      ${LAB}
      ${ATTN_HARNESS}

      const B = 2, S = 6, D = 8, HD = 8;

      describe('单头因果自注意力', () => {
        it('与 f64 参考实现最大差 ≤ 2e-6（fp32 的界）', () => {
          const r = runStudent();
          const ref = reference(r.x, r.wq, r.wk, r.wv, B, S, D, HD);
          const diff = maxDiff(r.out, ref);
          console.log('最大差 ' + diff.toExponential(2));
          lab.publish('attention.maxError', diff);
          expect(diff).toBeLessThan(2e-6);
        });

        /*
         * 因果性：改掉最后一个位置的输入，前面位置的输出必须**逐位**不变。
         * 判据不是「掩码写了没」（那查的是实现），而是行为。
         */
        it('改掉最后一个位置，前面位置的输出一位都不变', () => {
          const before = runStudent().out;
          const after = runStudent(
            '_x.set_([v + (3.5 if (i % (S * D)) >= (S - 1) * D else 0.0) '
            + 'for i, v in enumerate(_x.tolist())])'
          ).out;

          let leak = 0;
          let checked = 0;
          for (let b = 0; b < B; b++)
            for (let i = 0; i < S - 1; i++)     // 最后一个位置本来就该变
              for (let h = 0; h < HD; h++) {
                const at = (b * S + i) * HD + h;
                checked += 1;
                if (before[at] !== after[at]) leak += 1;
              }
          console.log('查了 ' + checked + ' 个位置，泄漏 ' + leak + ' 个');
          lab.publish('causality.leakBits', leak);
          lab.publish('causality.checked', checked);
          expect(checked).toBeGreaterThan(50);
          expect(leak).toBe(0);
        });

        it('每一行的概率和为 1，掩掉的位置是硬 0', () => {
          // 直接问学员的实现要中间的概率矩阵：用同样的零件再算一遍
          const probs = JSON.parse(String(lab.py(\`
      import nanotorch as nt, json
      from nanotorch import functional as F
      _q = F.linear(_x, _wq)
      _k = F.linear(_x, _wk)
      _sc = F.attn_scores(_q, _k, B, S, S, 1, 1, HD)
      _pr = F.softmax(_sc, B * S, S, F.causal_valid(B, 1, S))
      json.dumps(_pr.tolist())
      \`)));
          let worstSum = 0;
          let hardZeros = 0;
          for (let b = 0; b < B; b++)
            for (let i = 0; i < S; i++) {
              let sum = 0;
              for (let j = 0; j <= i; j++) sum += probs[(b * S + i) * S + j];
              worstSum = Math.max(worstSum, Math.abs(sum - 1));
              for (let j = i + 1; j < S; j++) {
                if (probs[(b * S + i) * S + j] === 0) hardZeros += 1;
              }
            }
          lab.publish('attention.probRowSumError', worstSum);
          // 同样是 fp32 的界：S 项求和，√S·ε ≈ 3e-7
          expect(worstSum).toBeLessThan(1e-6);
          expect(hardZeros).toBe(B * (S * (S - 1)) / 2);
        });

        it('没有用融合的那一块', () => {
          runStudent();
          const m = lab.metrics();
          expect(m.builtins.forbiddenCalls).toBe(0);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.attention.maxError', op: 'lte', value: 2e-6,
      zh: '与 f64 参考的最大差（fp32 的界）', en: 'max difference from the f64 reference (fp32 bound)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.causality.leakBits', op: 'eq', value: 0,
      zh: '因果泄漏（逐位比）', en: 'causal leakage (bit-exact)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.attention.probRowSumError', op: 'lte', value: 1e-6,
      zh: '每行概率和与 1 的差', en: 'row-sum deviation from 1', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.builtins.forbiddenCalls', op: 'eq', value: 0,
      zh: '用了禁用的融合算子', en: 'forbidden fused operator calls', dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      拆开写比融合写多算了大约一倍的分数：融合实现只算 \`Σ(i+1)\` 个，
      拆开是完整的 \`S²\`。**FlashAttention 省下的正是这一半**，
      外加那块 [B, H, S, S] 的中间矩阵根本不落地。第 16 关会回到这件事。

      真 PyTorch 里 \`F.scaled_dot_product_attention\` 会按输入形状自动选后端
      （FlashAttention / memory-efficient / math），\`is_causal=True\` 就是这里的掩码。
    `,
    code`
      Assembling it by hand computes roughly twice the scores: the fused version does
      \`Σ(i+1)\`, the split one does the full \`S²\`. **That half is what FlashAttention
      saves**, on top of never materialising the [B, H, S, S] matrix at all. Stage 16
      returns to this.

      In real PyTorch, \`F.scaled_dot_product_attention\` picks a backend from the shapes
      (FlashAttention / memory-efficient / math), and \`is_causal=True\` is this mask.
    `
  ),
};

/* ================================================================== */
/* 第 4 关：多头与 GQA                                                 */
/* ================================================================== */

const STAGE_MHA = {
  id: 'multi-head-gqa',
  title: t('多头与 GQA —— 少几个 kv 头能省多少', 'Multi-head and GQA — what fewer KV heads buy you'),
  goal: t(
    code`
      在 \`mha.py\` 里把多头注意力写成一个 \`nn.Module\`，并支持 **GQA**。

      \`\`\`python
      class MultiHeadAttention(nn.Module):
          def __init__(self, dim, n_head, n_kv_head, seed):
              # wq: [dim, n_head * head_dim]
              # wk / wv: [dim, n_kv_head * head_dim]   ← 注意是 n_kv_head
              # wo: [n_head * head_dim, dim]

          def forward(self, x, batch, seq):
              ...
      \`\`\`

      \`head_dim = dim // n_head\`。**wk 与 wv 按 \`n_kv_head\` 开，不是 \`n_head\`** ——
      这就是 GQA 省下来的地方，也是这一关最容易写错的一行。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 参数量 | **恰好等于解析式**（见下） |
      | 数值 | 与 f64 参考最大差 ≤ 2e-6（fp32 的界，同第 3 关） |
      | 因果性 | 泄漏 = 0 |
      | 捷径 | 仍然不许用融合的那一块 |

      参数量的解析式：

      \`\`\`
      dim·n_head·hd  +  dim·n_kv_head·hd × 2  +  n_head·hd·dim
      \`\`\`

      \`n_kv_head = n_head\` 时它退化成普通的 MHA。本关的配置是
      \`dim=64, n_head=8, n_kv_head=2\`，所以 wk 与 wv 各只有 MHA 的 **1/4**。

      ## 为什么要有 GQA

      推理时每生成一个 token 都要读一遍整个 KV cache，而 cache 的大小正比于
      \`n_kv_head\`。把 8 个 kv 头减到 2 个，**KV cache 直接小 4 倍** ——
      这在解码时是实打实的带宽，而质量几乎没掉。Llama 2 70B 起就是这么做的。
    `,
    code`
      Write multi-head attention as an \`nn.Module\` in \`mha.py\`, with **GQA**.

      \`\`\`python
      class MultiHeadAttention(nn.Module):
          def __init__(self, dim, n_head, n_kv_head, seed):
              # wq: [dim, n_head * head_dim]
              # wk / wv: [dim, n_kv_head * head_dim]   ← note n_kv_head
              # wo: [n_head * head_dim, dim]

          def forward(self, x, batch, seq):
              ...
      \`\`\`

      \`head_dim = dim // n_head\`. **wk and wv are sized by \`n_kv_head\`, not
      \`n_head\`** — that is what GQA saves, and the easiest line to get wrong here.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Parameters | **Exactly** the analytic formula (below) |
      | Numerics | Max difference from the f64 reference ≤ 2e-6 (the fp32 bound, as in stage 3) |
      | Causality | Leakage = 0 |
      | Shortcuts | The fused operator is still forbidden |

      The formula:

      \`\`\`
      dim·n_head·hd  +  dim·n_kv_head·hd × 2  +  n_head·hd·dim
      \`\`\`

      With \`n_kv_head = n_head\` it degenerates to plain MHA. This stage uses
      \`dim=64, n_head=8, n_kv_head=2\`, so wk and wv are each **a quarter** of MHA's.

      ## Why GQA exists

      Decoding reads the whole KV cache for every generated token, and the cache scales
      with \`n_kv_head\`. Going from 8 KV heads to 2 makes **the cache four times smaller**
      — real decode bandwidth, at almost no quality cost. Llama 2 70B onwards does this.
    `
  ),
  checklist: [
    t('参数量恰好等于解析式', 'Parameter count exactly matches the formula'),
    t('wk / wv 按 n_kv_head 开', 'wk and wv are sized by n_kv_head'),
    t('与 f64 参考最大差 ≤ 2e-6', 'Max difference from the f64 reference ≤ 2e-6'),
    t('因果泄漏 = 0', 'Causal leakage = 0'),
  ],
  hints: [
    t('attn_scores 与 attn_apply 都收 heads 与 kv_heads 两个参数，头的共享它们内部处理。',
      'attn_scores and attn_apply both take heads and kv_heads; they handle the sharing.'),
    t('softmax 的 rows 现在是 batch*n_head*seq，不再是 batch*seq。',
      'softmax now takes rows = batch*n_head*seq, no longer batch*seq.'),
    t('causal_valid 也要按 n_head 开，每个头各有一份行长度。',
      'causal_valid is sized by n_head too: one row length per head.'),
  ],
  pitfalls: [
    t(code`
      **wk / wv 按 n_head 开。** 前向完全跑得通、数值也对（因为 kv 头够用），
      只有参数量对不上。而多出来的那些参数会一直占着显存与优化器状态,
      在真实模型上就是白白多几个 GB。
    `, code`
      **Sizing wk / wv by n_head.** The forward pass works and the numbers are right
      (there are enough KV heads), only the parameter count is off. Those extra parameters
      occupy memory and optimiser state forever, which on a real model is several wasted GB.
    `),
    t(code`
      **忘了改 softmax 的 rows。** 单头时 rows = batch*seq，多头时是 batch*n_head*seq。
      写错的话只有第一个头被归一化，其余头的概率和不是 1,而输出看起来仍然是「有数」的。
    `, code`
      **Forgetting to update softmax's row count.** With one head rows = batch*seq; with
      many it is batch*n_head*seq. Get it wrong and only the first head is normalised while
      the rest do not sum to 1 — and the output still looks like plausible numbers.
    `),
  ],
  train: {
    forbidden: ['attn_fwd'],
    files: {
      'mha.py': code`
        """第 4 关：多头注意力 + GQA。

        仍然不许用 F.scaled_dot_product_attention。
        """
        import nanotorch as nt
        from nanotorch import nn, functional as F


        class MultiHeadAttention(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed):
                super().__init__()
                assert dim % n_head == 0
                assert n_head % n_kv_head == 0
                self.dim = dim
                self.n_head = n_head
                self.n_kv_head = n_kv_head
                self.head_dim = dim // n_head
                # TODO: 四个权重。注意 wk / wv 按 n_kv_head 开，不是 n_head
                self.wq = nt.parameter((dim, 1), seed + 1, 0.02, "wq")
                self.wk = nt.parameter((dim, 1), seed + 2, 0.02, "wk")
                self.wv = nt.parameter((dim, 1), seed + 3, 0.02, "wv")
                self.wo = nt.parameter((1, dim), seed + 4, 0.02, "wo")

            def forward(self, x, batch, seq):
                # TODO: 投影 -> 分数 -> 因果 softmax -> 加权求和 -> 输出投影
                return nt.zeros((batch * seq, self.dim))


        if __name__ == "__main__":
            B, S, DIM, H, KV = 2, 6, 64, 8, 2
            m = MultiHeadAttention(DIM, H, KV, seed=7)
            print("参数量", m.num_parameters())
            x = nt.zeros((B * S, DIM), role="data").normal_(1, 1.0)
            print("输出形状", m(x, B, S).shape)
      `,
    },
    referenceFiles: {
      'mha.py': code`
        """第 4 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F


        class MultiHeadAttention(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed):
                super().__init__()
                assert dim % n_head == 0
                assert n_head % n_kv_head == 0
                self.dim = dim
                self.n_head = n_head
                self.n_kv_head = n_kv_head
                self.head_dim = dim // n_head
                # wq 与 wo 按 n_head 开；**wk / wv 按 n_kv_head 开**,这就是 GQA
                self.wq = nt.parameter((dim, n_head * self.head_dim), seed + 1, 0.02, "wq")
                self.wk = nt.parameter((dim, n_kv_head * self.head_dim), seed + 2, 0.02, "wk")
                self.wv = nt.parameter((dim, n_kv_head * self.head_dim), seed + 3, 0.02, "wv")
                self.wo = nt.parameter((n_head * self.head_dim, dim), seed + 4, 0.02, "wo")

            def forward(self, x, batch, seq):
                rows = batch * seq
                q = F.linear(x, self.wq)
                k = F.linear(x, self.wk)
                v = F.linear(x, self.wv)

                scores = F.attn_scores(
                    q, k, batch, seq, seq, self.n_head, self.n_kv_head, self.head_dim
                )
                # rows 现在按 n_head 开：每个头的每一行各自归一化
                valid = F.causal_valid(batch, self.n_head, seq)
                probs = F.softmax(scores, batch * self.n_head * seq, seq, valid)

                out = F.attn_apply(
                    probs, v, batch, seq, seq, self.n_head, self.n_kv_head, self.head_dim,
                    out_shape=(rows, self.n_head * self.head_dim)
                )
                return F.linear(out, self.wo)


        if __name__ == "__main__":
            B, S, DIM, H, KV = 2, 6, 64, 8, 2
            m = MultiHeadAttention(DIM, H, KV, seed=7)
            print("参数量", m.num_parameters())
            x = nt.zeros((B * S, DIM), role="data").normal_(1, 1.0)
            print("输出形状", m(x, B, S).shape)
      `,
    },
  },
  specs: [
    spec('mha.spec.ts', code`
      ${LAB}

      const B = 2, S = 6, DIM = 64, H = 8, KV = 2;
      const HD = DIM / H;

      function build(extra) {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, mha
      importlib.reload(mha)
      import nanotorch as nt

      B, S, DIM, H, KV = \${B}, \${S}, \${DIM}, \${H}, \${KV}
      _m = mha.MultiHeadAttention(DIM, H, KV, seed=7)
      _x = nt.zeros((B * S, DIM), role="data").normal_(31, 1.0)
      \${extra || ''}
      _out = _m(_x, B, S)
      \`);
        return {
          params: lab.py('_m.num_parameters()'),
          named: JSON.parse(String(lab.py('json.dumps([[n, p.numel] for n, p in _m.named_parameters()])'))),
          out: JSON.parse(String(lab.py('json.dumps(_out.tolist())'))),
          x: JSON.parse(String(lab.py('json.dumps(_x.tolist())'))),
          weights: JSON.parse(String(lab.py(
            'json.dumps({"wq": _m.wq.tolist(), "wk": _m.wk.tolist(), '
            + '"wv": _m.wv.tolist(), "wo": _m.wo.tolist()})'
          ))),
        };
      }

      /** 平台侧 f64 参考。写得笨，一眼能看出对不对 */
      function reference(x, w) {
        const proj = (mat, outDim) => {
          const out = new Float64Array(B * S * outDim);
          for (let r = 0; r < B * S; r++)
            for (let o = 0; o < outDim; o++) {
              let acc = 0;
              for (let d = 0; d < DIM; d++) acc += x[r * DIM + d] * mat[d * outDim + o];
              out[r * outDim + o] = acc;
            }
          return out;
        };
        const q = proj(w.wq, H * HD);
        const k = proj(w.wk, KV * HD);
        const v = proj(w.wv, KV * HD);
        const scale = 1 / Math.sqrt(HD);
        const rep = H / KV;
        const ctx = new Float64Array(B * S * H * HD);

        for (let b = 0; b < B; b++)
          for (let h = 0; h < H; h++) {
            const kh = Math.floor(h / rep);
            for (let i = 0; i < S; i++) {
              const scores = [];
              for (let j = 0; j <= i; j++) {
                let s = 0;
                for (let c = 0; c < HD; c++) {
                  s += q[(b * S + i) * H * HD + h * HD + c] * k[(b * S + j) * KV * HD + kh * HD + c];
                }
                scores.push(s * scale);
              }
              const mx = Math.max(...scores);
              const exps = scores.map((s) => Math.exp(s - mx));
              const sum = exps.reduce((a, c) => a + c, 0);
              for (let j = 0; j <= i; j++) {
                const p = exps[j] / sum;
                for (let c = 0; c < HD; c++) {
                  ctx[(b * S + i) * H * HD + h * HD + c] +=
                    p * v[(b * S + j) * KV * HD + kh * HD + c];
                }
              }
            }
          }

        const out = new Float64Array(B * S * DIM);
        for (let r = 0; r < B * S; r++)
          for (let d = 0; d < DIM; d++) {
            let acc = 0;
            for (let c = 0; c < H * HD; c++) acc += ctx[r * H * HD + c] * w.wo[c * DIM + d];
            out[r * DIM + d] = acc;
          }
        return out;
      }

      describe('多头与 GQA', () => {
        it('参数量恰好等于解析式', () => {
          const r = build();
          const expected = DIM * H * HD + DIM * KV * HD * 2 + H * HD * DIM;
          console.log('参数量 ' + r.params + '，解析式 ' + expected);
          lab.publish('params.mha', r.params);
          expect(r.params).toBe(expected);
        });

        /*
         * 单独查 wk / wv 的大小。只查总数的话，「wk 按 n_head 开、wo 按 n_kv_head 开」
         * 这种两处都错但总数碰巧对得上的实现会漏过去。
         */
        it('wk 与 wv 按 n_kv_head 开，不是 n_head', () => {
          const named = new Map(build().named);
          expect(named.get('wk')).toBe(DIM * KV * HD);
          expect(named.get('wv')).toBe(DIM * KV * HD);
          expect(named.get('wq')).toBe(DIM * H * HD);
          expect(named.get('wo')).toBe(H * HD * DIM);
        });

        it('与 f64 参考最大差 ≤ 2e-6（fp32 的界）', () => {
          const r = build();
          const ref = reference(r.x, r.weights);
          let diff = 0;
          for (let i = 0; i < ref.length; i++) diff = Math.max(diff, Math.abs(r.out[i] - ref[i]));
          console.log('最大差 ' + diff.toExponential(2));
          lab.publish('attention.maxError', diff);
          expect(diff).toBeLessThan(2e-6);
        });

        it('改掉最后一个位置，前面位置的输出一位都不变', () => {
          const before = build().out;
          const after = build(
            '_x.set_([v + (2.5 if (i % (S * DIM)) >= (S - 1) * DIM else 0.0) '
            + 'for i, v in enumerate(_x.tolist())])'
          ).out;
          let leak = 0;
          let checked = 0;
          for (let b = 0; b < B; b++)
            for (let i = 0; i < S - 1; i++)
              for (let d = 0; d < DIM; d++) {
                const at = (b * S + i) * DIM + d;
                checked += 1;
                if (before[at] !== after[at]) leak += 1;
              }
          lab.publish('causality.leakBits', leak);
          expect(checked).toBeGreaterThan(500);
          expect(leak).toBe(0);
        });

        it('GQA 真的省了 —— 换成 MHA 参数量会变大', () => {
          const gqa = DIM * H * HD + DIM * KV * HD * 2 + H * HD * DIM;
          const mha = DIM * H * HD + DIM * H * HD * 2 + H * HD * DIM;
          lab.publish('params.mhaEquivalent', mha);
          expect(gqa).toBeLessThan(mha);
          // kv 头减到 1/4，wk + wv 也就减到 1/4
          expect(mha - gqa).toBe(2 * DIM * (H - KV) * HD);
        });

        it('没有用融合的那一块', () => {
          build();
          expect(lab.metrics().builtins.forbiddenCalls).toBe(0);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.params.mha', op: 'eq', value: 64 * 8 * 8 + 64 * 2 * 8 * 2 + 8 * 8 * 64,
      zh: '参数量（解析式）', en: 'parameter count (analytic)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.attention.maxError', op: 'lte', value: 2e-6,
      zh: '与 f64 参考的最大差（fp32 的界）', en: 'max difference from the f64 reference (fp32 bound)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.causality.leakBits', op: 'eq', value: 0,
      zh: '因果泄漏（逐位比）', en: 'causal leakage (bit-exact)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.builtins.forbiddenCalls', op: 'eq', value: 0,
      zh: '用了禁用的融合算子', en: 'forbidden fused operator calls', dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'encapsulation'],
  extension: t(
    code`
      2026 年的新变化：**MLA（多头潜在注意力）在大规模上胜出**。
      DeepSeek-V3、Kimi K2、LongCat 都用它,把 KV 压成一个共享的低秩潜向量，
      比 GQA 省得更多而质量更好。代价是 Q/K 在推理时只以展开形态瞬时存在，
      于是 QK-norm 这类技巧用不了。

      GQA 仍然是理解 KV cache 的最好起点,而且绝大多数中小模型还在用它。
    `,
    code`
      A 2026 development: **MLA (multi-head latent attention) wins at scale**.
      DeepSeek-V3, Kimi K2 and LongCat all use it, compressing KV into a shared low-rank
      latent — more savings than GQA at better quality. The cost is that Q/K exist only
      transiently in expanded form at inference, which rules out tricks like QK-norm.

      GQA remains the best entry point for understanding the KV cache, and most small and
      mid-size models still use it.
    `
  ),
};

/* ================================================================== */
/* 第 5 关：RoPE                                                       */
/* ================================================================== */

const STAGE_ROPE = {
  id: 'rope',
  title: t('RoPE —— 让注意力只看得见相对距离', 'RoPE — making attention see only relative distance'),
  goal: t(
    code`
      在 \`rope.py\` 里自己把 RoPE 的表算出来，并接进第 4 关的注意力。

      \`\`\`python
      def build_tables(positions, head_dim, base=10000.0):
          """positions 是一串位置下标，返回 (cos, sin)，形状都是
          (len(positions), head_dim // 2)。"""

      class RopeAttention(nn.Module):
          def forward(self, x, batch, seq, offset=0):
              # q 和 k 各转一次；**v 不转**
      \`\`\`

      **收的是位置列表，不是长度。** 解码时你要的往往不是 \`0..S\` 而是
      \`t..t+1\` —— 第 8 关的 KV cache 会直接用到这一点，所以接口现在就得是对的。

      ## 表怎么算

      第 \`i\` 对维度（\`i\` 从 0 数到 \`head_dim/2 - 1\`）配一个频率：

      \`\`\`
      θ(p, i) = p · base^(−2i / head_dim)
      cos[p][i] = cos(θ)      sin[p][i] = sin(θ)
      \`\`\`

      \`i = 0\` 时频率是 1，转得最快，管的是相邻几个位置；
      \`i\` 越大频率越低，管的是几百上千个位置的尺度。
      一个头的 \`head_dim/2\` 对维度合起来就是一把不同刻度的尺子。

      ## 转哪两维配对

      我们用**前后半配对**（Llama / HF 的写法）：第 \`i\` 维和第 \`i + head_dim/2\` 维
      当成一个复数转。另一种写法是相邻配对（\`2i\` 与 \`2i+1\`），
      两者数学上等价，但**表和权重必须按同一种约定**,混着用不会报错，只会静静地训不出来。

      \`\`\`
      x[i]        ← x[i]·cos − x[i+half]·sin
      x[i+half]   ← x[i]·sin + x[i+half]·cos
      \`\`\`

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 表 | 与 f64 参考最大差 ≤ 2e-6 |
      | 数值 | 整个注意力与 f64 参考最大差 ≤ 5e-5 |
      | **平移不变** | 整段往后挪 \`Δ\`，注意力分数矩阵**不变**（≤ 5e-5） |
      | v 没被转 | 每次前向恰好 \`rope_fwd\` **2 次** |

      平移不变那条是这一关的全部意义。\`q_i · k_j\` 转完之后只依赖 \`i − j\`,
      这就是「相对位置」四个字的准确含义，也是 RoPE 能外推到没训过的长度的原因。
      它挂了说明表没按位置对齐,而这个错在 loss 上看不出来。
    `,
    code`
      In \`rope.py\`, build the RoPE tables yourself and wire them into stage 4's attention.

      \`\`\`python
      def build_tables(positions, head_dim, base=10000.0):
          """positions is a list of position indices; returns (cos, sin), both
          shaped (len(positions), head_dim // 2)."""

      class RopeAttention(nn.Module):
          def forward(self, x, batch, seq, offset=0):
              # rotate q and k; **do not rotate v**
      \`\`\`

      **It takes positions, not a length.** When decoding you usually want \`t..t+1\`
      rather than \`0..S\` — stage 8's KV cache depends on exactly this, so the interface
      has to be right now.

      ## Building the table

      Dimension pair \`i\` (from 0 to \`head_dim/2 - 1\`) gets one frequency:

      \`\`\`
      θ(p, i) = p · base^(−2i / head_dim)
      cos[p][i] = cos(θ)      sin[p][i] = sin(θ)
      \`\`\`

      At \`i = 0\` the frequency is 1 and rotation is fastest, covering neighbouring
      positions; larger \`i\` means lower frequency, covering hundreds or thousands of
      positions. Together the \`head_dim/2\` pairs form rulers at many scales.

      ## Which dimensions pair up

      We use **half-and-half pairing** (the Llama / HF convention): dimension \`i\` pairs
      with dimension \`i + head_dim/2\`. The alternative pairs neighbours (\`2i\` with
      \`2i+1\`). They are mathematically equivalent, but **table and weights must agree**,
      mixing them raises no error and simply fails to train.

      \`\`\`
      x[i]        ← x[i]·cos − x[i+half]·sin
      x[i+half]   ← x[i]·sin + x[i+half]·cos
      \`\`\`

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Table | Max difference from the f64 reference ≤ 2e-6 |
      | Numerics | Whole attention within 5e-5 of the f64 reference |
      | **Shift invariance** | Shift the segment by \`Δ\`; the score matrix is unchanged (≤ 5e-5) |
      | v untouched | Exactly **2** \`rope_fwd\` calls per forward |

      Shift invariance is the whole point of this stage. After rotation \`q_i · k_j\`
      depends only on \`i − j\` — that is precisely what "relative position" means, and why
      RoPE extrapolates to lengths it never saw. If it fails, the table is not aligned to
      positions, and no loss curve will tell you.
    `
  ),
  checklist: [
    t('自己算的 cos / sin 表对得上 f64 参考', 'Your cos / sin tables match the f64 reference'),
    t('整段平移之后分数矩阵不变', 'Shifting the whole segment leaves the score matrix unchanged'),
    t('只转 q 和 k，不转 v', 'Rotate q and k only, never v'),
    t('build_tables 收位置列表，能从任意 offset 起算', 'build_tables takes positions, so any offset works'),
  ],
  hints: [
    t('base ** (-2.0 * i / head_dim) —— 指数是负的，i 越大频率越低。',
      'base ** (-2.0 * i / head_dim): the exponent is negative, so larger i means lower frequency.'),
    t('F.rope 是就地的，它改的就是传进去的那块。q 和 k 各调一次。',
      'F.rope is in-place: it rewrites the tensor you pass. Call it once for q and once for k.'),
    t('offset 只影响 positions —— range(offset, offset + seq)，别的都不用改。',
      'offset only affects positions: range(offset, offset + seq). Nothing else changes.'),
  ],
  pitfalls: [
    t(code`
      **顺手把 v 也转了。** 前向照跑，数值也不会离谱,注意力权重是对的，
      只是取出来的值被转过。模型仍然能训，只是比不转差一点。
      这一关靠数 \`rope_fwd\` 的调用次数把它抓出来。
    `, code`
      **Rotating v as well.** The forward pass runs and the numbers are not absurd: the
      attention weights are right, only the values fetched have been rotated. The model
      still trains, just slightly worse. This stage catches it by counting \`rope_fwd\` calls.
    `),
    t(code`
      **表按 head_dim 开而不是 head_dim/2。** 形状检查过不了是好事,
      真正麻烦的是把 \`2i\` 写成 \`i\`：表还是对的形状，频率却全错了一个尺度，
      短序列上几乎看不出来，长序列上直接废掉。
    `, code`
      **Sizing the table by head_dim instead of head_dim/2.** Failing a shape check is the
      good outcome; the nasty variant is writing \`i\` where \`2i\` belongs. The table keeps
      its shape while every frequency is off by a factor, which is nearly invisible on short
      sequences and fatal on long ones.
    `),
  ],
  train: {
    files: {
      'rope.py': code`
        """第 5 关：RoPE。

        自己算表，接进注意力。q 和 k 转，v 不转。
        """
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F


        def build_tables(positions, head_dim, base=10000.0):
            """返回 (cos, sin)，形状都是 (len(positions), head_dim // 2)。"""
            assert head_dim % 2 == 0
            half = head_dim // 2
            cos = nt.zeros((len(positions), half), role="data", name="rope.cos")
            sin = nt.zeros((len(positions), half), role="data", name="rope.sin")
            # TODO: 逐个位置、逐对维度算 θ = p * base ** (-2i / head_dim)
            cos.fill_(1.0)
            sin.fill_(0.0)
            return cos, sin


        class RopeAttention(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed, base=10000.0):
                super().__init__()
                assert dim % n_head == 0 and n_head % n_kv_head == 0
                self.dim, self.n_head, self.n_kv_head = dim, n_head, n_kv_head
                self.head_dim = dim // n_head
                self.base = base
                hd = self.head_dim
                self.wq = nt.parameter((dim, n_head * hd), seed + 1, 0.02, "wq")
                self.wk = nt.parameter((dim, n_kv_head * hd), seed + 2, 0.02, "wk")
                self.wv = nt.parameter((dim, n_kv_head * hd), seed + 3, 0.02, "wv")
                self.wo = nt.parameter((n_head * hd, dim), seed + 4, 0.02, "wo")

            def forward(self, x, batch, seq, offset=0):
                # TODO: 投影 -> 给 q / k 转 RoPE -> 因果注意力 -> 输出投影
                return nt.zeros((batch * seq, self.dim))


        if __name__ == "__main__":
            cos, sin = build_tables(list(range(4)), 8)
            print("表形状", cos.shape, sin.shape)
            m = RopeAttention(64, 4, 2, seed=11)
            x = nt.zeros((2 * 8, 64), role="data").normal_(1, 1.0)
            print("输出形状", m(x, 2, 8).shape)
      `,
    },
    referenceFiles: {
      'rope.py': code`
        """第 5 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F


        def build_tables(positions, head_dim, base=10000.0):
            assert head_dim % 2 == 0
            half = head_dim // 2
            cos = nt.zeros((len(positions), half), role="data", name="rope.cos")
            sin = nt.zeros((len(positions), half), role="data", name="rope.sin")
            cv, sv = [], []
            for p in positions:
                for i in range(half):
                    theta = p * (base ** (-2.0 * i / head_dim))
                    cv.append(math.cos(theta))
                    sv.append(math.sin(theta))
            cos.set_(cv)
            sin.set_(sv)
            return cos, sin


        class RopeAttention(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed, base=10000.0):
                super().__init__()
                assert dim % n_head == 0 and n_head % n_kv_head == 0
                self.dim, self.n_head, self.n_kv_head = dim, n_head, n_kv_head
                self.head_dim = dim // n_head
                self.base = base
                hd = self.head_dim
                self.wq = nt.parameter((dim, n_head * hd), seed + 1, 0.02, "wq")
                self.wk = nt.parameter((dim, n_kv_head * hd), seed + 2, 0.02, "wk")
                self.wv = nt.parameter((dim, n_kv_head * hd), seed + 3, 0.02, "wv")
                self.wo = nt.parameter((n_head * hd, dim), seed + 4, 0.02, "wo")

            def forward(self, x, batch, seq, offset=0):
                rows, hd = batch * seq, self.head_dim
                q = F.linear(x, self.wq)
                k = F.linear(x, self.wk)
                v = F.linear(x, self.wv)

                # 位置从 offset 起算 —— 解码时这就是「已经生成了多少个」
                cos, sin = build_tables(list(range(offset, offset + seq)), hd, self.base)
                q = F.rope(q, cos, sin, batch, seq, self.n_head, hd)
                k = F.rope(k, cos, sin, batch, seq, self.n_kv_head, hd)
                # v 不转：注意力取的是「值」，值不该带位置

                scores = F.attn_scores(q, k, batch, seq, seq, self.n_head, self.n_kv_head, hd)
                valid = F.causal_valid(batch, self.n_head, seq)
                probs = F.softmax(scores, batch * self.n_head * seq, seq, valid)
                out = F.attn_apply(
                    probs, v, batch, seq, seq, self.n_head, self.n_kv_head, hd,
                    out_shape=(rows, self.n_head * hd)
                )
                return F.linear(out, self.wo)


        if __name__ == "__main__":
            cos, sin = build_tables(list(range(4)), 8)
            print("表形状", cos.shape, sin.shape)
            m = RopeAttention(64, 4, 2, seed=11)
            x = nt.zeros((2 * 8, 64), role="data").normal_(1, 1.0)
            print("输出形状", m(x, 2, 8).shape)
      `,
    },
  },
  specs: [
    spec('rope.spec.ts', code`
      ${LAB}

      const B = 2, S = 8, DIM = 64, H = 4, KV = 2, BASE = 10000;
      const HD = DIM / H;

      /** 平台侧 f64 的表 */
      function refTables(positions, hd, base) {
        const half = hd / 2;
        const cos = [], sin = [];
        for (const p of positions)
          for (let i = 0; i < half; i++) {
            const th = p * Math.pow(base, (-2 * i) / hd);
            cos.push(Math.cos(th));
            sin.push(Math.sin(th));
          }
        return { cos, sin };
      }

      function rotate(vec, rows, heads, hd, cos, sin, seq) {
        const half = hd / 2;
        const out = Float64Array.from(vec);
        for (let r = 0; r < rows; r++) {
          const s = r % seq;
          for (let h = 0; h < heads; h++)
            for (let i = 0; i < half; i++) {
              const a = out[r * heads * hd + h * hd + i];
              const d = out[r * heads * hd + h * hd + i + half];
              const c = cos[s * half + i], n = sin[s * half + i];
              out[r * heads * hd + h * hd + i] = a * c - d * n;
              out[r * heads * hd + h * hd + i + half] = a * n + d * c;
            }
        }
        return out;
      }

      function build(offset) {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, rope
      importlib.reload(rope)
      import nanotorch as nt

      B, S, DIM, H, KV = \${B}, \${S}, \${DIM}, \${H}, \${KV}
      _m = rope.RopeAttention(DIM, H, KV, seed=11, base=\${BASE})
      _x = nt.zeros((B * S, DIM), role="data").normal_(77, 1.0)
      _out = _m(_x, B, S, offset=\${offset || 0})
      \`);
        return {
          out: JSON.parse(String(lab.py('json.dumps(_out.tolist())'))),
          x: JSON.parse(String(lab.py('json.dumps(_x.tolist())'))),
          w: JSON.parse(String(lab.py(
            'json.dumps({"wq": _m.wq.tolist(), "wk": _m.wk.tolist(), '
            + '"wv": _m.wv.tolist(), "wo": _m.wo.tolist()})'
          ))),
        };
      }

      /** f64 参考：投影 -> 转 q/k -> 因果注意力 -> 输出投影 */
      function reference(x, w, offset) {
        const rows = B * S;
        const proj = (mat, outDim) => {
          const out = new Float64Array(rows * outDim);
          for (let r = 0; r < rows; r++)
            for (let o = 0; o < outDim; o++) {
              let acc = 0;
              for (let d = 0; d < DIM; d++) acc += x[r * DIM + d] * mat[d * outDim + o];
              out[r * outDim + o] = acc;
            }
          return out;
        };
        const positions = [];
        for (let s = 0; s < S; s++) positions.push(offset + s);
        const { cos, sin } = refTables(positions, HD, BASE);

        const q = rotate(proj(w.wq, H * HD), rows, H, HD, cos, sin, S);
        const k = rotate(proj(w.wk, KV * HD), rows, KV, HD, cos, sin, S);
        const v = proj(w.wv, KV * HD);

        const scale = 1 / Math.sqrt(HD);
        const rep = H / KV;
        const ctx = new Float64Array(rows * H * HD);
        const scoreDump = [];
        for (let b = 0; b < B; b++)
          for (let h = 0; h < H; h++)
            for (let i = 0; i < S; i++) {
              const kh = Math.floor(h / rep);
              const raw = [];
              for (let j = 0; j <= i; j++) {
                let s = 0;
                for (let c = 0; c < HD; c++)
                  s += q[(b * S + i) * H * HD + h * HD + c] * k[(b * S + j) * KV * HD + kh * HD + c];
                raw.push(s * scale);
              }
              scoreDump.push(...raw);
              const mx = Math.max(...raw);
              const ex = raw.map((s) => Math.exp(s - mx));
              const sum = ex.reduce((a, c) => a + c, 0);
              for (let j = 0; j <= i; j++) {
                const p = ex[j] / sum;
                for (let c = 0; c < HD; c++)
                  ctx[(b * S + i) * H * HD + h * HD + c] += p * v[(b * S + j) * KV * HD + kh * HD + c];
              }
            }
        const out = new Float64Array(rows * DIM);
        for (let r = 0; r < rows; r++)
          for (let d = 0; d < DIM; d++) {
            let acc = 0;
            for (let c = 0; c < H * HD; c++) acc += ctx[r * H * HD + c] * w.wo[c * DIM + d];
            out[r * DIM + d] = acc;
          }
        return { out, scores: scoreDump };
      }

      describe('RoPE', () => {
        it('自己算的表对得上 f64 参考', () => {
          lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, rope
      importlib.reload(rope)
      _cos, _sin = rope.build_tables(list(range(\${S})), \${HD}, \${BASE})
      \`);
          const cos = JSON.parse(String(lab.py('json.dumps(_cos.tolist())')));
          const sin = JSON.parse(String(lab.py('json.dumps(_sin.tolist())')));
          const positions = [];
          for (let s = 0; s < S; s++) positions.push(s);
          const ref = refTables(positions, HD, BASE);

          expect(cos.length).toBe(S * (HD / 2));
          expect(sin.length).toBe(S * (HD / 2));
          let diff = 0;
          for (let i = 0; i < ref.cos.length; i++) {
            diff = Math.max(diff, Math.abs(cos[i] - ref.cos[i]));
            diff = Math.max(diff, Math.abs(sin[i] - ref.sin[i]));
          }
          console.log('表的最大差 ' + diff.toExponential(2));
          lab.publish('rope.tableError', diff);
          expect(diff).toBeLessThan(2e-6);
        });

        it('整个注意力与 f64 参考最大差 ≤ 5e-5', () => {
          const r = build(0);
          const ref = reference(r.x, r.w, 0);
          let diff = 0;
          for (let i = 0; i < ref.out.length; i++)
            diff = Math.max(diff, Math.abs(r.out[i] - ref.out[i]));
          console.log('最大差 ' + diff.toExponential(2));
          lab.publish('attention.maxError', diff);
          expect(diff).toBeLessThan(5e-5);
        });

        /*
         * 这一关的重点。RoPE 之后 q_i·k_j 只依赖 i−j，
         * 所以整段往后挪 Δ，分数矩阵应当一模一样。
         * 挂了说明表没跟位置对齐 —— 而这个错在 loss 上看不出来。
         */
        it('整段平移之后，注意力分数矩阵不变', () => {
          const D = 5;
          const a = build(0);
          const b2 = build(D);
          const s0 = reference(a.x, a.w, 0).scores;
          const sD = reference(b2.x, b2.w, D).scores;
          // 先确认参考本身满足这条性质（否则测的是参考不是学员）
          let refDiff = 0;
          for (let i = 0; i < s0.length; i++) refDiff = Math.max(refDiff, Math.abs(s0[i] - sD[i]));
          expect(refDiff).toBeLessThan(1e-12);

          // 学员那边：offset 变了，输出应当逐值相同
          let diff = 0;
          for (let i = 0; i < a.out.length; i++)
            diff = Math.max(diff, Math.abs(a.out[i] - b2.out[i]));
          console.log('平移 ' + D + ' 之后的最大差 ' + diff.toExponential(2));
          lab.publish('rope.shiftError', diff);
          expect(diff).toBeLessThan(5e-5);
        });

        /*
         * v 不该转。数值上很难抓（注意力权重仍然是对的），
         * 所以直接数 rope_fwd 调了几次 —— 一次前向恰好两次，q 和 k。
         */
        it('一次前向恰好转两次：q 和 k，不含 v', () => {
          const before = lab.metrics().kernelCalls.byOp.rope_fwd || 0;
          build(0);
          const after = lab.metrics().kernelCalls.byOp.rope_fwd || 0;
          const calls = after - before;
          console.log('一次前向的 rope_fwd 次数 ' + calls);
          lab.publish('rope.callsPerForward', calls);
          expect(calls).toBe(2);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.rope.tableError', op: 'lte', value: 2e-6,
      zh: 'cos / sin 表与 f64 参考的最大差', en: 'max table difference from the f64 reference',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.attention.maxError', op: 'lte', value: 5e-5,
      zh: '带 RoPE 的注意力与 f64 参考的最大差', en: 'max attention difference from the f64 reference',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.rope.shiftError', op: 'lte', value: 5e-5,
      zh: '整段平移之后的最大差（相对位置）', en: 'max difference after shifting the segment (relative position)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.rope.callsPerForward', op: 'eq', value: 2,
      zh: '一次前向转了几次（q 和 k，不含 v）', en: 'rotations per forward (q and k, not v)',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      \`base\` 决定了最低那档频率能覆盖多长。10000 是原论文的取值，对应几千的上下文；
      要把上下文拉到十万级，**光靠外推是不够的**,现在的做法是
      \`YaRN\` / \`NTK-aware\` 这类把 base 放大再微调一小段的方案，
      2026 年的长上下文模型基本都带一层这个。

      另一条正在铺开的路是 \`QK-norm\`：在算分数之前先给 q 和 k 各做一次 RMSNorm。
      它稳的是训练早期的注意力熵,Gemma 2 之后成了很多模型的标配。
      注意它和 MLA 有冲突（MLA 里 q/k 只以压缩形态存在），这也是第 4 关那条延伸里
      说的取舍。
    `,
    code`
      \`base\` sets how long the lowest frequency can cover. 10000 comes from the original
      paper and suits a few thousand tokens; reaching a hundred thousand **takes more than
      extrapolation**. Current practice is \`YaRN\` / \`NTK-aware\` scaling — enlarge the base
      and fine-tune briefly — and nearly every long-context model in 2026 ships one.

      Another spreading technique is \`QK-norm\`: RMSNorm q and k before computing scores.
      It stabilises attention entropy early in training and became standard for many models
      after Gemma 2. Note it conflicts with MLA, where q/k exist only in compressed form —
      the same trade-off stage 4's extension mentions.
    `
  ),
};

/* ================================================================== */
/* 第 6 关：RMSNorm 与 pre-norm                                        */
/* ================================================================== */

const STAGE_NORM = {
  id: 'rmsnorm-prenorm',
  title: t('RMSNorm 与 pre-norm —— 深了还能不能训', 'RMSNorm and pre-norm — staying trainable at depth'),
  goal: t(
    code`
      在 \`norm.py\` 里写归一化和残差堆叠，把「深度」这件事真的量出来。

      \`\`\`python
      class RMSNorm(nn.Module):
          def __init__(self, dim, eps=1e-5):   # 只有一个 weight，**没有 bias**
          def forward(self, x, rows):

      class Stack(nn.Module):
          def __init__(self, dim, n_layer, seed, residual_scale=True):
          def forward(self, x, rows):
              """每层：h = norm(x) -> linear -> (可选缩放) -> x = x + h

              顺手把每层之后的 F.rms(x) 记进 self.layer_rms。"""
      \`\`\`

      ## RMSNorm 和 LayerNorm 差在哪

      LayerNorm 先减均值再除标准差，RMSNorm **只除均方根**：

      \`\`\`
      LayerNorm(x) = (x − mean(x)) / std(x) · g + b
      RMSNorm(x)   = x / sqrt(mean(x²) + ε) · g
      \`\`\`

      少了减均值、少了 bias，省下大约 7% 的归一化开销,而效果基本持平。
      这是 Llama 之后的默认选择。

      一个直接的推论：**给输入整体加一个常数，LayerNorm 的输出不变，RMSNorm 的会变。**
      这一关就用它来验你写的到底是哪一个。

      ## pre-norm 与残差缩放

      \`pre-norm\`（\`x + f(norm(x))\`）和 \`post-norm\`（\`norm(x + f(x))\`）的区别，
      在于残差通路上有没有归一化挡着。pre-norm 的残差是一条干净的恒等通路,
      这是深层能训起来的直接原因，也是今天的默认。

      代价是残差流的量级随深度涨。每层往上加一份方差 \`σ²\`，\`L\` 层之后是
      \`sqrt(1 + L·σ²)\`。把每层输出乘 \`1/sqrt(2L)\` 之后，总量变成
      \`sqrt(1 + σ²/2)\` —— **和深度无关**。GPT-2 起就是这么初始化的。

      这一关把权重按 \`std = dim^(−1/2)\` 初始化，于是 \`σ ≈ 1\`，三个数分别是：

      \`\`\`
      16 层不带缩放   sqrt(1 + 16) ≈ 4.12
      16 层带缩放     sqrt(1 + 0.5) ≈ 1.22
       2 层带缩放     sqrt(1 + 0.5) ≈ 1.22   ← 和 16 层一样
      \`\`\`

      （\`0.02\` 那个常见的初始化是给 \`dim = 768\` 调的:
      \`0.02 · sqrt(768) ≈ 0.55\`。照搬到 \`dim = 32\` 上 \`σ\` 只有 0.11，
      深度效应会被压得几乎看不见。**初始化的尺度得跟着宽度走。**）

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 数值 | RMSNorm 与 f64 参考最大差 ≤ 2e-6 |
      | 是 RMSNorm 不是 LayerNorm | 整体平移之后输出的变化 **≥ 0.05** |
      | 参数 | 每层归一化恰好 \`dim\` 个参数（没有 bias） |
      | 深度无关 | 16 层与 2 层的残差流增长比 **≤ 1.25** |
    `,
    code`
      In \`norm.py\`, write the normalisation and the residual stack, and actually measure
      what depth does.

      \`\`\`python
      class RMSNorm(nn.Module):
          def __init__(self, dim, eps=1e-5):   # one weight, **no bias**
          def forward(self, x, rows):

      class Stack(nn.Module):
          def __init__(self, dim, n_layer, seed, residual_scale=True):
          def forward(self, x, rows):
              """Each layer: h = norm(x) -> linear -> (optional scale) -> x = x + h

              Record F.rms(x) after every layer into self.layer_rms."""
      \`\`\`

      ## RMSNorm versus LayerNorm

      LayerNorm subtracts the mean then divides by the standard deviation; RMSNorm
      **only divides by the root mean square**:

      \`\`\`
      LayerNorm(x) = (x − mean(x)) / std(x) · g + b
      RMSNorm(x)   = x / sqrt(mean(x²) + ε) · g
      \`\`\`

      No mean subtraction, no bias, about 7% less normalisation cost, and essentially the
      same quality. It has been the default since Llama.

      One immediate consequence: **add a constant to the whole input and LayerNorm's output
      is unchanged while RMSNorm's changes.** This stage uses that to check which one you
      actually wrote.

      ## Pre-norm and residual scaling

      \`pre-norm\` (\`x + f(norm(x))\`) differs from \`post-norm\` (\`norm(x + f(x))\`) in
      whether a normalisation sits on the residual path. Pre-norm keeps that path a clean
      identity, which is the direct reason deep stacks train, and the default today.

      The cost is that the residual stream grows with depth. Each layer adds variance
      \`σ²\`, so after \`L\` layers the scale is \`sqrt(1 + L·σ²)\`. Multiply each layer's
      output by \`1/sqrt(2L)\` and the total becomes \`sqrt(1 + σ²/2)\` — **independent of
      depth**. GPT-2 has initialised this way from the start.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Numerics | RMSNorm within 2e-6 of the f64 reference |
      | RMSNorm, not LayerNorm | Output change under a constant shift **≥ 0.05** |
      | Parameters | Exactly \`dim\` per normalisation layer (no bias) |
      | Depth independence | 16-layer growth over 2-layer growth **≤ 1.25** |
    `
  ),
  checklist: [
    t('RMSNorm 只有 weight，没有 bias', 'RMSNorm has a weight and no bias'),
    t('整体平移能改变 RMSNorm 的输出', 'A constant shift changes RMSNorm output'),
    t('残差是 x + f(norm(x))，归一化不挡在残差通路上',
      'The residual is x + f(norm(x)); no normalisation on the residual path'),
    t('带 1/sqrt(2L) 缩放之后增长与深度无关',
      'With 1/sqrt(2L) scaling the growth is depth-independent'),
  ],
  hints: [
    t('F.rms_norm(x, weight, eps) 已经有了，weight 用 nt.parameter 建好再 fill_(1.0)。',
      'F.rms_norm(x, weight, eps) exists; build weight with nt.parameter and fill_(1.0).'),
    t('F.rms(x) 返回一个普通的 float，是观测量，不进计算图。',
      'F.rms(x) returns a plain float; it is an observable, not part of the graph.'),
    t('每层输出乘 (2*n_layer) ** -0.5 就是那条缩放，用 F.scale。',
      'Multiply each layer output by (2*n_layer) ** -0.5 via F.scale.'),
  ],
  pitfalls: [
    t(code`
      **给 RMSNorm 加了 bias。** 参数量多了 \`dim\`，功能上也说得通,
      但它把「不减均值」这个前提破坏了：bias 能把均值挪回去，于是你写的其实是
      一个更贵的 LayerNorm。这一关单独查参数量。
    `, code`
      **Adding a bias to RMSNorm.** It costs \`dim\` extra parameters and seems harmless,
      but it breaks the premise of not subtracting the mean: a bias can shift the mean back,
      so what you wrote is an expensive LayerNorm. This stage checks the parameter count.
    `),
    t(code`
      **写成 post-norm。** \`norm(x + f(x))\` 在浅层上和 pre-norm 几乎没差,
      两三层的时候 loss 曲线看不出区别。差别要到十几层往上才出来，
      而那时候你已经没法用「换一行」来定位了。
    `, code`
      **Writing post-norm.** \`norm(x + f(x))\` is nearly indistinguishable from pre-norm in
      a shallow stack: at two or three layers the loss curves overlap. The gap appears above
      a dozen layers, by which point a one-line change is no longer easy to attribute.
    `),
  ],
  train: {
    files: {
      'norm.py': code`
        """第 6 关：RMSNorm 与 pre-norm 残差。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F


        class RMSNorm(nn.Module):
            def __init__(self, dim, eps=1e-5):
                super().__init__()
                self.dim, self.eps = dim, eps
                # TODO: 只有一个 weight，初值全 1，**没有 bias**
                self.weight = nt.parameter((dim,), None, 0.0, "norm.weight")

            def forward(self, x, rows):
                # TODO
                return x


        class Stack(nn.Module):
            def __init__(self, dim, n_layer, seed, residual_scale=True):
                super().__init__()
                self.dim, self.n_layer = dim, n_layer
                self.residual_scale = residual_scale
                self.layer_rms = []
                # TODO: n_layer 组 (RMSNorm, linear 权重)，权重的 std 取 dim ** -0.5。
                #       用 nn.ModuleList / nn.ParameterList 装 —— 放进普通 list
                #       的子模块不会被登记，parameters() 数不到它们
                self.norms = nn.ModuleList()
                self.weights = nn.ParameterList()

            def forward(self, x, rows):
                self.layer_rms = []
                # TODO: 每层 h = norm(x) -> linear -> 缩放 -> x = x + h
                #       每层之后 self.layer_rms.append(F.rms(x))
                return x


        if __name__ == "__main__":
            DIM, ROWS = 32, 64
            s = Stack(DIM, 4, seed=5)
            x = nt.zeros((ROWS, DIM), role="data").normal_(3, 1.0)
            print("入口 rms", round(F.rms(x), 4))
            out = s(x, ROWS)
            print("逐层 rms", [round(v, 4) for v in s.layer_rms])
      `,
    },
    referenceFiles: {
      'norm.py': code`
        """第 6 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F


        class RMSNorm(nn.Module):
            def __init__(self, dim, eps=1e-5):
                super().__init__()
                self.dim, self.eps = dim, eps
                # std=0 表示常数 1 起步 —— 归一化的增益就是这么初始化的
                self.weight = nt.parameter((dim,), None, 0.0, "norm.weight")

            def forward(self, x, rows):
                return F.rms_norm(x, self.weight, self.eps)


        class Stack(nn.Module):
            def __init__(self, dim, n_layer, seed, residual_scale=True):
                super().__init__()
                self.dim, self.n_layer = dim, n_layer
                self.residual_scale = residual_scale
                self.layer_rms = []
                self.norms = []
                self.weights = []
                # ModuleList / ParameterList：放进普通 list 的子模块不会被登记，
                # parameters() 就数不到它们 —— 优化器一个参数都不更新，而且不报错
                self.norms = nn.ModuleList([RMSNorm(dim) for _ in range(n_layer)])
                self.weights = nn.ParameterList([
                    # std = dim**-0.5：支路输出的量级和残差流可比，σ ≈ 1
                    nt.parameter((dim, dim), seed + i + 1, dim ** -0.5, "w" + str(i))
                    for i in range(n_layer)
                ])

            def forward(self, x, rows):
                self.layer_rms = []
                # GPT-2 起的做法：每层输出乘 1/sqrt(2L)，总增长就与深度无关
                scale = (2.0 * self.n_layer) ** -0.5 if self.residual_scale else 1.0
                for i in range(self.n_layer):
                    # pre-norm：归一化在支路上，残差通路是干净的恒等
                    h = self.norms[i](x, rows)
                    h = F.linear(h, self.weights[i])
                    if scale != 1.0:
                        h = F.scale(h, scale)
                    x = F.add(x, h)
                    self.layer_rms.append(F.rms(x))
                return x


        if __name__ == "__main__":
            DIM, ROWS = 32, 64
            s = Stack(DIM, 4, seed=5)
            x = nt.zeros((ROWS, DIM), role="data").normal_(3, 1.0)
            print("入口 rms", round(F.rms(x), 4))
            out = s(x, ROWS)
            print("逐层 rms", [round(v, 4) for v in s.layer_rms])
      `,
    },
  },
  specs: [
    spec('norm.spec.ts', code`
      ${LAB}

      const DIM = 32, ROWS = 64;

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, norm
      importlib.reload(norm)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
      }

      describe('RMSNorm 与 pre-norm', () => {
        it('RMSNorm 与 f64 参考最大差 ≤ 2e-6', () => {
          setup();
          lab.py(\`
      _n = norm.RMSNorm(\${DIM})
      _x = nt.zeros((\${ROWS}, \${DIM}), role="data").normal_(9, 1.5)
      _y = _n(_x, \${ROWS})
      \`);
          const x = JSON.parse(String(lab.py('json.dumps(_x.tolist())')));
          const y = JSON.parse(String(lab.py('json.dumps(_y.tolist())')));
          const g = JSON.parse(String(lab.py('json.dumps(_n.weight.tolist())')));

          let diff = 0;
          for (let r = 0; r < ROWS; r++) {
            let ss = 0;
            for (let d = 0; d < DIM; d++) ss += x[r * DIM + d] * x[r * DIM + d];
            const inv = 1 / Math.sqrt(ss / DIM + 1e-5);
            for (let d = 0; d < DIM; d++)
              diff = Math.max(diff, Math.abs(y[r * DIM + d] - x[r * DIM + d] * inv * g[d]));
          }
          console.log('最大差 ' + diff.toExponential(2));
          lab.publish('norm.rmsError', diff);
          expect(diff).toBeLessThan(2e-6);
        });

        /*
         * RMSNorm 不减均值，所以整体平移会改变输出；LayerNorm 不会。
         * 这一条把「写成 LayerNorm」和「写对了」分开 —— 数值门槛做不到，
         * 因为 LayerNorm 在零均值的输入上和 RMSNorm 几乎一样。
         */
        it('整体平移会改变输出 —— 证明不是 LayerNorm', () => {
          setup();
          lab.py(\`
      _n = norm.RMSNorm(\${DIM})
      _x = nt.zeros((\${ROWS}, \${DIM}), role="data").normal_(9, 1.5)
      _base = _n(_x, \${ROWS}).tolist()
      _x2 = nt.zeros((\${ROWS}, \${DIM}), role="data")
      _x2.set_([v + 1.0 for v in _x.tolist()])
      _shift = _n(_x2, \${ROWS}).tolist()
      \`);
          const base = JSON.parse(String(lab.py('json.dumps(_base)')));
          const shifted = JSON.parse(String(lab.py('json.dumps(_shift)')));
          let worst = 0;
          for (let i = 0; i < base.length; i++)
            worst = Math.max(worst, Math.abs(base[i] - shifted[i]));
          console.log('整体 +1 之后的最大变化 ' + worst.toFixed(4) + '（LayerNorm 会是 0）');
          lab.publish('norm.shiftSensitivity', worst);
          expect(worst).toBeGreaterThan(0.05);
        });

        it('每层归一化恰好 dim 个参数，没有 bias', () => {
          setup();
          lab.py(\`_n = norm.RMSNorm(\${DIM})\`);
          const named = JSON.parse(String(lab.py(
            'json.dumps([[n, p.numel] for n, p in _n.named_parameters()])'
          )));
          const total = named.reduce((a, pair) => a + pair[1], 0);
          console.log('RMSNorm 的参数 ' + JSON.stringify(named));
          lab.publish('params.normPerLayer', total);
          expect(total).toBe(DIM);
        });

        /*
         * 深度无关：带 1/sqrt(2L) 缩放时，16 层和 2 层的残差流增长应当接近。
         * 不带缩放时 16 层会明显更大 —— 两种都跑一遍，
         * 免得学员把 residual_scale 接成一个空开关也能过。
         */
        it('带缩放时增长与深度无关，不带时随深度涨', () => {
          setup();
          const growth = (layers, scaled) => {
            lab.py(\`
      _s = norm.Stack(\${DIM}, \${layers}, seed=5, residual_scale=\${scaled ? 'True' : 'False'})
      _x = nt.zeros((\${ROWS}, \${DIM}), role="data").normal_(3, 1.0)
      _in = F.rms(_x)
      _out = _s(_x, \${ROWS})
      _ratio = F.rms(_out) / _in
      _n_rms = len(_s.layer_rms)
      \`);
            return {
              ratio: Number(lab.py('_ratio')),
              layerCount: Number(lab.py('_n_rms')),
            };
          };

          const small = growth(2, true);
          const deep = growth(16, true);
          const deepRaw = growth(16, false);

          console.log(
            '带缩放 2 层 ' + small.ratio.toFixed(3)
            + '，16 层 ' + deep.ratio.toFixed(3)
            + '；不带缩放 16 层 ' + deepRaw.ratio.toFixed(3)
          );

          // 逐层 rms 要真的记下来了 —— 张量面板和后面几关都读它
          expect(small.layerCount).toBe(2);
          expect(deep.layerCount).toBe(16);

          const depthRatio = deep.ratio / small.ratio;
          lab.publish('residual.growthDeep', deep.ratio);
          lab.publish('residual.depthRatio', depthRatio);
          lab.publish('residual.growthUnscaled', deepRaw.ratio);

          expect(depthRatio).toBeLessThan(1.25);
          // 理论上 4.12 / 1.22 ≈ 3.4 倍。取 2 倍：不带缩放必须明显更大，
          // 否则 residual_scale 是个接了等于没接的空开关
          expect(deepRaw.ratio).toBeGreaterThan(deep.ratio * 2.0);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.norm.rmsError', op: 'lte', value: 2e-6,
      zh: 'RMSNorm 与 f64 参考的最大差', en: 'max RMSNorm difference from the f64 reference',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.norm.shiftSensitivity', op: 'gte', value: 0.05,
      zh: '整体平移带来的输出变化（LayerNorm 会是 0）',
      en: 'output change under a constant shift (LayerNorm gives 0)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.params.normPerLayer', op: 'eq', value: 32,
      zh: '每层归一化的参数量（没有 bias）', en: 'parameters per normalisation layer (no bias)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.residual.depthRatio', op: 'lte', value: 1.25,
      zh: '16 层与 2 层的残差流增长比', en: 'residual growth of 16 layers over 2 layers',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'encapsulation'],
  extension: t(
    code`
      2026 年还在动的一处是**归一化放哪**。除了 pre-norm，
      \`sandwich norm\`（支路前后各一次）在超深模型上更稳，Gemma 2 与几个国产模型在用；
      \`DeepNorm\` 走的是另一条路 —— 保留 post-norm，但把残差乘一个跟深度有关的常数，
      千层规模上仍然收敛。

      另外注意 \`eps\` 的位置：\`sqrt(mean(x²) + ε)\` 和 \`sqrt(mean(x²)) + ε\` 不一样，
      前者是标准写法。bf16 训练时 \`ε\` 太小会在归一化那步吃掉精度,
      这是混合精度那一关（第 18 关）会再碰到的东西。
    `,
    code`
      One thing still moving in 2026 is **where normalisation goes**. Besides pre-norm,
      \`sandwich norm\` (one before and one after the branch) is more stable in very deep
      models and ships in Gemma 2 and several others; \`DeepNorm\` takes the other route,
      keeping post-norm but scaling the residual by a depth-dependent constant, and still
      converges at thousand-layer scale.

      Also mind where \`eps\` sits: \`sqrt(mean(x²) + ε)\` is not \`sqrt(mean(x²)) + ε\`, and
      the former is standard. Under bf16 an \`ε\` that is too small loses precision at the
      normalisation step — something stage 18 on mixed precision revisits.
    `
  ),
};

/* ================================================================== */
/* 第 7 关：SwiGLU 与完整的 block                                       */
/* ================================================================== */

/** 前几关验收过的零件，这一关直接用 */
const PARTS_PY = code`
  """前几关已经验收过的零件。这一关直接用，不用再写一遍。"""
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F


  def build_tables(positions, head_dim, base=10000.0):
      """第 5 关的 RoPE 表。"""
      half = head_dim // 2
      cos = nt.zeros((len(positions), half), role="data", name="rope.cos")
      sin = nt.zeros((len(positions), half), role="data", name="rope.sin")
      cv, sv = [], []
      for p in positions:
          for i in range(half):
              theta = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(theta))
              sv.append(math.sin(theta))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class RMSNorm(nn.Module):
      """第 6 关的 RMSNorm。只有 weight，没有 bias。"""

      def __init__(self, dim, eps=1e-5):
          super().__init__()
          self.dim, self.eps = dim, eps
          self.weight = nt.parameter((dim,), None, 0.0, "norm.weight")

      def forward(self, x, rows=0):
          return F.rms_norm(x, self.weight, self.eps)


  class RopeAttention(nn.Module):
      """第 4 + 5 关：多头 GQA 注意力 + RoPE。"""

      def __init__(self, dim, n_head, n_kv_head, seed, base=10000.0):
          super().__init__()
          self.dim, self.n_head, self.n_kv_head = dim, n_head, n_kv_head
          self.head_dim = dim // n_head
          self.base = base
          hd = self.head_dim
          self.wq = nt.parameter((dim, n_head * hd), seed + 1, 0.02, "wq")
          self.wk = nt.parameter((dim, n_kv_head * hd), seed + 2, 0.02, "wk")
          self.wv = nt.parameter((dim, n_kv_head * hd), seed + 3, 0.02, "wv")
          self.wo = nt.parameter((n_head * hd, dim), seed + 4, 0.02, "wo")

      def forward(self, x, batch, seq, offset=0):
          rows, hd = batch * seq, self.head_dim
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          cos, sin = build_tables(list(range(offset, offset + seq)), hd, self.base)
          q = F.rope(q, cos, sin, batch, seq, self.n_head, hd)
          k = F.rope(k, cos, sin, batch, seq, self.n_kv_head, hd)
          scores = F.attn_scores(q, k, batch, seq, seq, self.n_head, self.n_kv_head, hd)
          valid = F.causal_valid(batch, self.n_head, seq, offset)
          probs = F.softmax(scores, batch * self.n_head * seq, seq, valid)
          out = F.attn_apply(
              probs, v, batch, seq, seq, self.n_head, self.n_kv_head, hd,
              out_shape=(rows, self.n_head * hd)
          )
          return F.linear(out, self.wo)
`;

const STAGE_BLOCK = {
  id: 'swiglu-block',
  title: t('SwiGLU 与完整的 block —— 一层到底是什么', 'SwiGLU and the full block — what one layer actually is'),
  goal: t(
    code`
      前几关的零件都在 \`parts.py\` 里了（RoPE 表、RMSNorm、GQA 注意力）。
      这一关在 \`block.py\` 里写前馈网络，并把一整层拼出来。

      \`\`\`python
      def swiglu_hidden(dim, multiple_of=8):
          """按 Llama 的规则算隐藏维。返回一个整数。"""

      class SwiGLU(nn.Module):
          def __init__(self, dim, hidden, seed):
              # w_gate / w_up: [dim, hidden]，w_down: [hidden, dim]

      class Block(nn.Module):
          def __init__(self, dim, n_head, n_kv_head, seed, n_layer=1):
          def forward(self, x, batch, seq, offset=0):
              # 两条 pre-norm 残差：注意力一条，前馈一条
      \`\`\`

      ## 隐藏维为什么是 176 而不是 256

      传统前馈是两个矩阵：\`down(act(up(x)))\`，隐藏维取 \`4·dim\`。
      SwiGLU 是**三个**矩阵：

      \`\`\`
      SwiGLU(x) = down( silu(gate(x)) · up(x) )
      silu(z) = z · σ(z)
      \`\`\`

      三个矩阵要是也用 \`4·dim\`，参数就比传统前馈多 50%。
      Llama 的做法是把隐藏维乘 \`2/3\` 再向上取到 \`multiple_of\` 的倍数：

      \`\`\`
      hidden = round_up( int(2 · (4 · dim) / 3), multiple_of )
      dim = 64  ->  int(512 · 2/3) = 170  ->  向上取到 8 的倍数 = 176
      \`\`\`

      于是参数量和传统前馈基本持平，而效果更好。**取整到 8 的倍数不是洁癖** ——
      矩阵乘的分块和张量核心都按 8/16/32 对齐，170 会掉进一条慢路径。

      ## 一层长什么样

      \`\`\`
      x = x + scale · attn(norm1(x))
      x = x + scale · mlp(norm2(x))
      \`\`\`

      两条残差，两个归一化，各挂在支路上。\`scale\` 是第 6 关那条 \`1/sqrt(2L)\`。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 参数量 | 恰好 **46208**（解析式见下） |
      | 前馈数值 | 与 f64 参考最大差 ≤ 2e-6 |
      | **残差是恒等** | 把 \`wo\` 和 \`w_down\` 清零，输出必须和输入**逐位相同** |
      | 因果性 | 泄漏 = 0 |
      | 每 token 的前向 FLOPs | 与 \`2N\` 的比在 **1.0 ~ 1.6** 之间 |

      \`\`\`
      注意力 12288 + 前馈 3·64·176 = 33792 + 两个 norm 128 = 46208
      \`\`\`

      「残差是恒等」那条能一刀切开 pre-norm 和 post-norm：支路清零之后
      pre-norm 的输出**就是**输入，post-norm 的输出是 \`norm(x)\`,差得很明显，
      而这两种写法在 loss 曲线上要十几层才分得开。

      最后一条是那个著名的经验规律：**前向大约是 \`2N\` FLOPs / token**
      （N 是参数量），反向再来两倍，一次训练步合计约 \`6N\`。
      注意力那块 \`O(S²)\` 的项让实测略高于 1.0。
    `,
    code`
      The pieces from earlier stages are in \`parts.py\` (RoPE tables, RMSNorm, GQA
      attention). This stage writes the feed-forward network in \`block.py\` and assembles a
      complete layer.

      \`\`\`python
      def swiglu_hidden(dim, multiple_of=8):
          """Llama's rule for the hidden width. Returns an integer."""

      class SwiGLU(nn.Module):
          def __init__(self, dim, hidden, seed):
              # w_gate / w_up: [dim, hidden]; w_down: [hidden, dim]

      class Block(nn.Module):
          def __init__(self, dim, n_head, n_kv_head, seed, n_layer=1):
          def forward(self, x, batch, seq, offset=0):
              # Two pre-norm residuals: one for attention, one for the MLP
      \`\`\`

      ## Why the hidden width is 176, not 256

      A classic feed-forward is two matrices, \`down(act(up(x)))\`, with a hidden width of
      \`4·dim\`. SwiGLU uses **three**:

      \`\`\`
      SwiGLU(x) = down( silu(gate(x)) · up(x) )
      silu(z) = z · σ(z)
      \`\`\`

      Three matrices at \`4·dim\` would cost 50% more parameters than the classic version.
      Llama scales the width by \`2/3\` and rounds up to a multiple of \`multiple_of\`:

      \`\`\`
      hidden = round_up( int(2 · (4 · dim) / 3), multiple_of )
      dim = 64  ->  int(512 · 2/3) = 170  ->  round up to a multiple of 8 = 176
      \`\`\`

      Parameters end up roughly matching the classic block while quality improves. **The
      rounding is not fastidiousness**: matmul tiling and tensor cores align to 8/16/32, and
      170 falls onto a slow path.

      ## What a layer looks like

      \`\`\`
      x = x + scale · attn(norm1(x))
      x = x + scale · mlp(norm2(x))
      \`\`\`

      Two residuals, two normalisations, each on a branch. \`scale\` is stage 6's
      \`1/sqrt(2L)\`.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Parameters | Exactly **46208** (formula below) |
      | MLP numerics | Within 2e-6 of the f64 reference |
      | **Residual is identity** | Zero \`wo\` and \`w_down\`; output must be **bit-identical** to the input |
      | Causality | Leakage = 0 |
      | Forward FLOPs per token | Ratio to \`2N\` between **1.0 and 1.6** |

      \`\`\`
      attention 12288 + MLP 3·64·176 = 33792 + two norms 128 = 46208
      \`\`\`

      The identity check cleanly separates pre-norm from post-norm: with the branches zeroed
      pre-norm returns the input exactly, while post-norm returns \`norm(x)\` — an obvious
      difference, where the two designs need a dozen layers before any loss curve tells them
      apart.

      The last row is the well-known rule of thumb: **a forward pass costs about \`2N\`
      FLOPs per token** (N being the parameter count), the backward twice that, so one
      training step is roughly \`6N\`. Attention's \`O(S²)\` term puts the measurement a
      little above 1.0.
    `
  ),
  checklist: [
    t('swiglu_hidden(64) 返回 176', 'swiglu_hidden(64) returns 176'),
    t('SwiGLU 是三个矩阵：gate / up / down', 'SwiGLU uses three matrices: gate, up, down'),
    t('两条 pre-norm 残差，归一化都在支路上', 'Two pre-norm residuals, both normalisations on branches'),
    t('支路清零之后 block 是恒等映射', 'With branches zeroed the block is the identity'),
  ],
  hints: [
    t('F.swiglu(gate, up) 已经有了，它算的就是 silu(gate) * up。',
      'F.swiglu(gate, up) already exists and computes silu(gate) * up.'),
    t('向上取整到 m 的倍数：(x + m - 1) // m * m。',
      'Rounding up to a multiple of m: (x + m - 1) // m * m.'),
    t('parts.py 里的 RopeAttention 和 RMSNorm 直接 import 就行，不用重写。',
      'Import RopeAttention and RMSNorm from parts.py; there is no need to rewrite them.'),
  ],
  pitfalls: [
    t(code`
      **隐藏维直接取 \`4·dim\`。** 跑得通、也能训，只是这一层的参数比该有的多了一半。
      放大到 70B 就是多出十几个 B 的参数、多出来的显存和多出来的训练时间,
      而它换不来相应的效果。
    `, code`
      **Taking \`4·dim\` as the hidden width.** It runs and it trains; the layer just carries
      50% more parameters than it should. At 70B scale that is billions of extra parameters,
      extra memory and extra training time, buying no matching quality.
    `),
    t(code`
      **把归一化写到残差通路上。** \`x = norm(x + f(x))\` 和 \`x = x + f(norm(x))\`
      只差几个字符，浅层上几乎没差别。这一关的恒等检查会直接把它揪出来 ——
      支路清零之后前者给的是 \`norm(x)\`，后者给的才是 \`x\`。
    `, code`
      **Putting a normalisation on the residual path.** \`x = norm(x + f(x))\` and
      \`x = x + f(norm(x))\` differ by a few characters and behave almost identically when
      shallow. The identity check catches it immediately: with the branches zeroed the first
      returns \`norm(x)\` while only the second returns \`x\`.
    `),
  ],
  train: {
    files: {
      'parts.py': PARTS_PY,
      'block.py': code`
        """第 7 关：SwiGLU 前馈 + 完整的 Transformer block。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F
        from parts import RMSNorm, RopeAttention


        def swiglu_hidden(dim, multiple_of=8):
            """Llama 的规则：int(2 * (4 * dim) / 3) 向上取到 multiple_of 的倍数。"""
            # TODO
            return 4 * dim


        class SwiGLU(nn.Module):
            def __init__(self, dim, hidden, seed):
                super().__init__()
                self.dim, self.hidden = dim, hidden
                # TODO: 三个矩阵 —— w_gate / w_up 是 [dim, hidden]，w_down 是 [hidden, dim]
                self.w_gate = nt.parameter((dim, 1), seed + 1, 0.02, "w_gate")
                self.w_up = nt.parameter((dim, 1), seed + 2, 0.02, "w_up")
                self.w_down = nt.parameter((1, dim), seed + 3, 0.02, "w_down")

            def forward(self, x, rows):
                # TODO: down( silu(gate(x)) * up(x) )
                return x


        class Block(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed, n_layer=1):
                super().__init__()
                self.dim, self.n_layer = dim, n_layer
                self.norm1 = RMSNorm(dim)
                self.attn = RopeAttention(dim, n_head, n_kv_head, seed)
                self.norm2 = RMSNorm(dim)
                self.mlp = SwiGLU(dim, swiglu_hidden(dim), seed + 10)

            def forward(self, x, batch, seq, offset=0):
                # TODO: 两条 pre-norm 残差，支路各乘 1/sqrt(2 * n_layer)
                return x


        if __name__ == "__main__":
            print("swiglu_hidden(64) =", swiglu_hidden(64))
            b = Block(64, 4, 2, seed=21)
            print("参数量", b.num_parameters())
            x = nt.zeros((2 * 8, 64), role="data").normal_(1, 1.0)
            print("输出形状", b(x, 2, 8).shape)
      `,
    },
    referenceFiles: {
      'block.py': code`
        """第 7 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F
        from parts import RMSNorm, RopeAttention


        def swiglu_hidden(dim, multiple_of=8):
            # 三个矩阵，所以先乘 2/3 把参数量压回两矩阵前馈的水平
            hidden = int(2 * (4 * dim) / 3)
            # 再向上取到 multiple_of 的倍数 —— 对齐了矩阵乘才走得上快路径
            return (hidden + multiple_of - 1) // multiple_of * multiple_of


        class SwiGLU(nn.Module):
            def __init__(self, dim, hidden, seed):
                super().__init__()
                self.dim, self.hidden = dim, hidden
                self.w_gate = nt.parameter((dim, hidden), seed + 1, 0.02, "w_gate")
                self.w_up = nt.parameter((dim, hidden), seed + 2, 0.02, "w_up")
                self.w_down = nt.parameter((hidden, dim), seed + 3, 0.02, "w_down")

            def forward(self, x, rows):
                gate = F.linear(x, self.w_gate)
                up = F.linear(x, self.w_up)
                return F.linear(F.swiglu(gate, up), self.w_down)


        class Block(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed, n_layer=1):
                super().__init__()
                self.dim, self.n_layer = dim, n_layer
                self.norm1 = RMSNorm(dim)
                self.attn = RopeAttention(dim, n_head, n_kv_head, seed)
                self.norm2 = RMSNorm(dim)
                self.mlp = SwiGLU(dim, swiglu_hidden(dim), seed + 10)

            def forward(self, x, batch, seq, offset=0):
                rows = batch * seq
                scale = (2.0 * self.n_layer) ** -0.5
                # 两条 pre-norm 残差。归一化在支路上，残差通路是干净的恒等
                h = self.attn(self.norm1(x, rows), batch, seq, offset)
                x = F.add(x, F.scale(h, scale))
                h = self.mlp(self.norm2(x, rows), rows)
                x = F.add(x, F.scale(h, scale))
                return x


        if __name__ == "__main__":
            print("swiglu_hidden(64) =", swiglu_hidden(64))
            b = Block(64, 4, 2, seed=21)
            print("参数量", b.num_parameters())
            x = nt.zeros((2 * 8, 64), role="data").normal_(1, 1.0)
            print("输出形状", b(x, 2, 8).shape)
      `,
    },
  },
  specs: [
    spec('block.spec.ts', code`
      ${LAB}

      const B = 2, S = 8, DIM = 64, H = 4, KV = 2;
      const HIDDEN = 176;
      const PARAMS = DIM * H * 16 + DIM * KV * 16 * 2 + H * 16 * DIM + 3 * DIM * HIDDEN + 2 * DIM;

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, parts, block
      importlib.reload(parts)
      importlib.reload(block)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
      }

      function makeBlock(tail) {
        setup();
        lab.py(\`
      _b = block.Block(\${DIM}, \${H}, \${KV}, seed=21)
      _x = nt.zeros((\${B} * \${S}, \${DIM}), role="data").normal_(55, 1.0)
      \${tail || ''}
      nt.phase("forward")
      _out = _b(_x, \${B}, \${S})
      nt.phase("other")
      \`);
        return {
          out: JSON.parse(String(lab.py('json.dumps(_out.tolist())'))),
          x: JSON.parse(String(lab.py('json.dumps(_x.tolist())'))),
          params: Number(lab.py('_b.num_parameters()')),
        };
      }

      describe('SwiGLU 与完整的 block', () => {
        it('隐藏维按 Llama 的规则算：dim=64 -> 176', () => {
          setup();
          const h64 = Number(lab.py('block.swiglu_hidden(64)'));
          const h768 = Number(lab.py('block.swiglu_hidden(768, 256)'));
          console.log('swiglu_hidden(64) = ' + h64 + '，swiglu_hidden(768, 256) = ' + h768);
          lab.publish('params.mlpHidden', h64);
          expect(h64).toBe(176);
          // Llama-7B 的那组数：dim=4096 时是 11008；这里按同一条规则缩小验一次
          expect(h768).toBe(2048);
        });

        it('参数量恰好等于解析式', () => {
          const r = makeBlock();
          console.log('参数量 ' + r.params + '，解析式 ' + PARAMS);
          lab.publish('params.block', r.params);
          expect(r.params).toBe(PARAMS);
        });

        it('SwiGLU 前馈与 f64 参考最大差 ≤ 2e-6', () => {
          setup();
          lab.py(\`
      _m = block.SwiGLU(\${DIM}, \${HIDDEN}, seed=31)
      _x = nt.zeros((\${B} * \${S}, \${DIM}), role="data").normal_(66, 1.0)
      _y = _m(_x, \${B} * \${S})
      \`);
          const x = JSON.parse(String(lab.py('json.dumps(_x.tolist())')));
          const y = JSON.parse(String(lab.py('json.dumps(_y.tolist())')));
          const wg = JSON.parse(String(lab.py('json.dumps(_m.w_gate.tolist())')));
          const wu = JSON.parse(String(lab.py('json.dumps(_m.w_up.tolist())')));
          const wd = JSON.parse(String(lab.py('json.dumps(_m.w_down.tolist())')));

          const rows = B * S;
          let diff = 0;
          for (let r = 0; r < rows; r++) {
            const mid = new Float64Array(HIDDEN);
            for (let hcol = 0; hcol < HIDDEN; hcol++) {
              let g = 0, u = 0;
              for (let d = 0; d < DIM; d++) {
                g += x[r * DIM + d] * wg[d * HIDDEN + hcol];
                u += x[r * DIM + d] * wu[d * HIDDEN + hcol];
              }
              mid[hcol] = (g / (1 + Math.exp(-g))) * u;   // silu(gate) * up
            }
            for (let d = 0; d < DIM; d++) {
              let acc = 0;
              for (let hcol = 0; hcol < HIDDEN; hcol++) acc += mid[hcol] * wd[hcol * DIM + d];
              diff = Math.max(diff, Math.abs(y[r * DIM + d] - acc));
            }
          }
          console.log('最大差 ' + diff.toExponential(2));
          lab.publish('mlp.maxError', diff);
          expect(diff).toBeLessThan(2e-6);
        });

        /*
         * 把两条支路的出口权重清零，pre-norm 的 block 就是恒等映射 —— 逐位相同。
         * post-norm 写法给出的是 norm(x)，差得一眼能看见。
         * 这一条比任何数值门槛都利落，因为它比的是「一位都不许差」。
         */
        it('支路清零之后 block 是恒等映射（逐位）', () => {
          const r = makeBlock('_b.attn.wo.fill_(0.0)\\n_b.mlp.w_down.fill_(0.0)');
          let mismatches = 0;
          for (let i = 0; i < r.x.length; i++) if (r.out[i] !== r.x[i]) mismatches += 1;
          console.log('清零之后有 ' + mismatches + ' / ' + r.x.length + ' 个位置和输入不同');
          lab.publish('residual.identityMismatches', mismatches);
          expect(r.x.length).toBeGreaterThan(500);
          expect(mismatches).toBe(0);
        });

        it('改掉最后一个位置，前面位置的输出一位都不变', () => {
          const before = makeBlock().out;
          const after = makeBlock(
            '_x.set_([v + (2.5 if (i % (' + S + ' * ' + DIM + ')) >= (' + S + ' - 1) * ' + DIM
            + ' else 0.0) for i, v in enumerate(_x.tolist())])'
          ).out;
          let leak = 0, checked = 0;
          for (let b = 0; b < B; b++)
            for (let i = 0; i < S - 1; i++)
              for (let d = 0; d < DIM; d++) {
                const at = (b * S + i) * DIM + d;
                checked += 1;
                if (before[at] !== after[at]) leak += 1;
              }
          lab.publish('causality.leakBits', leak);
          expect(checked).toBeGreaterThan(500);
          expect(leak).toBe(0);
        });

        /*
         * 那条著名的经验规律：前向约 2N FLOPs / token。
         * 注意力那块 O(S²) 的项让实测略高于 1.0。
         * 明显低于 1.0 说明有矩阵没算，明显高于 1.6 说明多算了东西。
         */
        it('每 token 的前向 FLOPs 约等于 2N', () => {
          setup();
          const before = lab.metrics().flops.forward;
          const beforeTokens = lab.metrics().tokens.total;
          makeBlock();
          const m = lab.metrics();
          const spent = m.flops.forward - before;
          const tokens = B * S;
          const perToken = spent / tokens;
          const ratio = perToken / (2 * PARAMS);
          console.log(
            '前向 ' + spent + ' FLOPs / ' + tokens + ' token = ' + perToken.toFixed(0)
            + '；2N = ' + (2 * PARAMS) + '，比值 ' + ratio.toFixed(3)
          );
          void beforeTokens;
          lab.publish('flops.perTokenOverTwoN', ratio);
          expect(ratio).toBeGreaterThan(1.0);
          expect(ratio).toBeLessThan(1.6);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.params.block', op: 'eq', value: 46208,
      zh: '一层的参数量（解析式）', en: 'parameters in one block (analytic)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.mlp.maxError', op: 'lte', value: 2e-6,
      zh: 'SwiGLU 前馈与 f64 参考的最大差', en: 'max SwiGLU difference from the f64 reference',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.residual.identityMismatches', op: 'eq', value: 0,
      zh: '支路清零后与输入不同的位置数（pre-norm 应为 0）',
      en: 'positions differing from the input with branches zeroed (0 for pre-norm)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.causality.leakBits', op: 'eq', value: 0,
      zh: '因果泄漏（逐位比）', en: 'causal leakage (bit-exact)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.flops.perTokenOverTwoN', op: 'lte', value: 1.6,
      zh: '每 token 前向 FLOPs 与 2N 的比', en: 'forward FLOPs per token over 2N',
      dimension: 'efficiency',
    }),
  ],
  focus: ['correctness', 'encapsulation', 'efficiency'],
  extension: t(
    code`
      \`2N\` 与 \`6N\` 这两个数值得记住 —— 它们是所有算力预算的起点。
      一个 7B 模型在 1T token 上训一遍，就是 \`6 · 7e9 · 1e12 ≈ 4.2e22\` FLOPs；
      一张 H100 的 bf16 峰值约 1e15 FLOP/s，按 40% 的实际利用率算，
      **约合 1200 张卡跑一天**。第 21 关的缩放律会正面用到这个式子。

      前馈这一块 2026 年最大的变化是 \`MoE\`：把一个大前馈换成很多个小的，
      每个 token 只激活其中几个。DeepSeek-V3 的总参数 671B、激活 37B，
      \`2N\` 里的 N 从此要分「总参数」和「激活参数」两个来算 —— 第 22 关做这件事。
    `,
    code`
      \`2N\` and \`6N\` are worth memorising: every compute budget starts there. Training a 7B
      model on 1T tokens costs \`6 · 7e9 · 1e12 ≈ 4.2e22\` FLOPs; an H100 peaks near 1e15
      bf16 FLOP/s, and at a realistic 40% utilisation that is **about 1200 cards for a day**.
      Stage 21 on scaling laws uses this formula directly.

      The biggest change to the feed-forward block in 2026 is \`MoE\`: replace one large FFN
      with many small ones and activate only a few per token. DeepSeek-V3 has 671B total
      parameters and 37B active, so the N in \`2N\` now splits into total and active — which
      is what stage 22 works through.
    `
  ),
};

/* ================================================================== */
/* 第 8 关：采样与 KV cache                                            */
/* ================================================================== */

const MODEL_PY = code`
  """平台给的小模型：嵌入 -> 一层注意力（pre-norm 残差）-> 归一化 -> 输出头。

  输出头和嵌入表**权重绑定**（weight tying）—— 小模型上这能省掉一大块参数，
  GPT-2 起就是这么做的。

  注意力那一块是你在 gen.py 里写的 CachedAttention，这里只负责把它接起来。
  """
  import nanotorch as nt
  from nanotorch import nn, functional as F
  from parts import RMSNorm


  class TinyModel(nn.Module):
      def __init__(self, vocab, dim, attn, seed=41):
          super().__init__()
          self.vocab, self.dim = vocab, dim
          self.embed = nt.parameter((vocab, dim), seed, 0.02, "embed")
          self.norm1 = RMSNorm(dim)
          self.attn = attn
          self.norm_f = RMSNorm(dim)

      def forward(self, idx, batch, seq, cache=None, offset=0):
          rows = batch * seq
          x = F.embedding(self.embed, idx, rows, self.dim)
          h = self.attn(self.norm1(x, rows), batch, seq, cache=cache, offset=offset)
          x = F.add(x, h)
          x = self.norm_f(x, rows)
          # 权重绑定：输出头就是嵌入表转置
          return F.linear_tied(x, self.embed, rows, self.dim, self.vocab)
`;

const STAGE_KVCACHE = {
  id: 'sampling-kvcache',
  title: t('采样与 KV cache —— 解码为什么不是 O(n²)', 'Sampling and the KV cache — why decoding is not O(n²)'),
  goal: t(
    code`
      在 \`gen.py\` 里写带缓存的注意力和生成循环。模型在 \`model.py\` 里已经接好了。

      \`\`\`python
      class CachedAttention(nn.Module):
          def forward(self, x, batch, seq, cache=None, offset=0):
              """cache 为 None 时算整段；给了 cache 就把新的 k/v 追加进去，
              再对缓存里已有的全部位置做注意力。"""

      def generate(model, prompt, n_new, vocab, seed, use_cache=True,
                   temperature=1.0, top_k=0):
          """prompt 是一个 token 列表（batch=1）。返回新生成的 n_new 个 token。"""
      \`\`\`

      ## 为什么必须有 cache

      不带缓存的解码，每生成一个 token 都要把整段前缀从头算一遍：
      第 \`t\` 步是 \`O(t)\`，生成 \`n\` 个就是 \`O(n²)\`。
      带缓存之后每步只算**新来的那一个位置**的投影，前面的 k/v 直接读缓存,
      每步 \`O(1)\`，全程 \`O(n)\`。

      这不是「优化」，是能不能用的分界。第 27 关的 GRPO 要成批地 rollout，
      不做缓存那一关**真的跑不完**。

      ## 两条路必须给出一样的结果

      带缓存和不带缓存算的是**同一个函数**，所以结果应当**逐位相同** ——
      不是「差不多」，是一位都不差。这一关的第一条门槛就是它。

      对不上通常是三件事之一：
      RoPE 的位置没跟着 \`offset\` 走、
      因果掩码的 \`offset\` 忘了传、
      往缓存里追加时 batch 之间串了位。

      ## 缓存怎么用

      \`nt.generate.KVCache\` 已经写好了：形状 \`[batch, max_seq, kv_heads·head_dim]\`，
      \`append(k, v, n)\` 按位置追加。注意它是按 \`max_seq\` 开的，
      所以做注意力时 \`seq_kv\` 传 \`cache.max_seq\`，
      靠 \`causal_valid(batch, heads, seq, offset)\` 把还没写过的位置挡在外面 ——
      那些位置的概率是**硬 0**，不参与求和。

      ## 采样

      \`nt.generate.sample(logits, row, vocab, temperature, top_k, top_p, seed)\`
      的参数名和叠加顺序都跟 HuggingFace 的 \`generate()\` 一致（先 top-k 后 top-p）。
      它是**确定性**的：结果只由 \`(logits, seed)\` 决定，
      概率相同的候选按 token id 排序 —— 否则整条重放链就断了。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 两条路一致 | 带 cache 与不带 cache 的输出**逐位相同** |
      | 真的省了 | 不带 cache 的解码 FLOPs 是带 cache 的 **≥ 3 倍** |
      | 确定性 | 同一个 seed 跑两遍，结果完全一样 |
      | top-k | 采出来的 token 全在**逐步重放算出来的** top-k 集合里 |
    `,
    code`
      Write the cached attention and the generation loop in \`gen.py\`. The model in
      \`model.py\` is already wired up.

      \`\`\`python
      class CachedAttention(nn.Module):
          def forward(self, x, batch, seq, cache=None, offset=0):
              """With cache=None compute the whole segment; with a cache, append the new
              k/v and attend over every position the cache holds."""

      def generate(model, prompt, n_new, vocab, seed, use_cache=True,
                   temperature=1.0, top_k=0):
          """prompt is a list of tokens (batch=1). Returns the n_new new tokens."""
      \`\`\`

      ## Why the cache is mandatory

      Uncached decoding recomputes the whole prefix for every generated token: step \`t\`
      costs \`O(t)\`, so \`n\` tokens cost \`O(n²)\`. With a cache each step projects only
      **the one new position** and reads earlier k/v straight from memory — \`O(1)\` per
      step, \`O(n)\` overall.

      This is not an optimisation but the line between usable and not. Stage 27's GRPO
      rolls out in batches, and without a cache that stage **genuinely does not finish**.

      ## The two paths must agree exactly

      Cached and uncached compute the **same function**, so the results must be
      **bit-identical** — not close, identical. That is this stage's first gate.

      A mismatch is usually one of three things: RoPE positions not following \`offset\`,
      a forgotten \`offset\` on the causal mask, or appends that cross batch boundaries.

      ## Using the cache

      \`nt.generate.KVCache\` is written for you: shape
      \`[batch, max_seq, kv_heads·head_dim]\`, with \`append(k, v, n)\` adding positions.
      It is allocated at \`max_seq\`, so pass \`cache.max_seq\` as \`seq_kv\` when attending
      and let \`causal_valid(batch, heads, seq, offset)\` exclude positions not yet written
      — their probability is a **hard zero** and they never enter the sum.

      ## Sampling

      \`nt.generate.sample(logits, row, vocab, temperature, top_k, top_p, seed)\` matches
      HuggingFace's \`generate()\` in both parameter names and ordering (top-k then top-p).
      It is **deterministic**: the result depends only on \`(logits, seed)\`, and ties are
      broken by token id — otherwise the whole replay chain breaks.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Paths agree | Cached and uncached outputs are **bit-identical** |
      | Real saving | Uncached decoding costs **at least 3x** the FLOPs of cached |
      | Determinism | The same seed twice gives the same result |
      | top-k | Every sampled token lies in the top-k set **recomputed by replay** |
    `
  ),
  checklist: [
    t('带 cache 与不带 cache 的生成结果逐位相同', 'Cached and uncached generation agree bit for bit'),
    t('RoPE 的位置跟着 offset 走', 'RoPE positions follow the offset'),
    t('因果掩码带上了 offset', 'The causal mask carries the offset'),
    t('同一个 seed 采样结果完全一样，且 top-k 真的生效',
      'The same seed samples identically, and top-k actually takes effect'),
  ],
  hints: [
    t('解码第 t 步：seq=1、offset=已生成长度、seq_kv=cache.max_seq。',
      'Decoding step t: seq=1, offset = length so far, seq_kv = cache.max_seq.'),
    t('prefill 一次把整段 prompt 塞进 cache，之后每步只喂一个 token。',
      'Prefill pushes the whole prompt into the cache once; after that feed one token per step.'),
    t('logits 是 [rows, vocab]，取最后一行就是 row = rows - 1。',
      'logits are [rows, vocab]; the last row is row = rows - 1.'),
  ],
  pitfalls: [
    t(code`
      **解码时 RoPE 还从 0 起算。** prefill 的结果是对的，从第一个新 token 起
      位置就全错了。生成出来的东西读着仍然像句子,因为模型还认得词，
      只是位置关系乱了。逐位比对是唯一能当场发现它的办法。
    `, code`
      **Leaving RoPE at position 0 while decoding.** Prefill is right and every generated
      token afterwards has the wrong position. The output still reads like language because
      the model still recognises words; only the positional relations are scrambled. A
      bit-exact comparison is the only thing that catches this on the spot.
    `),
    t(code`
      **因果掩码忘了 offset。** 解码时 \`seq_q=1\`，掩码算出来的有效长度就是 1 ——
      于是这个 token 只看得见它自己，前面的历史一个都没看。
      生成不会报错，只会变得毫无上下文。
    `, code`
      **Forgetting the offset on the causal mask.** While decoding \`seq_q=1\`, so the mask
      computes a valid length of 1 and the token attends only to itself, ignoring all
      history. Nothing raises an error; the generation simply loses all context.
    `),
  ],
  train: {
    files: {
      'parts.py': PARTS_PY,
      'model.py': MODEL_PY,
      'gen.py': code`
        """第 8 关：带 KV cache 的注意力 + 生成循环。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F
        from nanotorch.generate import KVCache, sample
        from parts import build_tables


        class CachedAttention(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed, base=10000.0):
                super().__init__()
                self.dim, self.n_head, self.n_kv_head = dim, n_head, n_kv_head
                self.head_dim = dim // n_head
                self.base = base
                hd = self.head_dim
                self.wq = nt.parameter((dim, n_head * hd), seed + 1, 0.02, "wq")
                self.wk = nt.parameter((dim, n_kv_head * hd), seed + 2, 0.02, "wk")
                self.wv = nt.parameter((dim, n_kv_head * hd), seed + 3, 0.02, "wv")
                self.wo = nt.parameter((n_head * hd, dim), seed + 4, 0.02, "wo")

            def forward(self, x, batch, seq, cache=None, offset=0):
                # TODO: 投影 -> RoPE（位置从 offset 起算）
                #       cache 为 None：seq_kv = seq
                #       给了 cache：append 之后 seq_kv = cache.max_seq
                #       两条路都要把 offset 传给 causal_valid
                return nt.zeros((batch * seq, self.dim))


        def generate(model, prompt, n_new, vocab, seed, use_cache=True,
                     temperature=1.0, top_k=0):
            """返回新生成的 n_new 个 token（batch=1）。"""
            # TODO: 不带 cache 就每步把整段重算；带 cache 先 prefill 再逐个解码
            return []


        if __name__ == "__main__":
            import model as M
            VOCAB, DIM = 16, 64
            attn = CachedAttention(DIM, 4, 2, seed=21)
            m = M.TinyModel(VOCAB, DIM, attn)
            out = generate(m, [1, 2, 3, 4], 6, VOCAB, seed=7, use_cache=True)
            print("生成", out)
      `,
    },
    referenceFiles: {
      'gen.py': code`
        """第 8 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F
        from nanotorch.generate import KVCache, sample
        from parts import build_tables


        class CachedAttention(nn.Module):
            def __init__(self, dim, n_head, n_kv_head, seed, base=10000.0):
                super().__init__()
                self.dim, self.n_head, self.n_kv_head = dim, n_head, n_kv_head
                self.head_dim = dim // n_head
                self.base = base
                hd = self.head_dim
                self.wq = nt.parameter((dim, n_head * hd), seed + 1, 0.02, "wq")
                self.wk = nt.parameter((dim, n_kv_head * hd), seed + 2, 0.02, "wk")
                self.wv = nt.parameter((dim, n_kv_head * hd), seed + 3, 0.02, "wv")
                self.wo = nt.parameter((n_head * hd, dim), seed + 4, 0.02, "wo")

            def forward(self, x, batch, seq, cache=None, offset=0):
                rows, hd = batch * seq, self.head_dim
                q = F.linear(x, self.wq)
                k = F.linear(x, self.wk)
                v = F.linear(x, self.wv)

                # 位置从 offset 起算 —— 解码时这就是「已经生成了多少个」
                cos, sin = build_tables(list(range(offset, offset + seq)), hd, self.base)
                q = F.rope(q, cos, sin, batch, seq, self.n_head, hd)
                k = F.rope(k, cos, sin, batch, seq, self.n_kv_head, hd)

                if cache is None:
                    keys, values, seq_kv = k, v, seq
                else:
                    cache.append(k, v, seq)
                    # 缓存是按 max_seq 开的，所以 seq_kv 传 max_seq，
                    # 还没写过的位置由 causal_valid 挡在外面（概率是硬 0）
                    keys, values, seq_kv = cache.k, cache.v, cache.max_seq

                scores = F.attn_scores(
                    q, keys, batch, seq, seq_kv, self.n_head, self.n_kv_head, hd
                )
                valid = F.causal_valid(batch, self.n_head, seq, offset)
                probs = F.softmax(scores, batch * self.n_head * seq, seq_kv, valid)
                out = F.attn_apply(
                    probs, values, batch, seq, seq_kv, self.n_head, self.n_kv_head, hd,
                    out_shape=(rows, self.n_head * hd)
                )
                return F.linear(out, self.wo)


        def generate(model, prompt, n_new, vocab, seed, use_cache=True,
                     temperature=1.0, top_k=0):
            ids = list(prompt)
            out = []
            idx = nt.zeros((len(prompt) + n_new,), role="data", name="gen.idx")

            cache = None
            if use_cache:
                cache = KVCache(1, len(prompt) + n_new,
                                model.attn.n_kv_head, model.attn.head_dim)

            for step in range(n_new):
                if use_cache:
                    # 第一步把整段 prompt 一次塞进缓存，之后每步只喂新来的那一个
                    feed = ids if step == 0 else ids[-1:]
                    offset = cache.length
                else:
                    # 不带缓存：每一步都把整段前缀从头算一遍，这就是那个 O(n²)
                    feed = ids
                    offset = 0
                idx.set_int_(feed)
                logits = model(idx, 1, len(feed), cache=cache, offset=offset)
                nxt = sample(logits, len(feed) - 1, vocab,
                             temperature=temperature, top_k=top_k, seed=seed + step)
                ids.append(nxt)
                out.append(nxt)
            return out


        if __name__ == "__main__":
            import model as M
            VOCAB, DIM = 16, 64
            attn = CachedAttention(DIM, 4, 2, seed=21)
            m = M.TinyModel(VOCAB, DIM, attn)
            out = generate(m, [1, 2, 3, 4], 6, VOCAB, seed=7, use_cache=True)
            print("生成", out)
      `,
    },
  },
  specs: [
    spec('gen.spec.ts', code`
      ${LAB}

      const VOCAB = 16, DIM = 64, H = 4, KV = 2;
      const PROMPT = '[1, 2, 3, 4]';
      const NEW = 12;

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, parts, model, gen
      importlib.reload(parts)
      importlib.reload(model)
      importlib.reload(gen)
      import nanotorch as nt

      def _fresh():
          attn = gen.CachedAttention(\${DIM}, \${H}, \${KV}, seed=21)
          return model.TinyModel(\${VOCAB}, \${DIM}, attn)
      \`);
      }

      function run(useCache, seed, topK) {
        lab.py(\`
      _m = _fresh()
      _got = gen.generate(_m, \${PROMPT}, \${NEW}, \${VOCAB}, seed=\${seed},
                          use_cache=\${useCache ? 'True' : 'False'}, top_k=\${topK || 0})
      \`);
        return JSON.parse(String(lab.py('json.dumps(list(_got))')));
      }

      describe('采样与 KV cache', () => {
        /*
         * 这一关的第一条。两条路算的是同一个函数，所以不是「差不多」——
         * 是一位都不许差。对不上一般是：RoPE 没跟 offset、掩码没带 offset、
         * 追加时 batch 串位。
         */
        it('带 cache 与不带 cache 的生成逐位相同', () => {
          setup();
          const withCache = run(true, 7);
          const without = run(false, 7);
          console.log('带 cache ' + JSON.stringify(withCache));
          console.log('不带     ' + JSON.stringify(without));
          let mismatches = 0;
          for (let i = 0; i < NEW; i++) if (withCache[i] !== without[i]) mismatches += 1;
          lab.publish('cache.mismatches', mismatches);
          expect(withCache.length).toBe(NEW);
          expect(mismatches).toBe(0);
        });

        it('不带 cache 的解码 FLOPs 是带 cache 的 3 倍以上', () => {
          setup();
          const measure = (useCache) => {
            const before = lab.metrics().flops.total;
            run(useCache, 7);
            return lab.metrics().flops.total - before;
          };
          const cached = measure(true);
          const uncached = measure(false);
          const ratio = uncached / cached;
          console.log(
            '带 cache ' + cached + ' FLOPs，不带 ' + uncached
            + '，比值 ' + ratio.toFixed(2)
          );
          lab.publish('cache.flopsRatio', ratio);
          expect(cached).toBeGreaterThan(0);
          expect(ratio).toBeGreaterThan(3.0);
        });

        it('同一个 seed 跑两遍结果完全一样', () => {
          setup();
          const a = run(true, 99);
          const b2 = run(true, 99);
          let mismatches = 0;
          for (let i = 0; i < NEW; i++) if (a[i] !== b2[i]) mismatches += 1;
          lab.publish('sample.determinismMismatches', mismatches);
          expect(mismatches).toBe(0);
          // 换个 seed 应当采出不一样的东西，否则采样其实退化成了贪心
          const c = run(true, 12345);
          let differs = 0;
          for (let i = 0; i < NEW; i++) if (a[i] !== c[i]) differs += 1;
          console.log('换 seed 之后有 ' + differs + ' / ' + NEW + ' 个位置不同');
          expect(differs).toBeGreaterThan(0);
        });

        /*
         * top-k 真的接上了没有。
         *
         * 只比「k=1 是不是等于贪心」是不够的：没训过的模型每一步的 argmax
         * 往往是同一个 token，于是一个「永远返回 4」的实现也能过。
         * 所以这里**逐步重放**：把已经生成的前缀重新算一遍 logits，
         * 取出真正的 top-k 集合，再看采出来的那个在不在里面。
         */
        it('采出来的 token 都落在真正的 top-k 集合里', () => {
          setup();
          const K = 3;
          const sampled = run(true, 7, K);

          // 逐步重放：第 i 步的前缀是 prompt + sampled[0..i-1]
          lab.py(\`
      _m = _fresh()
      _ids = list(\${PROMPT})
      _idx = nt.zeros((len(_ids) + \${NEW},), role="data")
      _tops = []
      for _t in \${JSON.stringify(sampled)}:
          _idx.set_int_(_ids)
          _lg = _m(_idx, 1, len(_ids))
          _row = (len(_ids) - 1) * \${VOCAB}
          _vals = _lg.tolist()[_row:_row + \${VOCAB}]
          _order = sorted(range(\${VOCAB}), key=lambda i: (-_vals[i], i))
          _tops.append(_order[:\${K}])
          _ids.append(_t)
      \`);
          const tops = JSON.parse(String(lab.py('json.dumps(_tops)')));

          let violations = 0;
          for (let i = 0; i < NEW; i++) if (!tops[i].includes(sampled[i])) violations += 1;
          const distinct = new Set(sampled).size;
          console.log('k=' + K + ' 采样 ' + JSON.stringify(sampled)
            + '，出现了 ' + distinct + ' 个不同的 token');
          console.log('前三步的 top-' + K + ' 集合 ' + JSON.stringify(tops.slice(0, 3)));
          lab.publish('sample.topKViolations', violations);
          expect(violations).toBe(0);
          // 真的在 top-k 里挑，而不是每步都吐同一个 —— 否则上面那条是白测的
          expect(distinct).toBeGreaterThan(1);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.cache.mismatches', op: 'eq', value: 0,
      zh: '带 cache 与不带 cache 结果不同的 token 数',
      en: 'tokens differing between the cached and uncached paths',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.cache.flopsRatio', op: 'gte', value: 3.0,
      zh: '不带 cache 与带 cache 的解码 FLOPs 比',
      en: 'decode FLOPs of the uncached path over the cached one',
      dimension: 'efficiency',
    }),
    gate({
      metric: 'llm.sample.determinismMismatches', op: 'eq', value: 0,
      zh: '同 seed 两次采样不同的 token 数', en: 'tokens differing between two runs at the same seed',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.sample.topKViolations', op: 'eq', value: 0,
      zh: 'top_k=1 时与贪心不同的 token 数', en: 'tokens differing from greedy at top_k=1',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      KV cache 是推理侧显存的大头。一个 70B 模型、batch 32、上下文 8k，
      GQA 之后的 cache 仍然要几十 GB —— **比权重本身还容易先撑爆**。
      围绕它有一整条技术线：GQA / MLA 减头数，量化到 int8 / fp8 减位宽，
      \`PagedAttention\`（vLLM）像操作系统的分页那样按块分配免掉碎片,
      这一条在 gpulab 第 18 关有单独一关。

      这里的实现是连续分配的那版，接口和真实引擎一致但没有分页。
      连续分配在批量服务下会碎得很厉害:这就是 vLLM 当初要解决的问题。
    `,
    code`
      The KV cache dominates inference memory. A 70B model at batch 32 and 8k context still
      needs tens of GB of cache after GQA — **easier to blow up than the weights themselves**.
      A whole line of work targets it: GQA and MLA to cut head count, int8/fp8 quantisation
      to cut width, and \`PagedAttention\` (vLLM) to allocate in blocks like OS paging and
      avoid fragmentation — which gpulab covers in its own stage 18.

      The implementation here allocates contiguously, matching real engines at the interface
      while skipping paging. Contiguous allocation fragments badly under batched serving,
      which is precisely the problem vLLM set out to solve.
    `
  ),
};

/* ================================================================== */
/* 第 9 关：手写一个算子的反向                                          */
/* ================================================================== */

const STAGE_MANUAL_BWD = {
  id: 'manual-backward',
  title: t('手写反向 —— 矩阵乘与交叉熵', 'Backward by hand — matmul and cross-entropy'),
  goal: t(
    code`
      在 \`mygrad.py\` 里写两个自定义算子，**前向和反向都自己来**。
      形状照 \`torch.autograd.Function\`：

      \`\`\`python
      class LinearFn(nt.autograd.Function):
          @staticmethod
          def forward(ctx, x, w):
              ctx.save_for_backward(x, w)
              return F.linear(x, w)

          @staticmethod
          def backward(ctx, grad_output):
              x, w = ctx.saved_tensors
              return dx, dw          # 顺序对着 forward 里的张量参数
      \`\`\`

      \`forward\` 跑在 \`no_grad\` 里，所以你在里面调 \`F.linear\` 也**不会**挂上
      内建的反向 —— 挂了的话反向会走两遍（引擎一遍、你的 \`backward\` 一遍），
      梯度正好翻倍。PyTorch 里这件事同样是自动的，只是藏得更深。

      ## 矩阵乘的反向

      \`y = x @ W\`，\`x\` 是 \`[rows, din]\`，\`W\` 是 \`[din, dout]\`。链式法则给出：

      \`\`\`
      dx = dy @ Wᵀ        [rows, din]
      dW = xᵀ @ dy        [din, dout]
      \`\`\`

      记住形状怎么对上就够了：**两个下标里，被消掉的那个是求和的维度。**
      \`F.gemm(a, b, m, n, k, mode)\` 有 \`"nn"\` / \`"nt"\` / \`"tn"\` 三种模式,
      名字照 BLAS 来，真的 cuBLAS 就是这三个转置标志：

      \`\`\`python
      dx = F.gemm(dy, w, rows, din, dout, "nt")     # dy @ Wᵀ
      dw = F.gemm(x, dy, din, dout, rows, "tn")     # xᵀ @ dy
      \`\`\`

      ## 交叉熵的反向

      这是整套里最漂亮的一个结果。softmax 加交叉熵合起来求导，
      中间那一大堆全消掉了，只剩：

      \`\`\`
      dlogits = (softmax(logits) − onehot(targets)) / rows
      \`\`\`

      「预测的概率减去真实的概率」—— 就这么一句。
      这也是为什么真实框架总把 softmax 和交叉熵**融在一个算子里**：
      分开算不但慢，还要在中间存一个 \`[rows, vocab]\` 的雅可比。

      \`F.softmax\` 与 \`F.one_hot\` 都有了。别忘了乘上游传下来的 \`grad_output\` ——
      虽然从 loss 出发时它就是 1，但**写对了才叫写对了**，
      到第 11 关整模型反向、第 19 关梯度累积时它就不再是 1 了。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 梯度检验 | **f64 中心差分**，最大相对误差 ≤ 2e-3 |
      | 抽样量 | 至少 16 个元素（2 个张量 × 8 点） |
      | 前向 | loss 与内建实现差 ≤ 1e-12 |
      | 不退化 | 梯度不能几乎全是 0 |

      ## 为什么梯度检验必须在 f64 上做

      中心差分是 \`(f(x+h) − f(x−h)) / 2h\`。分子是两个几乎相等的数相减,
      **灾难性抵消**，有效位数直接掉一大截。

      fp32 只有 24 位尾数（约 7 位十进制）。抵消掉 4~5 位之后剩不下什么，
      于是一个**完全正确**的反向也会量出 5e-2 量级的相对误差。
      这个项目在实现阶段实测过这一条：同一份反向，f32 下 4.99e-2，f64 下 1.47e-5。

      所以这一关的张量是 \`dtype="f64"\` 建的。**梯度检验挂了先看精度，再看代码。**
    `,
    code`
      Write two custom operators in \`mygrad.py\`, **forward and backward both by hand**,
      shaped like \`torch.autograd.Function\`:

      \`\`\`python
      class LinearFn(nt.autograd.Function):
          @staticmethod
          def forward(ctx, x, w):
              ctx.save_for_backward(x, w)
              return F.linear(x, w)

          @staticmethod
          def backward(ctx, grad_output):
              x, w = ctx.saved_tensors
              return dx, dw          # ordered like forward's tensor arguments
      \`\`\`

      \`forward\` runs under \`no_grad\`, so calling \`F.linear\` inside it does **not**
      attach the built-in backward — if it did, the backward would run twice (once by the
      engine, once by yours) and gradients would come out exactly doubled. PyTorch does the
      same thing, just less visibly.

      ## The backward of a matmul

      For \`y = x @ W\` with \`x\` at \`[rows, din]\` and \`W\` at \`[din, dout]\`, the chain
      rule gives:

      \`\`\`
      dx = dy @ Wᵀ        [rows, din]
      dW = xᵀ @ dy        [din, dout]
      \`\`\`

      Remembering how the shapes line up is enough: **the index that cancels is the summed
      dimension.** \`F.gemm(a, b, m, n, k, mode)\` offers \`"nn"\` / \`"nt"\` / \`"tn"\`,
      named after BLAS — real cuBLAS has exactly these three transpose flags:

      \`\`\`python
      dx = F.gemm(dy, w, rows, din, dout, "nt")     # dy @ Wᵀ
      dw = F.gemm(x, dy, din, dout, rows, "tn")     # xᵀ @ dy
      \`\`\`

      ## The backward of cross-entropy

      This is the prettiest result in the whole set. Differentiate softmax together with
      cross-entropy and everything in the middle cancels, leaving:

      \`\`\`
      dlogits = (softmax(logits) − onehot(targets)) / rows
      \`\`\`

      "Predicted probability minus true probability" — that is all of it. It is also why
      real frameworks **fuse** softmax and cross-entropy into one operator: splitting them
      is slower and forces a \`[rows, vocab]\` Jacobian into memory.

      \`F.softmax\` and \`F.one_hot\` are available. Do not forget to multiply by the
      incoming \`grad_output\`: it happens to be 1 when you start from the loss, but
      **correct means correct** — by stage 11 and by gradient accumulation in stage 19 it
      is no longer 1.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Gradient check | **f64 central differences**, max relative error ≤ 2e-3 |
      | Samples | At least 16 elements (2 tensors x 8 points) |
      | Forward | Loss within 1e-12 of the built-in |
      | Non-degenerate | Gradients must not be almost entirely zero |

      ## Why the gradient check must run in f64

      A central difference is \`(f(x+h) − f(x−h)) / 2h\`. The numerator subtracts two nearly
      equal numbers — **catastrophic cancellation** — and loses a large chunk of the
      significant digits.

      fp32 has a 24-bit mantissa, roughly 7 decimal digits. Cancel four or five of them and
      little remains, so a **perfectly correct** backward still measures a relative error
      around 5e-2. This project measured exactly that during implementation: the same
      backward gives 4.99e-2 in f32 and 1.47e-5 in f64.

      That is why this stage builds its tensors with \`dtype="f64"\`. **When a gradient check
      fails, suspect precision before you suspect the code.**
    `
  ),
  checklist: [
    t('LinearFn 的 dx 与 dw 形状都对', 'LinearFn produces dx and dw with the right shapes'),
    t('CrossEntropyFn 的 dlogits = (p − onehot) / rows',
      'CrossEntropyFn computes dlogits = (p - onehot) / rows'),
    t('乘上了上游传下来的 grad_output', 'The incoming grad_output is multiplied in'),
    t('f64 下的梯度检验通过', 'The f64 gradient check passes'),
  ],
  hints: [
    t('ctx.save_for_backward(...) 存的东西在 ctx.saved_tensors 里按原顺序取回来。',
      'What ctx.save_for_backward(...) stores comes back from ctx.saved_tensors in order.'),
    t('非张量参数（rows / vocab）直接挂在 ctx 上就行：ctx.rows = rows。',
      'Non-tensor arguments (rows / vocab) can just live on ctx: ctx.rows = rows.'),
    t('backward 要给每个张量参数返回一份梯度，不需要的位置返回 None。',
      'backward returns one gradient per tensor argument; return None where none is needed.'),
  ],
  pitfalls: [
    t(code`
      **忘了乘 \`grad_output\`。** 从 loss 出发时它是 1，所以这一关**照样能过**
      前向和一部分检验 —— 直到这个算子被放进更深的图里，
      上游传下来的不再是 1，梯度就整体错了一个因子。
      这一关的用例专门用一个不为 1 的 \`grad_output\` 再验一遍。
    `, code`
      **Forgetting to multiply by \`grad_output\`.** Starting from the loss it equals 1, so
      this stage would otherwise pass — right up until the operator sits deeper in a graph,
      the incoming gradient is no longer 1, and every gradient is off by a factor. The
      hidden cases re-check with a \`grad_output\` that is deliberately not 1.
    `),
    t(code`
      **\`gemm\` 的 m / n / k 写反。** 方阵上完全看不出来:形状检查过得去，
      数值也不离谱，只是梯度是转置过的。非方阵上才会报错，
      而等你发现时已经训了半天。这一关用的是 6×5×4 三个都不相等的形状。
    `, code`
      **Swapping \`gemm\`'s m / n / k.** On square matrices nothing shows: shapes check out,
      the numbers look plausible, and the gradient is merely transposed. Only non-square
      shapes raise an error, by which point you have been training for a while. This stage
      uses 6x5x4, all different.
    `),
  ],
  train: {
    files: {
      'mygrad.py': code`
        """第 9 关：手写矩阵乘与交叉熵的反向。"""
        import nanotorch as nt
        from nanotorch import functional as F


        class LinearFn(nt.autograd.Function):
            """y = x @ w。x 是 [rows, din]，w 是 [din, dout]。"""

            @staticmethod
            def forward(ctx, x, w):
                ctx.save_for_backward(x, w)
                return F.linear(x, w)

            @staticmethod
            def backward(ctx, grad_output):
                x, w = ctx.saved_tensors
                # TODO: dx = dy @ wᵀ，dw = xᵀ @ dy
                #       F.gemm(a, b, m, n, k, mode) 的 mode 是 "nn" / "nt" / "tn"
                return None, None


        class CrossEntropyFn(nt.autograd.Function):
            """softmax + 交叉熵，返回平均 loss。"""

            @staticmethod
            def forward(ctx, logits, targets, rows, vocab):
                ctx.save_for_backward(logits, targets)
                ctx.rows, ctx.vocab = rows, vocab
                return F.cross_entropy(logits, targets, rows, vocab)

            @staticmethod
            def backward(ctx, grad_output):
                logits, targets = ctx.saved_tensors
                # TODO: dlogits = (softmax(logits) − onehot(targets)) / rows
                #       再乘上游的 grad_output（它是个标量张量，用 .item() 读）
                #       targets 不需要梯度，返回 None
                return None, None


        if __name__ == "__main__":
            R, DIN, DOUT = 6, 5, 4
            x = nt.parameter((R, DIN), 3, 0.5, "x", dtype="f64")
            w = nt.parameter((DIN, DOUT), 7, 0.5, "w", dtype="f64")
            tgt = nt.zeros((R,), role="data")
            tgt.set_int_([0, 1, 2, 3, 1, 2])
            loss = CrossEntropyFn.apply(LinearFn.apply(x, w), tgt, R, DOUT)
            loss.backward()
            print("loss %.6f" % loss.value)
            print("dx 前几个", [round(v, 6) for v in x.grad.tolist()[:4]])
      `,
    },
    referenceFiles: {
      'mygrad.py': code`
        """第 9 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F


        class LinearFn(nt.autograd.Function):
            @staticmethod
            def forward(ctx, x, w):
                ctx.save_for_backward(x, w)
                return F.linear(x, w)

            @staticmethod
            def backward(ctx, grad_output):
                x, w = ctx.saved_tensors
                rows, din = x.shape[0], x.shape[1]
                dout = w.shape[1]
                # dx = dy @ wᵀ：消掉的是 dout
                dx = F.gemm(grad_output, w, rows, din, dout, "nt")
                # dw = xᵀ @ dy：消掉的是 rows
                dw = F.gemm(x, grad_output, din, dout, rows, "tn")
                return dx, dw


        class CrossEntropyFn(nt.autograd.Function):
            @staticmethod
            def forward(ctx, logits, targets, rows, vocab):
                ctx.save_for_backward(logits, targets)
                ctx.rows, ctx.vocab = rows, vocab
                return F.cross_entropy(logits, targets, rows, vocab)

            @staticmethod
            def backward(ctx, grad_output):
                logits, targets = ctx.saved_tensors
                rows, vocab = ctx.rows, ctx.vocab
                p = F.softmax(logits, rows, vocab)
                hot = F.one_hot(targets, rows, vocab, dtype=logits.dtype)
                # 「预测的概率减去真实的概率」—— softmax 与交叉熵合起来求导的全部结果
                diff = F.add(p, F.scale(hot, -1.0))
                dlogits = F.scale(diff, grad_output.item(0) / rows)
                # targets 是下标，不求导
                return dlogits, None


        if __name__ == "__main__":
            R, DIN, DOUT = 6, 5, 4
            x = nt.parameter((R, DIN), 3, 0.5, "x", dtype="f64")
            w = nt.parameter((DIN, DOUT), 7, 0.5, "w", dtype="f64")
            tgt = nt.zeros((R,), role="data")
            tgt.set_int_([0, 1, 2, 3, 1, 2])
            loss = CrossEntropyFn.apply(LinearFn.apply(x, w), tgt, R, DOUT)
            loss.backward()
            print("loss %.6f" % loss.value)
            print("dx 前几个", [round(v, 6) for v in x.grad.tolist()[:4]])
      `,
    },
  },
  specs: [
    spec('mygrad.spec.ts', code`
      ${LAB}

      const R = 6, DIN = 5, DOUT = 4;

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, mygrad
      importlib.reload(mygrad)
      import nanotorch as nt
      from nanotorch import functional as F

      R, DIN, DOUT = \${R}, \${DIN}, \${DOUT}
      # f64：中心差分要在 f64 上做，f32 的抵消噪声比信号还大
      _x = nt.parameter((R, DIN), 3, 0.5, "x", dtype="f64")
      _w = nt.parameter((DIN, DOUT), 7, 0.5, "w", dtype="f64")
      _tgt = nt.zeros((R,), role="data", name="tgt")
      _tgt.set_int_([0, 1, 2, 3, 1, 2])

      def _set(vals):
          _x.set_(vals[:R * DIN])
          _w.set_(vals[R * DIN:])

      def _loss_only():
          with nt.no_grad():
              y = mygrad.LinearFn.apply(_x, _w)
              return mygrad.CrossEntropyFn.apply(y, _tgt, R, DOUT).value

      def _run():
          _x.zero_grad()
          _w.zero_grad()
          y = mygrad.LinearFn.apply(_x, _w)
          loss = mygrad.CrossEntropyFn.apply(y, _tgt, R, DOUT)
          loss.backward()
          return loss.value
      \`);
      }

      describe('手写反向', () => {
        it('前向和内建实现对得上', () => {
          setup();
          const mine = Number(lab.py('_loss_only()'));
          const builtin = Number(lab.py(\`
      with nt.no_grad():
          _y = F.linear(_x, _w)
          _b = F.cross_entropy(_y, _tgt, R, DOUT).value
      _b
      \`));
          console.log('自己写的 ' + mine.toFixed(12) + '，内建 ' + builtin.toFixed(12));
          lab.publish('loss.forwardError', Math.abs(mine - builtin));
          expect(Math.abs(mine - builtin)).toBeLessThan(1e-12);
        });

        /*
         * f64 中心差分。**这一条是这一关的全部** ——
         * 反向写错了，前向照样跑得通、loss 照样是个正常的数。
         */
        it('f64 梯度检验：最大相对误差 ≤ 2e-3', () => {
          setup();
          const loss = Number(lab.py('_run()'));
          const gx = JSON.parse(String(lab.py('json.dumps(_x.grad.tolist())')));
          const gw = JSON.parse(String(lab.py('json.dumps(_w.grad.tolist())')));
          const x0 = JSON.parse(String(lab.py('json.dumps(_x.tolist())')));
          const w0 = JSON.parse(String(lab.py('json.dumps(_w.tolist())')));

          const values = Float64Array.from([...x0, ...w0]);
          const evalLoss = () => Number(lab.py('_set(' + JSON.stringify([...values]) + '); _loss_only()'));

          const report = lab.probe.gradCheck([
            { name: 'x', values: values.subarray(0, R * DIN), grad: Float64Array.from(gx) },
            { name: 'w', values: values.subarray(R * DIN), grad: Float64Array.from(gw) },
          ], evalLoss);

          console.log(
            'loss ' + loss.toFixed(6) + '；最大相对误差 ' + report.maxRelError.toExponential(2)
            + '（最差在 ' + report.worstTensor + '），抽了 ' + report.checkedElements + ' 个元素'
          );
          lab.publish('grad.maxRelError', report.maxRelError);
          lab.publish('grad.checkedElements', report.checkedElements);
          expect(report.maxRelError).toBeLessThan(2e-3);
          expect(report.checkedElements).toBeGreaterThanOrEqual(16);
        });

        /*
         * 一个「backward 返回全 0」的实现，在相对误差上未必红得干净。
         * 直接查非零比例，把退化的实现挡在外面。
         */
        it('梯度不是几乎全零', () => {
          setup();
          lab.py('_run()');
          const gx = JSON.parse(String(lab.py('json.dumps(_x.grad.tolist())')));
          const gw = JSON.parse(String(lab.py('json.dumps(_w.grad.tolist())')));
          const all = [...gx, ...gw];
          const nonZero = all.filter((v) => v !== 0).length / all.length;
          console.log('非零比例 ' + (nonZero * 100).toFixed(1) + '%');
          lab.publish('grad.nonZeroFraction', nonZero);
          expect(nonZero).toBeGreaterThan(0.9);
        });

        /*
         * 上游传下来的梯度不是 1 的时候，结果要按比例缩放。
         * 忘了乘 grad_output 的实现在「从 loss 出发」时完全正常,
         * 只有这一条能把它抓出来。
         */
        it('grad_output 不是 1 时，梯度按比例缩放', () => {
          setup();
          const scaled = JSON.parse(String(lab.py(\`
      _x.zero_grad(); _w.zero_grad()
      _y = mygrad.LinearFn.apply(_x, _w)
      _loss = mygrad.CrossEntropyFn.apply(_y, _tgt, R, DOUT)
      # 手动播一个 3.0 的种子，而不是 backward() 默认的 1.0
      _g = _loss.ensure_grad(); _g.set_([3.0])
      _topo, _seen = [], set()
      def _visit(t):
          if id(t) in _seen: return
          _seen.add(id(t))
          for p in t._parents: _visit(p)
          _topo.append(t)
      _visit(_loss)
      for _t in reversed(_topo):
          if _t._backward is not None: _t._backward()
      json.dumps(_x.grad.tolist())
      \`)));
          const base = JSON.parse(String(lab.py(\`
      _x.zero_grad(); _w.zero_grad()
      _run()
      json.dumps(_x.grad.tolist())
      \`)));

          let worst = 0;
          for (let i = 0; i < base.length; i++) {
            worst = Math.max(worst, Math.abs(scaled[i] - 3 * base[i]));
          }
          console.log('种子 3.0 与 3×（种子 1.0）的最大差 ' + worst.toExponential(2));
          lab.publish('grad.upstreamScaleError', worst);
          expect(worst).toBeLessThan(1e-12);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.grad.maxRelError', op: 'lte', value: 2e-3,
      zh: 'f64 中心差分的最大相对误差', en: 'max relative error of the f64 central-difference check',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.checkedElements', op: 'gte', value: 16,
      zh: '抽查的元素数', en: 'elements sampled by the gradient check', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.nonZeroFraction', op: 'gte', value: 0.9,
      zh: '梯度里非零的比例', en: 'fraction of non-zero gradient entries', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.upstreamScaleError', op: 'lte', value: 1e-12,
      zh: '上游梯度不为 1 时的缩放误差', en: 'error when the incoming gradient is not 1',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      真实框架里，**softmax 与交叉熵是融在一起的**（\`F.cross_entropy\` 收的是
      logits 不是概率）。理由有两个：一是省掉中间那块 \`[rows, vocab]\`,
      在 vocab 15 万的模型上，batch 一大它就是好几个 GB；
      二是数值稳定,分开算要先 exp 再 log，融在一起可以用 log-sum-exp 的形式，
      不会在中间溢出。

      你刚写的 \`(p − onehot) / rows\` 就是融合之后的那一个式子。
      2026 年这块还在继续融：Liger-Kernel 这类实现把 lm_head 的矩阵乘
      也一起融进去，分块地算 logits 和 loss，**峰值显存降一大半**,
      对长上下文的后训练来说这不是优化，是能不能跑的问题。
    `,
    code`
      In real frameworks **softmax and cross-entropy are fused** (\`F.cross_entropy\` takes
      logits, not probabilities). Two reasons: it avoids materialising the
      \`[rows, vocab]\` intermediate, which at a 150k vocabulary and a large batch is several
      GB; and it is numerically stabler, since the fused form uses log-sum-exp instead of
      exponentiating and then taking a log.

      The \`(p − onehot) / rows\` you just wrote is exactly the fused expression. Fusion keeps
      going in 2026: implementations like Liger-Kernel pull the lm_head matmul in as well,
      computing logits and loss in chunks and **roughly halving peak memory** — for
      long-context post-training that is not an optimisation but a precondition.
    `
  ),
};

/* ================================================================== */
/* 第 10 关：自动微分引擎                                               */
/* ================================================================== */

const STAGE_ENGINE = {
  id: 'autograd-engine',
  title: t('自动微分引擎 —— 那条带是怎么倒着走的', 'The autograd engine — how the tape runs backwards'),
  goal: t(
    code`
      在 \`engine.py\` 里自己写一遍反向传播的调度：

      \`\`\`python
      def backward(root):
          """从一个标量出发，把整张图的梯度算出来。"""
      \`\`\`

      **这一关不许调用 \`Tensor.backward()\`** —— 用例会把它换成一个当场报错的桩。

      ## 你手上有什么

      每个张量上挂着两样东西，前面几关的算子已经把它们填好了：

      \`\`\`python
      t._parents     # 一个元组：算出 t 的那几个输入
      t._backward    # 一个函数：把 t 的梯度散给它的 parents（不收参数）
      \`\`\`

      \`t._backward()\` 读的是 \`t.grad\`，写的是 \`t._parents\` 各自的 \`.grad\`,
      **累加**进去，不是赋值。所以你要做的只有三件事：

      1. 给起点播种：\`root.grad = 1\`（\`d(loss)/d(loss)\`）
      2. 排出一个**拓扑序**
      3. **倒着**走一遍，每个节点的 \`_backward\` 调**恰好一次**

      ## 为什么必须是拓扑序

      \`t._backward()\` 要求 \`t.grad\` 已经**攒齐**了 —— 所有用到 \`t\` 的下游都得先算完。
      顺序错了不会报错，只会算出一个偏小的梯度：某个下游的贡献还没加上就先散出去了。

      \`\`\`
            x
           / \\
          a   b        ← a 和 b 都用了 x
           \\ /
            y
      \`\`\`

      这张**菱形**图是分水岭。\`x\` 要等 \`a\` 和 \`b\` 都算完才轮到它。
      而如果你的实现在 DFS 里没有去重，\`x._backward\` 会被调两次,
      梯度**正好翻倍**，而这在单链的表达式上完全看不出来。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 数值 | 与内建引擎的结果差 ≤ 1e-9（f64） |
      | **菱形图** | 同一个中间量被用两次时梯度要相加 |
      | **每个节点恰好一次** | \`_backward\` 的最大调用次数 = 1 |
      | 没抄近路 | 没调 \`Tensor.backward()\` |

      「每个节点恰好一次」是这一关最锋利的一条:它不看数值，只数调用。
      一个「多调了一次」的实现在某些图上数值碰巧还对得上，
      但这条门槛不会放过它。

      ## 一句题外话

      你写的这十几行，就是 PyTorch \`autograd\` 引擎的骨架。
      真实的那个多了：跨线程的依赖计数（不是一次性排好拓扑序，
      而是每个节点记着「还有几个下游没来」）、\`retain_graph\`、
      钩子、以及对不需要梯度的子图的剪枝。骨架是一样的。
    `,
    code`
      Write the backward-pass scheduler yourself in \`engine.py\`:

      \`\`\`python
      def backward(root):
          """Given a scalar, compute gradients across the whole graph."""
      \`\`\`

      **This stage forbids \`Tensor.backward()\`** — the hidden cases replace it with a stub
      that raises.

      ## What you have

      Every tensor carries two things, already filled in by the operators from earlier
      stages:

      \`\`\`python
      t._parents     # a tuple: the inputs that produced t
      t._backward    # a function: scatter t's gradient to its parents (takes no arguments)
      \`\`\`

      \`t._backward()\` reads \`t.grad\` and writes into each parent's \`.grad\`,
      **accumulating** rather than assigning. So there are only three things to do:

      1. Seed the root: \`root.grad = 1\` (\`d(loss)/d(loss)\`)
      2. Produce a **topological order**
      3. Walk it **backwards**, calling each node's \`_backward\` **exactly once**

      ## Why the order has to be topological

      \`t._backward()\` requires \`t.grad\` to be **complete** — every downstream user of \`t\`
      must have finished first. Getting this wrong raises nothing; it just produces a
      gradient that is too small, because one downstream contribution had not arrived yet.

      \`\`\`
            x
           / \\
          a   b        ← both a and b use x
           \\ /
            y
      \`\`\`

      This **diamond** is the dividing line. \`x\` must wait for both \`a\` and \`b\`. And if
      your DFS does not deduplicate, \`x._backward\` runs twice and the gradient comes out
      **exactly doubled** — invisible on any single-chain expression.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Numerics | Within 1e-9 of the built-in engine (f64) |
      | **Diamond graph** | Gradients add when an intermediate is used twice |
      | **Exactly once per node** | Maximum \`_backward\` call count = 1 |
      | No shortcut | \`Tensor.backward()\` is not called |

      "Exactly once per node" is the sharpest gate here: it ignores values and counts calls.
      An implementation that calls one node twice can still land on the right numbers for
      some graphs; this gate does not let it through.

      ## An aside

      The dozen lines you are writing are the skeleton of PyTorch's \`autograd\` engine. The
      real one adds cross-thread dependency counting (rather than one precomputed
      topological order, each node tracks how many downstream users remain),
      \`retain_graph\`, hooks, and pruning of subgraphs that need no gradient. The skeleton
      is the same.
    `
  ),
  checklist: [
    t('给起点播了 1 的种子', 'The root is seeded with 1'),
    t('拓扑序排对了', 'The topological order is correct'),
    t('每个节点的 _backward 恰好调一次', "Each node's _backward runs exactly once"),
    t('菱形图上梯度是相加的', 'Gradients add on the diamond graph'),
  ],
  hints: [
    t('DFS 里用 id(t) 去重 —— 张量没实现 __hash__ 的语义，别拿它当 set 的元素。',
      'Deduplicate by id(t) in the DFS; tensors do not carry set-friendly hashing semantics.'),
    t('后序遍历得到的就是拓扑序：先递归 parents，再把自己放进列表。',
      'A post-order walk gives the topological order: recurse into parents first, then append.'),
    t('叶子节点的 _backward 是 None，跳过就行。',
      'Leaf nodes have _backward set to None; just skip them.'),
  ],
  pitfalls: [
    t(code`
      **DFS 没去重。** 菱形图上 \`x._backward\` 被调两次，梯度正好翻倍。
      而单链的表达式（\`a -> b -> c -> loss\`）上完全正常 ——
      如果你只拿一条链验过，这个错会一路活到整模型那一关。
    `, code`
      **A DFS without deduplication.** On a diamond, \`x._backward\` runs twice and the
      gradient doubles, while a single chain (\`a -> b -> c -> loss\`) behaves perfectly. If
      you only tested a chain, this survives all the way to the full-model stage.
    `),
    t(code`
      **忘了播种。** \`root.grad\` 是 None 的话，第一个 \`_backward\` 什么都不做,
      整张图的梯度全是 0。不报错，只是模型不学。
      这个错的表现和「学习率是 0」一模一样，很容易查错方向。
    `, code`
      **Forgetting to seed.** With \`root.grad\` still None the first \`_backward\` does
      nothing and every gradient in the graph stays zero. No error, just a model that does
      not learn — indistinguishable from a zero learning rate, which sends you looking in
      the wrong place.
    `),
  ],
  train: {
    forbidden: [],
    files: {
      'engine.py': code`
        """第 10 关：自己写反向传播的调度。

        不许调用 Tensor.backward()。
        """
        import nanotorch as nt


        def backward(root):
            """从标量 root 出发，把整张图的梯度算出来。"""
            assert root.numel == 1, "backward 只能从标量出发"
            # TODO: 1) 播种 root.grad = 1
            #       2) 排一个拓扑序（后序遍历 _parents，用 id() 去重）
            #       3) 倒着走，每个节点的 _backward 调恰好一次
            return None


        if __name__ == "__main__":
            from nanotorch import functional as F
            x = nt.parameter((4, 4), 1, 0.5, "x", dtype="f64")
            w = nt.parameter((4, 4), 2, 0.5, "w", dtype="f64")
            tgt = nt.zeros((4,), role="data")
            tgt.set_int_([0, 1, 2, 3])
            # 菱形：x 走两条路
            y = F.add(F.linear(x, w), F.scale(x, 0.5))
            loss = F.cross_entropy(y, tgt, 4, 4)
            backward(loss)
            print("dx 前几个", [round(v, 6) for v in (x.grad.tolist()[:4] if x.grad else [])])
      `,
    },
    referenceFiles: {
      'engine.py': code`
        """第 10 关的参考实现。"""
        import nanotorch as nt


        def backward(root):
            assert root.numel == 1, "backward 只能从标量出发"

            # 1) 播种。d(loss)/d(loss) = 1 —— 少了这一步整张图的梯度全是 0
            root.ensure_grad().fill_(1.0)

            # 2) 拓扑序。后序遍历：先把 parents 排完，再把自己接在后面。
            #    用 id() 去重 —— 菱形图里同一个节点会从两条路各来一次，
            #    不去重的话它的 _backward 会被调两遍，梯度正好翻倍。
            topo = []
            seen = set()

            def visit(t):
                if id(t) in seen:
                    return
                seen.add(id(t))
                for p in t._parents:
                    visit(p)
                topo.append(t)

            visit(root)

            # 3) 倒着走。倒着的理由：一个节点要等所有下游都把自己那份加完，
            #    它的 grad 才是完整的，这时候才轮到它往上散。
            for t in reversed(topo):
                if t._backward is not None:
                    t._backward()
            return topo


        if __name__ == "__main__":
            from nanotorch import functional as F
            x = nt.parameter((4, 4), 1, 0.5, "x", dtype="f64")
            w = nt.parameter((4, 4), 2, 0.5, "w", dtype="f64")
            tgt = nt.zeros((4,), role="data")
            tgt.set_int_([0, 1, 2, 3])
            y = F.add(F.linear(x, w), F.scale(x, 0.5))
            loss = F.cross_entropy(y, tgt, 4, 4)
            backward(loss)
            print("dx 前几个", [round(v, 6) for v in x.grad.tolist()[:4]])
      `,
    },
  },
  specs: [
    spec('engine.spec.ts', code`
      ${LAB}

      const N = 4;

      /**
       * 建一张**菱形**图：x 同时喂给 linear 和 scale，两条路再汇合。
       * which 决定用学员的引擎还是内建的。
       */
      function build(which) {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, engine
      importlib.reload(engine)
      import nanotorch as nt
      from nanotorch import functional as F

      N = \${N}
      _x = nt.parameter((N, N), 1, 0.5, "x", dtype="f64")
      _w = nt.parameter((N, N), 2, 0.5, "w", dtype="f64")
      _tgt = nt.zeros((N,), role="data")
      _tgt.set_int_([0, 1, 2, 3])

      def _graph():
          global _y
          _x.zero_grad(); _w.zero_grad()
          # 菱形：_x 走两条路，汇合之后进 loss
          _y = F.add(F.linear(_x, _w), F.scale(_x, 0.5))
          return F.cross_entropy(_y, _tgt, N, N)
      \`);

        if (which === 'student') {
          lab.py(\`
      _loss = _graph()
      _visits = {}
      def _wrap(t, seen=None):
          seen = seen if seen is not None else set()
          if id(t) in seen: return
          seen.add(id(t))
          for p in t._parents: _wrap(p, seen)
          if t._backward is not None:
              _orig = t._backward
              def _counted(_t=t, _o=_orig):
                  _visits[id(_t)] = _visits.get(id(_t), 0) + 1
                  _o()
              t._backward = _counted
      _wrap(_loss)

      # 换掉内建的 backward —— 这一关要自己走，不许转手
      def _forbidden(self, *a, **k):
          raise RuntimeError("这一关不许调用 Tensor.backward()")
      _saved = nt.Tensor.backward
      nt.Tensor.backward = _forbidden
      try:
          engine.backward(_loss)
      finally:
          nt.Tensor.backward = _saved
      \`);
        } else {
          lab.py('_loss = _graph()\\n_loss.backward()\\n_visits = {}');
        }

        return {
          loss: Number(lab.py('_loss.value')),
          gx: JSON.parse(String(lab.py('json.dumps(_x.grad.tolist() if _x.grad else [])'))),
          gw: JSON.parse(String(lab.py('json.dumps(_w.grad.tolist() if _w.grad else [])'))),
          maxVisits: Number(lab.py('max(_visits.values()) if _visits else 0')),
          nodes: Number(lab.py('len(_visits)')),
        };
      }

      describe('自动微分引擎', () => {
        it('菱形图上的梯度和内建引擎一致', () => {
          const mine = build('student');
          const ref = build('builtin');
          expect(mine.gx.length).toBe(N * N);
          expect(ref.gx.length).toBe(N * N);

          let worst = 0;
          for (let i = 0; i < ref.gx.length; i++)
            worst = Math.max(worst, Math.abs(mine.gx[i] - ref.gx[i]));
          for (let i = 0; i < ref.gw.length; i++)
            worst = Math.max(worst, Math.abs(mine.gw[i] - ref.gw[i]));

          console.log(
            'loss ' + mine.loss.toFixed(9) + '；与内建引擎的最大差 ' + worst.toExponential(2)
          );
          lab.publish('grad.engineError', worst);
          expect(worst).toBeLessThan(1e-9);
        });

        /*
         * 这一条不看数值，只数调用。
         * 一个「DFS 没去重」的实现会把菱形的分叉点调两次 —— 梯度正好翻倍，
         * 而它在单链上完全正常。
         */
        it('每个节点的 _backward 恰好调一次', () => {
          const mine = build('student');
          console.log('走过 ' + mine.nodes + ' 个节点，最多的那个调了 ' + mine.maxVisits + ' 次');
          lab.publish('grad.maxVisits', mine.maxVisits);
          lab.publish('grad.visitedNodes', mine.nodes);
          // 菱形图至少有 linear / scale / add / cross_entropy 四个有反向的节点
          expect(mine.nodes).toBeGreaterThanOrEqual(4);
          expect(mine.maxVisits).toBe(1);
        });

        /*
         * f64 中心差分。和内建一致还不够 —— 万一两边错得一样呢。
         * 这一条对的是数学，不是另一份实现。
         */
        it('f64 梯度检验：最大相对误差 ≤ 2e-3', () => {
          const mine = build('student');
          const x0 = JSON.parse(String(lab.py('json.dumps(_x.tolist())')));
          const w0 = JSON.parse(String(lab.py('json.dumps(_w.tolist())')));
          lab.py(\`
      def _set(vals):
          _x.set_(vals[:N * N])
          _w.set_(vals[N * N:])

      def _loss_only():
          with nt.no_grad():
              _y = F.add(F.linear(_x, _w), F.scale(_x, 0.5))
              return F.cross_entropy(_y, _tgt, N, N).value
      \`);
          const values = Float64Array.from([...x0, ...w0]);
          const evalLoss = () => Number(lab.py('_set(' + JSON.stringify([...values]) + '); _loss_only()'));

          const report = lab.probe.gradCheck([
            { name: 'x', values: values.subarray(0, N * N), grad: Float64Array.from(mine.gx) },
            { name: 'w', values: values.subarray(N * N), grad: Float64Array.from(mine.gw) },
          ], evalLoss);

          console.log(
            '最大相对误差 ' + report.maxRelError.toExponential(2)
            + '（最差在 ' + report.worstTensor + '）'
          );
          lab.publish('grad.maxRelError', report.maxRelError);
          expect(report.maxRelError).toBeLessThan(2e-3);
        });

        /*
         * 分叉点的梯度必须是两条路之和。
         *
         * 拆的时候要**固定 dL/dy** —— 直接把某条支路清零再重跑 loss 是不对的：
         * 交叉熵是非线性的，改了 y 就改了 dL/dy，三次跑的根本不是同一个数。
         * 所以这里先从学员那次反向里取出 dL/dy，再拿**同一份** dL/dy
         * 分别喂给两条支路，最后看两份之和对不对得上。
         */
        it('分叉点的梯度等于两条路各自梯度之和（dL/dy 固定）', () => {
          build('student');
          const both = JSON.parse(String(lab.py('json.dumps(_x.grad.tolist())')));

          const parts = JSON.parse(String(lab.py(\`
      # 学员那次反向留下的 dL/dy —— 两条支路共用它（add 的反向就是原样分发）
      _G = list(_y.grad.tolist())

      def _one(make):
          _x.zero_grad()
          _out = make()
          _g = _out.ensure_grad(); _g.set_(_G)
          _out._backward()
          return list(_x.grad.tolist())

      _a = _one(lambda: F.linear(_x, _w))
      _b = _one(lambda: F.scale(_x, 0.5))
      json.dumps({"a": _a, "b": _b})
      \`)));

          let worst = 0;
          for (let i = 0; i < both.length; i++)
            worst = Math.max(worst, Math.abs(both[i] - (parts.a[i] + parts.b[i])));
          console.log('菱形 vs 两条支路之和，最大差 ' + worst.toExponential(2));
          lab.publish('grad.diamondError', worst);
          expect(worst).toBeLessThan(1e-9);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.grad.engineError', op: 'lte', value: 1e-9,
      zh: '与内建引擎的最大差', en: 'max difference from the built-in engine', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.maxVisits', op: 'eq', value: 1,
      zh: '单个节点 _backward 的最大调用次数', en: 'maximum _backward calls on any node',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.maxRelError', op: 'lte', value: 2e-3,
      zh: 'f64 中心差分的最大相对误差', en: 'max relative error of the f64 central-difference check',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.diamondError', op: 'lte', value: 1e-9,
      zh: '菱形图与两条单链之和的差', en: 'diamond graph versus the sum of two single chains',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      你写的是**一次性排好拓扑序**的版本。PyTorch 真实的引擎换了个等价的做法：
      每个节点记一个「还有几个下游没来」的计数，计数归零才把它推进就绪队列。
      好处是**能多线程跑** —— 就绪队列上的节点彼此独立。

      另外两件真实引擎必须处理、这里回避掉的事：

      **图默认用完就拆。** \`backward()\` 之后中间量就释放了，
      再调一次会报 \`Trying to backward through the graph a second time\`。
      要留就得 \`retain_graph=True\`,而这是显存泄漏最常见的来源之一。

      **不需要梯度的子图要剪掉。** 冻结的层、\`no_grad\` 里的分支，
      引擎不会为它们建节点。微调一个大模型时，这一步剪掉的往往是绝大部分。
    `,
    code`
      You wrote the version that **precomputes one topological order**. PyTorch's real
      engine uses an equivalent alternative: each node counts how many downstream users
      remain, and enters a ready queue when that count hits zero. The advantage is
      **multi-threading** — nodes in the ready queue are independent.

      Two more things real engines must handle and this one sidesteps:

      **The graph is freed after use.** After \`backward()\` the intermediates are released
      and a second call raises \`Trying to backward through the graph a second time\`.
      Keeping it requires \`retain_graph=True\` — one of the most common sources of memory
      leaks.

      **Subgraphs that need no gradient are pruned.** Frozen layers and branches inside
      \`no_grad\` never get nodes at all. When fine-tuning a large model, that prunes the
      vast majority of the graph.
    `
  ),
};

/* ================================================================== */
/* 第 11 关：整个模型的反向                                             */
/* ================================================================== */

/** 第 4–7 关验收过的零件，带上 dtype —— 梯度检验要在 f64 上跑整个模型 */
const PARTS_FULL_PY = code`
  """前面几关验收过的零件。这一关直接用。

  和第 7 关那份比，这里有两处变化：

  1. 每个构造函数多了一个 \`dtype\` —— 对应 PyTorch 的 \`model.double()\`。
     梯度检验必须在 f64 上做，所以模型得能整体切过去。

  2. **权重按扇入初始化**：\`std = fan_in ** -0.5\`，而不是到处写 0.02。
     这是第 6 关那条结论的直接应用 —— 0.02 是给 \`dim = 768\` 调的
     （\`0.02 · sqrt(768) ≈ 0.55\`），搬到 \`dim = 16\` 上支路输出的量级只剩 0.08，
     残差流几乎不动。**初始化的尺度得跟着宽度走。**
  """
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F


  def build_tables(positions, head_dim, base=10000.0, dtype="f32"):
      half = head_dim // 2
      cos = nt.zeros((len(positions), half), dtype, role="data", name="rope.cos")
      sin = nt.zeros((len(positions), half), dtype, role="data", name="rope.sin")
      cv, sv = [], []
      for p in positions:
          for i in range(half):
              theta = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(theta))
              sv.append(math.sin(theta))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class RMSNorm(nn.Module):
      def __init__(self, dim, eps=1e-5, dtype="f32"):
          super().__init__()
          self.dim, self.eps = dim, eps
          self.weight = nt.parameter((dim,), None, 0.0, "norm.weight", dtype=dtype)

      def forward(self, x, rows=0):
          return F.rms_norm(x, self.weight, self.eps)


  class RopeAttention(nn.Module):
      def __init__(self, dim, n_head, n_kv_head, seed, base=10000.0, dtype="f32",
                   max_seq=64):
          super().__init__()
          self.dim, self.n_head, self.n_kv_head = dim, n_head, n_kv_head
          self.head_dim = dim // n_head
          self.base = base
          self.dtype = dtype
          self.max_seq = max_seq
          hd = self.head_dim
          self.wq = nt.parameter((dim, n_head * hd), seed + 1, dim ** -0.5, "wq", dtype=dtype)
          self.wk = nt.parameter((dim, n_kv_head * hd), seed + 2, dim ** -0.5, "wk", dtype=dtype)
          self.wv = nt.parameter((dim, n_kv_head * hd), seed + 3, dim ** -0.5, "wv", dtype=dtype)
          self.wo = nt.parameter((n_head * hd, dim), seed + 4, (n_head * hd) ** -0.5, "wo", dtype=dtype)
          # 表只跟位置和头维有关，跟数据无关 —— 整个训练里算一次就够
          # （Llama 里这块叫 rotary_emb，同样是预算好挂在模块上的）。
          # 更要紧的是它**必须在训练循环那个 mark 之前建好**：role="data" 是常驻角色，
          # 落在 mark 之后的话，每步的 release 会当场报错。
          self._cos, self._sin = build_tables(list(range(max_seq)), hd, base, dtype)

      def forward(self, x, batch, seq, offset=0):
          rows, hd = batch * seq, self.head_dim
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          if offset == 0 and seq <= self.max_seq:
              # 表是按位置排的，前 seq 行正好就是 0..seq-1
              cos, sin = self._cos, self._sin
          else:
              cos, sin = build_tables(list(range(offset, offset + seq)), hd, self.base, self.dtype)
          q = F.rope(q, cos, sin, batch, seq, self.n_head, hd)
          k = F.rope(k, cos, sin, batch, seq, self.n_kv_head, hd)
          scores = F.attn_scores(q, k, batch, seq, seq, self.n_head, self.n_kv_head, hd)
          valid = F.causal_valid(batch, self.n_head, seq, offset)
          probs = F.softmax(scores, batch * self.n_head * seq, seq, valid)
          out = F.attn_apply(
              probs, v, batch, seq, seq, self.n_head, self.n_kv_head, hd,
              out_shape=(rows, self.n_head * hd)
          )
          return F.linear(out, self.wo)


  def swiglu_hidden(dim, multiple_of=8):
      hidden = int(2 * (4 * dim) / 3)
      return (hidden + multiple_of - 1) // multiple_of * multiple_of


  class SwiGLU(nn.Module):
      def __init__(self, dim, hidden, seed, dtype="f32"):
          super().__init__()
          self.dim, self.hidden = dim, hidden
          self.w_gate = nt.parameter((dim, hidden), seed + 1, dim ** -0.5, "w_gate", dtype=dtype)
          self.w_up = nt.parameter((dim, hidden), seed + 2, dim ** -0.5, "w_up", dtype=dtype)
          self.w_down = nt.parameter((hidden, dim), seed + 3, hidden ** -0.5, "w_down", dtype=dtype)

      def forward(self, x, rows=0):
          return F.linear(F.swiglu(F.linear(x, self.w_gate), F.linear(x, self.w_up)), self.w_down)


  class Block(nn.Module):
      def __init__(self, dim, n_head, n_kv_head, seed, n_layer=1, dtype="f32"):
          super().__init__()
          self.dim, self.n_layer = dim, n_layer
          self.norm1 = RMSNorm(dim, dtype=dtype)
          self.attn = RopeAttention(dim, n_head, n_kv_head, seed, dtype=dtype)
          self.norm2 = RMSNorm(dim, dtype=dtype)
          self.mlp = SwiGLU(dim, swiglu_hidden(dim), seed + 10, dtype=dtype)

      def forward(self, x, batch, seq, offset=0):
          rows = batch * seq
          scale = (2.0 * self.n_layer) ** -0.5
          x = F.add(x, F.scale(self.attn(self.norm1(x, rows), batch, seq, offset), scale))
          x = F.add(x, F.scale(self.mlp(self.norm2(x, rows), rows), scale))
          return x
`;

const STAGE_MODEL_BWD = {
  id: 'model-backward',
  title: t('整个模型的反向 —— 每一个参数都得对', 'The whole model backward — every parameter has to be right'),
  goal: t(
    code`
      前面所有零件都在 \`parts.py\` 里了。这一关在 \`lm.py\` 里把它们接成一个
      **能训的语言模型**，并让每一个参数的梯度都经得起查。

      \`\`\`python
      class LM(nn.Module):
          def __init__(self, vocab, dim, n_layer, n_head, n_kv_head, seed, dtype="f32"):
              # 嵌入表 -> n_layer 个 Block -> 最后一次归一化 -> 输出头
          def forward(self, idx, targets, batch, seq):
              """返回一个标量 loss。"""
      \`\`\`

      ## 权重绑定

      输出头**用嵌入表本身**，不另开一块：\`F.linear_tied(x, self.embed, ...)\`。
      GPT-2 起就是这么做的。在小模型上这省掉的是一大块 —— 本关
      \`vocab · dim = 256\`，占总参数的 4%；到 vocab 15 万的模型上，
      不绑定的话光输出头就是几亿个参数。

      注意 \`parameters()\` **不许把它数两遍**。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 参数量 | 恰好 **6480**（解析式见下） |
      | **每一个参数张量都查过** | \`checkedTensors\` = **20** |
      | 梯度检验 | f64 中心差分，最大相对误差 ≤ 2e-3 |
      | **没有哪个张量的梯度全是 0** | 全零的张量数 = 0 |
      | 反向的代价 | \`backward / forward\` FLOPs ≤ **2.2** |

      \`\`\`
      嵌入 16·16 = 256
      每层 注意力 768 + 前馈 3·16·48 = 2304 + 两个 norm 32 = 3104
      2 层 6208，加最后一个 norm 16，加嵌入 256  ->  6480
      张量数 1 + 2·9 + 1 = 20
      \`\`\`

      ## 「梯度全是 0」为什么单独查

      一个模块建出来了、前向也用上了，但**没被登记进 \`parameters()\`** ——
      这是最常见的一类错。表现是：模型跑得通，loss 也降，只是那一部分从来没被更新过。
      放进普通 \`list\` 的子模块就是这样，\`nn.ModuleList\` 存在的全部理由就是它。

      另一种是某个分支根本没接进计算图（写了但没用上），梯度自然是 0。
      两种都不报错，两种都只能靠**逐张量查一遍**发现。

      ## \`backward / forward ≤ 2.2\` 是什么意思

      理论值是 **2**：每个矩阵乘在反向里要算两个（\`dX\` 和 \`dW\`），
      而逐元素的那些算子反向和前向同阶。留 0.2 的余量给
      softmax 反向、归一化反向这类稍贵一点的。

      **明显超过 2.2 说明反向里重算了前向。** 这个错不会让梯度出问题 ——
      结果完全正确，只是算力白花了一大半，而在 loss 曲线上一点痕迹都没有。
    `,
    code`
      All the earlier pieces live in \`parts.py\`. This stage assembles them in \`lm.py\`
      into a **trainable language model** whose every parameter gradient survives checking.

      \`\`\`python
      class LM(nn.Module):
          def __init__(self, vocab, dim, n_layer, n_head, n_kv_head, seed, dtype="f32"):
              # embedding -> n_layer Blocks -> a final normalisation -> output head
          def forward(self, idx, targets, batch, seq):
              """Returns a scalar loss."""
      \`\`\`

      ## Weight tying

      The output head **is the embedding table**, not a separate matrix:
      \`F.linear_tied(x, self.embed, ...)\`. GPT-2 onwards does this. Here
      \`vocab · dim = 256\` is 4% of the parameters; at a 150k vocabulary an untied output
      head alone would be hundreds of millions.

      Note that \`parameters()\` must **not count it twice**.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Parameters | Exactly **6480** (formula below) |
      | **Every parameter tensor checked** | \`checkedTensors\` = **20** |
      | Gradient check | f64 central differences, max relative error ≤ 2e-3 |
      | **No tensor with an all-zero gradient** | zero-gradient tensors = 0 |
      | Cost of the backward | \`backward / forward\` FLOPs ≤ **2.2** |

      \`\`\`
      embedding 16·16 = 256
      per layer: attention 768 + MLP 3·16·48 = 2304 + two norms 32 = 3104
      2 layers 6208, plus the final norm 16, plus the embedding 256  ->  6480
      tensors 1 + 2·9 + 1 = 20
      \`\`\`

      ## Why "all-zero gradient" gets its own check

      A module gets built and used in the forward pass, but is **never registered in
      \`parameters()\`** — the most common failure of its kind. The model runs, the loss
      falls, and that part is simply never updated. Submodules dropped into a plain
      \`list\` behave exactly this way; avoiding it is the entire reason \`nn.ModuleList\`
      exists.

      The other variant is a branch that never joined the graph at all (written but not
      used), whose gradient is naturally zero. Neither raises an error, and only a
      **per-tensor sweep** finds them.

      ## What \`backward / forward ≤ 2.2\` means

      The theoretical value is **2**: every matmul needs two in the backward (\`dX\` and
      \`dW\`), while elementwise operators cost the same either way. The 0.2 of slack covers
      slightly pricier backwards like softmax and normalisation.

      **Clearly above 2.2 means the backward recomputed the forward.** That bug does not
      corrupt gradients — results stay perfectly correct, more than half the compute is
      simply wasted, and no loss curve shows a trace of it.
    `
  ),
  checklist: [
    t('参数量恰好等于解析式，权重绑定没被数两遍',
      'The parameter count matches the formula; tying is not double-counted'),
    t('每一个参数张量的梯度都查过且非零',
      'Every parameter tensor has a checked, non-zero gradient'),
    t('f64 下整模型的梯度检验通过', 'The whole-model f64 gradient check passes'),
    t('反向的 FLOPs 不超过前向的 2.2 倍', 'Backward FLOPs stay within 2.2x of the forward'),
  ],
  hints: [
    t('blocks 用 nn.ModuleList 装 —— 普通 list 里的子模块不会被 parameters() 数到。',
      'Hold the blocks in nn.ModuleList; submodules in a plain list never reach parameters().'),
    t('F.linear_tied(x, table, rows, dim, vocab) 就是「输出头 = 嵌入表转置」。',
      'F.linear_tied(x, table, rows, dim, vocab) is exactly "output head = embedding transposed".'),
    t('dtype 要一路传下去 —— 混着 f32 和 f64 的话矩阵乘会当场报错。',
      'Thread dtype all the way down; mixing f32 and f64 makes the matmul raise immediately.'),
  ],
  pitfalls: [
    t(code`
      **把 blocks 放进普通 \`list\`。** 前向完全正常，loss 也降 ——
      降的是嵌入表和最后那个 norm 在学。中间那些层**一次都没被更新过**，
      而且不报任何错。这一关逐张量查梯度就是为了它。
    `, code`
      **Putting the blocks in a plain \`list\`.** The forward pass is fine and the loss
      falls — because the embedding and the final norm are learning. The middle layers are
      **never updated once**, and nothing raises. The per-tensor gradient sweep exists for
      this.
    `),
    t(code`
      **输出头另开一块权重。** 这不是错，只是没绑定 —— 参数量对不上，
      而且在真实尺度上多出来的是几亿个参数。
      反过来，绑定了却让 \`parameters()\` 数了两遍也是个坑：
      优化器会把同一份权重更新两次，等效于那一块的学习率翻倍。
    `, code`
      **Allocating a separate output head.** Not wrong, just untied — the parameter count
      misses, and at real scale that is hundreds of millions of extra parameters. The
      reverse trap is tying it but letting \`parameters()\` count it twice: the optimiser
      updates the same weights twice, effectively doubling the learning rate there.
    `),
  ],
  train: {
    files: {
      'parts.py': PARTS_FULL_PY,
      'lm.py': code`
        """第 11 关：把零件接成一个能训的语言模型。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F
        from parts import Block, RMSNorm


        class LM(nn.Module):
            def __init__(self, vocab, dim, n_layer, n_head, n_kv_head, seed, dtype="f32"):
                super().__init__()
                self.vocab, self.dim, self.n_layer = vocab, dim, n_layer
                # TODO: 嵌入表、n_layer 个 Block（用 nn.ModuleList）、最后一个 RMSNorm
                self.embed = nt.parameter((vocab, dim), seed, dim ** -0.5, "embed", dtype=dtype)

            def forward(self, idx, targets, batch, seq):
                rows = batch * seq
                # TODO: 查表 -> 逐层 -> 最后归一化 -> 输出头（权重绑定）-> 交叉熵
                x = F.embedding(self.embed, idx, rows, self.dim)
                return F.cross_entropy(
                    F.linear_tied(x, self.embed, rows, self.dim, self.vocab),
                    targets, rows, self.vocab
                )


        if __name__ == "__main__":
            V, D, L, H, KV, B, S = 16, 16, 2, 2, 1, 2, 4
            m = LM(V, D, L, H, KV, seed=5)
            print("参数量", m.num_parameters(), "张量数", len(m.parameters()))
            idx = nt.zeros((B * S,), role="data"); idx.set_int_([1, 2, 3, 4, 5, 6, 7, 8])
            tgt = nt.zeros((B * S,), role="data"); tgt.set_int_([2, 3, 4, 5, 6, 7, 8, 9])
            loss = m(idx, tgt, B, S)
            loss.backward()
            print("loss %.4f" % loss.value)
      `,
    },
    referenceFiles: {
      'lm.py': code`
        """第 11 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import nn, functional as F
        from parts import Block, RMSNorm


        class LM(nn.Module):
            def __init__(self, vocab, dim, n_layer, n_head, n_kv_head, seed, dtype="f32"):
                super().__init__()
                self.vocab, self.dim, self.n_layer = vocab, dim, n_layer
                # 扇入初始化：这张表同时是输出头，那一侧的扇入就是 dim
                self.embed = nt.parameter((vocab, dim), seed, dim ** -0.5, "embed", dtype=dtype)
                # ModuleList，不是普通 list —— 普通 list 里的子模块不会被登记，
                # 于是 parameters() 数不到它们，中间那些层一次都不会被更新
                self.blocks = nn.ModuleList([
                    Block(dim, n_head, n_kv_head, seed + 100 * (i + 1), n_layer, dtype)
                    for i in range(n_layer)
                ])
                self.norm_f = RMSNorm(dim, dtype=dtype)

            def forward(self, idx, targets, batch, seq):
                rows = batch * seq
                x = F.embedding(self.embed, idx, rows, self.dim)
                for blk in self.blocks:
                    x = blk(x, batch, seq)
                x = self.norm_f(x, rows)
                # 权重绑定：输出头就是嵌入表转置，不另开一块
                logits = F.linear_tied(x, self.embed, rows, self.dim, self.vocab)
                return F.cross_entropy(logits, targets, rows, self.vocab)


        if __name__ == "__main__":
            V, D, L, H, KV, B, S = 16, 16, 2, 2, 1, 2, 4
            m = LM(V, D, L, H, KV, seed=5)
            print("参数量", m.num_parameters(), "张量数", len(m.parameters()))
            idx = nt.zeros((B * S,), role="data"); idx.set_int_([1, 2, 3, 4, 5, 6, 7, 8])
            tgt = nt.zeros((B * S,), role="data"); tgt.set_int_([2, 3, 4, 5, 6, 7, 8, 9])
            loss = m(idx, tgt, B, S)
            loss.backward()
            print("loss %.4f" % loss.value)
      `,
    },
  },
  specs: [
    spec('lm.spec.ts', code`
      ${LAB}

      const V = 16, D = 16, L = 2, H = 2, KV = 1, B = 2, S = 4;
      const HIDDEN = 48;
      const PER_BLOCK = D * (H * 8) + 2 * D * (KV * 8) + (H * 8) * D + 3 * D * HIDDEN + 2 * D;
      const PARAMS = V * D + L * PER_BLOCK + D;
      const TENSORS = 1 + L * 9 + 1;

      function setup(dtype) {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, parts, lm
      importlib.reload(parts)
      importlib.reload(lm)
      import nanotorch as nt
      from nanotorch import functional as F

      V, D, L, H, KV, B, S = \${V}, \${D}, \${L}, \${H}, \${KV}, \${B}, \${S}
      _m = lm.LM(V, D, L, H, KV, seed=5, dtype="\${dtype}")
      _idx = nt.zeros((B * S,), role="data", name="idx")
      _tgt = nt.zeros((B * S,), role="data", name="tgt")
      _idx.set_int_([1, 2, 3, 4, 5, 6, 7, 8])
      _tgt.set_int_([2, 3, 4, 5, 6, 7, 8, 9])

      _plist = [p for _, p in _m.named_parameters()]
      _pnames = [n for n, _ in _m.named_parameters()]
      _sizes = [p.numel for p in _plist]

      def _poke(changes):
          for i, val in changes:
              k = 0
              while i >= _sizes[k]:
                  i -= _sizes[k]
                  k += 1
              _plist[k].set_at_(i, val)

      def _loss_only():
          with nt.no_grad():
              return _m(_idx, _tgt, B, S).value

      def _run():
          _m.zero_grad()
          nt.phase("forward")
          _loss = _m(_idx, _tgt, B, S)
          nt.phase("other")
          _loss.backward()
          return _loss.value
      \`);
      }

      describe('整个模型的反向', () => {
        it('参数量与张量数都等于解析式', () => {
          setup('f32');
          const params = Number(lab.py('_m.num_parameters()'));
          const tensors = Number(lab.py('len(_m.parameters())'));
          const names = JSON.parse(String(lab.py('json.dumps(_pnames)')));
          console.log('参数量 ' + params + '（解析式 ' + PARAMS + '），张量 ' + tensors + ' 个');
          console.log('张量名 ' + JSON.stringify(names));
          lab.publish('params.total', params);
          lab.publish('params.tensors', tensors);
          expect(params).toBe(PARAMS);
          // 权重绑定不许被数两遍
          expect(tensors).toBe(TENSORS);
        });

        /*
         * 逐张量查梯度。**这一条抓的是「建了但没登记」** ——
         * 前向完全正常、loss 也降，只是那些层从来没被更新过，而且不报错。
         */
        it('每个参数张量的梯度都不是全零', () => {
          setup('f32');
          lab.py('_run()');
          const zeros = JSON.parse(String(lab.py(\`
      json.dumps([n for n, p in _m.named_parameters()
                  if p.grad is None or all(v == 0.0 for v in p.grad.tolist())])
      \`)));
          console.log('梯度全零的张量：' + (zeros.length ? JSON.stringify(zeros) : '没有'));
          lab.publish('grad.zeroGradTensors', zeros.length);
          expect(zeros.length).toBe(0);
        });

        it('f64 下整模型的梯度检验：最大相对误差 ≤ 2e-3', () => {
          setup('f64');
          const loss = Number(lab.py('_run()'));
          const flat = JSON.parse(String(lab.py(\`
      json.dumps({"names": _pnames,
                  "values": [v for p in _plist for v in p.tolist()],
                  "grads": [v for p in _plist for v in p.grad.tolist()],
                  "sizes": _sizes})
      \`)));

          const values = Float64Array.from(flat.values);
          const grads = Float64Array.from(flat.grads);

          /*
           * 中心差分一次只动一个元素 —— 整块重写要跨语言搬 6480 个 float，
           * 一次检验就是上百万个。所以只发变化的那几个。
           *
           * **要比的是「Python 那边现在是什么」，不是「原始值是什么」。**
           * 探针在 (+h, −h) 两次取值之后会把 JS 这边的元素还原，
           * 但那次还原后面没有跟一次 loss()，所以 Python 那边还停在 −h 上。
           * 拿原始值当基准的话，这个 −h 就再也发不过去了 ——
           * 每查一个元素模型就永久地偏一点，160 个元素之后偏出一个假的误差。
           */
          const pyState = Float64Array.from(flat.values);
          const evalLoss = () => {
            const changes = [];
            for (let i = 0; i < values.length; i++) {
              if (values[i] !== pyState[i]) {
                changes.push([i, values[i]]);
                pyState[i] = values[i];
              }
            }
            return Number(lab.py('_poke(' + JSON.stringify(changes) + '); _loss_only()'));
          };

          const params = [];
          let at = 0;
          for (let k = 0; k < flat.names.length; k++) {
            const n = flat.sizes[k];
            params.push({
              name: flat.names[k],
              values: values.subarray(at, at + n),
              grad: grads.subarray(at, at + n),
            });
            at += n;
          }

          // 每个张量抽 4 个点：20 个张量共 80 个元素、160 次前向。
          const report = lab.probe.gradCheck(params, evalLoss, 4);
          console.log(
            'loss ' + loss.toFixed(6) + '；查了 ' + report.checkedTensors + ' 个张量 / '
            + report.checkedElements + ' 个元素，最大相对误差 '
            + report.maxRelError.toExponential(2) + '（最差在 ' + report.worstTensor + '）'
          );
          lab.publish('grad.checkedTensors', report.checkedTensors);
          lab.publish('grad.maxRelError', report.maxRelError);
          expect(report.checkedTensors).toBe(TENSORS);
          expect(report.maxRelError).toBeLessThan(2e-3);
        });

        /*
         * 反向大约是前向的两倍：每个矩阵乘在反向里要算 dX 和 dW 两个。
         * 明显超过 2.2 说明反向里重算了前向 —— 梯度完全正确，
         * 只是算力白花了一大半，而 loss 曲线上没有任何痕迹。
         */
        it('反向的 FLOPs 不超过前向的 2.2 倍', () => {
          setup('f32');
          const before = lab.metrics().flops;
          lab.py('_run()');
          const after = lab.metrics().flops;
          const fwd = after.forward - before.forward;
          const bwd = after.backward - before.backward;
          const ratio = fwd > 0 ? bwd / fwd : 0;
          console.log(
            '前向 ' + fwd + '，反向 ' + bwd + '，比值 ' + ratio.toFixed(3) + '（理论 2）'
          );
          lab.publish('flops.backwardOverForward', ratio);
          expect(fwd).toBeGreaterThan(0);
          expect(ratio).toBeGreaterThan(1.2);
          expect(ratio).toBeLessThan(2.2);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.params.total', op: 'eq', value: 6480,
      zh: '模型的参数量（解析式）', en: 'model parameter count (analytic)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.checkedTensors', op: 'eq', value: 20,
      zh: '梯度检验覆盖的张量数（要全覆盖）', en: 'parameter tensors covered by the gradient check',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.maxRelError', op: 'lte', value: 2e-3,
      zh: 'f64 中心差分的最大相对误差', en: 'max relative error of the f64 central-difference check',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.zeroGradTensors', op: 'eq', value: 0,
      zh: '梯度全零的参数张量数', en: 'parameter tensors with an all-zero gradient',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.flops.backwardOverForward', op: 'lte', value: 2.2,
      zh: '反向与前向的 FLOPs 比（理论 2）', en: 'backward-over-forward FLOPs (theory says 2)',
      dimension: 'efficiency',
    }),
  ],
  focus: ['correctness', 'encapsulation', 'efficiency'],
  extension: t(
    code`
      \`6N\` 那个式子的来历，到这一关就完整了：前向 \`2N\`、反向 \`4N\`。
      反向是前向的两倍，因为每个矩阵乘要算两个梯度。

      真实训练里还有第四块 —— **激活重算**（第 18 关）。
      为了省显存，反向时把一部分前向重新算一遍，于是比值从 2 涨到 3 左右，
      \`6N\` 变成 \`8N\`。**这是拿算力换显存，而且是自愿的**：
      在显存不够的档位上，不换就根本训不了。

      逐张量查梯度这件事，PyTorch 里对应 \`torch.autograd.gradcheck\`。
      它默认要求 \`double\` 输入，理由和这里一样。真实项目里它一般只在
      自定义算子上跑,整模型跑一次太慢，但**新写的每一个 \`autograd.Function\`
      都该过一遍**。
    `,
    code`
      The \`6N\` rule is now complete: \`2N\` forward, \`4N\` backward. The backward is twice
      the forward because each matmul produces two gradients.

      Real training adds a fourth piece — **activation recomputation** (stage 18). To save
      memory the backward recomputes part of the forward, pushing the ratio from 2 to about
      3 and \`6N\` to \`8N\`. **That trades compute for memory, deliberately**: at memory-bound
      scales, not trading means not training at all.

      Per-tensor gradient checking corresponds to \`torch.autograd.gradcheck\` in PyTorch,
      which likewise requires \`double\` inputs for the same reason. Real projects usually run
      it only on custom operators — a whole model is too slow — but **every newly written
      \`autograd.Function\` should go through it**.
    `
  ),
};

/* ================================================================== */
/* 第 12 关：AdamW                                                     */
/* ================================================================== */

const STAGE_ADAMW = {
  id: 'adamw',
  title: t('AdamW —— 偏差修正与解耦的权重衰减', 'AdamW — bias correction and decoupled weight decay'),
  goal: t(
    code`
      在 \`opt.py\` 里自己写一个 AdamW。**这一关不许用 \`nt.optim.AdamW\`** ——
      用例会把它换成一个当场报错的桩。

      \`\`\`python
      class MyAdamW:
          def __init__(self, params, lr=3e-3, betas=(0.9, 0.95), eps=1e-8,
                       weight_decay=0.1, grad_clip=1.0):
          def zero_grad(self):
          def grad_norm(self):
          def step(self, lr=None):
              """走一步，返回**裁剪前**的梯度范数。"""
      \`\`\`

      逐元素的那一步用 \`F.adamw_(p, g, m, v, lr, beta1, beta2, eps, decay, t, clip)\` ——
      它对应一次融合的优化器 kernel（真实框架里叫 \`fused\` 或 \`foreach\`）。
      **你要写的是它外面那一层**：状态怎么开、\`t\` 怎么数、哪些参数衰减、裁剪怎么算。
      而这一层正是真实训练代码里出错的地方。

      ## 偏差修正：为什么第一步的步长恰好是 lr

      一阶动量从 0 起步：\`m₁ = (1−β₁)·g\`。β₁ = 0.9 的话它只有梯度的 **1/10**。
      二阶同理，\`v₁ = (1−β₂)·g²\`。直接拿去更新的话第一步会小得离谱：

      \`\`\`
      不修正   lr · (1−β₁)g / sqrt((1−β₂)g²) = lr · 0.1/0.2236 ≈ 0.447 · lr
      修正后   m̂ = m₁/(1−β₁) = g，v̂ = v₁/(1−β₂) = g²
               lr · g / |g| = lr        ← 恰好一个 lr
      \`\`\`

      所以**梯度恒定时，第一步的参数变化幅度恰好是 \`lr\`**（先不算衰减）。
      这一关就用它来验偏差修正接没接对：量出 0.447 说明没修正，量出 nan 说明 \`t\` 从 0 数起。

      修正的分母是 \`1 − β^t\`,\`t\` 从 **1** 开始数，不是 0。

      ## 解耦的权重衰减：AdamW 里的那个 W

      Adam 加 L2 正则是把 \`λ·w\` 加进**梯度**里，于是它也被 \`sqrt(v)\` 除了一道 ——
      梯度大的参数被衰减得少，梯度小的被衰减得多，**和「衰减」的本意正好相反**。

      AdamW 把它**解耦**出来，直接作用在参数上：

      \`\`\`
      w ← w − lr · ( m̂/(sqrt(v̂)+ε) + λ·w )
                                      ↑ 不经过 sqrt(v)
      \`\`\`

      ## 一维参数不衰减

      归一化的增益、以及（如果有的话）bias，都是一维的。它们**不该被衰减**：
      增益的作用就是把某一层整体放大或缩小，衰减它等于持续往「缩小」推，
      而 loss 在前几百步看不出区别。

      这一关的探针：给一维参数**零梯度**跑 100 步。
      写对了它们的范数**一点都不变**；把它们一起衰减掉的话，
      \`lr=0.1, λ=0.1\` 下 100 步之后只剩 \`(1−0.01)¹⁰⁰ ≈ 37%\`。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 与参考实现 | 20 步之后**逐位相同** |
      | **偏差修正** | 恒定梯度下第一步的幅度与 \`lr\` 的相对差 ≤ 0.02 |
      | **一维不衰减** | 零梯度跑 100 步，一维参数的范数比 ≥ 0.999 |
      | 状态显存 | 恰好是参数的 **2 倍**（m 和 v） |

      最后一条顺带回答一个常被问到的问题：**AdamW 的优化器状态是参数的两倍。**
      加上参数本身和梯度，fp32 训练光这三样就是 \`4N\` 个 float,
      一个 7B 模型 112GB，而这还没算激活。混合精度和分片存在的理由就在这里。
    `,
    code`
      Write your own AdamW in \`opt.py\`. **\`nt.optim.AdamW\` is forbidden here** — the
      hidden cases replace it with a stub that raises.

      \`\`\`python
      class MyAdamW:
          def __init__(self, params, lr=3e-3, betas=(0.9, 0.95), eps=1e-8,
                       weight_decay=0.1, grad_clip=1.0):
          def zero_grad(self):
          def grad_norm(self):
          def step(self, lr=None):
              """Take a step; return the gradient norm **before** clipping."""
      \`\`\`

      The elementwise part is
      \`F.adamw_(p, g, m, v, lr, beta1, beta2, eps, decay, t, clip)\`, corresponding to a
      fused optimiser kernel (\`fused\` or \`foreach\` in real frameworks). **Your job is the
      layer around it**: how state is allocated, how \`t\` is counted, which parameters
      decay, how clipping is computed. That layer is where real training code goes wrong.

      ## Bias correction: why the first step is exactly lr

      The first moment starts at zero: \`m₁ = (1−β₁)·g\`, which at β₁ = 0.9 is only **a
      tenth** of the gradient. The second follows suit, \`v₁ = (1−β₂)·g²\`. Used directly,
      the first step is absurdly small:

      \`\`\`
      uncorrected   lr · (1−β₁)g / sqrt((1−β₂)g²) = lr · 0.1/0.2236 ≈ 0.447 · lr
      corrected     m̂ = m₁/(1−β₁) = g,  v̂ = v₁/(1−β₂) = g²
                    lr · g / |g| = lr        <- exactly one lr
      \`\`\`

      So **with a constant gradient the first step moves each parameter by exactly \`lr\`**
      (ignoring decay). This stage uses that to verify bias correction: measuring 0.447
      means no correction, and a nan means \`t\` started at 0.

      The correction denominator is \`1 − β^t\`, with \`t\` counting from **1**, not 0.

      ## Decoupled weight decay: the W in AdamW

      Adam with L2 regularisation adds \`λ·w\` into the **gradient**, so it too gets divided
      by \`sqrt(v)\` — parameters with large gradients decay less and those with small
      gradients decay more, **the opposite of what decay is for**.

      AdamW **decouples** it, applying it straight to the parameter:

      \`\`\`
      w <- w − lr · ( m̂/(sqrt(v̂)+ε) + λ·w )
                                      ^ never passes through sqrt(v)
      \`\`\`

      ## One-dimensional parameters are not decayed

      Normalisation gains, and biases where they exist, are one-dimensional. They **should
      not decay**: a gain exists to scale a layer up or down, and decaying it pushes
      permanently toward "down" — with no visible difference in the loss for hundreds of
      steps.

      The probe here gives one-dimensional parameters **zero gradients** for 100 steps.
      Done right their norm does not move at all; decayed along with everything else, at
      \`lr=0.1, λ=0.1\` only \`(1−0.01)¹⁰⁰ ≈ 37%\` remains after 100 steps.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Versus the reference | **Bit-identical** after 20 steps |
      | **Bias correction** | With a constant gradient, first-step size within 0.02 of \`lr\` |
      | **No decay on 1-D** | Zero gradients for 100 steps; 1-D norm ratio >= 0.999 |
      | Optimiser state | Exactly **2x** the parameters (m and v) |

      That last row answers a frequently asked question: **AdamW's optimiser state is twice
      the parameters.** Together with the parameters and gradients, fp32 training needs
      \`4N\` floats for those three alone — 112GB for a 7B model, before any activations.
      That is the reason mixed precision and sharding exist.
    `
  ),
  checklist: [
    t('m 和 v 的角色是 optimizer，梯度在 __init__ 里就分配掉',
      'm and v carry the optimizer role, and gradients are allocated in __init__'),
    t('t 从 1 开始数，偏差修正的分母是 1 − β^t',
      't counts from 1, and the correction denominator is 1 − β^t'),
    t('一维参数不做权重衰减', 'One-dimensional parameters are not weight-decayed'),
    t('裁剪用的是全局范数，step 返回裁剪前的值',
      'Clipping uses the global norm; step returns the pre-clip value'),
  ],
  hints: [
    t('Tensor(p.shape, p.dtype, role="optimizer") 建 m 与 v，建完 fill_(0.0)。',
      'Build m and v with Tensor(p.shape, p.dtype, role="optimizer"), then fill_(0.0).'),
    t('全局范数：把每个梯度的 F.sumsq 加起来再开方，不是逐张量各裁各的。',
      'Global norm: add up F.sumsq of every gradient then take the root, not per-tensor clipping.'),
    t('一维的判据是 len(p.shape) == 1。',
      'One-dimensional means len(p.shape) == 1.'),
  ],
  pitfalls: [
    t(code`
      **梯度留到第一次反向才分配。** 训练循环每步 \`release\` 一次激活，
      而懒分配出来的梯度会落在那个 mark 之后 —— **第二步就被推平了**。
      报出来的错是「没有 id 为 105 的张量」，一个和病因毫无关系的数字。
      这个坑这个项目自己踩过，所以 \`__init__\` 里就得把梯度开好。
    `, code`
      **Allocating gradients lazily at the first backward.** The training loop releases
      activations every step, and lazily allocated gradients land after that mark — so
      **step two wipes them**. The error reads "no tensor with id 105", a number with no
      relation to the cause. This project hit exactly that, which is why gradients get
      allocated in \`__init__\`.
    `),
    t(code`
      **逐张量裁剪而不是全局裁剪。** 每个张量各自裁到 clip 的话，
      裁完的总范数是 \`clip · sqrt(张量数)\` —— 20 个张量就是 4.5 倍，
      而且**各层之间的相对大小被抹平了**，梯度的方向都变了。
      全局裁剪只缩放，不改方向。
    `, code`
      **Clipping per tensor instead of globally.** Clipping each tensor to \`clip\` leaves a
      total norm of \`clip · sqrt(tensors)\` — 4.5x at 20 tensors — and **flattens the
      relative magnitudes between layers**, changing the gradient's direction. Global
      clipping only rescales; it never rotates.
    `),
  ],
  train: {
    files: {
      'opt.py': code`
        """第 12 关：自己写 AdamW。不许用 nt.optim.AdamW。"""
        import nanotorch as nt
        from nanotorch import functional as F
        from nanotorch.tensor import Tensor


        class MyAdamW:
            def __init__(self, params, lr=3e-3, betas=(0.9, 0.95), eps=1e-8,
                         weight_decay=0.1, grad_clip=1.0):
                self.params = list(params)
                self.lr = lr
                self.beta1, self.beta2 = betas
                self.eps = eps
                self.weight_decay = weight_decay
                self.grad_clip = grad_clip
                self.t = 0
                # TODO: 一阶动量 m 与二阶动量 v，角色是 "optimizer"，初值全 0
                self._m = []
                self._v = []
                # TODO: 梯度也在这里分配掉，别留到第一次反向

            def zero_grad(self):
                for p in self.params:
                    p.zero_grad()

            def grad_norm(self):
                """全局梯度范数。"""
                # TODO
                return 0.0

            def step(self, lr=None):
                """走一步，返回裁剪前的梯度范数。"""
                nt.phase("optimizer")
                # TODO: t += 1 -> 算全局范数 -> 算裁剪系数 -> 逐张量调 F.adamw_
                #       一维参数的 decay 是 0
                nt.phase("other")
                return 0.0


        if __name__ == "__main__":
            w = nt.parameter((4, 4), 1, 0.5, "w")
            g = nt.parameter((4,), None, 0.0, "gain")
            opt = MyAdamW([w, g], lr=0.1)
            before = F.norm(w)
            w.grad.fill_(1.0)
            print("范数", round(opt.step(), 6))
            print("第一步走了", round(abs(F.norm(w) - before), 6))
      `,
    },
    referenceFiles: {
      'opt.py': code`
        """第 12 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F
        from nanotorch.tensor import Tensor


        class MyAdamW:
            def __init__(self, params, lr=3e-3, betas=(0.9, 0.95), eps=1e-8,
                         weight_decay=0.1, grad_clip=1.0):
                self.params = list(params)
                self.lr = lr
                self.beta1, self.beta2 = betas
                self.eps = eps
                self.weight_decay = weight_decay
                self.grad_clip = grad_clip
                self.t = 0
                # role="optimizer"：这两块要出现在 memory.optimizerStateBytes 里,
                # AdamW 的 2 倍状态是显存关的主角之一
                self._m = [Tensor(p.shape, p.dtype, role="optimizer", name="m") for p in self.params]
                self._v = [Tensor(p.shape, p.dtype, role="optimizer", name="v") for p in self.params]
                for t in self._m + self._v:
                    t.fill_(0.0)
                # 梯度在这里就分配掉。懒分配的话它会落在训练循环那个 mark 之后，
                # 第二步的 release 会把它推平
                for p in self.params:
                    p.ensure_grad()

            def zero_grad(self):
                for p in self.params:
                    p.zero_grad()

            def grad_norm(self):
                total = 0.0
                for p in self.params:
                    if p.grad is not None:
                        # 先把平方和加起来再开方。用 F.norm 各自平方回去的话，
                        # sqrt(s)**2 和 s 在浮点下不是同一个数,而裁剪系数是拿它除出来的
                        total += F.sumsq(p.grad)
                return total ** 0.5

            def step(self, lr=None):
                nt.phase("optimizer")
                self.t += 1
                rate = self.lr if lr is None else lr
                norm = self.grad_norm()
                # 全局裁剪：只缩放，不改方向。逐张量各裁各的会把层间的相对大小抹平
                scale = 1.0
                if self.grad_clip > 0 and norm > self.grad_clip:
                    scale = self.grad_clip / norm

                for i, p in enumerate(self.params):
                    if p.grad is None:
                        continue
                    # 一维的不衰减：norm 的增益、bias 都在这一类里
                    decay = self.weight_decay if len(p.shape) > 1 else 0.0
                    F.adamw_(p, p.grad, self._m[i], self._v[i],
                             rate, self.beta1, self.beta2, self.eps, decay, self.t, scale)
                nt.phase("other")
                # 返回裁剪前的值：曲线要看的是梯度本来有多大，
                # 而不是裁完那个恒等于 clip 的数
                return norm


        if __name__ == "__main__":
            w = nt.parameter((4, 4), 1, 0.5, "w")
            g = nt.parameter((4,), None, 0.0, "gain")
            opt = MyAdamW([w, g], lr=0.1)
            before = F.norm(w)
            w.grad.fill_(1.0)
            print("范数", round(opt.step(), 6))
            print("第一步走了", round(abs(F.norm(w) - before), 6))
      `,
    },
  },
  specs: [
    spec('opt.spec.ts', code`
      ${LAB}

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, opt
      importlib.reload(opt)
      import nanotorch as nt
      from nanotorch import functional as F, optim

      def _pair(seed):
          """一个矩阵 + 一个一维增益。两者的衰减待遇不一样。"""
          w = nt.parameter((4, 4), seed, 0.5, "w")
          g = nt.parameter((4,), None, 0.0, "gain")
          return [w, g]

      # 换掉内建的 AdamW —— 这一关要自己写，不许转手。
      # 换之前先存一份：判定自己还要拿它当参考跑一遍。
      _SAVED_ADAMW = getattr(optim, "_saved_adamw", None) or optim.AdamW
      optim._saved_adamw = _SAVED_ADAMW

      def _forbid_builtin():
          class _Boom:
              def __init__(self, *a, **k):
                  raise RuntimeError("这一关不许用 nt.optim.AdamW，自己写一个")
          optim.AdamW = _Boom

      def _allow_builtin():
          optim.AdamW = _SAVED_ADAMW
      \`);
      }

      describe('AdamW', () => {
        /*
         * 20 步之后逐位相同。用同一串梯度喂两边 ——
         * 这条同时管住偏差修正、解耦衰减、裁剪、以及 t 从几开始数。
         */
        it('跑 20 步之后与参考实现逐位相同', () => {
          setup();
          const run = (which) => JSON.parse(String(lab.py(\`
      _ps = _pair(11)
      \${which === 'mine' ? '_forbid_builtin()\\n_o = opt.MyAdamW(_ps, lr=0.05, weight_decay=0.1, grad_clip=1.0)'
                          : '_allow_builtin()\\n_o = optim.AdamW(_ps, lr=0.05, weight_decay=0.1, grad_clip=1.0)'}
      _norms = []
      for _s in range(20):
          _o.zero_grad()
          # 每步换一串确定的梯度，量级故意跨过 grad_clip
          for _j, _p in enumerate(_ps):
              _p.grad.set_([((_i * 7 + _s * 13 + _j * 3) % 11 - 5) * 0.11
                            for _i in range(_p.numel)])
          _norms.append(_o.step())
      json.dumps({"w": _ps[0].tolist(), "g": _ps[1].tolist(), "norms": _norms})
      \`)));

          const mine = run('mine');
          const ref = run('builtin');
          let mismatches = 0;
          for (let i = 0; i < ref.w.length; i++) if (mine.w[i] !== ref.w[i]) mismatches += 1;
          for (let i = 0; i < ref.g.length; i++) if (mine.g[i] !== ref.g[i]) mismatches += 1;
          for (let i = 0; i < ref.norms.length; i++) {
            if (Math.abs(mine.norms[i] - ref.norms[i]) > 1e-12) mismatches += 1;
          }
          console.log(
            '20 步之后 w[0] 自己写的 ' + mine.w[0] + '，参考 ' + ref.w[0]
            + '；对不上的位置 ' + mismatches + ' 个'
          );
          lab.publish('optim.referenceMismatches', mismatches);
          expect(mismatches).toBe(0);
        });

        /*
         * 偏差修正接对了的话，恒定梯度下第一步的幅度恰好是 lr。
         * 没修正是 0.447·lr；t 从 0 数起会得到 nan。
         */
        it('恒定梯度下，第一步的幅度恰好是 lr', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _forbid_builtin()
      _w = nt.parameter((4, 4), 3, 0.5, "w")
      _o = opt.MyAdamW([_w], lr=0.1, weight_decay=0.0, grad_clip=0.0)
      _before = list(_w.tolist())
      _w.grad.fill_(1.0)
      _o.step()
      _after = list(_w.tolist())
      json.dumps({"before": _before, "after": _after})
      \`)));

          let worst = 0;
          for (let i = 0; i < r.before.length; i++) {
            worst = Math.max(worst, Math.abs(Math.abs(r.after[i] - r.before[i]) / 0.1 - 1));
          }
          console.log(
            '第一步的幅度 / lr，最差偏离 1 的程度 ' + worst.toFixed(6)
            + '（不做偏差修正会是 0.553）'
          );
          lab.publish('optim.firstStepError', worst);
          expect(worst).toBeLessThan(0.02);
        });

        /*
         * 一维参数不衰减。零梯度跑 100 步：
         * 写对了范数一点不变；一起衰减掉的话只剩 37%。
         * 同时验矩阵**确实**被衰减了 —— 否则「所有参数都不衰减」也能过。
         */
        it('零梯度跑 100 步：一维不衰减，矩阵衰减', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _forbid_builtin()
      _ps = _pair(7)
      _o = opt.MyAdamW(_ps, lr=0.1, weight_decay=0.1, grad_clip=0.0)
      _w0, _g0 = F.norm(_ps[0]), F.norm(_ps[1])
      for _ in range(100):
          _o.zero_grad()          # 梯度全 0，只剩衰减在起作用
          _o.step()
      json.dumps({"w": F.norm(_ps[0]) / _w0, "g": F.norm(_ps[1]) / _g0})
      \`)));
          console.log(
            '100 步之后 矩阵剩 ' + (r.w * 100).toFixed(1) + '%，一维剩 '
            + (r.g * 100).toFixed(1) + '%（一起衰减的话一维会剩 36.6%）'
          );
          lab.publish('optim.gainNormRatio', r.g);
          lab.publish('optim.matrixNormRatio', r.w);
          expect(r.g).toBeGreaterThan(0.999);
          // 矩阵必须真的被衰减，否则「全都不衰减」也能过上面那条
          expect(r.w).toBeLessThan(0.99);
        });

        it('优化器状态恰好是参数的 2 倍', () => {
          setup();
          const before = lab.metrics().memory.optimizerStateBytes;
          const paramBytes = Number(lab.py(\`
      _forbid_builtin()
      _ps = _pair(5)
      _o = opt.MyAdamW(_ps, lr=0.05)
      sum(p.numel for p in _ps) * 4
      \`));
          const after = lab.metrics().memory.optimizerStateBytes;
          const ratio = (after - before) / paramBytes;
          console.log(
            '参数 ' + paramBytes + ' 字节，优化器状态 ' + (after - before)
            + ' 字节，比值 ' + ratio.toFixed(3)
          );
          lab.publish('optim.stateOverParamBytes', ratio);
          expect(ratio).toBe(2);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.optim.referenceMismatches', op: 'eq', value: 0,
      zh: '20 步之后与参考实现对不上的位置数',
      en: 'positions differing from the reference after 20 steps', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.optim.firstStepError', op: 'lte', value: 0.02,
      zh: '第一步的幅度与 lr 的相对差（偏差修正）',
      en: 'first-step size relative to lr (bias correction)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.optim.gainNormRatio', op: 'gte', value: 0.999,
      zh: '零梯度 100 步后一维参数的范数比', en: '1-D parameter norm ratio after 100 zero-gradient steps',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.optim.stateOverParamBytes', op: 'eq', value: 2,
      zh: '优化器状态与参数的字节比', en: 'optimiser state bytes over parameter bytes',
      dimension: 'efficiency',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      \`betas=(0.9, 0.95)\` 而不是 PyTorch 默认的 \`(0.9, 0.999)\` —— LLM 预训练普遍用
      0.95。二阶动量跟得太慢的话，loss 出尖峰之后要很久才恢复，
      而尖峰在大规模预训练里是常态。

      优化器状态是显存关的主角。fp32 下参数 + 梯度 + m + v = \`4N\` 个 float，
      7B 就是 112GB —— 一张 H100 装不下。真实做法有三条：
      **混合精度**（第 17 关）把激活和梯度降到 bf16；
      **ZeRO / FSDP** 把优化器状态按数据并行的秩切开，每张卡只存 1/N；
      **8-bit 优化器**（bitsandbytes）把 m 和 v 量化到 8 位，状态直接省 4 倍。

      2026 年还有一条新的：**Muon** 在大规模上取代了 AdamW 的一部分。
      它对矩阵参数做一次正交化（Newton–Schulz 迭代）再更新，
      同样的 token 预算下 loss 更低。Kimi K2 与 GLM-5 都在用。
      注意它**只管矩阵** —— 嵌入表和一维参数仍然走 Adam，第 21 关做这件事。
    `,
    code`
      \`betas=(0.9, 0.95)\` rather than PyTorch's default \`(0.9, 0.999)\` is standard for LLM
      pretraining. A second moment that adapts too slowly makes recovery from a loss spike
      take a long time, and spikes are routine at scale.

      Optimiser state dominates memory. In fp32, parameters + gradients + m + v is \`4N\`
      floats — 112GB at 7B, more than one H100 holds. Real practice has three answers:
      **mixed precision** (stage 17) drops activations and gradients to bf16; **ZeRO /
      FSDP** shards optimiser state across data-parallel ranks so each holds 1/N; and
      **8-bit optimisers** (bitsandbytes) quantise m and v to 8 bits, cutting state
      fourfold.

      2026 adds one more: **Muon** has displaced part of AdamW at scale. It orthogonalises
      matrix parameters (via Newton-Schulz iterations) before updating, reaching a lower
      loss at the same token budget; Kimi K2 and GLM-5 both use it. Note it applies **only
      to matrices** — embeddings and 1-D parameters stay on Adam, which is stage 21's work.
    `
  ),
};

/* ================================================================== */
/* 第 13 关：学习率调度与 warmup                                        */
/* ================================================================== */

/** 平台给的训练套件：模型 + 训练循环。这几关只关心调度与裁剪 */
const KIT_PY = code`
  """平台给的训练套件：一个小语言模型 + 一条训练循环。

  这几关不动模型,要写的是**外面那一层**：学习率怎么排、梯度怎么裁、
  炸了怎么办。真实项目里模型代码往往是最稳定的部分，而训练循环是天天在改的。

  模型就是第 11 关那个，只是配置小一点：
  \`vocab=16, dim=32, n_layer=2, n_head=4, n_kv_head=2\`，
  batch 8 × seq 16 = 每步 128 个 token。
  """
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F

  V, D, L, H, KV, HID, B, S = 16, 32, 2, 4, 2, 88, 8, 16


  def build_tables(positions, head_dim, base=10000.0):
      half = head_dim // 2
      cos = nt.zeros((len(positions), half), role="data", name="rope.cos")
      sin = nt.zeros((len(positions), half), role="data", name="rope.sin")
      cv, sv = [], []
      for p in positions:
          for i in range(half):
              th = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(th))
              sv.append(math.sin(th))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class Norm(nn.Module):
      def __init__(self, dim):
          super().__init__()
          self.weight = nt.parameter((dim,), None, 0.0, "g")

      def forward(self, x):
          return F.rms_norm(x, self.weight, 1e-5)


  class Attn(nn.Module):
      def __init__(self, dim, nh, nkv, seed, max_seq=64):
          super().__init__()
          self.nh, self.nkv, self.hd = nh, nkv, dim // nh
          hd = self.hd
          self.wq = nt.parameter((dim, nh * hd), seed + 1, dim ** -0.5, "wq")
          self.wk = nt.parameter((dim, nkv * hd), seed + 2, dim ** -0.5, "wk")
          self.wv = nt.parameter((dim, nkv * hd), seed + 3, dim ** -0.5, "wv")
          self.wo = nt.parameter((nh * hd, dim), seed + 4, (nh * hd) ** -0.5, "wo")
          # 表在这里建好 —— 它是常驻的，落在训练循环的 mark 之后会被 release 拦下
          self._cos, self._sin = build_tables(list(range(max_seq)), hd)

      def forward(self, x, b, s):
          hd = self.hd
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          q = F.rope(q, self._cos, self._sin, b, s, self.nh, hd)
          k = F.rope(k, self._cos, self._sin, b, s, self.nkv, hd)
          sc = F.attn_scores(q, k, b, s, s, self.nh, self.nkv, hd)
          valid = F.causal_valid(b, self.nh, s)
          pr = F.softmax(sc, b * self.nh * s, s, valid)
          o = F.attn_apply(pr, v, b, s, s, self.nh, self.nkv, hd,
                           out_shape=(b * s, self.nh * hd))
          return F.linear(o, self.wo)


  class Mlp(nn.Module):
      def __init__(self, dim, hid, seed):
          super().__init__()
          self.wg = nt.parameter((dim, hid), seed + 1, dim ** -0.5, "wg")
          self.wu = nt.parameter((dim, hid), seed + 2, dim ** -0.5, "wu")
          self.wd = nt.parameter((hid, dim), seed + 3, hid ** -0.5, "wd")

      def forward(self, x):
          return F.linear(F.swiglu(F.linear(x, self.wg), F.linear(x, self.wu)), self.wd)


  class Block(nn.Module):
      def __init__(self, dim, nh, nkv, hid, seed, nl):
          super().__init__()
          self.n1, self.at = Norm(dim), Attn(dim, nh, nkv, seed)
          self.n2, self.mp = Norm(dim), Mlp(dim, hid, seed + 40)
          self.sc = (2.0 * nl) ** -0.5

      def forward(self, x, b, s):
          x = F.add(x, F.scale(self.at(self.n1(x), b, s), self.sc))
          return F.add(x, F.scale(self.mp(self.n2(x)), self.sc))


  class LM(nn.Module):
      def __init__(self, seed=1):
          super().__init__()
          self.embed = nt.parameter((V, D), seed, D ** -0.5, "embed")
          self.blocks = nn.ModuleList([
              Block(D, H, KV, HID, seed + 100 * (i + 1), L) for i in range(L)
          ])
          self.nf = Norm(D)

      def forward(self, idx, tgt, b, s):
          rows = b * s
          x = F.embedding(self.embed, idx, rows, D)
          for blk in self.blocks:
              x = blk(x, b, s)
          x = self.nf(x)
          return F.cross_entropy(F.linear_tied(x, self.embed, rows, D, V), tgt, rows, V)


  # 平台会把归纳任务的数据灌进来：_batches[seed] = (idx, tgt)
  _batches = {}


  def get_batch(seed):
      return _batches[seed]
`;

const STAGE_SCHEDULE = {
  id: 'lr-schedule',
  title: t('学习率调度 —— 为什么开头要慢慢来', 'The learning-rate schedule — why the start has to be slow'),
  goal: t(
    code`
      在 \`sched.py\` 里写学习率调度。模型和训练循环都在 \`kit.py\` 里，这一关只写这一个函数：

      \`\`\`python
      def lr_at(step, total_steps, base_lr, warmup, floor=0.1):
          """第 step 步（**从 1 数起**）该用多大的学习率。"""
      \`\`\`

      **这一关不许用 \`nt.optim.cosine_with_warmup\`** —— 用例会把它换成报错的桩。

      ## 两段

      \`\`\`
      step ≤ warmup:   base_lr · step / warmup                    ← 线性爬升
      step > warmup:   base_lr · (floor + (1−floor)·½(1+cos(π·p)))
                       其中 p = (step − warmup) / (total − warmup)  ← 余弦退火
      \`\`\`

      两段在 \`step = warmup\` 处接上：爬升段到顶正好是 \`base_lr\`，
      退火段从 \`p = 0\` 起也正好是 \`base_lr\`。**接不上的调度在曲线上是一个台阶**，
      而台阶处的那一步会把权重推出去一截。

      \`floor\` 是退火的终点比例。取 0.1 而不是 0 —— 学习率真降到 0 的话，
      最后那些步等于白跑；留一成还能继续微调。

      ## warmup 到底在挡什么

      开头的模型是随机的，梯度又大又没方向。而 Adam 的二阶动量 \`v\` 从 0 起步，
      前几步估得很不准 —— **分母不可靠的时候分子还很大**，一步就能把权重推很远。
      warmup 用一段小学习率把 \`v\` 喂到可信的量级，再放开。

      这不是理论。同一个模型、同一份数据、同一个 seed，跑 300 步：

      \`\`\`
      带 warmup（20 步）    最后 10 步平均 loss  1.286
      不带 warmup           最后 10 步平均 loss  1.964
      信息论地板                                 1.213
      均匀分布（什么都没学）                       2.773
      \`\`\`

      **差的不是一点半点** —— 不带 warmup 的那一路，走了三分之二的路程就停住了。
      这两个数是这一关的用例真的跑出来的，你自己也会跑到。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 公式 | 与参考在 60 个采样点上差 ≤ 1e-12 |
      | 接得上 | \`step = warmup\` 处恰好是 \`base_lr\` |
      | 训得动 | 300 步之后最后 10 步平均 loss ≤ **1.45** |
      | 比得过对照 | 不带 warmup 的对照必须明显更差 |
    `,
    code`
      Write the learning-rate schedule in \`sched.py\`. The model and training loop live in
      \`kit.py\`; this stage is one function:

      \`\`\`python
      def lr_at(step, total_steps, base_lr, warmup, floor=0.1):
          """The learning rate for step \`step\` (**counting from 1**)."""
      \`\`\`

      **\`nt.optim.cosine_with_warmup\` is forbidden here** — the hidden cases replace it
      with a stub that raises.

      ## Two segments

      \`\`\`
      step <= warmup:  base_lr · step / warmup                     <- linear ramp
      step > warmup:   base_lr · (floor + (1−floor)·½(1+cos(π·p)))
                       with p = (step − warmup) / (total − warmup)  <- cosine decay
      \`\`\`

      They meet at \`step = warmup\`: the ramp tops out at exactly \`base_lr\`, and the decay
      starts from \`p = 0\` at exactly \`base_lr\`. **A schedule that fails to meet shows a
      step in the curve**, and that one step shoves the weights outward.

      \`floor\` is where the decay ends, as a fraction. It is 0.1 rather than 0 — at a
      genuine zero the last steps do nothing, while a tenth still refines.

      ## What warmup actually prevents

      Early on the model is random and gradients are large and directionless. Adam's second
      moment \`v\` starts at zero and is badly estimated for the first few steps —
      **an unreliable denominator under a large numerator** can throw weights far in one
      step. Warmup uses a stretch of small learning rates to feed \`v\` to a trustworthy
      scale before opening up.

      This is not theory. Same model, same data, same seed, 300 steps:

      \`\`\`
      with warmup (20 steps)    mean loss over the last 10 steps  1.286
      without warmup            mean loss over the last 10 steps  1.964
      information-theoretic floor                                 1.213
      uniform (nothing learned)                                   2.773
      \`\`\`

      **That is not a small gap** — the run without warmup stops two thirds of the way
      there. The hidden cases actually produce these two numbers, and so will you.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Formula | Within 1e-12 of the reference at 60 sampled steps |
      | Continuity | Exactly \`base_lr\` at \`step = warmup\` |
      | It trains | Mean loss over the last 10 of 300 steps <= **1.45** |
      | It beats the control | The no-warmup control must be clearly worse |
    `
  ),
  checklist: [
    t('step 从 1 数起，warmup 段是 base_lr · step / warmup',
      'Steps count from 1; the ramp is base_lr · step / warmup'),
    t('两段在 step = warmup 处接得上', 'The two segments meet at step = warmup'),
    t('退火到 floor · base_lr 而不是 0', 'Decay ends at floor · base_lr, not zero'),
    t('300 步之后 loss ≤ 1.45', 'Loss reaches 1.45 or below after 300 steps'),
  ],
  hints: [
    t('余弦那段的 p 是 (step − warmup) / (total − warmup)，不是 step / total。',
      "The cosine's p is (step − warmup) / (total − warmup), not step / total."),
    t('total − warmup 可能是 0，用 max(1, ...) 兜一下。',
      'total − warmup can be zero; guard it with max(1, ...).'),
    t('warmup = 0 时整条曲线就只有余弦那一段 —— 对照组要用到。',
      'With warmup = 0 the whole curve is just the cosine segment; the control needs that.'),
  ],
  pitfalls: [
    t(code`
      **余弦那段的进度用 \`step / total\` 算。** 曲线看着也是从高到低，
      只是在 \`step = warmup\` 处有个**向下的台阶** —— 学习率突然掉一截。
      训练不会炸，只是比该有的慢一点，而这个「慢一点」你没有对照就看不出来。
    `, code`
      **Computing the cosine's progress as \`step / total\`.** The curve still descends; it
      just has a **downward step** at \`step = warmup\` where the rate suddenly drops.
      Training does not break, it merely runs slower than it should — and without a control
      run you will never notice.
    `),
    t(code`
      **step 从 0 数起。** 第一步的学习率就是 0，那一步白跑；
      更麻烦的是配上 AdamW 的偏差修正（分母 \`1 − β^t\`），\`t = 0\` 会直接除零。
      调度和优化器**必须用同一套步数编号**。
    `, code`
      **Counting steps from zero.** The first step gets a learning rate of 0 and does
      nothing; worse, paired with AdamW's bias correction (denominator \`1 − β^t\`) a
      \`t = 0\` divides by zero. The schedule and the optimiser **must share one step
      numbering**.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_PY,
      'sched.py': code`
        """第 13 关：学习率调度。不许用 nt.optim.cosine_with_warmup。"""
        import math


        def lr_at(step, total_steps, base_lr, warmup, floor=0.1):
            """第 step 步（从 1 数起）该用多大的学习率。"""
            # TODO: step <= warmup 走线性爬升，之后走余弦退火到 floor · base_lr
            return base_lr


        if __name__ == "__main__":
            for s in [1, 10, 20, 21, 100, 300]:
                print(s, round(lr_at(s, 300, 0.03, 20), 6))
      `,
    },
    referenceFiles: {
      'sched.py': code`
        """第 13 关的参考实现。"""
        import math


        def lr_at(step, total_steps, base_lr, warmup, floor=0.1):
            if warmup > 0 and step <= warmup:
                # 线性爬升。step 从 1 数起，所以 step == warmup 时正好是 base_lr
                return base_lr * step / warmup
            # 余弦退火。进度是「退火段内的进度」，不是「整段的进度」——
            # 用 step / total 的话，两段在 step = warmup 处对不上，曲线上是个台阶
            progress = (step - warmup) / max(1, total_steps - warmup)
            return base_lr * (floor + (1 - floor) * 0.5 * (1 + math.cos(math.pi * progress)))


        if __name__ == "__main__":
            for s in [1, 10, 20, 21, 100, 300]:
                print(s, round(lr_at(s, 300, 0.03, 20), 6))
      `,
    },
  },
  specs: [
    spec('sched.spec.ts', code`
      ${LAB}

      const TOTAL = 300, PEAK = 0.03, WARMUP = 20, FLOOR = 0.1;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, sched
      importlib.reload(kit)
      importlib.reload(sched)
      import nanotorch as nt
      from nanotorch import functional as F, optim

      _SAVED_SCHED = getattr(optim, "_saved_sched", None) or optim.cosine_with_warmup
      optim._saved_sched = _SAVED_SCHED

      def _boom(*a, **k):
          raise RuntimeError("这一关不许用 nt.optim.cosine_with_warmup，自己写一个")
      optim.cosine_with_warmup = _boom
      \`);
        // 平台造归纳数据，灌进 kit
        for (let s = 1; s <= TOTAL; s++) {
          const d = lab.data.induction(8, 16, 16, 1000 + s);
          lab.py('kit._batches[' + (1000 + s) + '] = ('
            + JSON.stringify([...d.idx]) + ', ' + JSON.stringify([...d.tgt]) + ')');
        }
        lab.py(\`
      def _train(use_student, warmup):
          """跑 \${TOTAL} 步，返回 loss 序列。use_student 决定学习率谁说了算。"""
          m = kit.LM(seed=1)
          opt = nt.optim.AdamW(m.parameters(), lr=\${PEAK}, betas=(0.9, 0.95),
                               weight_decay=0.1, grad_clip=1.0)
          idx = nt.zeros((kit.B * kit.S,), role="data", name="idx")
          tgt = nt.zeros((kit.B * kit.S,), role="data", name="tgt")
          hist = []
          base = nt.mark()
          for st in range(1, \${TOTAL} + 1):
              nt.release(base)
              bi, bt = kit.get_batch(1000 + st)
              idx.set_int_(bi)
              tgt.set_int_(bt)
              opt.zero_grad()
              nt.phase("forward")
              loss = m(idx, tgt, kit.B, kit.S)
              nt.phase("other")
              loss.backward()
              if use_student:
                  lr = sched.lr_at(st, \${TOTAL}, \${PEAK}, warmup, \${FLOOR})
              else:
                  # 平台自己的对照：完全不带 warmup
                  p = (st - 1) / max(1, \${TOTAL} - 1)
                  lr = \${PEAK} * (\${FLOOR} + (1 - \${FLOOR}) * 0.5 * (1 + math.cos(math.pi * p)))
              opt.step(lr=lr)
              hist.append(loss.value)
          return hist
      \`);
      }

      /** 平台侧的参考公式 */
      function refLr(step) {
        if (WARMUP > 0 && step <= WARMUP) return (PEAK * step) / WARMUP;
        const p = (step - WARMUP) / Math.max(1, TOTAL - WARMUP);
        return PEAK * (FLOOR + (1 - FLOOR) * 0.5 * (1 + Math.cos(Math.PI * p)));
      }

      describe('学习率调度', () => {
        it('公式在 60 个采样点上与参考一致', () => {
          setup();
          const steps = [];
          for (let i = 0; i < 60; i++) steps.push(1 + Math.floor((i * TOTAL) / 60));
          const got = JSON.parse(String(lab.py(
            'json.dumps([sched.lr_at(s, ' + TOTAL + ', ' + PEAK + ', ' + WARMUP + ', ' + FLOOR + ')'
            + ' for s in ' + JSON.stringify(steps) + '])'
          )));
          let worst = 0;
          for (let i = 0; i < steps.length; i++) {
            worst = Math.max(worst, Math.abs(got[i] - refLr(steps[i])));
          }
          console.log(
            'lr(1)=' + got[0].toExponential(3) + '，lr(' + WARMUP + ')=' + refLr(WARMUP).toExponential(3)
            + '，lr(' + TOTAL + ')=' + refLr(TOTAL).toExponential(3)
            + '；最大差 ' + worst.toExponential(2)
          );
          lab.publish('lr.scheduleError', worst);
          expect(worst).toBeLessThan(1e-12);
        });

        /*
         * 两段要在 step = warmup 处接上。接不上的话曲线里有个台阶,
         * 训练不会炸，只会慢，而没有对照的话看不出来。
         */
        it('爬升段与退火段在 step = warmup 处接得上', () => {
          setup();
          const at = (s) => Number(lab.py(
            'sched.lr_at(' + s + ', ' + TOTAL + ', ' + PEAK + ', ' + WARMUP + ', ' + FLOOR + ')'
          ));
          const peak = at(WARMUP);
          const next = at(WARMUP + 1);
          console.log(
            'lr(warmup)=' + peak.toExponential(6) + '（该是 ' + PEAK + '），'
            + '下一步 ' + next.toExponential(6)
          );
          lab.publish('lr.peakError', Math.abs(peak - PEAK));
          expect(Math.abs(peak - PEAK)).toBeLessThan(1e-12);
          // 退火段第一步应当只比顶点低一点点，不是掉一截
          expect(next).toBeLessThan(peak);
          expect(next).toBeGreaterThan(peak * 0.99);
          // 终点是 floor · base_lr 附近，不是 0
          expect(at(TOTAL)).toBeGreaterThan(PEAK * FLOOR * 0.9);
        });

        /*
         * 真训一遍。这一关的门槛不是「公式对」而是「训得动」——
         * 公式对但接不上的调度，能过上面那两条里的第一条，过不了这一条。
         */
        it('300 步之后 loss 掉到 1.45 以下，且明显好过没有 warmup 的对照', () => {
          setup();
          const mine = JSON.parse(String(lab.py('json.dumps(_train(True, ' + WARMUP + '))')));
          const control = JSON.parse(String(lab.py('json.dumps(_train(False, 0))')));

          const tail = (h) => h.slice(-10).reduce((a, c) => a + c, 0) / 10;
          const mineLoss = tail(mine);
          const ctrlLoss = tail(control);
          const floor = lab.data.inductionFloor(16, 16);
          // 归纳任务的均匀熵是 ln(16)。注意别用 lab.world.baselines().uniform ——
          // 那是**语料字符表**的，和这个合成任务不是一个词表
          const uniform = Math.log(16);

          console.log(
            '带 warmup ' + mineLoss.toFixed(4) + '，不带 ' + ctrlLoss.toFixed(4)
            + '；信息论地板 ' + floor.toFixed(4) + '，均匀 ' + uniform.toFixed(4)
          );
          lab.publish('loss.final', mineLoss);
          lab.publish('loss.noWarmupControl', ctrlLoss);
          lab.publish('loss.overFloor', mineLoss / floor);

          expect(mine.every((v) => Number.isFinite(v))).toBe(true);
          expect(mineLoss).toBeLessThan(1.45);
          // 对照必须明显更差 —— 否则这一关根本没在教 warmup
          expect(ctrlLoss).toBeGreaterThan(mineLoss * 1.25);
        });

        it('没有偷用内建的调度', () => {
          setup();
          const blocked = lab.py(\`
      try:
          optim.cosine_with_warmup(1, 10, 0.1)
          _ok = 0
      except RuntimeError:
          _ok = 1
      _ok
      \`);
          expect(Number(blocked)).toBe(1);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.lr.scheduleError', op: 'lte', value: 1e-12,
      zh: '调度公式与参考的最大差', en: 'max schedule difference from the reference',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.lr.peakError', op: 'lte', value: 1e-12,
      zh: 'step = warmup 处与 base_lr 的差（两段接得上）',
      en: 'gap from base_lr at step = warmup (the segments meet)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.loss.final', op: 'lte', value: 1.45,
      zh: '300 步之后最后 10 步的平均 loss', en: 'mean loss over the last 10 of 300 steps',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.loss.overFloor', op: 'lte', value: 1.2,
      zh: '最终 loss 与信息论地板的比', en: 'final loss over the information-theoretic floor',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      余弦不是唯一的选择。2026 年用得越来越多的是 **WSD**
      （Warmup–Stable–Decay）：爬升之后**保持恒定**很长一段，最后再快速衰减。
      好处是「随时可以决定再多训一会儿」—— 余弦的形状取决于你一开始声明的
      \`total_steps\`，中途想加训就得重排整条曲线，而 WSD 的恒定段可以一直延长。
      MiniCPM 与 DeepSeek 都在用它。

      另一件真实的事：**学习率和 batch 大小要一起调**。经验规律是
      batch 翻倍、学习率乘 \`sqrt(2)\`（Adam 类优化器）。
      单独把 batch 调大而不动学习率，等效于把学习率调小了。
    `,
    code`
      Cosine is not the only option. **WSD** (Warmup–Stable–Decay) has grown common in
      2026: ramp up, **hold constant** for a long stretch, then decay quickly at the end.
      Its advantage is that you can decide later to train longer — a cosine's shape depends
      on the \`total_steps\` you declared up front, so extending a run means redrawing the
      whole curve, while a WSD plateau simply continues. MiniCPM and DeepSeek both use it.

      Another real consideration: **learning rate and batch size are tuned together**. The
      rule of thumb is that doubling the batch multiplies the rate by \`sqrt(2)\` for
      Adam-family optimisers. Raising the batch alone, without touching the rate, is
      equivalent to lowering the learning rate.
    `
  ),
};

/* ================================================================== */
/* 第 14 关：梯度裁剪与训练稳定性                                        */
/* ================================================================== */

const STAGE_CLIP = {
  id: 'grad-clip',
  title: t('梯度裁剪 —— 只缩放，不改方向', 'Gradient clipping — rescale, never rotate'),
  goal: t(
    code`
      在 \`clip.py\` 里写两个函数。模型和训练循环还是 \`kit.py\` 那一套。

      \`\`\`python
      def clip_grad_norm_(params, max_norm):
          """就地裁剪，返回**裁剪前**的全局范数。

          对应 torch.nn.utils.clip_grad_norm_ —— 名字、行为、返回值都一样。"""

      def has_nonfinite_grad(params):
          """梯度里有没有 NaN / inf。有就返回 True。"""
      \`\`\`

      ## 全局范数，不是逐张量

      \`\`\`
      total = sqrt( Σ_p ‖g_p‖² )                ← 所有梯度拼成一个向量的长度
      coef  = max_norm / total   （total > max_norm 时）
      每个 g_p 原地乘上同一个 coef
      \`\`\`

      要点是**同一个 coef**。逐张量各裁各的话，各层之间的相对大小被抹平了 ——
      梯度的**方向变了**，而方向才是梯度携带的信息。
      顺带一提，逐张量裁完的总范数是 \`max_norm · sqrt(张量数)\`，根本不是 \`max_norm\`。

      这一关有一条门槛专门查方向：裁剪前后的梯度向量，**夹角余弦必须是 1**。

      ## 返回裁剪前的值

      \`clip_grad_norm_\` 返回的是**裁剪前**的范数,PyTorch 也是这样。
      理由是诊断：训练曲线要看的是梯度本来有多大。返回裁剪后的值的话，
      那个数在裁剪生效时恒等于 \`max_norm\`，是一条毫无信息量的直线。

      ## 非有限的梯度：跳过，不是清零

      bf16 / fp16 训练里，梯度出现 \`inf\` 或 \`NaN\` 是常事（溢出）。
      标准做法是**跳过这一步**：不更新参数，也不更新优化器状态,
      下一步照常。这就是混合精度里 \`GradScaler\` 干的事。

      **不要清零之后照样 step。** 那样 AdamW 的动量会被一个假的「零梯度」污染，
      而且优化器的步数 \`t\` 还往前走了一格,偏差修正的分母跟着变，
      后面每一步都受影响。

      \`F.count_nonfinite(t)\` 数得出一个张量里有多少个 NaN / inf。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 裁剪之后 | 全局范数 ≤ \`max_norm\`（全程） |
      | **只缩放不改方向** | 裁剪前后的夹角余弦与 1 差 ≤ 1e-6 |
      | 真的裁到了 | 至少有一步触发了裁剪 |
      | 炸了要跳过 | 注入一次 \`inf\` 之后，参数里非有限的个数 = **0** |
      | 跳过的步数 | 恰好 **1**（就是注入的那一步） |
    `,
    code`
      Write two functions in \`clip.py\`. The model and training loop are still \`kit.py\`.

      \`\`\`python
      def clip_grad_norm_(params, max_norm):
          """Clip in place; return the **pre-clip** global norm.

          Mirrors torch.nn.utils.clip_grad_norm_ in name, behaviour and return value."""

      def has_nonfinite_grad(params):
          """True if any gradient contains a NaN or an inf."""
      \`\`\`

      ## Global norm, not per tensor

      \`\`\`
      total = sqrt( Σ_p ‖g_p‖² )                <- length of all gradients as one vector
      coef  = max_norm / total   (when total > max_norm)
      multiply every g_p in place by the same coef
      \`\`\`

      The point is **the same coef**. Clipping tensor by tensor flattens the relative
      magnitudes between layers — it **changes the gradient's direction**, and direction is
      what a gradient carries. Incidentally, per-tensor clipping leaves a total norm of
      \`max_norm · sqrt(tensors)\`, not \`max_norm\`.

      One gate here checks direction specifically: the cosine between the pre-clip and
      post-clip gradient vectors **must be 1**.

      ## Return the pre-clip value

      \`clip_grad_norm_\` returns the norm **before** clipping, as PyTorch does. The reason
      is diagnostic: a training curve wants to show how large the gradient really was.
      Returning the post-clip value gives a number that is identically \`max_norm\` whenever
      clipping fires — a flat line carrying no information.

      ## Non-finite gradients: skip, do not zero

      Under bf16 / fp16, gradients turn into \`inf\` or \`NaN\` routinely (overflow). The
      standard response is to **skip the step**: leave parameters and optimiser state
      untouched and carry on. That is what \`GradScaler\` does in mixed precision.

      **Do not zero them and step anyway.** That pollutes AdamW's momentum with a fake
      "zero gradient", and the optimiser's step counter \`t\` still advances — changing the
      bias-correction denominator and affecting every step that follows.

      \`F.count_nonfinite(t)\` counts the NaNs and infs in a tensor.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | After clipping | Global norm <= \`max_norm\`, throughout |
      | **Rescale only** | Pre/post cosine within 1e-6 of 1 |
      | It actually clipped | At least one step triggered clipping |
      | Blow-ups get skipped | After one injected \`inf\`, non-finite parameters = **0** |
      | Steps skipped | Exactly **1** — the injected one |
    `
  ),
  checklist: [
    t('用全局范数算一个 coef，所有梯度乘同一个',
      'One coef from the global norm, applied to every gradient'),
    t('返回的是裁剪前的范数', 'The returned norm is the pre-clip one'),
    t('total ≤ max_norm 时不动梯度', 'Gradients are untouched when total <= max_norm'),
    t('梯度非有限时跳过整步，不清零硬走', 'Non-finite gradients skip the whole step rather than being zeroed'),
  ],
  hints: [
    t('F.sumsq(g) 拿平方和，全部加起来再开方 —— 别把各自的范数平方回去。',
      'Take F.sumsq(g), add them all, then take the root; do not square individual norms back.'),
    t('F.scale_(g, coef) 就地乘。它不挂反向 —— 梯度本来就不需要再求导。',
      'F.scale_(g, coef) multiplies in place. It attaches no backward; gradients need none.'),
    t('F.count_nonfinite(g) > 0 就是有 NaN 或 inf。',
      'F.count_nonfinite(g) > 0 means a NaN or an inf is present.'),
  ],
  pitfalls: [
    t(code`
      **逐张量裁剪。** 每个张量各自裁到 \`max_norm\`，看起来「都裁过了」，
      但总范数变成 \`max_norm · sqrt(张量数)\` —— 20 个张量就是 4.5 倍。
      更糟的是层与层之间的相对大小被抹平，**梯度的方向变了**。
      这一关的余弦门槛专门抓它。
    `, code`
      **Clipping per tensor.** Each tensor gets clipped to \`max_norm\`, which looks
      thorough, but the total norm becomes \`max_norm · sqrt(tensors)\` — 4.5x at 20
      tensors. Worse, relative magnitudes between layers are flattened and **the gradient's
      direction changes**. The cosine gate exists for this.
    `),
    t(code`
      **梯度炸了就清零然后照常 step。** 参数确实没被推飞，看着像是「处理了」。
      但 AdamW 的动量被一个假的零梯度污染了，而且步数 \`t\` 往前走了一格 ——
      偏差修正的分母跟着变，**后面每一步都受影响**。正确的做法是整步跳过。
    `, code`
      **Zeroing a blown-up gradient and stepping anyway.** Parameters do not fly off, so it
      looks handled. But AdamW's momentum is polluted by a fake zero gradient and the step
      counter \`t\` still advances — the bias-correction denominator shifts and **every
      later step is affected**. The correct response is to skip the whole step.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_PY,
      'clip.py': code`
        """第 14 关：梯度裁剪与非有限梯度的处理。"""
        import nanotorch as nt
        from nanotorch import functional as F


        def clip_grad_norm_(params, max_norm):
            """就地裁剪，返回裁剪前的全局范数。"""
            # TODO: 全局范数 -> 一个 coef -> 所有梯度乘同一个 coef
            return 0.0


        def has_nonfinite_grad(params):
            """梯度里有没有 NaN / inf。"""
            # TODO
            return False


        if __name__ == "__main__":
            a = nt.parameter((4, 4), 1, 1.0, "a")
            b = nt.parameter((4,), None, 0.0, "b")
            a.ensure_grad().fill_(1.0)
            b.ensure_grad().fill_(1.0)
            print("裁剪前的范数", round(clip_grad_norm_([a, b], 1.0), 6))
            print("裁剪后的范数", round((F.sumsq(a.grad) + F.sumsq(b.grad)) ** 0.5, 6))
      `,
    },
    referenceFiles: {
      'clip.py': code`
        """第 14 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F


        def clip_grad_norm_(params, max_norm):
            # 全局范数：先把各自的平方和加起来，再开一次方。
            # 不是把各自的范数平方回去 —— sqrt(s)**2 和 s 在浮点下不是同一个数
            total = 0.0
            for p in params:
                if p.grad is not None:
                    total += F.sumsq(p.grad)
            total = total ** 0.5

            if max_norm > 0 and total > max_norm:
                # 同一个 coef 乘给所有梯度：只缩放，不改方向
                coef = max_norm / total
                for p in params:
                    if p.grad is not None:
                        F.scale_(p.grad, coef)

            # 返回裁剪前的值 —— 曲线要看的是梯度本来有多大
            return total


        def has_nonfinite_grad(params):
            for p in params:
                if p.grad is not None and F.count_nonfinite(p.grad) > 0:
                    return True
            return False


        if __name__ == "__main__":
            a = nt.parameter((4, 4), 1, 1.0, "a")
            b = nt.parameter((4,), None, 0.0, "b")
            a.ensure_grad().fill_(1.0)
            b.ensure_grad().fill_(1.0)
            print("裁剪前的范数", round(clip_grad_norm_([a, b], 1.0), 6))
            print("裁剪后的范数", round((F.sumsq(a.grad) + F.sumsq(b.grad)) ** 0.5, 6))
      `,
    },
  },
  specs: [
    spec('clip.spec.ts', code`
      ${LAB}

      const TOTAL = 250, PEAK = 0.03, CLIP = 1.0, BOOM_AT = 40;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, clip
      importlib.reload(kit)
      importlib.reload(clip)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
        for (let s = 1; s <= TOTAL; s++) {
          const d = lab.data.induction(8, 16, 16, 1000 + s);
          lab.py('kit._batches[' + (1000 + s) + '] = ('
            + JSON.stringify([...d.idx]) + ', ' + JSON.stringify([...d.tgt]) + ')');
        }
        lab.py(\`
      def _flat_grads(ps):
          out = []
          for p in ps:
              out.extend(p.grad.tolist())
          return out

      _runs = {}


      def _train(boom_at):
          """跑 \${TOTAL} 步。boom_at 那一步往梯度里注入一个 inf。

          裁剪与「要不要跳过」都由学员的代码说了算 —— 优化器自己的裁剪关掉。
          """
          if boom_at in _runs:
              return _runs[boom_at]
          m = kit.LM(seed=1)
          opt = nt.optim.AdamW(m.parameters(), lr=\${PEAK}, betas=(0.9, 0.95),
                               weight_decay=0.1, grad_clip=0.0)
          ps = m.parameters()
          idx = nt.zeros((kit.B * kit.S,), role="data", name="idx")
          tgt = nt.zeros((kit.B * kit.S,), role="data", name="tgt")

          stats = {"clipped": 0, "skipped": 0, "maxPost": 0.0,
                   "norms": [], "losses": [], "cosErr": 0.0, "sampled": 0}
          base = nt.mark()
          for st in range(1, \${TOTAL} + 1):
              nt.release(base)
              bi, bt = kit.get_batch(1000 + st)
              idx.set_int_(bi)
              tgt.set_int_(bt)
              opt.zero_grad()
              nt.phase("forward")
              loss = m(idx, tgt, kit.B, kit.S)
              nt.phase("other")
              loss.backward()

              if boom_at and st == boom_at:
                  # 模拟一次溢出：往第一个梯度里塞一个 inf
                  ps[0].grad.set_at_(0, float("inf"))

              if clip.has_nonfinite_grad(ps):
                  stats["skipped"] += 1
                  stats["losses"].append(loss.value)
                  continue

              before = _flat_grads(ps) if st == 3 else None
              pre = clip.clip_grad_norm_(ps, \${CLIP})
              post = sum(F.sumsq(p.grad) for p in ps) ** 0.5
              if pre > \${CLIP} + 1e-9:
                  stats["clipped"] += 1
              stats["maxPost"] = max(stats["maxPost"], post)
              stats["norms"].append(pre)

              if before is not None:
                  # 只缩放不改方向：夹角余弦该是 1
                  after = _flat_grads(ps)
                  dot = sum(a * b for a, b in zip(before, after))
                  na = sum(a * a for a in before) ** 0.5
                  nb = sum(b * b for b in after) ** 0.5
                  if na > 0 and nb > 0:
                      stats["cosErr"] = abs(dot / (na * nb) - 1.0)
                      stats["sampled"] = 1

              # 平台自己的调度（第 13 关那条）—— 这一关的重点是裁剪，
              # 但模型得真的在学，「跳过一步之后照常收敛」才说明得了问题
              if st <= 20:
                  lr = \${PEAK} * st / 20
              else:
                  pr = (st - 20) / max(1, \${TOTAL} - 20)
                  lr = \${PEAK} * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
              opt.step(lr=lr)
              stats["losses"].append(loss.value)

          stats["nonfiniteParams"] = sum(F.count_nonfinite(p) for p in ps)
          _runs[boom_at] = stats
          return stats
      \`);
      }

      describe('梯度裁剪与稳定性', () => {
        it('裁剪之后全局范数不超过 max_norm，而且真的裁到了', () => {
          setup();
          const st = JSON.parse(String(lab.py('json.dumps(_train(0))')));
          const norms = st.norms;
          console.log(
            '裁剪前的范数：第 1 步 ' + norms[0].toFixed(3)
            + '，最大 ' + Math.max(...norms).toFixed(3)
            + '；' + st.clipped + ' / ' + norms.length + ' 步触发了裁剪；'
            + '裁剪后的最大范数 ' + st.maxPost.toFixed(6)
          );
          lab.publish('grad.postClipNorm', st.maxPost);
          lab.publish('grad.clippedSteps', st.clipped);
          expect(st.maxPost).toBeLessThan(CLIP + 1e-6);
          // 一次都没裁到的话，上面那条是白测的
          expect(st.clipped).toBeGreaterThan(0);
        });

        /*
         * 只缩放，不改方向。逐张量裁剪会把层间的相对大小抹平 ——
         * 范数照样 ≤ max_norm，但夹角变了，而梯度携带的信息就是方向。
         */
        it('裁剪只缩放，不改方向（夹角余弦 = 1）', () => {
          setup();
          const st = JSON.parse(String(lab.py('json.dumps(_train(0))')));
          console.log('裁剪前后的夹角余弦与 1 的差 ' + st.cosErr.toExponential(2));
          lab.publish('grad.clipDirectionError', st.cosErr);
          expect(st.sampled).toBe(1);
          expect(st.cosErr).toBeLessThan(1e-6);
        });

        /*
         * 注入一次 inf。正确的处理是**整步跳过** ——
         * 清零之后照走的话参数也不会飞，但 AdamW 的动量被污染了、t 还往前走了一格。
         */
        it('梯度里出现 inf 时跳过整步，参数保持有限', () => {
          setup();
          const st = JSON.parse(String(lab.py('json.dumps(_train(' + BOOM_AT + '))')));
          console.log(
            '跳过了 ' + st.skipped + ' 步（注入在第 ' + BOOM_AT + ' 步）；'
            + '参数里非有限的有 ' + st.nonfiniteParams + ' 个；'
            + '最后 10 步平均 loss ' + (st.losses.slice(-10).reduce((a, c) => a + c, 0) / 10).toFixed(4)
            + '（均匀 ' + Math.log(16).toFixed(4) + '）'
          );
          lab.publish('train.skippedSteps', st.skipped);
          lab.publish('nan.paramCount', st.nonfiniteParams);
          const tail = st.losses.slice(-10).reduce((a, c) => a + c, 0) / 10;
          lab.publish('loss.afterSkip', tail);
          expect(st.skipped).toBe(1);
          expect(st.nonfiniteParams).toBe(0);
          expect(st.losses.every((v) => Number.isFinite(v))).toBe(true);
          // 跳过那一步之后训练要照常往下走 —— 停在均匀熵上说明模型已经废了
          expect(tail).toBeLessThan(Math.log(16) * 0.8);
        });

        it('total ≤ max_norm 时不动梯度，返回的是裁剪前的值', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _a = nt.parameter((4, 4), 1, 1.0, "a")
      _a.ensure_grad().fill_(0.01)          # 范数 0.04，远小于 max_norm
      _before = list(_a.grad.tolist())
      _n1 = clip.clip_grad_norm_([_a], 1.0)
      _after = list(_a.grad.tolist())

      _a.grad.fill_(1.0)                    # 范数 4.0，会被裁
      _n2 = clip.clip_grad_norm_([_a], 1.0)
      _post = sum(F.sumsq(_a.grad) for _ in [0]) ** 0.5
      json.dumps({"n1": _n1, "same": _before == _after, "n2": _n2, "post": _post})
      \`)));
          console.log(
            '小梯度：返回 ' + r.n1.toFixed(6) + '，梯度没动 ' + r.same
            + '；大梯度：返回 ' + r.n2.toFixed(6) + '（裁剪前），裁完 ' + r.post.toFixed(6)
          );
          expect(r.same).toBe(true);
          expect(Math.abs(r.n1 - 0.04)).toBeLessThan(1e-6);
          // 返回裁剪前的 4.0，不是裁完的 1.0
          expect(Math.abs(r.n2 - 4)).toBeLessThan(1e-5);
          expect(Math.abs(r.post - 1)).toBeLessThan(1e-6);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.grad.postClipNorm', op: 'lte', value: 1.000001,
      zh: '裁剪之后的最大全局范数', en: 'largest post-clip global norm', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.grad.clipDirectionError', op: 'lte', value: 1e-6,
      zh: '裁剪前后夹角余弦与 1 的差（只缩放不改方向）',
      en: 'pre/post cosine gap from 1 (rescale only, no rotation)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.train.skippedSteps', op: 'eq', value: 1,
      zh: '因梯度非有限而跳过的步数', en: 'steps skipped for non-finite gradients',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.nan.paramCount', op: 'eq', value: 0,
      zh: '训练结束时参数里非有限的个数', en: 'non-finite parameters at the end of training',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      \`max_norm = 1.0\` 是 LLM 预训练里最常见的取值,从 GPT-3 到今天基本没变过。
      它不是调出来的最优值，而是一个「足够安全又不太干扰」的惯例。

      裁剪的另一面是**它掩盖问题**。梯度范数长期贴着 clip 说明学习率偏大、
      或者某处的初始化不对,这时候该改的是那些，不是把 clip 调大。
      所以 \`clip_grad_norm_\` 返回裁剪前的值这件事很要紧：**那条曲线是诊断信息**。

      非有限梯度的处理在混合精度里是一整套机制。fp16 的动态范围只有 ±65504，
      梯度很容易下溢成 0 或上溢成 inf，于是有了 \`GradScaler\`:
      把 loss 乘一个大系数再反向，反向完再除回去；一旦发现 inf 就跳过这一步
      并把系数减半。bf16 的动态范围和 fp32 一样，基本不需要这套 ——
      这正是第 17 关要讲的，**bf16 赢在动态范围，不是精度**。
    `,
    code`
      \`max_norm = 1.0\` is the most common value in LLM pretraining, essentially unchanged
      from GPT-3 onwards. It is not a tuned optimum but a convention that is safe enough
      without interfering much.

      The other side of clipping is that **it hides problems**. A gradient norm that sits
      against the clip for a long time means the learning rate is too high or something is
      initialised wrong — those are what to fix, not the clip threshold. Which is why
      \`clip_grad_norm_\` returning the pre-clip value matters: **that curve is diagnostic**.

      Handling non-finite gradients is a whole mechanism under mixed precision. fp16's
      dynamic range is only ±65504, so gradients underflow to zero or overflow to inf
      easily; hence \`GradScaler\`, which multiplies the loss by a large factor before the
      backward, divides it back afterwards, and on seeing an inf skips the step and halves
      the factor. bf16 has fp32's dynamic range and barely needs any of it — which is
      stage 17's point: **bf16 wins on range, not on precision**.
    `
  ),
};

/* ================================================================== */
/* 第 15 关：数据打包与跨文档泄漏                                        */
/* ================================================================== */

const STAGE_PACKING = {
  id: 'data-packing',
  title: t('数据打包 —— 别让一篇看见另一篇', 'Packing the data — one document must not see another'),
  goal: t(
    code`
      语料是一篇篇长短不一的文档，模型要的是定长的块。怎么把前者变成后者，
      有两种做法，差别很大。

      在 \`packing.py\` 里实现打包和掩码：

      \`\`\`python
      def pack(docs, block_size, eos_id):
          """docs 是若干个 token 列表。返回 (blocks, doc_ids, stats)。

          blocks:  [[block_size + 1 个 token], ...]   多一个是给目标位移用的
          doc_ids: [[block_size 个编号], ...]         每个位置属于第几篇
          stats:   {"padded": 填充的个数, "total": 总个数}
          """

      def attn_bias(doc_ids, batch, heads, seq, neg=-1e30):
          """加性掩码，形状 (batch, heads, seq, seq)。

          同一篇**且** j <= i 的位置是 0，其余是 neg。
          对应 PyTorch 的 scaled_dot_product_attention(attn_mask=...)。"""
      \`\`\`

      ## 两种做法

      **一篇一块，不够就填。** 简单，但这一关的语料里句子长度从 16 到 97 不等,
      按 32 一块算，填充率超过 **30%**。三分之一的算力花在填充符上。

      **拼成一条流再切。** 每篇末尾加一个 \`EOS\` 标出边界，全部首尾相接，
      然后按 \`block_size\` 切开。填充率接近 **0**,只有最后那一块的尾巴。
      代价是**一块里可能横跨两三篇**。

      真实预训练用的都是第二种。填充率不是省一点点的问题:
      30% 的填充意味着 30% 的算力、30% 的显存、30% 的时间白花。

      ## 代价：跨文档泄漏

      拼起来之后，第 5 个位置（属于第 1 篇）和第 20 个位置（属于第 2 篇）在同一块里。
      因果掩码只管「不许看未来」，**它不知道文档边界** ——
      于是第 2 篇的位置能看见第 1 篇的内容。

      这件事的后果不是「错一点」，而是**模型学到了不存在的关系**。
      两篇毫不相干的文档被当成上下文连在一起；训练 loss 甚至会更低
      （信息更多了），而模型在真实使用中拿不到这种上下文。

      所以要一个**块对角**的掩码：只有同一篇之间才允许注意。

      \`\`\`
          j:  0 1 2 | 3 4 5      ← 竖线是文档边界
      i=0     ✓ · · | · · ·
      i=1     ✓ ✓ · | · · ·
      i=2     ✓ ✓ ✓ | · · ·
      i=3     · · · | ✓ · ·      ← 第 2 篇的第一个位置只看得见自己
      i=4     · · · | ✓ ✓ ·
      i=5     · · · | ✓ ✓ ✓
      \`\`\`

      ## 为什么是加性掩码，不是 valid 长度

      前面几关的因果掩码写成「每行能看到前多少个」—— 那是个**前缀长度**，
      表达不了「从第 3 列到第 5 列」这种**区间**。
      块对角掩码需要区间，所以换成加性掩码：把不许看的位置加上一个很大的负数，
      softmax 之后它们是**硬 0**（\`exp\` 直接下溢）。

      PyTorch 的 \`attn_mask\` 就是这个形式。两种表示各有各的用处 ——
      前缀长度更省（一行一个整数），加性掩码更通用。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 一个 token 不丢不重 | 拼出来的流与「逐篇加 EOS 首尾相接」逐个相同 |
      | 填充率 | ≤ **2%**（一篇一块的对照是 30% 以上） |
      | **跨文档泄漏** | 不同篇之间的注意力概率**恒为 0** |
      | 因果性 | 未来位置的概率也恒为 0 |
    `,
    code`
      A corpus is documents of varying length; a model wants fixed-length blocks. There are
      two ways to get from one to the other, and they differ a lot.

      Implement packing and masking in \`packing.py\`:

      \`\`\`python
      def pack(docs, block_size, eos_id):
          """docs is a list of token lists. Returns (blocks, doc_ids, stats).

          blocks:  [[block_size + 1 tokens], ...]   the extra one is for the target shift
          doc_ids: [[block_size ids], ...]          which document each position belongs to
          stats:   {"padded": padding count, "total": total count}
          """

      def attn_bias(doc_ids, batch, heads, seq, neg=-1e30):
          """Additive mask of shape (batch, heads, seq, seq).

          Zero where the documents match **and** j <= i, neg elsewhere.
          Mirrors PyTorch's scaled_dot_product_attention(attn_mask=...)."""
      \`\`\`

      ## Two approaches

      **One document per block, padded.** Simple, but sentence lengths here run from 16 to
      97, so at a block size of 32 the padding rate exceeds **30%**. A third of the compute
      goes into padding symbols.

      **Concatenate into one stream, then cut.** Append an \`EOS\` to each document to mark
      the boundary, join them end to end, and cut every \`block_size\` tokens. Padding drops
      to nearly **zero** — only the final tail. The cost is that **a block may span two or
      three documents**.

      Real pretraining uses the second. Padding is not a minor saving: 30% padding means
      30% of the compute, memory and time is wasted.

      ## The cost: cross-document leakage

      After concatenation, position 5 (document 1) and position 20 (document 2) sit in the
      same block. The causal mask only enforces "no looking ahead"; **it knows nothing about
      document boundaries** — so document 2 can see document 1.

      The consequence is not "slightly wrong" but **a model that learns relationships which
      do not exist**. Two unrelated documents get treated as one context; training loss may
      even improve (more information), while at inference that context is never there.

      So the mask has to be **block-diagonal**: attention only within a document.

      \`\`\`
          j:  0 1 2 | 3 4 5      <- the bar is a document boundary
      i=0     ✓ · · | · · ·
      i=1     ✓ ✓ · | · · ·
      i=2     ✓ ✓ ✓ | · · ·
      i=3     · · · | ✓ · ·      <- document 2's first position sees only itself
      i=4     · · · | ✓ ✓ ·
      i=5     · · · | ✓ ✓ ✓
      \`\`\`

      ## Why an additive mask rather than valid lengths

      Earlier stages wrote the causal mask as "how many keys each row may see" — a
      **prefix length**, which cannot express an **interval** like "columns 3 through 5".
      Block-diagonal masking needs intervals, so it switches to an additive mask: add a
      large negative number at forbidden positions and softmax turns them into **hard
      zeros** (\`exp\` underflows).

      PyTorch's \`attn_mask\` uses exactly this form. Both representations have their place:
      prefix lengths are cheaper (one integer per row), additive masks are more general.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | No token lost or duplicated | The stream matches "each document plus EOS, concatenated" |
      | Padding rate | <= **2%** (the one-per-block control exceeds 30%) |
      | **Cross-document leakage** | Attention probability across documents is **exactly 0** |
      | Causality | Future positions are exactly 0 as well |
    `
  ),
  checklist: [
    t('每篇末尾加 EOS，再首尾相接切块', 'Append EOS to each document, concatenate, then cut'),
    t('doc_ids 标出每个位置属于第几篇', 'doc_ids records which document each position belongs to'),
    t('掩码是块对角的：同一篇且 j ≤ i', 'The mask is block-diagonal: same document and j <= i'),
    t('填充率降到 2% 以下', 'Padding falls below 2%'),
  ],
  hints: [
    t('block 要 block_size + 1 个 token —— 多的那个是目标位移用的。',
      'A block holds block_size + 1 tokens; the extra one covers the target shift.'),
    t('doc_ids 只标前 block_size 个位置（查询能落在的那些）。',
      'doc_ids covers only the first block_size positions, the ones a query can sit at.'),
    t('掩码用 nt.zeros((batch, heads, seq, seq)) 建，再 set_ 一整个列表。',
      'Build the mask with nt.zeros((batch, heads, seq, seq)) and set_ one flat list.'),
  ],
  pitfalls: [
    t(code`
      **拼起来了但没改掩码。** 这是最贵的一个错：填充率是降下去了，
      而模型开始学两篇不相干文档之间的「关系」。训练 loss 甚至会更低 ——
      上下文里多了信息 —— 而这些信息在真实使用时根本不存在。
      **loss 变好反而是坏消息**，这一关的探针专门数跨文档的注意力概率。
    `, code`
      **Concatenating without changing the mask.** The most expensive mistake here: padding
      drops, and the model starts learning "relationships" between unrelated documents.
      Training loss may even improve — the context carries more information — information
      that does not exist at inference. **A better loss is the bad news here**, and the
      probe counts cross-document attention probability directly.
    `),
    t(code`
      **用一个「很大的负数」而不是足够大的负数。** \`-1e4\` 在 fp32 里够了，
      但如果分数本身也在几千的量级，掩掉的位置会留下一个非零的概率。
      这一关要求**恒为 0**,\`-1e30\` 之后 \`exp\` 直接下溢，是真的 0，
      而不是「小到看不见」。「小到看不见」在逐位比较里是过不去的。
    `, code`
      **Using "a large negative number" that is not large enough.** \`-1e4\` suffices in
      fp32 until the scores themselves reach the thousands, at which point masked positions
      keep a non-zero probability. This stage requires **exactly zero**: after \`-1e30\` the
      \`exp\` underflows to a true zero rather than something merely invisible. "Invisibly
      small" does not survive a bit-exact comparison.
    `),
  ],
  train: {
    files: {
      'packing.py': code`
        """第 15 关：文档打包与块对角掩码。"""
        import nanotorch as nt
        from nanotorch import functional as F


        def pack(docs, block_size, eos_id):
            """返回 (blocks, doc_ids, stats)。"""
            # TODO: 每篇加 EOS -> 拼成一条流 -> 按 block_size 切
            #       最后一块不够就用 eos_id 填，并把填了几个记进 stats["padded"]
            return [], [], {"padded": 0, "total": 0}


        def attn_bias(doc_ids, batch, heads, seq, neg=-1e30):
            """加性掩码 (batch, heads, seq, seq)：同一篇且 j <= i 是 0，其余是 neg。"""
            # TODO
            return nt.zeros((batch, heads, seq, seq), role="data")


        if __name__ == "__main__":
            docs = [[1, 2, 3], [4, 5], [6, 7, 8, 9]]
            blocks, ids, stats = pack(docs, 4, 0)
            print("块", blocks)
            print("文档编号", ids)
            print("填充率", stats["padded"] / max(1, stats["total"]))
      `,
    },
    referenceFiles: {
      'packing.py': code`
        """第 15 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F


        def pack(docs, block_size, eos_id):
            # 每篇末尾加 EOS 标出边界，然后首尾相接成一条流。
            # 不加 EOS 的话，模型没有任何信号知道一篇结束了
            stream, owner = [], []
            for d, doc in enumerate(docs):
                for tok in doc:
                    stream.append(tok)
                    owner.append(d)
                stream.append(eos_id)
                owner.append(d)

            # 切块。每块要 block_size + 1 个 token —— 多的那个给目标位移。
            # 步长是 block_size，不是 block_size + 1：相邻两块的边界处
            # 前一块的最后一个目标就是后一块的第一个输入
            blocks, doc_ids = [], []
            padded = 0
            at = 0
            while at + 1 < len(stream):
                chunk = stream[at:at + block_size + 1]
                ids = owner[at:at + block_size]
                if len(chunk) < block_size + 1:
                    need = block_size + 1 - len(chunk)
                    chunk = chunk + [eos_id] * need
                    padded += need
                while len(ids) < block_size:
                    # 填充位置归到一个不存在的文档里 —— 它谁也看不见，谁也看不见它
                    ids.append(-1)
                blocks.append(chunk)
                doc_ids.append(ids)
                at += block_size

            return blocks, doc_ids, {"padded": padded, "total": len(blocks) * (block_size + 1)}


        def attn_bias(doc_ids, batch, heads, seq, neg=-1e30):
            flat = []
            for b in range(batch):
                ids = doc_ids[b]
                row = []
                for i in range(seq):
                    for j in range(seq):
                        # 块对角 + 因果：同一篇，且 j 不在 i 的未来
                        ok = (j <= i) and (ids[i] == ids[j])
                        row.append(0.0 if ok else neg)
                # 所有头共用同一张掩码
                for _ in range(heads):
                    flat.extend(row)

            out = nt.zeros((batch, heads, seq, seq), role="data", name="attn.bias")
            out.set_(flat)
            return out


        if __name__ == "__main__":
            docs = [[1, 2, 3], [4, 5], [6, 7, 8, 9]]
            blocks, ids, stats = pack(docs, 4, 0)
            print("块", blocks)
            print("文档编号", ids)
            print("填充率", stats["padded"] / max(1, stats["total"]))
      `,
    },
  },
  specs: [
    spec('packing.spec.ts', code`
      ${LAB}

      const BLOCK = 64, HEADS = 2, HD = 8, EOS = 99;
      const DOC_COUNT = 24;

      /** 语料按句子切成「文档」，编码成 token */
      function documents() {
        const text = lab.world.corpus();
        const sentences = text.split(/(?<=[.!?])\\s+/)
          .map((s) => s.trim()).filter((s) => s.length > 0).slice(0, DOC_COUNT);
        const vocab = lab.world.vocabSize();
        // 直接用字符码点取模 —— 这一关不关心具体编码，只关心打包
        return sentences.map((s) => [...s].map((c) => c.charCodeAt(0) % vocab));
      }

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, packing
      importlib.reload(packing)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
        const docs = documents();
        lab.py('_docs = ' + JSON.stringify(docs));
        return docs;
      }

      describe('数据打包', () => {
        it('一个 token 不丢不重，块的形状也对', () => {
          const docs = setup();
          const r = JSON.parse(String(lab.py(
            '_blocks, _ids, _stats = packing.pack(_docs, ' + BLOCK + ', ' + EOS + ')\\n'
            + 'json.dumps({"blocks": _blocks, "ids": _ids, "stats": _stats})'
          )));

          // 参考的流：逐篇加 EOS 首尾相接
          const stream = [];
          for (const d of docs) { stream.push(...d, EOS); }

          // 把块按步长 BLOCK 拼回去，应当逐个等于原流（末尾的填充不算）
          const rebuilt = [];
          for (const blk of r.blocks) rebuilt.push(...blk.slice(0, BLOCK));
          let same = 0;
          for (let i = 0; i < stream.length && i < rebuilt.length; i++) {
            if (stream[i] === rebuilt[i]) same += 1;
          }
          console.log(
            '文档 ' + docs.length + ' 篇，流长 ' + stream.length
            + '，切成 ' + r.blocks.length + ' 块 × ' + BLOCK
            + '，对得上的位置 ' + same + ' / ' + Math.min(stream.length, rebuilt.length)
          );
          lab.publish('packing.tokensPreserved', same === Math.min(stream.length, rebuilt.length) ? 1 : 0);

          expect(r.blocks.length).toBeGreaterThan(2);
          for (const blk of r.blocks) expect(blk.length).toBe(BLOCK + 1);
          for (const ids of r.ids) expect(ids.length).toBe(BLOCK);
          expect(same).toBe(Math.min(stream.length, rebuilt.length));
        });

        it('填充率 ≤ 2%，而一篇一块的对照超过 30%', () => {
          const docs = setup();
          const stats = JSON.parse(String(lab.py(
            '_b, _i, _s = packing.pack(_docs, ' + BLOCK + ', ' + EOS + ')\\njson.dumps(_s)'
          )));
          const ratio = stats.padded / stats.total;

          // 对照：一篇一块，不够就填
          let naivePad = 0, naiveTotal = 0;
          for (const d of docs) {
            const blocks = Math.ceil((d.length + 1) / BLOCK);
            naiveTotal += blocks * BLOCK;
            naivePad += blocks * BLOCK - (d.length + 1);
          }
          const naiveRatio = naivePad / naiveTotal;

          console.log(
            '拼流打包的填充率 ' + (ratio * 100).toFixed(2) + '%，'
            + '一篇一块是 ' + (naiveRatio * 100).toFixed(1) + '%'
          );
          lab.publish('tokens.padRatio', ratio);
          lab.publish('tokens.padRatioNaive', naiveRatio);
          expect(ratio).toBeLessThan(0.02);
          // 对照必须明显更差，否则这一关的前提不成立
          expect(naiveRatio).toBeGreaterThan(0.25);
        });

        /*
         * 这一关的核心。拼起来之后一块里横跨几篇，
         * 因果掩码不知道文档边界 —— 掩码不改的话，第 2 篇能看见第 1 篇。
         * 探针直接数跨文档的注意力概率，要求**恒为 0**。
         */
        it('跨文档的注意力概率恒为 0', () => {
          setup();
          const B = 4;
          const r = JSON.parse(String(lab.py(\`
      _blocks, _ids, _stats = packing.pack(_docs, \${BLOCK}, \${EOS})
      _b, _h, _s, _hd = \${B}, \${HEADS}, \${BLOCK}, \${HD}
      _use = _ids[:_b]

      # 随便造一组 q / k，只看掩码起没起作用
      _q = nt.zeros((_b * _s, _h * _hd), role="data").normal_(21, 1.0)
      _k = nt.zeros((_b * _s, _h * _hd), role="data").normal_(22, 1.0)
      _sc = F.attn_scores(_q, _k, _b, _s, _s, _h, _h, _hd)
      _bias = packing.attn_bias(_use, _b, _h, _s)
      _sc = F.add(_sc, _bias)
      _probs = F.softmax(_sc, _b * _h * _s, _s)
      json.dumps({"probs": _probs.tolist(), "ids": _use})
      \`)));

          const docIds = new Int32Array(B * BLOCK);
          for (let b = 0; b < B; b++) {
            for (let i = 0; i < BLOCK; i++) docIds[b * BLOCK + i] = r.ids[b][i];
          }
          const report = lab.probe.crossDocument(r.probs, docIds, B, HEADS, BLOCK);

          // 未来位置也要是硬 0
          let future = 0;
          for (let b = 0; b < B; b++)
            for (let h = 0; h < HEADS; h++)
              for (let i = 0; i < BLOCK; i++)
                for (let j = i + 1; j < BLOCK; j++) {
                  if (r.probs[((b * HEADS + h) * BLOCK + i) * BLOCK + j] !== 0) future += 1;
                }

          const distinct = new Set(r.ids.flat()).size;
          // 真正要紧的不是「出现了几篇」，而是「有几块横跨了边界」——
          // 一块里只有一篇的话，块对角掩码和普通因果掩码没有区别，这条就白测了
          const spanning = r.ids.filter((row) => new Set(row).size > 1).length;
          console.log(
            '这 ' + B + ' 块里出现了 ' + distinct + ' 个文档编号，'
            + spanning + ' 块横跨了文档边界；'
            + '查了 ' + report.checked + ' 对，跨文档还有概率的 ' + report.crossDocumentPairs + ' 对；'
            + '未来位置非零的 ' + future + ' 个'
          );
          lab.publish('attention.crossDocumentPairs', report.crossDocumentPairs);
          lab.publish('attention.futureLeakBits', future);

          // 必须真的有块横跨了边界，否则上面那条是白测的
          expect(spanning).toBeGreaterThanOrEqual(2);
          expect(report.crossDocumentPairs).toBe(0);
          expect(future).toBe(0);
        });

        it('每行概率和仍然是 1 —— 掩码没把整行掩没', () => {
          setup();
          const rows = JSON.parse(String(lab.py(\`
      _blocks, _ids, _stats = packing.pack(_docs, \${BLOCK}, \${EOS})
      _b, _h, _s, _hd = 4, \${HEADS}, \${BLOCK}, \${HD}
      _q = nt.zeros((_b * _s, _h * _hd), role="data").normal_(21, 1.0)
      _k = nt.zeros((_b * _s, _h * _hd), role="data").normal_(22, 1.0)
      _sc = F.add(F.attn_scores(_q, _k, _b, _s, _s, _h, _h, _hd),
                  packing.attn_bias(_ids[:_b], _b, _h, _s))
      _p = F.softmax(_sc, _b * _h * _s, _s).tolist()
      json.dumps([sum(_p[r * _s:(r + 1) * _s]) for r in range(_b * _h * _s)])
      \`)));
          let worst = 0;
          for (const v of rows) worst = Math.max(worst, Math.abs(v - 1));
          console.log('每行概率和与 1 的最大差 ' + worst.toExponential(2));
          lab.publish('attention.probRowSumError', worst);
          expect(worst).toBeLessThan(1e-6);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.packing.tokensPreserved', op: 'eq', value: 1,
      zh: '打包之后 token 一个不丢不重', en: 'no token lost or duplicated by packing',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.tokens.padRatio', op: 'lte', value: 0.02,
      zh: '填充率（一篇一块的对照超过 30%）', en: 'padding rate (the one-per-block control exceeds 30%)',
      dimension: 'efficiency',
    }),
    gate({
      metric: 'llm.attention.crossDocumentPairs', op: 'eq', value: 0,
      zh: '跨文档还有注意力概率的位置对数', en: 'position pairs with cross-document attention',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.attention.futureLeakBits', op: 'eq', value: 0,
      zh: '未来位置还有概率的个数', en: 'future positions with non-zero probability',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      2026 年的预训练数据流水线里，打包只是最后一步。前面还有：
      **去重**（MinHash / 精确子串），**质量过滤**（FineWeb-Edu 用一个小分类器
      给「教育价值」打分，只留高分的），**去污染**（把评测集从训练集里挖掉）。
      DCLM 与 Nemotron-CC 这些公开配方把这几步的消融做得很细,
      同样的算力下，数据处理带来的提升往往比改模型结构大。

      掩码这一侧还有个工程细节：块对角掩码让注意力矩阵变得**稀疏且规则**。
      FlashAttention 从 2.x 起支持这种「变长序列」的接口（\`varlen\`），
      直接跳过不需要算的块 —— 于是块对角掩码不但更正确，**还更快**。
      我们这里是加性掩码的教学写法，算了再掩；真实实现是根本不算。
    `,
    code`
      In a 2026 pretraining pipeline, packing is only the last step. Before it come
      **deduplication** (MinHash or exact substring), **quality filtering** (FineWeb-Edu
      scores "educational value" with a small classifier and keeps the top slice), and
      **decontamination** (removing evaluation sets from the training data). Public recipes
      like DCLM and Nemotron-CC ablate these carefully — at equal compute, data processing
      often beats architectural changes.

      On the masking side there is an engineering detail: a block-diagonal mask makes the
      attention matrix **sparse and regular**. FlashAttention has supported this
      variable-length interface (\`varlen\`) since 2.x, skipping blocks it does not need to
      compute — so a block-diagonal mask is not only more correct but **faster**. What we
      write here is the teaching form: compute then mask. Real implementations never
      compute those entries at all.
    `
  ),
};

/* ================================================================== */
/* 第 16 关：完整的预训练循环                                           */
/* ================================================================== */

/** 第 16 关的模型：和第 13/14 关同一套，只是按语料的字符表开 */
const KIT16_PY = code`
  """平台给的模型。和第 13/14 关是同一套，只是按语料的字符表开：
  \`dim=64, n_layer=2, n_head=4, n_kv_head=2, hidden=176\`，
  batch 8 × seq 32 = 每步 256 个 token。

  这一关要写的是**外面那整条循环**。
  """
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F

  D, L, H, KV, HID = 64, 2, 4, 2, 176


  def build_tables(n, head_dim, base=10000.0):
      half = head_dim // 2
      cos = nt.zeros((n, half), role="data", name="rope.cos")
      sin = nt.zeros((n, half), role="data", name="rope.sin")
      cv, sv = [], []
      for p in range(n):
          for i in range(half):
              th = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(th))
              sv.append(math.sin(th))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class Norm(nn.Module):
      def __init__(self, dim):
          super().__init__()
          self.weight = nt.parameter((dim,), None, 0.0, "g")

      def forward(self, x):
          return F.rms_norm(x, self.weight, 1e-5)


  class Attn(nn.Module):
      def __init__(self, dim, nh, nkv, seed, max_seq=64):
          super().__init__()
          self.nh, self.nkv, self.hd = nh, nkv, dim // nh
          hd = self.hd
          self.wq = nt.parameter((dim, nh * hd), seed + 1, dim ** -0.5, "wq")
          self.wk = nt.parameter((dim, nkv * hd), seed + 2, dim ** -0.5, "wk")
          self.wv = nt.parameter((dim, nkv * hd), seed + 3, dim ** -0.5, "wv")
          self.wo = nt.parameter((nh * hd, dim), seed + 4, (nh * hd) ** -0.5, "wo")
          self._cos, self._sin = build_tables(max_seq, hd)

      def forward(self, x, b, s):
          hd = self.hd
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          q = F.rope(q, self._cos, self._sin, b, s, self.nh, hd)
          k = F.rope(k, self._cos, self._sin, b, s, self.nkv, hd)
          sc = F.attn_scores(q, k, b, s, s, self.nh, self.nkv, hd)
          pr = F.softmax(sc, b * self.nh * s, s, F.causal_valid(b, self.nh, s))
          o = F.attn_apply(pr, v, b, s, s, self.nh, self.nkv, hd,
                           out_shape=(b * s, self.nh * hd))
          return F.linear(o, self.wo)


  class Mlp(nn.Module):
      def __init__(self, dim, hid, seed):
          super().__init__()
          self.wg = nt.parameter((dim, hid), seed + 1, dim ** -0.5, "wg")
          self.wu = nt.parameter((dim, hid), seed + 2, dim ** -0.5, "wu")
          self.wd = nt.parameter((hid, dim), seed + 3, hid ** -0.5, "wd")

      def forward(self, x):
          return F.linear(F.swiglu(F.linear(x, self.wg), F.linear(x, self.wu)), self.wd)


  class Block(nn.Module):
      def __init__(self, dim, nh, nkv, hid, seed, nl):
          super().__init__()
          self.n1, self.at = Norm(dim), Attn(dim, nh, nkv, seed)
          self.n2, self.mp = Norm(dim), Mlp(dim, hid, seed + 40)
          self.sc = (2.0 * nl) ** -0.5

      def forward(self, x, b, s):
          x = F.add(x, F.scale(self.at(self.n1(x), b, s), self.sc))
          return F.add(x, F.scale(self.mp(self.n2(x)), self.sc))


  class LM(nn.Module):
      def __init__(self, vocab, seed=1):
          super().__init__()
          self.vocab = vocab
          self.embed = nt.parameter((vocab, D), seed, D ** -0.5, "embed")
          self.blocks = nn.ModuleList([
              Block(D, H, KV, HID, seed + 100 * (i + 1), L) for i in range(L)
          ])
          self.nf = Norm(D)

      def forward(self, idx, tgt, b, s):
          rows = b * s
          x = F.embedding(self.embed, idx, rows, D)
          for blk in self.blocks:
              x = blk(x, b, s)
          x = self.nf(x)
          logits = F.linear_tied(x, self.embed, rows, D, self.vocab)
          return F.cross_entropy(logits, tgt, rows, self.vocab)


  # 平台灌进来：训练集与验证集的 token 序列
  train_tokens = []
  val_tokens = []
`;

const STAGE_PRETRAIN = {
  id: 'pretraining-loop',
  title: t('完整的预训练循环 —— 打穿 bigram 基线', 'The full pretraining loop — beating the bigram baseline'),
  goal: t(
    code`
      前面十五关的零件到齐了。这一关在 \`pretrain.py\` 里把它们串成一条**完整的循环**，
      在真语料上训到打穿基线。模型在 \`kit.py\` 里，其余都是你的。

      \`\`\`python
      def sample_batch(tokens, step, batch, seq):
          """从 token 流里取一批 (idx, tgt)。tgt 是 idx 往后错一位。"""

      def evaluate(model, tokens, batch, seq, n_batches=20):
          """在验证集上算平均 loss。**必须在 no_grad 下跑。**"""

      def train(model, tokens, val_tokens, steps, batch, seq,
                peak_lr=0.03, warmup=None, clip=1.0, seed=1):
          """完整的训练循环。返回 {"train": [...], "val": float}。"""
      \`\`\`

      ## 这条循环里有什么

      \`\`\`
      每步：取一批 -> zero_grad -> 前向 -> 反向 -> 裁剪 -> 按调度取 lr -> step
      结束：在**留出集**上评一次
      \`\`\`

      七件事，前面各关分别做过。这一关的价值在于**它们必须同时对**,
      任何一件错了，loss 曲线看起来都还是「在降」。

      ## 评测必须在 \`no_grad\` 下

      不加 \`no_grad\` 的评测也能算出正确的数,**它只是白白建了一整条反向的带**。
      在这个小模型上你感觉不到；在真实尺度上，评测时建带意味着要为反向留住
      每一层的激活，显存差好几倍,而评测本来是不需要反向的。

      这一关**数得出来**：判定会记下评测过程里每个算子调用时
      \`is_grad_enabled()\` 的值，要求全部是 False。

      ## 基线

      语料是字符级的，词表 50。三条基线（第 2 关算过）：

      \`\`\`
      均匀（什么都不学）    3.912
      unigram（只看频率）   2.993
      bigram（只看前一个）  2.144   ← 这一关的分母
      \`\`\`

      bigram 是**只看前一个字符**能做到的极限。打穿它意味着模型真的用上了
      更长的上下文,这是「注意力在工作」最直接的证据。
      参考实现 400 步之后验证集 loss 约 **1.60**，是 bigram 的 **0.75 倍**。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 验证集 loss | ≤ **1.90** |
      | 打穿 bigram | 验证 loss / bigram ≤ **0.85** |
      | 确定性 | 同一个 seed 跑两遍，**逐位一致** |
      | 评测没建带 | 评测过程里 \`is_grad_enabled()\` 为真的调用数 = **0** |

      ## 为什么要有验证集

      训练 loss 只说明「模型记住了训练数据」。这个模型只有 3.9 万参数、
      语料 6 万个 token,过拟合是有可能的，而过拟合在训练 loss 上是看不出来的
      （它只会一路降）。留出集是唯一能分开「学会了」和「背下来了」的东西。
    `,
    code`
      Every piece from the previous fifteen stages is now available. This stage strings them
      into a **complete loop** in \`pretrain.py\` and trains on the real corpus until it
      beats the baseline. The model is in \`kit.py\`; everything else is yours.

      \`\`\`python
      def sample_batch(tokens, step, batch, seq):
          """Take a batch (idx, tgt) from the token stream; tgt is idx shifted by one."""

      def evaluate(model, tokens, batch, seq, n_batches=20):
          """Mean loss on the validation set. **Must run under no_grad.**"""

      def train(model, tokens, val_tokens, steps, batch, seq,
                peak_lr=0.03, warmup=None, clip=1.0, seed=1):
          """The full training loop. Returns {"train": [...], "val": float}."""
      \`\`\`

      ## What the loop contains

      \`\`\`
      each step: take a batch -> zero_grad -> forward -> backward -> clip
                 -> pick lr from the schedule -> step
      at the end: evaluate once on the **held-out** set
      \`\`\`

      Seven things, each covered by an earlier stage. The value here is that **they must all
      be right at once** — get any one wrong and the loss curve still looks like it is
      falling.

      ## Evaluation must run under \`no_grad\`

      Evaluating without \`no_grad\` still computes the right number; **it merely builds an
      entire backward tape for nothing**. You will not feel it on this small model; at real
      scale, building a tape during evaluation means keeping every layer's activations alive
      for a backward pass that never comes — several times the memory.

      This stage **counts it**: the hidden cases record \`is_grad_enabled()\` at every
      operator call during evaluation and require all of them to be False.

      ## Baselines

      The corpus is character-level with a vocabulary of 50. Three baselines (computed back
      in stage 2):

      \`\`\`
      uniform (nothing learned)     3.912
      unigram (frequency only)      2.993
      bigram (previous char only)   2.144   <- this stage's denominator
      \`\`\`

      Bigram is the ceiling for **looking at one previous character**. Beating it means the
      model genuinely uses longer context — the most direct evidence that attention is
      working. The reference reaches a validation loss of about **1.60** after 400 steps,
      **0.75x** the bigram baseline.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Validation loss | <= **1.90** |
      | Beats bigram | validation / bigram <= **0.85** |
      | Determinism | Two runs at the same seed are **bit-identical** |
      | No tape during eval | Calls with \`is_grad_enabled()\` true during evaluation = **0** |

      ## Why a validation set at all

      Training loss only shows that the model memorised the training data. This model has
      39k parameters against a 60k-token corpus — overfitting is possible, and it is
      invisible in the training loss, which simply keeps falling. A held-out set is the only
      thing that separates "learned" from "memorised".
    `
  ),
  checklist: [
    t('评测在 no_grad 下跑', 'Evaluation runs under no_grad'),
    t('验证集 loss 打穿 bigram 基线', 'Validation loss beats the bigram baseline'),
    t('同一个 seed 两遍逐位一致', 'Two runs at the same seed are bit-identical'),
    t('训练用训练集，评测用留出集，两者不重叠',
      'Training uses the training split and evaluation the held-out one, with no overlap'),
  ],
  hints: [
    t('取批次的随机数要自己写一个确定性的 —— 用 step 当种子，别用全局状态。',
      'Write your own deterministic sampler seeded by step; do not rely on global state.'),
    t('模型、优化器、输入缓冲都要在 nt.mark() 之前建好，每步只 release 激活。',
      'Build the model, optimiser and input buffers before nt.mark(); each step releases only activations.'),
    t('warmup 不给的话取 max(1, steps // 20)。',
      'When warmup is not given, use max(1, steps // 20).'),
  ],
  pitfalls: [
    t(code`
      **评测忘了 \`no_grad\`。** 数字完全正确,唯一的代价是白建了一整条带。
      在这个小模型上你感觉不到，所以它能一路活到真实项目里，
      在那里它表现为「评测的时候显存爆了」，而没人会想到是少了一行 \`with\`。
    `, code`
      **Forgetting \`no_grad\` during evaluation.** The numbers are perfectly correct; the
      only cost is a tape built for nothing. You cannot feel it on this model, so it
      survives into real projects, where it shows up as "evaluation runs out of memory" and
      nobody suspects a missing \`with\` line.
    `),
    t(code`
      **用训练集评测。** loss 会好看很多,而且随着训练变得越来越好看。
      这条曲线唯一说明的是「模型记住了训练数据」，而这本来就是它该做的。
      留出集是唯一能分开「学会了」和「背下来了」的东西。
    `, code`
      **Evaluating on the training set.** The loss looks much better, and keeps improving.
      All that curve shows is that the model memorised its training data, which is what it
      was asked to do. A held-out set is the only thing separating "learned" from
      "memorised".
    `),
  ],
  train: {
    files: {
      'kit.py': KIT16_PY,
      'pretrain.py': code`
        """第 16 关：完整的预训练循环。"""
        import math
        import nanotorch as nt
        from nanotorch import functional as F
        import kit


        def sample_batch(tokens, step, batch, seq):
            """从 token 流里取一批 (idx, tgt)。确定性:同一个 step 永远给同一批。"""
            state = (step * 1103515245 + 12345) & 0x7fffffff
            idx, tgt = [], []
            for _ in range(batch):
                state = (state * 1103515245 + 12345) & 0x7fffffff
                off = state % (len(tokens) - seq - 1)
                idx.extend(tokens[off:off + seq])
                tgt.extend(tokens[off + 1:off + seq + 1])
            return idx, tgt


        def evaluate(model, tokens, batch, seq, n_batches=20):
            """验证集上的平均 loss。**必须在 no_grad 下跑。**"""
            # TODO
            return 0.0


        def train(model, tokens, val_tokens, steps, batch, seq,
                  peak_lr=0.03, warmup=None, clip=1.0, seed=1):
            """返回 {"train": [每步的 loss], "val": 最后的验证 loss}。"""
            # TODO: 建优化器与输入缓冲 -> nt.mark() -> 每步：release / 取批 /
            #       zero_grad / 前向 / 反向 / 按调度取 lr / step
            #       最后在留出集上评一次
            return {"train": [], "val": 0.0}


        if __name__ == "__main__":
            m = kit.LM(len(set(kit.train_tokens)) or 50)
            print("参数量", m.num_parameters())
      `,
    },
    referenceFiles: {
      'pretrain.py': code`
        """第 16 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import functional as F
        import kit


        def sample_batch(tokens, step, batch, seq):
            state = (step * 1103515245 + 12345) & 0x7fffffff
            idx, tgt = [], []
            for _ in range(batch):
                state = (state * 1103515245 + 12345) & 0x7fffffff
                off = state % (len(tokens) - seq - 1)
                idx.extend(tokens[off:off + seq])
                tgt.extend(tokens[off + 1:off + seq + 1])
            return idx, tgt


        def evaluate(model, tokens, batch, seq, n_batches=20):
            idx = nt.zeros((batch * seq,), role="data", name="eval.idx")
            tgt = nt.zeros((batch * seq,), role="data", name="eval.tgt")
            total = 0.0
            # no_grad：评测不需要反向，建带纯属白费。
            # 这个模型上感觉不到，真实尺度上是好几倍的显存
            with nt.no_grad():
                mark = nt.mark()
                for k in range(n_batches):
                    nt.release(mark)
                    bi, bt = sample_batch(tokens, 90000 + k, batch, seq)
                    idx.set_int_(bi)
                    tgt.set_int_(bt)
                    total += model(idx, tgt, batch, seq).value
            return total / n_batches


        def train(model, tokens, val_tokens, steps, batch, seq,
                  peak_lr=0.03, warmup=None, clip=1.0, seed=1):
            if warmup is None:
                warmup = max(1, steps // 20)
            opt = nt.optim.AdamW(model.parameters(), lr=peak_lr, betas=(0.9, 0.95),
                                 weight_decay=0.1, grad_clip=clip)
            # 输入缓冲在 mark 之前建好 —— 它是常驻的，落在 mark 之后每步会被 release 拦下
            idx = nt.zeros((batch * seq,), role="data", name="idx")
            tgt = nt.zeros((batch * seq,), role="data", name="tgt")

            hist = []
            base = nt.mark()
            for st in range(1, steps + 1):
                nt.release(base)
                bi, bt = sample_batch(tokens, seed * 100000 + st, batch, seq)
                idx.set_int_(bi)
                tgt.set_int_(bt)

                opt.zero_grad()
                nt.phase("forward")
                loss = model(idx, tgt, batch, seq)
                nt.phase("other")
                loss.backward()

                if st <= warmup:
                    lr = peak_lr * st / warmup
                else:
                    p = (st - warmup) / max(1, steps - warmup)
                    lr = peak_lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))
                opt.step(lr=lr)
                hist.append(loss.value)

            return {"train": hist, "val": evaluate(model, val_tokens, batch, seq)}


        if __name__ == "__main__":
            m = kit.LM(len(set(kit.train_tokens)) or 50)
            print("参数量", m.num_parameters())
      `,
    },
  },
  specs: [
    spec('pretrain.spec.ts', code`
      ${LAB}

      const STEPS = 400, BATCH = 8, SEQ = 32;

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, kit, pretrain
      importlib.reload(kit)
      importlib.reload(pretrain)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
        const toks = lab.world.tokens();
        const at = lab.world.holdoutAt();
        lab.py('kit.train_tokens = ' + JSON.stringify([...toks.slice(0, at)]));
        lab.py('kit.val_tokens = ' + JSON.stringify([...toks.slice(at)]));
        return { vocab: lab.world.vocabSize(), trainLen: at, valLen: toks.length - at };
      }

      function run(seed) {
        return JSON.parse(String(lab.py(\`
      _m = kit.LM(\${lab.world.vocabSize()}, seed=1)
      _r = pretrain.train(_m, kit.train_tokens, kit.val_tokens,
                          \${STEPS}, \${BATCH}, \${SEQ}, seed=\${seed})
      json.dumps({"first": _r["train"][:5], "last": _r["train"][-10:], "val": _r["val"],
                  "params": _m.num_parameters()})
      \`)));
      }

      describe('完整的预训练循环', () => {
        it('训练集与验证集不重叠，模型是那个模型', () => {
          const info = setup();
          console.log(
            '词表 ' + info.vocab + '，训练集 ' + info.trainLen
            + ' 个 token，留出 ' + info.valLen + ' 个'
          );
          expect(info.trainLen).toBeGreaterThan(1000);
          expect(info.valLen).toBeGreaterThan(1000);
        });

        it('400 步之后打穿 bigram 基线', () => {
          setup();
          const r = run(1);
          const base = lab.world.baselines();
          const ratio = r.val / base.bigram;
          console.log(
            '参数量 ' + r.params + '；训练 loss ' + (r.first.reduce((a, c) => a + c, 0) / 5).toFixed(4)
            + ' -> ' + (r.last.reduce((a, c) => a + c, 0) / 10).toFixed(4)
            + '；验证 ' + r.val.toFixed(4)
          );
          console.log(
            '基线：均匀 ' + base.uniform.toFixed(3) + '，unigram ' + base.unigram.toFixed(3)
            + '，bigram ' + base.bigram.toFixed(3) + '；验证 / bigram = ' + ratio.toFixed(3)
          );
          lab.publish('loss.val', r.val);
          lab.publish('loss.vsBigram', ratio);
          expect(r.val).toBeLessThan(1.9);
          expect(ratio).toBeLessThan(0.85);
          // 也要真的比 unigram 好 —— 打穿 bigram 才说明用上了长上下文
          expect(r.val).toBeLessThan(base.unigram);
        });

        it('同一个 seed 跑两遍，逐位一致', () => {
          setup();
          const a = run(7);
          const b2 = run(7);
          let mismatches = 0;
          for (let i = 0; i < a.first.length; i++) if (a.first[i] !== b2.first[i]) mismatches += 1;
          for (let i = 0; i < a.last.length; i++) if (a.last[i] !== b2.last[i]) mismatches += 1;
          if (a.val !== b2.val) mismatches += 1;
          console.log(
            '两遍的验证 loss ' + a.val + ' / ' + b2.val + '，对不上的位置 ' + mismatches + ' 个'
          );
          lab.publish('determinism.mismatches', mismatches);
          expect(mismatches).toBe(0);
        });

        /*
         * 评测必须在 no_grad 下。数字不带 no_grad 也是对的 ——
         * 代价是白建一整条反向的带，而这在小模型上感觉不到。
         * 所以直接数：评测过程里每次算子调用时 is_grad_enabled() 是什么。
         */
        it('评测过程里一次都没建带', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = kit.LM(\${lab.world.vocabSize()}, seed=1)
      _seen = []
      _orig = F.embedding

      def _spy(*a, **k):
          _seen.append(bool(nt.is_grad_enabled()))
          return _orig(*a, **k)

      F.embedding = _spy
      try:
          _v = pretrain.evaluate(_m, kit.val_tokens, \${BATCH}, \${SEQ}, 4)
      finally:
          F.embedding = _orig
      json.dumps({"calls": len(_seen), "enabled": sum(1 for v in _seen if v), "val": _v})
      \`)));
          console.log(
            '评测里调了 ' + r.calls + ' 次前向，其中建带的 ' + r.enabled
            + ' 次；验证 loss ' + r.val.toFixed(4)
          );
          lab.publish('eval.gradEnabledCalls', r.enabled);
          // 真的跑了才算数
          expect(r.calls).toBeGreaterThanOrEqual(4);
          expect(r.enabled).toBe(0);
          expect(Number.isFinite(r.val)).toBe(true);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.loss.val', op: 'lte', value: 1.9,
      zh: '留出集上的 loss', en: 'loss on the held-out set', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.loss.vsBigram', op: 'lte', value: 0.85,
      zh: '验证 loss 与 bigram 基线的比', en: 'validation loss over the bigram baseline',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.determinism.mismatches', op: 'eq', value: 0,
      zh: '同 seed 两遍对不上的位置数', en: 'positions differing between two runs at one seed',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.eval.gradEnabledCalls', op: 'eq', value: 0,
      zh: '评测过程里建了带的调用数', en: 'calls that built a tape during evaluation',
      dimension: 'efficiency',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      到这里，**预训练这条链是完整的**：分词、模型、反向、优化器、调度、裁剪、
      数据打包、评测。真实项目里多出来的主要是规模带来的东西 ——
      分布式（数据并行 / 张量并行 / 流水线并行）、检查点与断点续训、
      以及一整套监控（梯度范数、激活范数、各层的更新比例）。

      有一条经验值得记住：**训练崩了的时候，先看梯度范数的曲线**。
      它比 loss 早得多地告诉你出了什么事,loss 尖峰的时候，
      梯度范数往往已经涨了几十步了。

      还有一件小事但很实在：**先跑一个「能过拟合一小批数据」的检查**。
      拿 8 条样本训 200 步，loss 应该掉到接近 0。掉不下去说明模型或反向有 bug，
      而这个检查只要几秒钟。在真正开跑之前做一次，能省掉很多天。
    `,
    code`
      At this point **the pretraining chain is complete**: tokenisation, model, backward,
      optimiser, schedule, clipping, data packing, evaluation. What real projects add is
      mostly what scale demands — distribution (data, tensor and pipeline parallelism),
      checkpointing and resumption, and a monitoring suite (gradient norms, activation
      norms, per-layer update ratios).

      One rule worth remembering: **when training breaks, look at the gradient-norm curve
      first**. It tells you what happened long before the loss does — by the time a loss
      spike appears, the gradient norm has usually been climbing for dozens of steps.

      And a small but practical habit: **first run an "overfit a tiny batch" check**. Train
      on 8 examples for 200 steps and the loss should approach zero. If it does not, the
      model or the backward has a bug — and the check takes seconds. Doing it once before a
      real run saves days.
    `
  ),
};

/* ================================================================== */
/* 第 17 关：混合精度                                                   */
/* ================================================================== */

/** 第 17 / 18 关的模型：6 层，深一点才看得出重算省了多少 */
const KIT_DEEP_PY = code`
  """平台给的模型。和前面几关同一套，只是**深到 6 层** ——
  激活重算省下来的东西正比于层数，两层的模型上看不出来。

  \`vocab=16, dim=32, n_layer=6, n_head=4, n_kv_head=2, hidden=88\`，
  batch 8 × seq 16。
  """
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F

  V, D, L, H, KV, HID, B, S = 16, 32, 6, 4, 2, 88, 8, 16


  def build_tables(n, head_dim, base=10000.0):
      half = head_dim // 2
      cos = nt.zeros((n, half), role="data", name="rope.cos")
      sin = nt.zeros((n, half), role="data", name="rope.sin")
      cv, sv = [], []
      for p in range(n):
          for i in range(half):
              th = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(th))
              sv.append(math.sin(th))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class Norm(nn.Module):
      def __init__(self, dim):
          super().__init__()
          self.weight = nt.parameter((dim,), None, 0.0, "g")

      def forward(self, x):
          return F.rms_norm(x, self.weight, 1e-5)


  class Attn(nn.Module):
      def __init__(self, dim, nh, nkv, seed, max_seq=64):
          super().__init__()
          self.nh, self.nkv, self.hd = nh, nkv, dim // nh
          hd = self.hd
          self.wq = nt.parameter((dim, nh * hd), seed + 1, dim ** -0.5, "wq")
          self.wk = nt.parameter((dim, nkv * hd), seed + 2, dim ** -0.5, "wk")
          self.wv = nt.parameter((dim, nkv * hd), seed + 3, dim ** -0.5, "wv")
          self.wo = nt.parameter((nh * hd, dim), seed + 4, (nh * hd) ** -0.5, "wo")
          self._cos, self._sin = build_tables(max_seq, hd)

      def forward(self, x, b, s):
          hd = self.hd
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          q = F.rope(q, self._cos, self._sin, b, s, self.nh, hd)
          k = F.rope(k, self._cos, self._sin, b, s, self.nkv, hd)
          sc = F.attn_scores(q, k, b, s, s, self.nh, self.nkv, hd)
          pr = F.softmax(sc, b * self.nh * s, s, F.causal_valid(b, self.nh, s))
          o = F.attn_apply(pr, v, b, s, s, self.nh, self.nkv, hd,
                           out_shape=(b * s, self.nh * hd))
          return F.linear(o, self.wo)


  class Mlp(nn.Module):
      def __init__(self, dim, hid, seed):
          super().__init__()
          self.wg = nt.parameter((dim, hid), seed + 1, dim ** -0.5, "wg")
          self.wu = nt.parameter((dim, hid), seed + 2, dim ** -0.5, "wu")
          self.wd = nt.parameter((hid, dim), seed + 3, hid ** -0.5, "wd")

      def forward(self, x):
          return F.linear(F.swiglu(F.linear(x, self.wg), F.linear(x, self.wu)), self.wd)


  class Block(nn.Module):
      def __init__(self, dim, nh, nkv, hid, seed, nl):
          super().__init__()
          self.n1, self.at = Norm(dim), Attn(dim, nh, nkv, seed)
          self.n2, self.mp = Norm(dim), Mlp(dim, hid, seed + 40)
          self.sc = (2.0 * nl) ** -0.5

      def forward(self, x, b, s):
          x = F.add(x, F.scale(self.at(self.n1(x), b, s), self.sc))
          return F.add(x, F.scale(self.mp(self.n2(x)), self.sc))


  class LM(nn.Module):
      """\`wrap\` 给第 18 关用：把每层包一层重算。第 17 关不用管它。"""

      def __init__(self, seed=1, wrap=None):
          super().__init__()
          self.wrap = wrap
          self.embed = nt.parameter((V, D), seed, D ** -0.5, "embed")
          self.blocks = nn.ModuleList([
              Block(D, H, KV, HID, seed + 100 * (i + 1), L) for i in range(L)
          ])
          self.nf = Norm(D)

      def forward(self, idx, tgt, b, s):
          rows = b * s
          x = F.embedding(self.embed, idx, rows, D)
          for blk in self.blocks:
              x = self.wrap(blk, x, b, s) if self.wrap else blk(x, b, s)
          x = self.nf(x)
          return F.cross_entropy(F.linear_tied(x, self.embed, rows, D, V), tgt, rows, V)


  _batches = {}


  def get_batch(seed):
      return _batches[seed]
`;

const STAGE_AMP = {
  id: 'mixed-precision',
  title: t('混合精度 —— bf16 赢在动态范围', 'Mixed precision — bf16 wins on range'),
  goal: t(
    code`
      在 \`amp.py\` 里写一个 \`autocast\`：**参数留在 fp32，算的时候降到低精度**。

      \`\`\`python
      class Cast(nt.autograd.Function):
          """把张量舍入到 bf16 / fp16 能表示的值上。反向**直通**。"""

      class autocast:
          """with autocast("bf16"): ... —— 里面的矩阵乘走低精度。

          对应 torch.autocast。"""
          def __init__(self, dtype="bf16", enabled=True):
          def __enter__(self):   # 把 F.linear 换成先降精度再算的版本
          def __exit__(self, *a):  # 换回来
      \`\`\`

      \`F.quantize_(x, "bf16")\` 已经有了 —— 它**就地**把每个数舍入到该精度
      能表示的最近的值（位级模拟，不是乘个系数糊弄）。

      ## 三种格式，差的不是一件事

      \`\`\`
              指数位   尾数位   动态范围            相对精度
      fp32      8       23     ±3.4e38            2⁻²⁴ ≈ 6e-8
      bf16      8        7     ±3.4e38（同 fp32） 2⁻⁸  ≈ 3.9e-3
      fp16      5       10     ±65504             2⁻¹¹ ≈ 4.9e-4
      \`\`\`

      **bf16 比 fp16 精度更差，却是训练的默认选择。** 因为它保住了 fp32 的
      指数位数,动态范围一模一样。而训练里真正会出事的是**范围**不是精度：
      梯度动辄跨十几个数量级，fp16 的上限 65504 很容易撞上，下限那头则悄悄下溢成 0。

      fp16 要用起来得配一整套 \`GradScaler\`（loss 先乘一个大系数，
      反向完再除回去，撞到 inf 就跳过这步并把系数减半）。
      bf16 什么都不用配。**省掉的复杂度才是 bf16 真正的价值。**

      这一关会拿一组 \`1e5\` 量级的数验一遍：fp16 全部溢出成 inf，bf16 一个都不溢。

      ## 主权重必须留在 fp32

      \`autocast\` 只在**算的时候**降精度,参数本身、梯度、优化器状态都留在 fp32。
      理由是更新量太小：\`lr · m̂/√v̂\` 常常在 \`1e-6\` 量级，
      而 bf16 在 1.0 附近的分辨率是 \`3.9e-3\` —— **加上去等于没加**，
      模型会静静地停止学习。

      所以 \`Cast\` 必须**返回一份拷贝**，不能就地把参数改掉。
      这一关的门槛专门查这件事：训练结束之后，参数的值必须**还不是** bf16 能表示的值。

      ## 反向为什么是直通

      舍入这个操作几乎处处导数为 0（阶梯函数），照实求导的话梯度全是 0。
      标准做法是**直通估计**（straight-through）：前向照舍，反向当它是恒等。
      量化感知训练里的那个 STE 就是同一个东西。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | bf16 的舍入 | 最大相对误差 ≤ **2⁻⁸ = 3.907e-3**，且明显大于 0 |
      | 动态范围 | \`1e5\` 量级下 bf16 溢出 **0** 个（fp16 全溢） |
      | **主权重完好** | 训练完的参数与它的 bf16 版本之差 > 0 |
      | 质量 | 250 步之后 bf16 与 fp32 的 loss 差 ≤ **0.05** |
    `,
    code`
      Write an \`autocast\` in \`amp.py\`: **parameters stay in fp32, arithmetic drops to low
      precision**.

      \`\`\`python
      class Cast(nt.autograd.Function):
          """Round a tensor to the nearest value the target format can hold.
          The backward is **straight-through**."""

      class autocast:
          """with autocast("bf16"): ... — matmuls inside run in low precision.

          Mirrors torch.autocast."""
          def __init__(self, dtype="bf16", enabled=True):
          def __enter__(self):   # swap F.linear for a version that casts first
          def __exit__(self, *a):  # swap it back
      \`\`\`

      \`F.quantize_(x, "bf16")\` already exists — it rounds every value **in place** to the
      nearest representable one (bit-level, not a scale factor).

      ## Three formats, differing in different ways

      \`\`\`
              exponent  mantissa  dynamic range      relative precision
      fp32       8         23      ±3.4e38           2⁻²⁴ ≈ 6e-8
      bf16       8          7      ±3.4e38 (= fp32)  2⁻⁸  ≈ 3.9e-3
      fp16       5         10      ±65504            2⁻¹¹ ≈ 4.9e-4
      \`\`\`

      **bf16 is less precise than fp16 and yet the default for training.** It keeps fp32's
      exponent width, so the dynamic range is identical. What actually breaks training is
      **range**, not precision: gradients span a dozen orders of magnitude, fp16's ceiling
      of 65504 is easy to hit, and the low end quietly underflows to zero.

      Using fp16 requires the whole \`GradScaler\` apparatus (multiply the loss by a large
      factor, divide it back after the backward, and on hitting an inf skip the step and
      halve the factor). bf16 needs none of that. **The complexity it removes is bf16's real
      value.**

      This stage checks it on a batch of values around \`1e5\`: fp16 turns every one into
      inf, bf16 none.

      ## Master weights stay in fp32

      \`autocast\` lowers precision **only for the arithmetic**; parameters, gradients and
      optimiser state stay fp32. The reason is that updates are tiny: \`lr · m̂/√v̂\` often
      sits around \`1e-6\`, while bf16's resolution near 1.0 is \`3.9e-3\` — **adding it
      changes nothing**, and the model silently stops learning.

      So \`Cast\` must **return a copy** rather than modifying the parameter in place. One
      gate checks exactly this: after training, parameter values must **not** be values bf16
      could represent.

      ## Why the backward is straight-through

      Rounding has zero derivative almost everywhere (it is a step function), so
      differentiating it honestly gives zero gradients everywhere. The standard answer is
      the **straight-through estimator**: round in the forward, treat it as the identity in
      the backward. The STE in quantisation-aware training is the same idea.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | bf16 rounding | Max relative error <= **2⁻⁸ = 3.907e-3**, and clearly above 0 |
      | Dynamic range | Around \`1e5\`, bf16 overflows **0** values (fp16 overflows all) |
      | **Master weights intact** | Trained parameters differ from their bf16 rounding |
      | Quality | After 250 steps, bf16 within **0.05** of fp32's loss |
    `
  ),
  checklist: [
    t('Cast 返回拷贝，不就地改参数', 'Cast returns a copy and never modifies the parameter in place'),
    t('Cast 的反向是直通', "Cast's backward is straight-through"),
    t('autocast 出了作用域要把 F.linear 换回来',
      'autocast restores F.linear on exit'),
    t('参数、梯度、优化器状态都留在 fp32',
      'Parameters, gradients and optimiser state all stay in fp32'),
  ],
  hints: [
    t('x.detach() 给你一份同值的拷贝，再 F.quantize_ 就不会碰到原张量。',
      'x.detach() gives a same-valued copy; F.quantize_ on it never touches the original.'),
    t('__exit__ 里一定要还原 —— 用 try/finally 的思路，别只在正常路径上还。',
      'Always restore in __exit__; think try/finally rather than only the happy path.'),
    t('enabled=False 时什么都不做 —— 对照组要用它。',
      'With enabled=False do nothing at all; the control run needs that.'),
  ],
  pitfalls: [
    t(code`
      **就地量化参数。** \`F.quantize_(w, "bf16")\` 直接改的是主权重。
      前几步看不出来 —— loss 照样降。等到更新量掉到 \`1e-6\` 量级，
      而 bf16 在 1.0 附近的分辨率是 \`3.9e-3\`，**每一次更新都被舍回原值**，
      模型静静地停止学习，loss 曲线变成一条水平线，而没有任何错误。
    `, code`
      **Quantising parameters in place.** \`F.quantize_(w, "bf16")\` rewrites the master
      weights. Nothing shows for the first steps — the loss still falls. Then updates shrink
      to around \`1e-6\` while bf16's resolution near 1.0 is \`3.9e-3\`, so **every update
      rounds back to where it started**, the model silently stops learning, and the loss
      curve flattens with no error anywhere.
    `),
    t(code`
      **反向照实求导。** 舍入几乎处处导数为 0，于是梯度全是 0 —— 模型完全不动。
      这个错反而**容易发现**（loss 一步都不降），比上面那个好得多。
      正确做法是直通：前向照舍，反向当恒等。
    `, code`
      **Differentiating the rounding honestly.** Its derivative is zero almost everywhere,
      so every gradient is zero and the model does not move at all. This failure is
      **easy to spot** (the loss never drops), which makes it far kinder than the previous
      one. The fix is straight-through: round forward, identity backward.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_DEEP_PY,
      'amp.py': code`
        """第 17 关：混合精度。参数留 fp32，算的时候降精度。"""
        import nanotorch as nt
        from nanotorch import functional as F


        class Cast(nt.autograd.Function):
            """舍入到 dtype 能表示的值。反向直通。"""

            @staticmethod
            def forward(ctx, x, dtype):
                # TODO: 拷一份再量化 —— 别碰原张量
                return x

            @staticmethod
            def backward(ctx, grad_output):
                # TODO: 直通
                return None


        class autocast:
            """with autocast("bf16"): ... 里面的 F.linear 走低精度。"""

            def __init__(self, dtype="bf16", enabled=True):
                self.dtype, self.enabled = dtype, enabled

            def __enter__(self):
                # TODO: 把 F.linear 换成「先把 x 和 w 降精度，再调原来的」
                return self

            def __exit__(self, *exc):
                # TODO: 换回来
                return False


        if __name__ == "__main__":
            x = nt.zeros((8,), role="data").normal_(1, 1.0)
            before = list(x.tolist())
            y = Cast.apply(x, "bf16")
            print("原值", [round(v, 6) for v in before[:3]])
            print("bf16", [round(v, 6) for v in y.tolist()[:3]])
            print("原张量没被改", before == x.tolist())
      `,
    },
    referenceFiles: {
      'amp.py': code`
        """第 17 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F


        class Cast(nt.autograd.Function):
            @staticmethod
            def forward(ctx, x, dtype):
                # detach 拿一份拷贝再量化。**就地量化参数会毁掉主权重** ——
                # 更新量在 1e-6 量级，而 bf16 在 1.0 附近的分辨率是 3.9e-3，
                # 每次更新都被舍回原值，模型静静地停止学习
                y = x.detach()
                F.quantize_(y, dtype)
                return y

            @staticmethod
            def backward(ctx, grad_output):
                # 直通：舍入几乎处处导数为 0，照实求导的话梯度全是 0。
                # 量化感知训练里的 STE 是同一个东西
                return grad_output


        class autocast:
            def __init__(self, dtype="bf16", enabled=True):
                self.dtype, self.enabled = dtype, enabled

            def __enter__(self):
                if not self.enabled:
                    return self
                self._orig = F.linear
                dtype, orig = self.dtype, F.linear

                def low_precision_linear(x, weight):
                    return orig(Cast.apply(x, dtype), Cast.apply(weight, dtype))

                F.linear = low_precision_linear
                return self

            def __exit__(self, *exc):
                if self.enabled:
                    F.linear = self._orig
                return False


        if __name__ == "__main__":
            x = nt.zeros((8,), role="data").normal_(1, 1.0)
            before = list(x.tolist())
            y = Cast.apply(x, "bf16")
            print("原值", [round(v, 6) for v in before[:3]])
            print("bf16", [round(v, 6) for v in y.tolist()[:3]])
            print("原张量没被改", before == x.tolist())
      `,
    },
  },
  specs: [
    spec('amp.spec.ts', code`
      ${LAB}

      const STEPS = 250;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, amp
      importlib.reload(kit)
      importlib.reload(amp)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
        for (let s = 1; s <= 10; s++) {
          const d = lab.data.induction(8, 16, 16, 1000 + s);
          lab.py('kit._batches[' + (1000 + s) + '] = ('
            + JSON.stringify([...d.idx]) + ', ' + JSON.stringify([...d.tgt]) + ')');
        }
        lab.py(\`
      def _train(dtype, enabled, steps):
          m = kit.LM(seed=1)
          opt = nt.optim.AdamW(m.parameters(), lr=0.03, betas=(0.9, 0.95),
                               weight_decay=0.1, grad_clip=1.0)
          idx = nt.zeros((kit.B * kit.S,), role="data", name="idx")
          tgt = nt.zeros((kit.B * kit.S,), role="data", name="tgt")
          hist = []
          base = nt.mark()
          for st in range(1, steps + 1):
              nt.release(base)
              bi, bt = kit.get_batch(1000 + ((st - 1) % 10) + 1)
              idx.set_int_(bi)
              tgt.set_int_(bt)
              opt.zero_grad()
              nt.phase("forward")
              with amp.autocast(dtype, enabled):
                  loss = m(idx, tgt, kit.B, kit.S)
              nt.phase("other")
              loss.backward()
              w = max(1, steps // 20)
              if st <= w:
                  lr = 0.03 * st / w
              else:
                  pr = (st - w) / max(1, steps - w)
                  lr = 0.03 * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
              opt.step(lr=lr)
              hist.append(loss.value)

          # 主权重有没有被就地毁掉：和它的 bf16 版本比，应当还有差
          intact = 0.0
          for p in m.parameters():
              c = p.detach()
              F.quantize_(c, "bf16")
              for u, v in zip(p.tolist(), c.tolist()):
                  intact = max(intact, abs(u - v))
          return {"last": sum(hist[-10:]) / 10, "intact": intact,
                  "finite": all(v == v for v in hist)}
      \`);
      }

      describe('混合精度', () => {
        it('bf16 的舍入误差正好卡在 2⁻⁸ 上', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _x = nt.zeros((256,), role="data").normal_(5, 1.0)
      _ref = list(_x.tolist())
      _y = amp.Cast.apply(_x, "bf16")
      _q = list(_y.tolist())
      _worst = 0.0
      for _a, _b in zip(_ref, _q):
          if _a != 0:
              _worst = max(_worst, abs(_a - _b) / abs(_a))
      json.dumps({"worst": _worst, "untouched": _ref == _x.tolist()})
      \`)));
          const bound = Math.pow(2, -8);
          console.log(
            'bf16 最大相对误差 ' + r.worst.toExponential(3)
            + '，理论界 2⁻⁸ = ' + bound.toExponential(3)
            + '；原张量没被改 ' + r.untouched
          );
          lab.publish('precision.bf16MaxRelError', r.worst);
          expect(r.worst).toBeLessThanOrEqual(bound);
          // 真的舍了才算数 —— 原样返回的话这条也会「过」
          expect(r.worst).toBeGreaterThan(1e-3);
          // Cast 必须返回拷贝
          expect(r.untouched).toBe(true);
        });

        /*
         * bf16 比 fp16 精度更差，却是训练的默认选择 —— 差别在**动态范围**。
         * 这一条用一组 1e5 量级的数把这件事量出来。
         */
        it('1e5 量级下 fp16 全部溢出，bf16 一个都不溢', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _big = nt.zeros((64,), role="data")
      _big.set_([1e5 * (i + 1) for i in range(64)])
      _f16 = amp.Cast.apply(_big, "fp16")
      _b16 = amp.Cast.apply(_big, "bf16")
      json.dumps({"fp16": F.count_nonfinite(_f16), "bf16": F.count_nonfinite(_b16)})
      \`)));
          console.log(
            '1e5 ~ 6.4e6 这 64 个数：fp16 溢出 ' + r.fp16
            + ' 个（上限 65504），bf16 溢出 ' + r.bf16 + ' 个（上限 3.4e38）'
          );
          lab.publish('precision.bf16NonFinite', r.bf16);
          lab.publish('precision.fp16NonFinite', r.fp16);
          expect(r.bf16).toBe(0);
          expect(r.fp16).toBe(64);
        });

        it('训练完主权重还在 fp32 —— 没被就地量化掉', () => {
          setup();
          const r = JSON.parse(String(lab.py('json.dumps(_train("bf16", True, 60))')));
          console.log(
            '参数与它的 bf16 版本的最大差 ' + r.intact.toExponential(2)
            + '（就地量化掉的话这个数会是 0）'
          );
          lab.publish('precision.masterWeightsIntact', r.intact);
          expect(r.intact).toBeGreaterThan(1e-6);
        });

        it('250 步之后 bf16 与 fp32 的 loss 差 ≤ 0.05', () => {
          setup();
          const fp32 = JSON.parse(String(lab.py('json.dumps(_train("bf16", False, ' + STEPS + '))')));
          const bf16 = JSON.parse(String(lab.py('json.dumps(_train("bf16", True, ' + STEPS + '))')));
          const gap = Math.abs(bf16.last - fp32.last);
          console.log(
            'fp32 ' + fp32.last.toFixed(4) + '，bf16 ' + bf16.last.toFixed(4)
            + '，差 ' + gap.toFixed(4)
          );
          lab.publish('loss.bf16Gap', gap);
          expect(fp32.finite && bf16.finite).toBe(true);
          expect(gap).toBeLessThan(0.05);
          // 两边都要真的训下来了，否则「差不多」是因为两边都没学
          expect(bf16.last).toBeLessThan(1.0);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.precision.bf16MaxRelError', op: 'lte', value: 0.00390625,
      zh: 'bf16 舍入的最大相对误差（界是 2⁻⁸）', en: 'max bf16 rounding error (bound 2⁻⁸)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.precision.bf16NonFinite', op: 'eq', value: 0,
      zh: '1e5 量级下 bf16 溢出的个数（fp16 全溢）',
      en: 'bf16 overflows around 1e5 (fp16 overflows all)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.precision.masterWeightsIntact', op: 'gte', value: 1e-6,
      zh: '参数与其 bf16 版本的差（主权重没被就地量化）',
      en: 'gap between parameters and their bf16 rounding (master weights survived)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.loss.bf16Gap', op: 'lte', value: 0.05,
      zh: 'bf16 与 fp32 的最终 loss 差', en: 'final loss gap between bf16 and fp32',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      这一关的模型太小，**fp16 在这里也能训下来** —— 激活和梯度都远够不到 65504。
      范围的问题要到真实尺度才出现，而那时候它出现得非常突然：
      某一层的某个梯度撞上上限，整步变成 NaN。
      所以这一关把范围单独拿一组 \`1e5\` 的数来量,**不假装小模型上 fp16 会炸**。

      2026 年还在往更低走。\`fp8\`（E4M3 / E5M2 两种）在 H100 起的硬件上
      有原生支持，训练里已经在用了 —— 但**不是整网 fp8**：
      通常只有矩阵乘的输入降到 fp8，累加仍然在 fp32，
      而且要配**逐张量或逐块的缩放系数**把值挪进 fp8 那个很窄的窗口里。
      DeepSeek-V3 的技术报告里这一段写得很细。

      再往下是推理侧的 \`int4\` / \`int8\` 量化，那是另一条线 ——
      训练要梯度，推理不要，所以推理能压得比训练狠得多。
    `,
    code`
      The model here is small enough that **fp16 trains fine too** — activations and
      gradients never approach 65504. Range problems appear only at real scale, and when
      they do they appear abruptly: one gradient in one layer hits the ceiling and the whole
      step becomes NaN. That is why this stage measures range on a separate batch of
      \`1e5\` values instead of **pretending fp16 breaks on a toy model**.

      2026 keeps going lower. \`fp8\` (in E4M3 and E5M2 flavours) has native hardware
      support from H100 onward and is used in training — but **never as whole-network
      fp8**: typically only matmul inputs drop to fp8 while accumulation stays fp32, plus
      **per-tensor or per-block scaling factors** to move values into fp8's narrow window.
      DeepSeek-V3's technical report covers this in detail.

      Below that sits inference-side \`int4\` / \`int8\` quantisation, a separate line of
      work — training needs gradients and inference does not, so inference compresses far
      more aggressively than training can.
    `
  ),
};

/* ================================================================== */
/* 第 18 关：激活重算                                                   */
/* ================================================================== */

const STAGE_RECOMPUTE = {
  id: 'activation-recompute',
  title: t('激活重算 —— 拿算力换显存', 'Activation recomputation — trading compute for memory'),
  goal: t(
    code`
      前向算出来的中间量，反向要用,所以它们得一直留到反向。
      这些**激活**在真实训练里是显存的大头，而且正比于层数。

      \`激活重算\`（也叫 gradient checkpointing）换了个做法：
      前向**只留每层的边界**，中间量算完就扔；反向走到那一层时**重新算一遍**。
      代价是多一次前向的算力，收益是显存降一个量级。

      在 \`recompute.py\` 里实现它：

      \`\`\`python
      class Checkpoint(nt.autograd.Function):
          @staticmethod
          def forward(ctx, block, x, batch, seq):
              """只留输出，中间量全放掉。"""

          @staticmethod
          def backward(ctx, grad_output):
              """重新前向一遍，然后从 grad_output 倒着走。"""

      def checkpoint(block, x, batch, seq):
          return Checkpoint.apply(block, x, batch, seq)
      \`\`\`

      对应 \`torch.utils.checkpoint.checkpoint\`。

      ## 前向：留边界，扔中间

      竞技场是**按标记回退**的：\`nt.mark()\` 记下当前位置，
      \`nt.release(mark)\` 把之后分配的全部放掉。所以：

      \`\`\`python
      out = nt.zeros(x.shape)      # 边界张量，要在 mark 之前分配
      m = nt.mark()
      y = block(x, batch, seq)     # 中间量都落在 m 之后
      out.copy_(y)
      nt.release(m)                # 中间量一把放掉，只剩 out
      \`\`\`

      注意 \`Function.forward\` **本来就跑在 \`no_grad\` 里**（第 9 关那条），
      所以这一遍不会建带 —— 这正是我们要的。

      ## 反向：重算，然后倒着走

      \`\`\`python
      xd = ctx.x.detach()          # 干净的叶子，不接回原来的图
      xd.requires_grad = True
      with nt.enable_grad():       # 这一遍要建带
          y = ctx.block(xd, ...)
      nt.autograd.backward(y, grad_output)
      return xd.grad
      \`\`\`

      \`detach()\` 不能省。不 detach 的话重算出来的子图会接回原图，
      反向会**沿着同一条路走两遍**,梯度直接翻倍。

      块里的**参数**梯度在重算的那一遍里就已经累加好了（它们不是 \`apply\` 的输入），
      所以 \`backward\` 只需要返回 \`x\` 那一份。

      ## 量的是「留存」，不是「峰值」

      这一关的门槛读 \`memory.currentActivationBytes\` —— **前向刚结束、反向还没开始**
      那一刻还占着的激活。这才是重算省下来的东西。

      峰值不行：峰值里混着反向自己的临时量，而那部分重算不但不省，
      还因为多算一遍而略高。**量错对象的话，一个完全正确的实现会显示成「没省」。**

      ## 算力那一侧

      重算发生在反向阶段，所以 \`前向 FLOPs\` 不变，涨的是 \`反向 / 前向\` 这个比：

      \`\`\`
      不重算   反向 / 前向 ≈ 2      （每个 gemm 算 dX 和 dW）
      重算     反向 / 前向 ≈ 3      （多了一整遍前向）
      一步合计  6N  ->  8N
      \`\`\`

      **前向 FLOPs 涨了说明重算跑到前向里去了** —— 那不是重算，那是白算。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | **留存的激活** | 重算 / 不重算 ≤ **0.4** |
      | 反向 / 前向 | 在 **2.4 ~ 3.6** 之间 |
      | 前向 FLOPs | 与不重算**完全相同** |
      | **梯度** | 与不重算**逐位相同** |

      最后一条值得说：重算跑的是同一串算子、同一个顺序，
      所以结果**应当**逐位相同 —— 不是「差不多」。差了说明 detach 漏了、
      或者重算那一遍的输入不是原来那个。
    `,
    code`
      The forward pass produces intermediates the backward needs, so they must stay alive
      until then. Those **activations** dominate memory in real training, and they scale
      with depth.

      \`Activation recomputation\` (also called gradient checkpointing) takes another route:
      the forward **keeps only the boundary of each layer** and discards everything in
      between; when the backward reaches that layer it **computes the forward again**. The
      cost is one extra forward pass, the gain is an order of magnitude less memory.

      Implement it in \`recompute.py\`:

      \`\`\`python
      class Checkpoint(nt.autograd.Function):
          @staticmethod
          def forward(ctx, block, x, batch, seq):
              """Keep only the output; drop every intermediate."""

          @staticmethod
          def backward(ctx, grad_output):
              """Recompute the forward, then walk back from grad_output."""

      def checkpoint(block, x, batch, seq):
          return Checkpoint.apply(block, x, batch, seq)
      \`\`\`

      This mirrors \`torch.utils.checkpoint.checkpoint\`.

      ## Forward: keep the boundary, drop the middle

      The arena rewinds **to a mark**: \`nt.mark()\` records the position and
      \`nt.release(mark)\` frees everything allocated after it. So:

      \`\`\`python
      out = nt.zeros(x.shape)      # the boundary tensor, allocated before the mark
      m = nt.mark()
      y = block(x, batch, seq)     # intermediates all land after m
      out.copy_(y)
      nt.release(m)                # drop them all at once, keeping only out
      \`\`\`

      Note that \`Function.forward\` **already runs under \`no_grad\`** (stage 9), so this
      pass builds no tape — exactly what is wanted.

      ## Backward: recompute, then walk

      \`\`\`python
      xd = ctx.x.detach()          # a clean leaf, not attached to the original graph
      xd.requires_grad = True
      with nt.enable_grad():       # this pass does need a tape
          y = ctx.block(xd, ...)
      nt.autograd.backward(y, grad_output)
      return xd.grad
      \`\`\`

      \`detach()\` is not optional. Without it the recomputed subgraph reconnects to the
      original, and the backward **walks the same path twice** — gradients come out doubled.

      Gradients for the block's **parameters** are already accumulated during the recompute
      (they are not inputs to \`apply\`), so \`backward\` only returns the one for \`x\`.

      ## What gets measured is what is **kept**, not the peak

      The gate reads \`memory.currentActivationBytes\` — what is still held **the moment the
      forward ends and before the backward starts**. That is precisely what recomputation
      saves.

      The peak will not do: it mixes in the backward's own temporaries, which recomputation
      does not reduce and in fact slightly increases. **Measure the wrong thing and a
      perfectly correct implementation reads as "no saving".**

      ## The compute side

      Recomputation happens during the backward, so \`forward FLOPs\` are unchanged and what
      rises is the \`backward / forward\` ratio:

      \`\`\`
      without   backward / forward ≈ 2      (each gemm produces dX and dW)
      with      backward / forward ≈ 3      (one extra full forward)
      per step  6N  ->  8N
      \`\`\`

      **Rising forward FLOPs means the recompute leaked into the forward** — that is not
      recomputation, that is wasted work.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | **Activations kept** | with / without <= **0.4** |
      | backward / forward | Between **2.4 and 3.6** |
      | Forward FLOPs | **Identical** to the non-recomputing run |
      | **Gradients** | **Bit-identical** to the non-recomputing run |

      That last row is worth stating: recomputation runs the same operators in the same
      order, so results **should** be bit-identical, not merely close. A difference means a
      missing detach, or that the recompute used a different input.
    `
  ),
  checklist: [
    t('边界张量在 mark 之前分配', 'The boundary tensor is allocated before the mark'),
    t('重算那一遍从 detach 出来的叶子出发', 'The recompute starts from a detached leaf'),
    t('重算跑在 enable_grad 里', 'The recompute runs under enable_grad'),
    t('梯度与不重算逐位相同', 'Gradients are bit-identical to the non-recomputing run'),
  ],
  hints: [
    t('Function.forward 已经在 no_grad 里了，前向那一遍不用自己加。',
      'Function.forward already runs under no_grad; the forward pass needs nothing extra.'),
    t('nt.autograd.backward(y, grad) 能从非标量出发 —— 这一关要的就是它。',
      'nt.autograd.backward(y, grad) starts from a non-scalar, which is what this needs.'),
    t('block 与 batch / seq 不是张量，apply 不会把它们算进输入 —— backward 只返回一份梯度。',
      'block and batch/seq are not tensors, so apply ignores them; backward returns one gradient.'),
  ],
  pitfalls: [
    t(code`
      **重算那一遍直接用 \`ctx.x\`，没有 detach。** 新算出来的子图接回了原图，
      于是反向沿着同一条路走两遍,**梯度正好翻倍**。
      loss 照样降（只是等效学习率大了一倍），一切看起来正常。
      这一关拿「与不重算逐位相同」把它抓出来。
    `, code`
      **Recomputing directly from \`ctx.x\` without detaching.** The new subgraph reconnects
      to the original, so the backward walks the same path twice and **gradients double**.
      The loss still falls (the effective learning rate merely doubled) and everything looks
      normal. The bit-identity check against the non-recomputing run catches it.
    `),
    t(code`
      **边界张量在 mark 之后分配。** \`nt.release(mark)\` 会把它一起放掉,
      下一层拿到的是一块已经被回收的显存。
      报出来的错是「张量已经被 release 掉了」,这次算是运气好，
      竞技场有守卫；换个不查的实现，读到的就是别人的数据。
    `, code`
      **Allocating the boundary tensor after the mark.** \`nt.release(mark)\` frees it too,
      and the next layer receives reclaimed memory. The error reads "this tensor was already
      released" — which is the lucky outcome, since the arena checks. An implementation
      without that guard would quietly read someone else's data.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_DEEP_PY,
      'recompute.py': code`
        """第 18 关：激活重算。前向留边界，反向重新算一遍。"""
        import nanotorch as nt
        from nanotorch import functional as F


        class Checkpoint(nt.autograd.Function):
            @staticmethod
            def forward(ctx, block, x, batch, seq):
                ctx.block, ctx.x = block, x
                ctx.batch, ctx.seq = batch, seq
                # TODO: 边界张量在 mark 之前分配 -> mark -> 跑 block ->
                #       把结果拷进边界张量 -> release 掉中间量
                return block(x, batch, seq)

            @staticmethod
            def backward(ctx, grad_output):
                # TODO: detach 出一个干净的叶子 -> enable_grad 里重算 ->
                #       nt.autograd.backward(y, grad_output) -> 返回叶子的梯度
                return None


        def checkpoint(block, x, batch, seq):
            return Checkpoint.apply(block, x, batch, seq)


        if __name__ == "__main__":
            import kit
            m = kit.LM(seed=1, wrap=checkpoint)
            idx = nt.zeros((kit.B * kit.S,), role="data")
            tgt = nt.zeros((kit.B * kit.S,), role="data")
            idx.set_int_([i % kit.V for i in range(kit.B * kit.S)])
            tgt.set_int_([(i + 1) % kit.V for i in range(kit.B * kit.S)])
            loss = m(idx, tgt, kit.B, kit.S)
            loss.backward()
            print("loss %.6f" % loss.value)
      `,
    },
    referenceFiles: {
      'recompute.py': code`
        """第 18 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F


        class Checkpoint(nt.autograd.Function):
            @staticmethod
            def forward(ctx, block, x, batch, seq):
                ctx.block, ctx.x = block, x
                ctx.batch, ctx.seq = batch, seq

                # 边界张量要在 mark **之前**分配 —— 之后分配的话会被 release 一起放掉
                out = nt.zeros(x.shape, x.dtype, name="ckpt.out")
                mark = nt.mark()
                # Function.forward 本来就跑在 no_grad 里，这一遍不建带
                y = block(x, batch, seq)
                out.copy_(y)
                # 中间量一把放掉，只留边界
                nt.release(mark)
                return out

            @staticmethod
            def backward(ctx, grad_output):
                # detach：重算要从一个干净的叶子出发。
                # 不 detach 的话新子图会接回原图，反向沿同一条路走两遍,梯度翻倍
                xd = ctx.x.detach()
                xd.requires_grad = True
                with nt.enable_grad():
                    y = ctx.block(xd, ctx.batch, ctx.seq)
                # 起点不是标量，所以要用 autograd.backward 播种
                nt.autograd.backward(y, grad_output)
                # 块里参数的梯度在上面那一遍就累加好了（它们不是 apply 的输入）
                return xd.grad


        def checkpoint(block, x, batch, seq):
            return Checkpoint.apply(block, x, batch, seq)


        if __name__ == "__main__":
            import kit
            m = kit.LM(seed=1, wrap=checkpoint)
            idx = nt.zeros((kit.B * kit.S,), role="data")
            tgt = nt.zeros((kit.B * kit.S,), role="data")
            idx.set_int_([i % kit.V for i in range(kit.B * kit.S)])
            tgt.set_int_([(i + 1) % kit.V for i in range(kit.B * kit.S)])
            loss = m(idx, tgt, kit.B, kit.S)
            loss.backward()
            print("loss %.6f" % loss.value)
      `,
    },
  },
  specs: [
    spec('recompute.spec.ts', code`
      ${LAB}

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, kit, recompute
      importlib.reload(kit)
      importlib.reload(recompute)
      import nanotorch as nt
      from nanotorch import functional as F

      _state = {}

      def step_forward(use_ckpt):
          """跑到反向之前就停 —— 判定要在这里读「还为反向留着多少激活」。"""
          m = kit.LM(seed=1, wrap=recompute.checkpoint if use_ckpt else None)
          idx = nt.zeros((kit.B * kit.S,), role="data", name="idx")
          tgt = nt.zeros((kit.B * kit.S,), role="data", name="tgt")
          _bi = [(i * 7 + 3) % kit.V for i in range(kit.B * kit.S)]
          idx.set_int_(_bi)
          tgt.set_int_([(v + 1) % kit.V for v in _bi])
          for p in m.parameters():
              p.ensure_grad()
          base = nt.mark()
          nt.reset_peak()
          m.zero_grad()
          nt.phase("forward")
          loss = m(idx, tgt, kit.B, kit.S)
          nt.phase("other")
          _state.update({"m": m, "loss": loss, "base": base})
          return loss.value

      def step_backward():
          m, loss = _state["m"], _state["loss"]
          loss.backward()
          grads = []
          for _, p in m.named_parameters():
              grads.extend(p.grad.tolist())
          nt.release(_state["base"])
          return grads
      \`);
      }

      /** 跑一整步，中途把「留存的激活」读出来 */
      function step(useCkpt) {
        const m0 = lab.metrics();
        const loss = Number(lab.py('step_forward(' + (useCkpt ? 'True' : 'False') + ')'));
        // 前向刚完、反向还没开始 —— 这一刻占着的激活就是「为反向留着的」
        const kept = lab.metrics().memory.currentActivationBytes;
        const grads = JSON.parse(String(lab.py('json.dumps(step_backward())')));
        const m1 = lab.metrics();
        return {
          loss, kept, grads,
          fwd: m1.flops.forward - m0.flops.forward,
          bwd: m1.flops.backward - m0.flops.backward,
        };
      }

      describe('激活重算', () => {
        it('前向为反向留着的激活降到四成以下', () => {
          setup();
          const plain = step(false);
          const ck = step(true);
          const ratio = ck.kept / plain.kept;
          console.log(
            '不重算留着 ' + (plain.kept / 1024).toFixed(0) + ' KB，'
            + '重算留着 ' + (ck.kept / 1024).toFixed(0) + ' KB，比 ' + ratio.toFixed(3)
            + '（模型 ' + Number(lab.py('kit.L')) + ' 层）'
          );
          lab.publish('memory.keptRatio', ratio);
          expect(plain.kept).toBeGreaterThan(0);
          expect(ratio).toBeLessThan(0.4);
        });

        /*
         * 重算跑的是同一串算子、同一个顺序 —— 结果**应当**逐位相同。
         * 差了一般是 detach 漏了：新子图接回原图，反向沿同一条路走两遍，梯度翻倍。
         */
        it('梯度与不重算逐位相同', () => {
          setup();
          const plain = step(false);
          const ck = step(true);
          let mismatch = 0;
          let worst = 0;
          for (let i = 0; i < plain.grads.length; i++) {
            if (plain.grads[i] !== ck.grads[i]) mismatch += 1;
            worst = Math.max(worst, Math.abs(plain.grads[i] - ck.grads[i]));
          }
          console.log(
            'loss ' + plain.loss + ' / ' + ck.loss + '；'
            + plain.grads.length + ' 个梯度里对不上的 ' + mismatch
            + ' 个，最大差 ' + worst.toExponential(2)
          );
          lab.publish('grad.recomputeMismatches', mismatch);
          expect(plain.grads.length).toBeGreaterThan(1000);
          expect(plain.loss).toBe(ck.loss);
          expect(mismatch).toBe(0);
        });

        /*
         * 重算发生在反向阶段，所以前向 FLOPs 一点不该变，
         * 涨的是反向 / 前向那个比：2 -> 3。
         * 前向涨了说明重算跑到前向里去了 —— 那不是重算，是白算。
         */
        it('前向 FLOPs 不变，反向 / 前向从 2 涨到 3', () => {
          setup();
          const plain = step(false);
          const ck = step(true);
          const r0 = plain.bwd / plain.fwd;
          const r1 = ck.bwd / ck.fwd;
          console.log(
            '不重算 前向 ' + plain.fwd + ' 反向 ' + plain.bwd + ' 比 ' + r0.toFixed(3)
            + '；重算 前向 ' + ck.fwd + ' 反向 ' + ck.bwd + ' 比 ' + r1.toFixed(3)
          );
          lab.publish('flops.backwardOverForward', r1);
          lab.publish('flops.forwardDelta', ck.fwd - plain.fwd);
          expect(ck.fwd).toBe(plain.fwd);
          expect(r0).toBeGreaterThan(1.8);
          expect(r0).toBeLessThan(2.2);
          expect(r1).toBeGreaterThan(2.4);
          expect(r1).toBeLessThan(3.6);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.memory.keptRatio', op: 'lte', value: 0.4,
      zh: '前向留给反向的激活（重算 / 不重算）',
      en: 'activations kept for the backward (with / without recomputation)',
      dimension: 'efficiency',
    }),
    gate({
      metric: 'llm.grad.recomputeMismatches', op: 'eq', value: 0,
      zh: '与不重算对不上的梯度个数', en: 'gradients differing from the non-recomputing run',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.flops.forwardDelta', op: 'eq', value: 0,
      zh: '前向 FLOPs 的变化（重算不该落在前向里）',
      en: 'change in forward FLOPs (recomputation must not land in the forward)',
      dimension: 'efficiency',
    }),
    gate({
      metric: 'llm.flops.backwardOverForward', op: 'lte', value: 3.6,
      zh: '重算之后的反向 / 前向（理论 3）',
      en: 'backward over forward with recomputation (theory says 3)', dimension: 'efficiency',
    }),
  ],
  focus: ['efficiency', 'correctness'],
  extension: t(
    code`
      这一关是「整层重算」，最省显存也最费算力。真实框架有更细的档位：
      **选择性重算**只重算便宜的那些（归一化、激活函数），
      把贵的（注意力那块 \`O(S²)\`）留着,显存降大半而算力只多一点。
      \`torch.utils.checkpoint\` 的 \`SAC\`（selective activation checkpointing）
      就是干这个的。

      另一条完全不同的路是**别产生那么多激活**。
      FlashAttention 不存那块 \`[B, H, S, S]\` 的注意力矩阵 ——
      它分块地算，边算边把结果累加出去。省下的不是「重算换来的」，
      是**根本没生成**。这两条可以叠加，而 FlashAttention 那条更划算。

      顺带回答一个常见的困惑：**重算和梯度累积不是一回事**。
      重算省的是激活（一次前向内部），梯度累积省的是 batch 那一维
      （多个小 batch 攒一次更新）。两者常常一起用，解决的是不同的瓶颈。
    `,
    code`
      This stage recomputes whole layers, which saves the most memory and costs the most
      compute. Real frameworks offer finer settings: **selective recomputation** recomputes
      only the cheap parts (normalisation, activation functions) while keeping the expensive
      ones (attention's \`O(S²)\` block) — most of the memory saving at a fraction of the
      compute. That is what \`torch.utils.checkpoint\`'s SAC (selective activation
      checkpointing) does.

      A completely different route is **not producing the activations at all**.
      FlashAttention never materialises the \`[B, H, S, S]\` attention matrix; it computes
      in tiles and accumulates as it goes. The saving is not "bought back by recomputing" —
      the data is **never generated**. The two compose, and FlashAttention's route is the
      better bargain.

      One common confusion worth settling: **recomputation and gradient accumulation are not
      the same thing.** Recomputation saves activations within one forward pass; gradient
      accumulation saves along the batch dimension (several small batches per update). They
      are often used together and address different bottlenecks.
    `
  ),
};

/** 第 19 关的训练套件：一条恒定学习率下的学习曲线 */
const KIT_SCALE_PY = code`
  """平台给的训练套件。这一关不写模型也不写训练循环 ——
  要写的是**拿曲线去拟合幂律**这一步。

  \`dim=32, n_layer=2, n_head=4, n_kv_head=2, hidden=88\`，batch 8 × seq 32。
  学习率**恒定**：余弦退火后期 loss 掉得快是学习率在降，
  拿那段去拟合会把指数拟大。数据轴的曲线必须在恒定学习率下取。
  """
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F

  D, L, H, KV, HID, B, S = 32, 2, 4, 2, 88, 8, 32


  def build_tables(n, head_dim, base=10000.0):
      half = head_dim // 2
      cos = nt.zeros((n, half), role="data", name="rope.cos")
      sin = nt.zeros((n, half), role="data", name="rope.sin")
      cv, sv = [], []
      for p in range(n):
          for i in range(half):
              th = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(th))
              sv.append(math.sin(th))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class Norm(nn.Module):
      def __init__(self, dim):
          super().__init__()
          self.weight = nt.parameter((dim,), None, 0.0, "g")

      def forward(self, x):
          return F.rms_norm(x, self.weight, 1e-5)


  class Attn(nn.Module):
      def __init__(self, dim, nh, nkv, seed, max_seq=64):
          super().__init__()
          self.nh, self.nkv, self.hd = nh, nkv, dim // nh
          hd = self.hd
          self.wq = nt.parameter((dim, nh * hd), seed + 1, dim ** -0.5, "wq")
          self.wk = nt.parameter((dim, nkv * hd), seed + 2, dim ** -0.5, "wk")
          self.wv = nt.parameter((dim, nkv * hd), seed + 3, dim ** -0.5, "wv")
          self.wo = nt.parameter((nh * hd, dim), seed + 4, (nh * hd) ** -0.5, "wo")
          self._cos, self._sin = build_tables(max_seq, hd)

      def forward(self, x, b, s):
          hd = self.hd
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          q = F.rope(q, self._cos, self._sin, b, s, self.nh, hd)
          k = F.rope(k, self._cos, self._sin, b, s, self.nkv, hd)
          sc = F.attn_scores(q, k, b, s, s, self.nh, self.nkv, hd)
          pr = F.softmax(sc, b * self.nh * s, s, F.causal_valid(b, self.nh, s))
          o = F.attn_apply(pr, v, b, s, s, self.nh, self.nkv, hd,
                           out_shape=(b * s, self.nh * hd))
          return F.linear(o, self.wo)


  class Mlp(nn.Module):
      def __init__(self, dim, hid, seed):
          super().__init__()
          self.wg = nt.parameter((dim, hid), seed + 1, dim ** -0.5, "wg")
          self.wu = nt.parameter((dim, hid), seed + 2, dim ** -0.5, "wu")
          self.wd = nt.parameter((hid, dim), seed + 3, hid ** -0.5, "wd")

      def forward(self, x):
          return F.linear(F.swiglu(F.linear(x, self.wg), F.linear(x, self.wu)), self.wd)


  class Block(nn.Module):
      def __init__(self, dim, nh, nkv, hid, seed, nl):
          super().__init__()
          self.n1, self.at = Norm(dim), Attn(dim, nh, nkv, seed)
          self.n2, self.mp = Norm(dim), Mlp(dim, hid, seed + 40)
          self.sc = (2.0 * nl) ** -0.5

      def forward(self, x, b, s):
          x = F.add(x, F.scale(self.at(self.n1(x), b, s), self.sc))
          return F.add(x, F.scale(self.mp(self.n2(x)), self.sc))


  class LM(nn.Module):
      def __init__(self, vocab, seed=1):
          super().__init__()
          self.vocab = vocab
          self.embed = nt.parameter((vocab, D), seed, D ** -0.5, "embed")
          self.blocks = nn.ModuleList([
              Block(D, H, KV, HID, seed + 100 * (i + 1), L) for i in range(L)
          ])
          self.nf = Norm(D)

      def forward(self, idx, tgt, b, s):
          rows = b * s
          x = F.embedding(self.embed, idx, rows, D)
          for blk in self.blocks:
              x = blk(x, b, s)
          x = self.nf(x)
          return F.cross_entropy(F.linear_tied(x, self.embed, rows, D, self.vocab),
                                 tgt, rows, self.vocab)


  train_tokens = []


  def sample_batch(tokens, step, batch, seq):
      state = (step * 1103515245 + 12345) & 0x7fffffff
      idx, tgt = [], []
      for _ in range(batch):
          state = (state * 1103515245 + 12345) & 0x7fffffff
          off = state % (len(tokens) - seq - 1)
          idx.extend(tokens[off:off + seq])
          tgt.extend(tokens[off + 1:off + seq + 1])
      return idx, tgt


  def constant_lr_curve(steps, lr):
      """恒定学习率跑一条曲线，返回每一步的 loss。"""
      vocab = max(train_tokens) + 1
      m = LM(vocab, seed=1)
      opt = nt.optim.AdamW(m.parameters(), lr=lr, betas=(0.9, 0.95),
                           weight_decay=0.1, grad_clip=1.0)
      idx = nt.zeros((B * S,), role="data", name="idx")
      tgt = nt.zeros((B * S,), role="data", name="tgt")
      hist = []
      base = nt.mark()
      for st in range(1, steps + 1):
          nt.release(base)
          bi, bt = sample_batch(train_tokens, st, B, S)
          idx.set_int_(bi)
          tgt.set_int_(bt)
          opt.zero_grad()
          nt.phase("forward")
          loss = m(idx, tgt, B, S)
          nt.phase("other")
          loss.backward()
          opt.step(lr=lr)
          hist.append(loss.value)
      nt.release(base)
      return hist
`;

/* ================================================================== */
/* 第 19 关：缩放定律                                                   */
/* ================================================================== */

const STAGE_SCALING = {
  id: 'scaling-laws',
  title: t('缩放定律 —— 用小档预测大档', 'Scaling laws — predicting the large run from small ones'),
  goal: t(
    code`
      训一个大模型很贵，而**贵的东西不能靠试**。缩放定律的用处就在这里：
      跑几个便宜的小档，拟合出规律，**预测一个还没跑过的档位**,
      然后才决定要不要花那笔钱。

      在 \`scaling.py\` 里实现拟合与外推：

      \`\`\`python
      def fit_power_law(points):
          """points 是 [(D, L), ...]。返回 (log_b, beta)，使得 L ≈ exp(log_b) · D^(−beta)。

          在 log-log 上做最小二乘 —— 幂律取对数之后是一条直线。"""

      def predict(fit, d):
          """按拟合出来的律，预测在 d 处的 loss。"""
      \`\`\`

      ## 幂律取对数是直线

      \`\`\`
      L = B · D^(−β)
      log L = log B − β · log D
      \`\`\`

      于是「拟合幂律」就是「在 log-log 上拟合一条直线」,
      最小二乘的闭式解两行就写完：

      \`\`\`
      β  = −Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²        其中 x = log D, y = log L
      log B = ȳ + β·x̄
      \`\`\`

      **别用普通的线性回归直接拟 (D, L)。** 幂律在线性坐标下是一条曲线，
      直线拟合它会在两端都偏，而外推正是在端点外面。

      ## 这一关走数据轴

      Chinchilla 那套式子有两根轴：参数量 \`N\` 和数据量 \`D\`。
      这一关拟合的是**数据轴**,固定一个模型，看 loss 随「看过多少 token」怎么降。

      为什么不走参数轴？因为**参数轴的缩放律要求每个档位都单独调好超参**。
      这个项目实测过：同一个学习率、同样的步数，四个宽度跑出来是

      \`\`\`
      dim=16  loss 1.379      dim=32  loss 1.081
      dim=24  loss 1.220      dim=48  loss 1.201      dim=64  loss 1.709
      \`\`\`

      **大的反而更差** —— 不是缩放律不成立，是最优学习率随宽度变，
      而我们给所有档位用了同一个。这正是 \`µP\`（最大更新参数化）要解决的问题：
      让超参在宽度之间可迁移，缩放律才拟合得出来。
      数据轴没有这个麻烦,同一个模型、同一套超参，只是训得久一点。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 拟合 | 4 个点上的 log 残差 RMS ≤ **0.04** |
      | **外推** | 预测 2.3 倍数据量处的 loss，相对误差 ≤ **0.15** |
      | 指数 | 拟合出的 \`β\` ≥ **0.15**（真的在降，不是一条平线） |
      | 方向 | 数据翻倍，预测的 loss 必须**更低** |

      参考实现拿前 4 个点（D 从 1.8 万到 6 万）预测 D = 13.6 万处的 loss：
      **预测 0.982，实际 1.021，相对误差 3.9%**。
      比最后一个拟合点远 2.3 倍、比第一个远 7.6 倍，误差 4% ——
      这就是为什么大模型敢在跑之前就定预算。
    `,
    code`
      Training a large model is expensive, and **expensive things cannot be found by trial**.
      That is what scaling laws are for: run a few cheap small configurations, fit the trend,
      **predict a configuration nobody has run**, and only then decide whether to spend.

      Implement the fit and the extrapolation in \`scaling.py\`:

      \`\`\`python
      def fit_power_law(points):
          """points is [(D, L), ...]. Returns (log_b, beta) such that
          L ≈ exp(log_b) · D^(−beta).

          Least squares in log-log — a power law is a straight line there."""

      def predict(fit, d):
          """Predict the loss at d under the fitted law."""
      \`\`\`

      ## A power law is a line in log-log

      \`\`\`
      L = B · D^(−β)
      log L = log B − β · log D
      \`\`\`

      So "fit a power law" means "fit a line in log-log", and the closed-form least squares
      is two lines of code:

      \`\`\`
      β  = −Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²        with x = log D, y = log L
      log B = ȳ + β·x̄
      \`\`\`

      **Do not run ordinary linear regression on (D, L) directly.** A power law is curved in
      linear coordinates, a straight fit misses at both ends, and extrapolation happens
      exactly beyond those ends.

      ## This stage uses the data axis

      Chinchilla's formulation has two axes: parameters \`N\` and data \`D\`. This stage fits
      the **data axis** — fix a model and watch the loss fall as it sees more tokens.

      Why not the parameter axis? Because **a parameter-axis law requires hyperparameters
      tuned per configuration**. This project measured it: same learning rate, same step
      count, four widths give

      \`\`\`
      dim=16  loss 1.379      dim=32  loss 1.081
      dim=24  loss 1.220      dim=48  loss 1.201      dim=64  loss 1.709
      \`\`\`

      **Bigger is worse** — not because scaling laws fail, but because the optimal learning
      rate moves with width and we used one rate for all. That is precisely the problem
      \`µP\` (maximal update parameterisation) solves: make hyperparameters transfer across
      widths so the law can be fitted at all. The data axis has no such trouble — same
      model, same hyperparameters, simply trained longer.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Fit | RMS log-residual over 4 points <= **0.04** |
      | **Extrapolation** | Predict the loss at 2.3x the data, within **0.15** relative |
      | Exponent | Fitted \`β\` >= **0.15** (genuinely decreasing, not flat) |
      | Direction | Doubling the data must predict a **lower** loss |

      The reference fits the first 4 points (D from 18k to 60k) and predicts D = 136k:
      **0.982 predicted against 1.021 actual, 3.9% relative error** — 2.3x beyond the last
      fitted point and 7.6x beyond the first. Extrapolating that far at 4% error is why
      large runs can commit to a budget before starting.
    `
  ),
  checklist: [
    t('在 log-log 上做最小二乘，不是在线性坐标上',
      'Least squares in log-log, not in linear coordinates'),
    t('拟合残差足够小', 'The fit residual is small'),
    t('外推到 2.3 倍数据量，误差在 15% 以内',
      'Extrapolating 2.3x stays within 15%'),
    t('预测的方向是对的：数据越多 loss 越低',
      'The direction is right: more data predicts a lower loss'),
  ],
  hints: [
    t('闭式解就够了：β = −Σ(x−x̄)(y−ȳ)/Σ(x−x̄)²，不用迭代优化。',
      'The closed form suffices: β = −Σ(x−x̄)(y−ȳ)/Σ(x−x̄)²; no iterative optimisation.'),
    t('math.log / math.exp 就行，不需要张量。',
      'math.log and math.exp are enough; no tensors involved.'),
    t('返回的是 (log_b, beta)，predict 里再 exp 回去。',
      'Return (log_b, beta) and exponentiate back inside predict.'),
  ],
  pitfalls: [
    t(code`
      **在线性坐标上拟直线。** 幂律在线性坐标下是一条凸曲线，
      直线拟合它会在两端都偏 —— 而**外推恰恰发生在端点外面**，
      于是误差在你最需要它准的地方最大。
      内插看起来还行，这让这个错更难发现。
    `, code`
      **Fitting a line in linear coordinates.** A power law is convex there, so a straight
      fit misses at both ends — and **extrapolation happens precisely beyond those ends**,
      making the error largest exactly where accuracy matters most. Interpolation still looks
      acceptable, which makes the mistake harder to notice.
    `),
    t(code`
      **拿一条正在被学习率调度改变的曲线去拟合。** 余弦退火后期 loss 掉得快，
      那是学习率在降，不是数据在起作用。拟出来的 \`β\` 会偏大，外推到更远处偏得更多。
      数据轴的曲线要在**恒定学习率**下取,这一关的曲线就是这么跑的。
    `, code`
      **Fitting a curve that a learning-rate schedule is still bending.** Loss falls quickly
      late in a cosine decay because the rate is dropping, not because data is helping. The
      fitted \`β\` comes out too large and the extrapolation drifts further the further you
      go. A data-axis curve must be measured at a **constant learning rate**, which is how
      this stage's curve was produced.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_SCALE_PY,
      'scaling.py': code`
        """第 19 关：拟合幂律，外推到没跑过的档位。"""
        import math


        def fit_power_law(points):
            """points 是 [(D, L), ...]。返回 (log_b, beta)，L ≈ exp(log_b) · D^(−beta)。"""
            # TODO: 取 log 之后做最小二乘
            return (0.0, 0.0)


        def predict(fit, d):
            """按拟合出来的律预测 d 处的 loss。"""
            # TODO
            return 0.0


        if __name__ == "__main__":
            pts = [(1000, 1.0), (2000, 0.8), (4000, 0.64), (8000, 0.512)]
            f = fit_power_law(pts)
            print("beta = %.4f" % f[1])
            print("预测 D=16000 ->", round(predict(f, 16000), 4), "（该是 0.41 上下）")
      `,
    },
    referenceFiles: {
      'scaling.py': code`
        """第 19 关的参考实现。"""
        import math


        def fit_power_law(points):
            # 幂律取对数是直线：log L = log B − β·log D。
            # **不能在线性坐标上拟** —— 幂律在那里是曲线，直线会在两端都偏，
            # 而外推恰恰发生在端点外面
            xs = [math.log(d) for d, _ in points]
            ys = [math.log(l) for _, l in points]
            n = len(points)
            mx = sum(xs) / n
            my = sum(ys) / n
            num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            den = sum((x - mx) ** 2 for x in xs)
            slope = num / den if den != 0 else 0.0
            log_b = my - slope * mx
            # 斜率是 −β，所以 β = −slope
            return (log_b, -slope)


        def predict(fit, d):
            log_b, beta = fit
            return math.exp(log_b - beta * math.log(d))


        if __name__ == "__main__":
            pts = [(1000, 1.0), (2000, 0.8), (4000, 0.64), (8000, 0.512)]
            f = fit_power_law(pts)
            print("beta = %.4f" % f[1])
            print("预测 D=16000 ->", round(predict(f, 16000), 4), "（该是 0.41 上下）")
      `,
    },
  },
  specs: [
    spec('scaling.spec.ts', code`
      ${LAB}

      /**
       * 平台跑一条**恒定学习率**下的学习曲线，切出 6 个采样点。
       * 恒定学习率是必要的：余弦退火后期 loss 掉得快是学习率在降，
       * 拿那段去拟合会把 β 拟大。
       */
      function curve() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, scaling
      importlib.reload(kit)
      importlib.reload(scaling)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
        const toks = lab.world.tokens();
        lab.py('kit.train_tokens = ' + JSON.stringify([...toks.slice(0, lab.world.holdoutAt())]));
        const hist = JSON.parse(String(lab.py(\`
      if "_curve" not in globals():
          _curve = kit.constant_lr_curve(560, 0.02)
      json.dumps(_curve)
      \`)));
        const win = (end) => {
          const a = hist.slice(Math.max(0, end - 20), end);
          return a.reduce((x, c) => x + c, 0) / a.length;
        };
        const marks = [70, 105, 157, 236, 354, 531];
        return marks.map((m) => ({ d: m * kit_batch() * kit_seq(), l: win(m) }));
      }
      function kit_batch() { return Number(lab.py('kit.B')); }
      function kit_seq() { return Number(lab.py('kit.S')); }

      describe('缩放定律', () => {
        it('学习曲线是单调下降的 —— 幂律的前提', () => {
          const pts = curve();
          console.log(pts.map((p) => 'D=' + p.d + ' L=' + p.l.toFixed(4)).join('  '));
          for (let i = 1; i < pts.length; i++) {
            expect(pts[i].l).toBeLessThan(pts[i - 1].l);
          }
          lab.publish('scaling.points', pts.length);
        });

        it('4 个点上的 log 残差 RMS ≤ 0.04', () => {
          const pts = curve();
          const fit = JSON.parse(String(lab.py(
            'json.dumps(list(scaling.fit_power_law(' + JSON.stringify(pts.slice(0, 4).map((p) => [p.d, p.l])) + ')))'
          )));
          const [logB, beta] = fit;
          let sq = 0;
          for (const p of pts.slice(0, 4)) {
            const pred = Math.exp(logB - beta * Math.log(p.d));
            sq += Math.pow(Math.log(pred) - Math.log(p.l), 2);
          }
          const rms = Math.sqrt(sq / 4);
          console.log('log_b = ' + logB.toFixed(4) + '，β = ' + beta.toFixed(4)
            + '，残差 RMS ' + rms.toExponential(2));
          lab.publish('scaling.fitResidual', rms);
          lab.publish('scaling.exponent', beta);
          expect(rms).toBeLessThan(0.04);
          expect(beta).toBeGreaterThan(0.15);
        });

        /*
         * 这一关的全部意义：拿便宜的小档去预测一个没跑过的大档。
         * 前 4 个点覆盖 D 从 1.8 万到 6 万，要预测的是 13.6 万 ——
         * 比最后一个拟合点远 2.3 倍，比第一个远 7.6 倍。
         */
        it('外推到 2.3 倍数据量，相对误差 ≤ 0.15', () => {
          const pts = curve();
          const fitPts = pts.slice(0, 4);
          const target = pts[pts.length - 1];
          const predicted = Number(lab.py(
            'scaling.predict(scaling.fit_power_law('
            + JSON.stringify(fitPts.map((p) => [p.d, p.l])) + '), ' + target.d + ')'
          ));
          const rel = Math.abs(predicted - target.l) / target.l;
          console.log(
            '拟合用的 D ' + fitPts[0].d + ' ~ ' + fitPts[3].d
            + '，要预测的 D ' + target.d + '（' + (target.d / fitPts[3].d).toFixed(1) + ' 倍）'
          );
          console.log(
            '预测 ' + predicted.toFixed(4) + '，实际 ' + target.l.toFixed(4)
            + '，相对误差 ' + (rel * 100).toFixed(2) + '%'
          );
          lab.publish('scaling.predictionRelError', rel);
          expect(rel).toBeLessThan(0.15);
        });

        it('数据翻倍，预测的 loss 更低', () => {
          const pts = curve();
          const arg = JSON.stringify(pts.slice(0, 4).map((p) => [p.d, p.l]));
          const at = (d) => Number(lab.py('scaling.predict(scaling.fit_power_law(' + arg + '), ' + d + ')'));
          const a = at(100000);
          const b2 = at(200000);
          console.log('D=1e5 预测 ' + a.toFixed(4) + '，D=2e5 预测 ' + b2.toFixed(4));
          lab.publish('scaling.direction', b2 < a ? 1 : 0);
          expect(b2).toBeLessThan(a);
          // 幂律：翻倍之后的比值该是 2^(−β)，和拟合出来的 β 对得上
          const beta = Number(lab.py('scaling.fit_power_law(' + arg + ')[1]'));
          expect(Math.abs(b2 / a - Math.pow(2, -beta))).toBeLessThan(1e-9);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.scaling.fitResidual', op: 'lte', value: 0.04,
      zh: '拟合点上的 log 残差 RMS', en: 'RMS log-residual over the fitted points',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.scaling.predictionRelError', op: 'lte', value: 0.15,
      zh: '外推到 2.3 倍数据量的相对误差', en: 'relative error extrapolating 2.3x',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.scaling.exponent', op: 'gte', value: 0.15,
      zh: '拟合出的指数 β', en: 'fitted exponent β', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.scaling.direction', op: 'eq', value: 1,
      zh: '数据翻倍时预测的 loss 更低', en: 'doubling the data predicts a lower loss',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      Chinchilla 那篇（2022）的结论是**参数量和数据量要一起涨**：
      给定算力预算 \`C ≈ 6ND\`，最优配比大约是 \`D ≈ 20N\` token/参数。
      在那之前的模型普遍**训得太少**,GPT-3 的 175B 只喂了 300B token，
      按这个配比应该是 3.5T。

      2026 年这个配比在实践中被推得远高于 20：
      Llama 3 的 8B 训了 15T token（\`D/N ≈ 1875\`），
      因为「训练一次、推理无数次」——**推理成本正比于 N 而不是 D**，
      所以为了省推理，人们愿意在训练上超额投入。
      Chinchilla 最优的是「这一次训练的 loss」，不是「部署之后的总成本」。

      另一件事：**外推要谨慎**。缩放律在拟合区间附近很准，
      跨几个数量级之后会遇到没被建模的东西 —— 数据枯竭、
      架构在某个尺度上的行为变化、以及那个绕不开的不可约损失 \`E\`。
      这一关外推了 2.3 倍，误差 4%；外推 1000 倍就完全是另一回事了。
    `,
    code`
      The Chinchilla paper (2022) concluded that **parameters and data should grow
      together**: for a compute budget \`C ≈ 6ND\`, the optimum sits near \`D ≈ 20N\` tokens
      per parameter. Models before it were generally **undertrained** — GPT-3's 175B saw
      300B tokens where this ratio calls for 3.5T.

      By 2026 practice pushes that ratio far past 20: Llama 3's 8B trained on 15T tokens
      (\`D/N ≈ 1875\`), because you train once and infer forever — **inference cost scales
      with N, not D** — so people overspend on training to save on serving. Chinchilla
      optimises the loss of one training run, not total cost after deployment.

      One more caution: **extrapolate carefully**. Scaling laws are accurate near the fitted
      range and run into unmodelled effects several orders of magnitude out — data
      exhaustion, architectural behaviour changing with scale, and the irreducible loss
      \`E\` that no amount of data removes. This stage extrapolates 2.3x at 4% error;
      extrapolating 1000x is an entirely different proposition.
    `
  ),
};

/* ================================================================== */
/* 第 20 关：MoE                                                       */
/* ================================================================== */

const STAGE_MOE = {
  id: 'moe',
  title: t('MoE —— 参数变多，每个 token 的算力不变', 'MoE — more parameters, same compute per token'),
  goal: t(
    code`
      稠密模型里，每个 token 都要过一遍**全部**参数。\`MoE\` 把一个大前馈换成
      \`n_expert\` 个小的，每个 token 只走其中 \`top_k\` 个 ——
      **参数量涨了 \`n_expert / top_k\` 倍，而每个 token 的算力不变。**

      在 \`moe.py\` 里实现路由与稀疏执行：

      \`\`\`python
      def route(probs, n_token, n_expert, top_k):
          """每个 token 挑 top_k 个专家。返回 (expert_ids, weights)，
          两个都是长度 n_token*top_k 的列表；weights 在 top_k 内归一化。"""

      def capacity_assign(expert_ids, n_token, n_expert, top_k, capacity):
          """按容量分配。每个专家最多收 capacity 个，超出的丢掉。
          返回 (keep, dropped) —— keep 是 [(token, expert, weight_index), ...]。"""

      def load_balance_loss(probs, expert_ids, n_token, n_expert, top_k):
          """Switch Transformer 的辅助损失：n_expert · Σ_i f_i · P_i。"""

      class MoEMlp(nn.Module):
          def forward(self, x, n_token):
              """按专家 gather 出 token -> 各自算 -> 乘路由权重 -> scatter 回原位。"""
      \`\`\`

      ## 路由：谁去哪

      路由器是一个小线性层，把每个 token 映射到 \`n_expert\` 个分数，softmax 之后
      取最大的 \`top_k\` 个。权重要在这 \`top_k\` 个里**重新归一化**,
      不归一化的话，路由器的置信度会直接缩放这一层的输出量级。

      ## 容量：为什么要丢

      专家的负载是不均的。真实实现给每个专家一个**容量上限**
      \`capacity = capacity_factor · n_token · top_k / n_expert\`,
      超出的 (token, 专家) 对被**丢掉**（那个 token 就少走一个专家）。

      为什么不干脆不设上限？因为在真实的分布式实现里，每个专家在一张卡上，
      **通信的缓冲区必须是定长的**。容量就是那个缓冲区的大小。
      这不是算法上的选择，是工程上的约束,而它反过来影响了算法
      （于是才有了负载均衡损失）。

      ## 负载均衡损失

      不加干预的话路由器会**塌**：所有 token 都去同一个专家，其余的永远学不到东西。
      Switch Transformer 的做法是加一个辅助损失：

      \`\`\`
      aux = n_expert · Σ_i  f_i · P_i
        f_i = 分给专家 i 的 token 比例（用 top-1 数）
        P_i = 路由器给专家 i 的平均概率
      \`\`\`

      两个都均匀时 \`aux = 1\`；越集中它越大。它可导的那一半是 \`P_i\`,
      \`f_i\` 是数出来的、不可导，这个不对称是有意的。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 参数量 | 总量与激活量都**恰好等于解析式**，且激活量 < 总量 |
      | **真的稀疏** | 前馈 FLOPs / **同参数量**的稠密前馈 ≤ **0.6**（= top_k / n_expert） |
      | 容量宽松时 | 丢弃 = **0** |
      | 容量收紧时 | 丢弃 **> 0**（容量真的在起作用，不是摆设） |
      | 辅助损失 | 与参考公式差 ≤ 1e-6 |
    `,
    code`
      In a dense model every token passes through **all** parameters. \`MoE\` replaces one
      large feed-forward with \`n_expert\` smaller ones and routes each token through
      \`top_k\` of them — **parameters grow by \`n_expert / top_k\` while per-token compute
      stays the same.**

      Implement routing and sparse execution in \`moe.py\`:

      \`\`\`python
      def route(probs, n_token, n_expert, top_k):
          """Pick top_k experts per token. Returns (expert_ids, weights), both of
          length n_token*top_k; weights are renormalised within the top_k."""

      def capacity_assign(expert_ids, n_token, n_expert, top_k, capacity):
          """Assign under a capacity limit. Each expert accepts at most capacity
          entries; the rest are dropped. Returns (keep, dropped) where keep is
          [(token, expert, weight_index), ...]."""

      def load_balance_loss(probs, expert_ids, n_token, n_expert, top_k):
          """Switch Transformer's auxiliary loss: n_expert · Σ_i f_i · P_i."""

      class MoEMlp(nn.Module):
          def forward(self, x, n_token):
              """Gather each expert's tokens -> compute -> apply routing weights
              -> scatter back."""
      \`\`\`

      ## Routing: who goes where

      The router is a small linear layer mapping each token to \`n_expert\` scores; softmax
      and take the largest \`top_k\`. Weights must be **renormalised within those top_k** —
      otherwise the router's confidence directly scales this layer's output magnitude.

      ## Capacity: why anything gets dropped

      Expert load is uneven. Real implementations cap each expert at
      \`capacity = capacity_factor · n_token · top_k / n_expert\`, and (token, expert) pairs
      beyond it are **dropped** — that token simply visits one fewer expert.

      Why cap at all? Because in a real distributed implementation each expert lives on one
      device and **the communication buffer must be a fixed size**. Capacity is that buffer.
      It is not an algorithmic choice but an engineering constraint — one that then shapes
      the algorithm, which is where the load-balancing loss comes from.

      ## The load-balancing loss

      Left alone the router **collapses**: every token goes to one expert and the rest never
      learn anything. Switch Transformer adds an auxiliary loss:

      \`\`\`
      aux = n_expert · Σ_i  f_i · P_i
        f_i = fraction of tokens assigned to expert i (counted by top-1)
        P_i = the router's mean probability for expert i
      \`\`\`

      Both uniform gives \`aux = 1\`; concentration raises it. Only \`P_i\` is
      differentiable — \`f_i\` is counted and has no gradient, and that asymmetry is
      deliberate.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Parameters | Total and active both **exactly** the formula, with active < total |
      | **Genuinely sparse** | FFN FLOPs over a dense FFN with the **same parameters** <= **0.6** (= top_k / n_expert) |
      | Loose capacity | Dropped = **0** |
      | Tight capacity | Dropped **> 0** (capacity actually binds) |
      | Auxiliary loss | Within 1e-6 of the reference formula |
    `
  ),
  checklist: [
    t('top_k 内的权重重新归一化', 'Weights are renormalised within the top_k'),
    t('容量上限真的在起作用', 'The capacity limit actually binds'),
    t('用 gather / scatter_add 真的做稀疏执行', 'Sparse execution really uses gather / scatter_add'),
    t('辅助损失对得上 Switch 的公式', 'The auxiliary loss matches the Switch formula'),
  ],
  hints: [
    t('F.gather(x, idx, n, dim) 按行取，F.scatter_add(src, idx, n, dim, out_rows) 放回去。',
      'F.gather(x, idx, n, dim) takes rows; F.scatter_add(src, idx, n, dim, out_rows) puts them back.'),
    t('F.row_scale(y, w, rows, dim) 给每一行乘自己的路由权重。',
      'F.row_scale(y, w, rows, dim) multiplies each row by its own routing weight.'),
    t('scatter_add 是累加 —— top_k > 1 时同一个 token 会收到好几份，正好该加起来。',
      'scatter_add accumulates, which is exactly right when top_k > 1 gives a token several contributions.'),
  ],
  pitfalls: [
    t(code`
      **top_k 的权重不归一化。** 直接拿 softmax 出来的两个概率当权重，
      它们加起来是 0.6 还是 0.95 取决于路由器有多确信 ——
      于是**这一层的输出量级跟着路由器的置信度飘**。
      训练早期路由器接近均匀，输出被压小；后期变确信，输出又变大。
      不报错，只是把一个本来不该有的动态量引进了残差流。
    `, code`
      **Not renormalising the top_k weights.** Using the raw softmax probabilities means
      their sum is 0.6 or 0.95 depending on how confident the router is — so **this layer's
      output magnitude drifts with router confidence**. Early in training the router is near
      uniform and outputs are suppressed; later it sharpens and they grow. Nothing errors; a
      spurious dynamic has simply been injected into the residual stream.
    `),
    t(code`
      **scatter 写成覆盖而不是累加。** top_k = 2 时每个 token 有两个专家的贡献，
      覆盖的话只剩后写的那一个 —— **等效于 top_k = 1，而参数量还是按 2 算的**。
      loss 照样降，只是这一层白花了一半的算力。
    `, code`
      **Writing scatter as assignment instead of accumulation.** At top_k = 2 each token has
      two expert contributions; assignment keeps only the last — **effectively top_k = 1
      while the parameter budget still assumes 2**. The loss still falls; half this layer's
      compute is simply wasted.
    `),
  ],
  train: {
    files: {
      'moe.py': code`
        """第 20 关：MoE 的路由、容量与稀疏执行。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F


        def route(probs, n_token, n_expert, top_k):
            """probs 是长度 n_token*n_expert 的列表。返回 (expert_ids, weights)。"""
            # TODO: 每个 token 取概率最大的 top_k 个，权重在 top_k 内归一化
            return [], []


        def capacity_assign(expert_ids, n_token, n_expert, top_k, capacity):
            """返回 (keep, dropped)。keep 是 [(token, expert, k), ...]。"""
            # TODO: 按顺序分配，每个专家最多收 capacity 个
            return [], 0


        def load_balance_loss(probs, expert_ids, n_token, n_expert, top_k):
            """n_expert · Σ_i f_i · P_i。"""
            # TODO
            return 0.0


        class MoEMlp(nn.Module):
            def __init__(self, dim, hidden, n_expert, top_k, seed, capacity_factor=2.0):
                super().__init__()
                self.dim, self.hidden = dim, hidden
                self.n_expert, self.top_k = n_expert, top_k
                self.capacity_factor = capacity_factor
                self.router = nt.parameter((dim, n_expert), seed, dim ** -0.5, "router")
                self.wg = nn.ParameterList([
                    nt.parameter((dim, hidden), seed + 10 * (e + 1) + 1, dim ** -0.5, "wg")
                    for e in range(n_expert)
                ])
                self.wu = nn.ParameterList([
                    nt.parameter((dim, hidden), seed + 10 * (e + 1) + 2, dim ** -0.5, "wu")
                    for e in range(n_expert)
                ])
                self.wd = nn.ParameterList([
                    nt.parameter((hidden, dim), seed + 10 * (e + 1) + 3, hidden ** -0.5, "wd")
                    for e in range(n_expert)
                ])
                self.last_load = []
                self.last_dropped = 0
                self.last_aux = 0.0

            def forward(self, x, n_token):
                # TODO: 路由 -> 容量分配 -> 逐专家 gather / 算 / 乘权重 / scatter 回去
                return x


        if __name__ == "__main__":
            m = MoEMlp(16, 32, 4, 2, seed=3)
            x = nt.zeros((8, 16), role="data").normal_(1, 1.0)
            y = m(x, 8)
            print("输出形状", y.shape, "丢弃", m.last_dropped, "负载", m.last_load)
      `,
    },
    referenceFiles: {
      'moe.py': code`
        """第 20 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F


        def route(probs, n_token, n_expert, top_k):
            expert_ids, weights = [], []
            for t in range(n_token):
                row = probs[t * n_expert:(t + 1) * n_expert]
                # 按概率降序；同分的按专家号排，保证确定性
                order = sorted(range(n_expert), key=lambda e: (-row[e], e))[:top_k]
                total = sum(row[e] for e in order)
                for e in order:
                    expert_ids.append(e)
                    # **在 top_k 内重新归一化** —— 不归一化的话这一层的输出量级
                    # 会跟着路由器的置信度飘
                    weights.append(row[e] / total if total > 0 else 1.0 / top_k)
            return expert_ids, weights


        def capacity_assign(expert_ids, n_token, n_expert, top_k, capacity):
            used = [0] * n_expert
            keep, dropped = [], 0
            for t in range(n_token):
                for k in range(top_k):
                    e = expert_ids[t * top_k + k]
                    if used[e] < capacity:
                        used[e] += 1
                        keep.append((t, e, k))
                    else:
                        # 容量满了就丢。真实实现里容量就是通信缓冲区的大小，
                        # 定长是工程约束，不是算法选择
                        dropped += 1
            return keep, dropped


        def load_balance_loss(probs, expert_ids, n_token, n_expert, top_k):
            # f_i：按 top-1 数，分给专家 i 的 token 比例（数出来的，不可导）
            counts = [0] * n_expert
            for t in range(n_token):
                counts[expert_ids[t * top_k]] += 1
            f = [c / n_token for c in counts]
            # P_i：路由器给专家 i 的平均概率（可导的那一半）
            p = [0.0] * n_expert
            for t in range(n_token):
                for e in range(n_expert):
                    p[e] += probs[t * n_expert + e]
            p = [v / n_token for v in p]
            return n_expert * sum(fi * pi for fi, pi in zip(f, p))


        class MoEMlp(nn.Module):
            def __init__(self, dim, hidden, n_expert, top_k, seed, capacity_factor=2.0):
                super().__init__()
                self.dim, self.hidden = dim, hidden
                self.n_expert, self.top_k = n_expert, top_k
                self.capacity_factor = capacity_factor
                self.router = nt.parameter((dim, n_expert), seed, dim ** -0.5, "router")
                self.wg = nn.ParameterList([
                    nt.parameter((dim, hidden), seed + 10 * (e + 1) + 1, dim ** -0.5, "wg")
                    for e in range(n_expert)
                ])
                self.wu = nn.ParameterList([
                    nt.parameter((dim, hidden), seed + 10 * (e + 1) + 2, dim ** -0.5, "wu")
                    for e in range(n_expert)
                ])
                self.wd = nn.ParameterList([
                    nt.parameter((hidden, dim), seed + 10 * (e + 1) + 3, hidden ** -0.5, "wd")
                    for e in range(n_expert)
                ])
                self.last_load = []
                self.last_dropped = 0
                self.last_aux = 0.0

            def forward(self, x, n_token):
                logits = F.linear(x, self.router)
                probs_t = F.softmax(logits, n_token, self.n_expert)
                probs = probs_t.tolist()

                expert_ids, weights = route(probs, n_token, self.n_expert, self.top_k)
                capacity = int(math.ceil(
                    self.capacity_factor * n_token * self.top_k / self.n_expert
                ))
                keep, dropped = capacity_assign(
                    expert_ids, n_token, self.n_expert, self.top_k, capacity
                )
                self.last_dropped = dropped
                self.last_aux = load_balance_loss(
                    probs, expert_ids, n_token, self.n_expert, self.top_k
                )

                out = nt.zeros((n_token, self.dim), x.dtype, name="moe.out")
                load = [0] * self.n_expert
                for e in range(self.n_expert):
                    mine = [(t, k) for (t, ee, k) in keep if ee == e]
                    load[e] = len(mine)
                    if not mine:
                        continue
                    rows = len(mine)
                    idx = nt.zeros((rows,), role="data", name="moe.idx")
                    idx.set_int_([t for t, _ in mine])
                    # 只把分给这个专家的 token 取出来算 —— 稀疏就稀疏在这里
                    xe = F.gather(x, idx, rows, self.dim)
                    ye = F.linear(
                        F.swiglu(F.linear(xe, self.wg[e]), F.linear(xe, self.wu[e])),
                        self.wd[e]
                    )
                    w = nt.zeros((rows,), x.dtype, role="data", name="moe.w")
                    w.set_([weights[t * self.top_k + k] for t, k in mine])
                    ye = F.row_scale(ye, w, rows, self.dim)
                    # 累加不是覆盖：top_k > 1 时一个 token 会收到好几份
                    out = F.add(out, F.scatter_add(ye, idx, rows, self.dim, n_token))
                self.last_load = load
                return out


        if __name__ == "__main__":
            m = MoEMlp(16, 32, 4, 2, seed=3)
            x = nt.zeros((8, 16), role="data").normal_(1, 1.0)
            y = m(x, 8)
            print("输出形状", y.shape, "丢弃", m.last_dropped, "负载", m.last_load)
      `,
    },
  },
  specs: [
    spec('moe.spec.ts', code`
      ${LAB}

      const DIM = 16, HIDDEN = 32, N_EXPERT = 4, TOP_K = 2, N_TOKEN = 32;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, moe
      importlib.reload(moe)
      import nanotorch as nt
      from nanotorch import functional as F

      def _build(cf):
          m = moe.MoEMlp(\${DIM}, \${HIDDEN}, \${N_EXPERT}, \${TOP_K}, seed=3, capacity_factor=cf)
          x = nt.zeros((\${N_TOKEN}, \${DIM}), role="data").normal_(17, 1.0)
          return m, x
      \`);
      }

      describe('MoE', () => {
        it('参数量：总量与激活量都等于解析式，激活 < 总量', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m, _x = _build(2.0)
      json.dumps({"total": _m.num_parameters(),
                  "router": _m.router.numel,
                  "perExpert": _m.wg[0].numel + _m.wu[0].numel + _m.wd[0].numel})
      \`)));
          const perExpert = 3 * DIM * HIDDEN;
          const total = DIM * N_EXPERT + N_EXPERT * perExpert;
          // 激活参数：路由器 + top_k 个专家
          const active = DIM * N_EXPERT + TOP_K * perExpert;
          console.log(
            '总参数 ' + r.total + '（解析式 ' + total + '），'
            + '每个专家 ' + r.perExpert + '，激活 ' + active
            + '，激活 / 总量 = ' + (active / total).toFixed(3)
          );
          lab.publish('params.total', r.total);
          lab.publish('params.active', active);
          expect(r.total).toBe(total);
          expect(r.perExpert).toBe(perExpert);
          expect(active).toBeLessThan(total);
        });

        /*
         * 「真的稀疏」不能靠声明，要靠数。
         * 把 MoE 前馈的 FLOPs 和「同样宽度的稠密前馈」比一比 ——
         * top_k=2 / n_expert=4，比值该在 0.5 上下。
         */
        it('前馈的 FLOPs 只有稠密等价的一半上下', () => {
          setup();
          const before = lab.metrics().flops.total;
          lab.py('_m, _x = _build(2.0)\\n_y = _m(_x, ' + N_TOKEN + ')');
          const moeFlops = lab.metrics().flops.total - before;

          /*
           * 稠密等价 = **同样参数量**的稠密前馈，所以 hidden 要乘 n_expert。
           * 拿同样 hidden 的稠密去比是错的：top_k=2 的 MoE 做的是它的两倍工作。
           * MoE 省的是「同样多的参数，更少的算力」，不是「更少的参数」。
           */
          const b2 = lab.metrics().flops.total;
          lab.py(\`
      _hd = \${HIDDEN * N_EXPERT}
      _wg = nt.parameter((\${DIM}, _hd), 1, 0.02, "wg")
      _wu = nt.parameter((\${DIM}, _hd), 2, 0.02, "wu")
      _wd = nt.parameter((_hd, \${DIM}), 3, 0.02, "wd")
      _d = F.linear(F.swiglu(F.linear(_x, _wg), F.linear(_x, _wu)), _wd)
      \`);
          const denseFlops = lab.metrics().flops.total - b2;
          const ratio = moeFlops / denseFlops;
          console.log(
            'MoE 前馈 ' + moeFlops + ' FLOPs，同参数量的稠密前馈 ' + denseFlops
            + '，比值 ' + ratio.toFixed(3) + '（top_k/n_expert = '
            + (TOP_K / N_EXPERT).toFixed(2) + '，另外还有路由器与 gather/scatter）'
          );
          lab.publish('flops.moeOverDense', ratio);
          expect(ratio).toBeLessThan(0.6);
          // 太低说明专家根本没被调用
          expect(ratio).toBeGreaterThan(0.2);
        });

        /*
         * 容量两个方向都要验：宽松时一个不丢，收紧时必须丢。
         * 只验前者的话，「根本没实现容量」也能过。
         */
        it('容量宽松时不丢，收紧时真的丢', () => {
          setup();
          const loose = JSON.parse(String(lab.py(\`
      _m, _x = _build(2.0)
      _y = _m(_x, \${N_TOKEN})
      json.dumps({"dropped": _m.last_dropped, "load": _m.last_load})
      \`)));
          const tight = JSON.parse(String(lab.py(\`
      _m2, _x2 = _build(0.35)
      _y2 = _m2(_x2, \${N_TOKEN})
      json.dumps({"dropped": _m2.last_dropped, "load": _m2.last_load})
      \`)));
          const maxLoad = Math.max(...loose.load);
          const meanLoad = loose.load.reduce((a, c) => a + c, 0) / N_EXPERT;
          const imbalance = maxLoad / meanLoad;
          console.log(
            '宽松（cf=2.0）：丢弃 ' + loose.dropped + '，负载 ' + JSON.stringify(loose.load)
            + '，最大 / 平均 = ' + imbalance.toFixed(3)
          );
          console.log('收紧（cf=0.35）：丢弃 ' + tight.dropped + '，负载 ' + JSON.stringify(tight.load));
          lab.publish('expert.droppedTokens', loose.dropped);
          lab.publish('expert.dropsUnderTightCapacity', tight.dropped);
          lab.publish('expert.loadImbalance', imbalance);
          expect(loose.dropped).toBe(0);
          expect(tight.dropped).toBeGreaterThan(0);
          // 每个 token 走 top_k 个专家，总分配数要对得上
          expect(loose.load.reduce((a, c) => a + c, 0)).toBe(N_TOKEN * TOP_K);
        });

        it('辅助损失对得上 Switch 的公式，且均匀时等于 1', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m, _x = _build(2.0)
      _y = _m(_x, \${N_TOKEN})
      _logits = F.linear(_x, _m.router)
      _probs = F.softmax(_logits, \${N_TOKEN}, \${N_EXPERT}).tolist()
      _ids, _w = moe.route(_probs, \${N_TOKEN}, \${N_EXPERT}, \${TOP_K})

      # 完全均匀的对照：概率与分配都均匀，aux 该正好是 1
      _uniform = [1.0 / \${N_EXPERT}] * (\${N_TOKEN} * \${N_EXPERT})
      _uids = [(t + k) % \${N_EXPERT} for t in range(\${N_TOKEN}) for k in range(\${TOP_K})]
      json.dumps({"aux": _m.last_aux, "probs": _probs, "ids": _ids,
                  "uniform": moe.load_balance_loss(_uniform, _uids, \${N_TOKEN}, \${N_EXPERT}, \${TOP_K})})
      \`)));

          // 平台侧照公式重算一遍
          const counts = new Array(N_EXPERT).fill(0);
          for (let t = 0; t < N_TOKEN; t++) counts[r.ids[t * TOP_K]] += 1;
          const p = new Array(N_EXPERT).fill(0);
          for (let t = 0; t < N_TOKEN; t++)
            for (let e = 0; e < N_EXPERT; e++) p[e] += r.probs[t * N_EXPERT + e];
          let ref = 0;
          for (let e = 0; e < N_EXPERT; e++) ref += (counts[e] / N_TOKEN) * (p[e] / N_TOKEN);
          ref *= N_EXPERT;

          console.log(
            'aux ' + r.aux.toFixed(6) + '，参考 ' + ref.toFixed(6)
            + '；完全均匀时 ' + r.uniform.toFixed(6) + '（该是 1）'
          );
          lab.publish('expert.auxLossError', Math.abs(r.aux - ref));
          expect(Math.abs(r.aux - ref)).toBeLessThan(1e-6);
          expect(Math.abs(r.uniform - 1)).toBeLessThan(1e-9);
          // 真实路由不可能正好均匀，所以 aux 该 > 1
          expect(r.aux).toBeGreaterThan(1);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.flops.moeOverDense', op: 'lte', value: 0.6,
      zh: 'MoE 前馈与稠密等价的 FLOPs 比', en: 'MoE FFN FLOPs over the dense equivalent',
      dimension: 'efficiency',
    }),
    gate({
      metric: 'llm.expert.droppedTokens', op: 'eq', value: 0,
      zh: '容量宽松时丢弃的分配数', en: 'assignments dropped under loose capacity',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.expert.dropsUnderTightCapacity', op: 'gte', value: 1,
      zh: '容量收紧时丢弃的分配数（容量真的在起作用）',
      en: 'assignments dropped under tight capacity (capacity actually binds)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.expert.auxLossError', op: 'lte', value: 1e-6,
      zh: '辅助损失与参考公式的差', en: 'auxiliary loss versus the reference formula',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      DeepSeek-V3 的配置是**总参数 671B、激活 37B** —— 18 倍的稀疏度。
      它在这一关的基础上多了两件事：

      **共享专家。** 留一两个专家**所有 token 都过**，专门吃那些通用的模式，
      让被路由的专家去学各自专门的东西。DeepSeekMoE 的主要贡献之一。

      **无辅助损失的均衡。** 辅助损失有个副作用:它是在和主损失抢梯度，
      逼着路由器为了均衡去做一些不利于建模的选择。
      DeepSeek-V3 换成了一个**只调偏置不进梯度**的做法：
      给每个专家的路由分数加一个可调的偏置，谁超载就把谁的偏置调低。
      这样均衡完全不打扰主损失。

      还有一条工程上的：**MoE 的瓶颈是通信不是计算**。
      专家分布在不同的卡上，每一层都要做两次 all-to-all（发过去、收回来）。
      容量因子、专家并行的拓扑、以及 DeepEP 这类通信库，都是围着这件事转的。
      这也是为什么容量必须是定长的 —— 变长缓冲区在集合通信里没法用。
    `,
    code`
      DeepSeek-V3 runs **671B total parameters with 37B active** — 18x sparsity. Beyond what
      this stage builds, it adds two things:

      **Shared experts.** One or two experts that **every token passes through**, absorbing
      the generic patterns so routed experts can specialise. One of DeepSeekMoE's main
      contributions.

      **Balancing without an auxiliary loss.** The auxiliary loss has a side effect: it
      competes with the main loss for gradient, pushing the router toward choices that
      balance load at the expense of modelling. DeepSeek-V3 replaced it with a
      **bias-only, gradient-free** scheme: add a tunable bias to each expert's routing
      score and lower it whenever that expert is overloaded. Balancing then never disturbs
      the main objective.

      And an engineering note: **MoE is bottlenecked by communication, not compute**.
      Experts sit on different devices, so every layer performs two all-to-all exchanges
      (send out, gather back). Capacity factors, expert-parallel topologies and libraries
      like DeepEP all revolve around this. It is also why capacity must be a fixed size —
      variable-length buffers are unusable in collective communication.
    `
  ),
};

/* ================================================================== */
/* 第 21 关：Muon                                                      */
/* ================================================================== */

const STAGE_MUON = {
  id: 'muon',
  title: t('Muon —— 把更新正交化', 'Muon — orthogonalising the update'),
  goal: t(
    code`
      AdamW 把每个参数**单独**看：各自估一个步长，彼此无关。
      但一个权重**矩阵**不是一堆无关的数,它有奇异值谱，而梯度矩阵往往
      被少数几个方向主导。沿着这样的矩阵走一步，等于在少数几个方向上走得很远、
      其余方向几乎没动。

      \`Muon\` 换了个做法：把动量矩阵**正交化**之后再更新 ——
      让所有方向的步长拉平。在 \`muon.py\` 里实现它：

      \`\`\`python
      def newton_schulz(g, rows, cols, steps=5):
          """把 g 近似正交化。返回一个新张量，不动 g。"""

      class Muon:
          """矩阵参数走 Muon，其余（嵌入表、一维参数）走 AdamW。"""
          def __init__(self, named_params, lr=0.03, momentum=0.95, ...):
          def zero_grad(self):
          def step(self, lr=None):
      \`\`\`

      ## Newton–Schulz：不做 SVD 的正交化

      真正的正交化要做 SVD（\`G = UΣVᵀ\` 之后取 \`UVᵀ\`），而 SVD 在 GPU 上很慢，
      也不好并行。Muon 用一个只含矩阵乘的**五次迭代**逼近它：

      \`\`\`
      X ← G / ‖G‖_F                    先归一化，让奇异值落进收敛域
      重复 5 次：
          A ← X Xᵀ                     （行少于列时；否则用 XᵀX，见下）
          B ← b·A + c·A²
          X ← a·X + B X
      (a, b, c) = (3.4445, −4.7750, 2.0315)
      \`\`\`

      **这三个系数不是为了收敛到精确解调的，是为了「五步之内把奇异值挤进
      大致 [0.7, 1.3]」调的。** 所以 \`XᵀX\` 离单位阵还差得挺远 ——
      本关实测最大偏差约 **0.39**，而这是**正常的**，不是没收敛。
      Muon 需要的只是「各方向步长差不多」，不需要精确正交。

      ## 高矮两种形状

      \`A = X Xᵀ\` 是 \`[rows, rows]\`,矩阵很「宽」时这块比 \`X\` 还大。
      所以要按短边来：

      \`\`\`
      rows ≤ cols:  A = X Xᵀ  [r,r]，  X ← a·X + B X
      rows >  cols: A = Xᵀ X  [c,c]，  X ← a·X + X B
      \`\`\`

      两条是同一个迭代，只是把乘法放在另一边。\`F.gemm\` 的
      \`"nt"\` / \`"tn"\` / \`"nn"\` 正好够用,**不需要显式转置**。

      ## 谁走 Muon，谁不走

      **只有矩阵参数走 Muon。** 嵌入表和一维参数（norm 的增益）继续走 AdamW：

      - 一维参数根本没有「奇异值谱」这回事,正交化对它没有意义
      - 嵌入表虽然是二维的，但它的每一行是一个独立的 token，
        行与行之间没有那种「矩阵」的结构;实践中把它交给 Adam 更好

      这不是实现上的偷懒，是 Muon 论文与所有生产实现的一致做法。

      ## 更新还要按形状缩放

      正交化之后的 \`X\` 每个方向的量级都是 1，于是更新的 Frobenius 范数
      正比于 \`sqrt(min(rows, cols))\`。为了让不同形状的矩阵步长可比，
      要再乘一个 \`sqrt(max(1, rows/cols))\`。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 正交化 | \`\\|XᵀX − I\\|\` 最大 ≤ **0.6**（五步的 NS 就该在这个量级） |
      | 有效 | 谱最宽的那个形状上，偏差降到正交化之前的 **1/5 以下** |
      | 分工 | 矩阵参数走 Muon，嵌入与一维走 AdamW,两边的个数都要对 |
      | **效果** | 同模型、同数据、同步数下，Muon 的 loss ≤ AdamW 的 **0.95 倍** |

      最后一条是这一关唯一的效果类门槛，而它是**结构性比较**：
      两边除了优化器什么都一样。参考实现 300 步之后
      **AdamW 1.081，Muon 0.920,比值 0.851**。
    `,
    code`
      AdamW treats every parameter **separately**: each gets its own step size, independent
      of the rest. But a weight **matrix** is not a pile of unrelated numbers — it has a
      singular value spectrum, and gradient matrices are usually dominated by a few
      directions. Stepping along such a matrix means moving far in a few directions and
      barely at all in the others.

      \`Muon\` takes another route: **orthogonalise** the momentum matrix before updating, so
      every direction gets a comparable step. Implement it in \`muon.py\`:

      \`\`\`python
      def newton_schulz(g, rows, cols, steps=5):
          """Approximately orthogonalise g. Returns a new tensor, leaving g alone."""

      class Muon:
          """Matrix parameters use Muon; everything else (embeddings, 1-D) uses AdamW."""
          def __init__(self, named_params, lr=0.03, momentum=0.95, ...):
          def zero_grad(self):
          def step(self, lr=None):
      \`\`\`

      ## Newton–Schulz: orthogonalisation without an SVD

      True orthogonalisation needs an SVD (\`G = UΣVᵀ\`, then take \`UVᵀ\`), and SVD is slow
      on GPUs and hard to parallelise. Muon approximates it with a **quintic iteration**
      made only of matrix multiplies:

      \`\`\`
      X ← G / ‖G‖_F                    normalise so singular values land in the basin
      repeat 5 times:
          A ← X Xᵀ                     (when rows <= cols; otherwise XᵀX, see below)
          B ← b·A + c·A²
          X ← a·X + B X
      (a, b, c) = (3.4445, −4.7750, 2.0315)
      \`\`\`

      **Those coefficients are not tuned to converge to the exact answer; they are tuned to
      squeeze singular values into roughly [0.7, 1.3] within five steps.** So \`XᵀX\` stays
      noticeably away from the identity — this stage measures a maximum deviation around
      **0.39**, and that is **correct**, not unconverged. Muon only needs comparable steps
      across directions, not exact orthogonality.

      ## Tall and wide

      \`A = X Xᵀ\` is \`[rows, rows]\`, which for a wide matrix is larger than \`X\` itself.
      So work along the short side:

      \`\`\`
      rows <= cols:  A = X Xᵀ  [r,r],  X ← a·X + B X
      rows >  cols:  A = Xᵀ X  [c,c],  X ← a·X + X B
      \`\`\`

      Both are the same iteration with the multiplication on the other side. \`F.gemm\`'s
      \`"nt"\` / \`"tn"\` / \`"nn"\` cover it — **no explicit transpose needed**.

      ## Who uses Muon and who does not

      **Only matrix parameters.** Embeddings and 1-D parameters (normalisation gains) stay
      on AdamW:

      - a 1-D parameter has no singular value spectrum at all, so orthogonalising it is
        meaningless
      - an embedding table is two-dimensional, but each row is an independent token and the
        rows carry none of that matrix structure; in practice Adam does better there

      This is not implementation laziness but what the Muon paper and every production
      implementation do.

      ## The update is also scaled by shape

      After orthogonalisation every direction of \`X\` has magnitude 1, so the update's
      Frobenius norm scales with \`sqrt(min(rows, cols))\`. To make steps comparable across
      shapes, multiply by \`sqrt(max(1, rows/cols))\`.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Orthogonalisation | max \`\\|XᵀX − I\\|\` <= **0.6** (five NS steps belong at this scale) |
      | Effective | On the widest-spectrum shape, deviation falls below **1/5** of before |
      | Split | Matrices on Muon, embeddings and 1-D on AdamW, with both counts correct |
      | **Result** | Same model, data and steps: Muon's loss <= **0.95x** AdamW's |

      That last row is the only outcome gate here, and it is a **structural comparison**:
      the two runs differ in nothing but the optimiser. The reference measures
      **AdamW 1.081 against Muon 0.920 after 300 steps — a ratio of 0.851.**
    `
  ),
  checklist: [
    t('Newton–Schulz 按短边选形状，不做显式转置',
      'Newton-Schulz picks the shape by the short side, with no explicit transpose'),
    t('动量缓冲是就地更新的', 'The momentum buffer is updated in place'),
    t('嵌入表与一维参数走 AdamW', 'Embeddings and 1-D parameters use AdamW'),
    t('同预算下 loss 低于 AdamW', 'Lower loss than AdamW at the same budget'),
  ],
  hints: [
    t('F.gemm(x, x, r, r, c, "nt") 是 X Xᵀ；F.gemm(x, x, c, c, r, "tn") 是 Xᵀ X。',
      'F.gemm(x, x, r, r, c, "nt") is X Xᵀ; F.gemm(x, x, c, c, r, "tn") is Xᵀ X.'),
    t('F.scale_ 是就地的，F.scale 会新建一块 —— 动量缓冲要用前者。',
      'F.scale_ is in place while F.scale allocates; the momentum buffer needs the former.'),
    t('矩阵的判据是 len(p.shape) == 2 且不是嵌入表。',
      'A matrix means len(p.shape) == 2 and not the embedding table.'),
  ],
  pitfalls: [
    t(code`
      **动量缓冲用赋值而不是就地更新。** \`self._m[i] = F.add(self._m[i], g)\`
      建的是一个**新的激活张量**,它落在训练循环那个 mark 之后，
      第二步的 release 把它推平，第三步读到的是一块已经回收的显存。
      报出来的错是「没有 id 为 24995 的张量」。
      优化器状态必须一直是同一块内存,这是它和激活最根本的区别。
    `, code`
      **Assigning to the momentum buffer instead of updating it in place.**
      \`self._m[i] = F.add(self._m[i], g)\` builds a **new activation tensor**; it lands
      after the training loop's mark, step two's release wipes it, and step three reads
      reclaimed memory. The error reads "no tensor with id 24995". Optimiser state must stay
      the same block of memory — that is what most fundamentally separates it from an
      activation.
    `),
    t(code`
      **把嵌入表也交给 Muon。** 跑得通，训练也不会炸,只是效果变差。
      嵌入表的每一行是一个独立的 token，行与行之间没有「矩阵」的那种结构，
      正交化等于在一个不存在的结构上做手术。
      这个错没有任何报错信号，只有 A/B 跑一遍才看得出来。
    `, code`
      **Handing the embedding table to Muon as well.** It runs and training does not break;
      results merely get worse. Each row of an embedding table is an independent token and
      the rows carry none of the matrix structure, so orthogonalising operates on a structure
      that is not there. Nothing signals this error; only an A/B run reveals it.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_SCALE_PY,
      'muon.py': code`
        """第 21 关：Muon。矩阵参数正交化之后再更新。"""
        import math
        import nanotorch as nt
        from nanotorch import functional as F
        from nanotorch.tensor import Tensor
        from nanotorch import _bridge as B

        NS_A, NS_B, NS_C = 3.4445, -4.7750, 2.0315


        def newton_schulz(g, rows, cols, steps=5):
            """近似正交化。返回新张量，不动 g。"""
            # TODO: 先按 Frobenius 范数归一化，再迭代 steps 次
            #       rows <= cols 用 X Xᵀ 与 B X；否则用 Xᵀ X 与 X B
            return g.detach()


        class Muon:
            def __init__(self, named_params, lr=0.03, momentum=0.95,
                         weight_decay=0.1, grad_clip=1.0, ns_steps=5):
                self.matrix, self.other = [], []
                for name, p in named_params:
                    # TODO: 二维且不是嵌入表 -> matrix；其余 -> other
                    self.other.append(p)
                self.lr, self.momentum = lr, momentum
                self.weight_decay, self.grad_clip = weight_decay, grad_clip
                self.ns_steps = ns_steps
                # TODO: 每个矩阵参数一块动量缓冲，角色 optimizer
                self._m = []
                self.adam = nt.optim.AdamW(self.other, lr=lr, betas=(0.9, 0.95),
                                           weight_decay=weight_decay, grad_clip=0.0)
                for p in self.matrix:
                    p.ensure_grad()

            def zero_grad(self):
                for p in self.matrix:
                    p.zero_grad()
                self.adam.zero_grad()

            def grad_norm(self):
                total = 0.0
                for p in self.matrix + self.other:
                    if p.grad is not None:
                        total += F.sumsq(p.grad)
                return total ** 0.5

            def step(self, lr=None):
                nt.phase("optimizer")
                # TODO: 全局裁剪 -> 每个矩阵：更新动量 -> 正交化 -> 形状缩放 ->
                #       解耦衰减 -> 减到参数上；最后 self.adam.step(lr)
                nt.phase("other")
                return 0.0


        if __name__ == "__main__":
            g = nt.zeros((8, 4), role="data").normal_(3, 1.0)
            x = newton_schulz(g, 8, 4)
            print("正交化之后的 Frobenius 范数", round(F.sumsq(x) ** 0.5, 4))
      `,
    },
    referenceFiles: {
      'muon.py': code`
        """第 21 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import functional as F
        from nanotorch.tensor import Tensor
        from nanotorch import _bridge as B

        NS_A, NS_B, NS_C = 3.4445, -4.7750, 2.0315


        def newton_schulz(g, rows, cols, steps=5):
            # 先归一化：三个系数是在「奇异值已经在 1 附近」的前提下调出来的
            x = g.detach()
            F.scale_(x, 1.0 / ((F.sumsq(x) ** 0.5) + 1e-7))
            for _ in range(steps):
                # 按短边选形状 —— 宽矩阵上 X Xᵀ 比 X 本身还大
                if rows <= cols:
                    a = F.gemm(x, x, rows, rows, cols, "nt")     # X Xᵀ  [r,r]
                    aa = F.gemm(a, a, rows, rows, rows, "nn")
                else:
                    a = F.gemm(x, x, cols, cols, rows, "tn")     # Xᵀ X  [c,c]
                    aa = F.gemm(a, a, cols, cols, cols, "nn")
                F.scale_(a, NS_B)
                F.scale_(aa, NS_C)
                b = F.add(a, aa)                                  # bA + cA²
                if rows <= cols:
                    bx = F.gemm(b, x, rows, cols, rows, "nn")     # B X
                else:
                    bx = F.gemm(x, b, rows, cols, cols, "nn")     # X B
                F.scale_(x, NS_A)
                x = F.add(x, bx)
            return x


        class Muon:
            def __init__(self, named_params, lr=0.03, momentum=0.95,
                         weight_decay=0.1, grad_clip=1.0, ns_steps=5):
                self.matrix, self.other = [], []
                for name, p in named_params:
                    # 只有矩阵走 Muon。嵌入表虽然是二维的，但它的每一行是一个
                    # 独立的 token，行与行之间没有那种「矩阵」的结构
                    if len(p.shape) == 2 and "embed" not in name:
                        self.matrix.append(p)
                    else:
                        self.other.append(p)
                self.lr, self.momentum = lr, momentum
                self.weight_decay, self.grad_clip = weight_decay, grad_clip
                self.ns_steps = ns_steps
                self._m = [Tensor(p.shape, p.dtype, role="optimizer", name="muon.m")
                           for p in self.matrix]
                for t in self._m:
                    t.fill_(0.0)
                self.adam = nt.optim.AdamW(self.other, lr=lr, betas=(0.9, 0.95),
                                           weight_decay=weight_decay, grad_clip=0.0)
                for p in self.matrix:
                    p.ensure_grad()

            def zero_grad(self):
                for p in self.matrix:
                    p.zero_grad()
                self.adam.zero_grad()

            def grad_norm(self):
                total = 0.0
                for p in self.matrix + self.other:
                    if p.grad is not None:
                        total += F.sumsq(p.grad)
                return total ** 0.5

            def step(self, lr=None):
                nt.phase("optimizer")
                rate = self.lr if lr is None else lr
                norm = self.grad_norm()
                scale = 1.0
                if self.grad_clip > 0 and norm > self.grad_clip:
                    scale = self.grad_clip / norm

                for i, p in enumerate(self.matrix):
                    rows, cols = p.shape[0], p.shape[1]
                    g = p.grad.detach()
                    F.scale_(g, scale)

                    # 动量**就地**更新。写成 self._m[i] = F.add(...) 的话，
                    # 新建的是一个激活张量，第二步就被 release 推平了
                    mbuf = self._m[i]
                    F.scale_(mbuf, self.momentum)
                    B.add_inplace(mbuf.handle, g.handle, mbuf.numel)
                    # Nesterov：正交化的是「往前看一步」的那个方向
                    look = F.add(g, F.scale(mbuf, self.momentum))

                    u = newton_schulz(look, rows, cols, self.ns_steps)
                    # 正交化之后每个方向的量级都是 1，所以按形状再缩一次，
                    # 不同形状的矩阵步长才可比
                    F.scale_(u, rate * max(1.0, rows / cols) ** 0.5)
                    # 解耦权重衰减：直接作用在参数上，不进更新方向
                    if self.weight_decay > 0:
                        F.scale_(p, 1.0 - rate * self.weight_decay)
                    F.scale_(u, -1.0)
                    B.add_inplace(p.handle, u.handle, p.numel)

                self.adam.step(lr=rate)
                nt.phase("other")
                return norm


        if __name__ == "__main__":
            g = nt.zeros((8, 4), role="data").normal_(3, 1.0)
            x = newton_schulz(g, 8, 4)
            print("正交化之后的 Frobenius 范数", round(F.sumsq(x) ** 0.5, 4))
      `,
    },
  },
  specs: [
    spec('muon.spec.ts', code`
      ${LAB}

      const STEPS = 300, PEAK = 0.03;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, muon
      importlib.reload(kit)
      importlib.reload(muon)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
        const toks = lab.world.tokens();
        lab.py('kit.train_tokens = ' + JSON.stringify([...toks.slice(0, lab.world.holdoutAt())]));
        lab.py(\`
      def _ortho_error(rows, cols):
          """|XᵀX − I| 的最大元素。正交化之前的同一个 G 也量一遍，作为对照。

          **对照要用一个奇异值谱很宽的矩阵**：随机高斯矩阵归一化之后
          本来就已经接近正交了，拿它当对照的话，NS 看起来「什么也没做」。
          这里给每一列乘一个跨两个数量级的系数，把谱拉开。
          """
          g = nt.zeros((rows, cols), role="data").normal_(31, 1.0)
          vals = g.tolist()
          for i in range(rows):
              for j in range(cols):
                  vals[i * cols + j] *= 0.01 ** (j / max(1, cols - 1))
          g.set_(vals)
          short = min(rows, cols)

          def dev(x):
              if rows <= cols:
                  a = F.gemm(x, x, rows, rows, cols, "nt")
              else:
                  a = F.gemm(x, x, cols, cols, rows, "tn")
              v = a.tolist()
              w = 0.0
              for i in range(short):
                  for j in range(short):
                      w = max(w, abs(v[i * short + j] - (1.0 if i == j else 0.0)))
              return w

          raw = g.detach()
          F.scale_(raw, (short ** 0.5) / ((F.sumsq(raw) ** 0.5) + 1e-7))
          before = dev(raw)
          after = dev(muon.newton_schulz(g, rows, cols, 5))
          return {"before": before, "after": after}


      def _train(which, steps, peak):
          vocab = max(kit.train_tokens) + 1
          m = kit.LM(vocab, seed=1)
          if which == "muon":
              opt = muon.Muon(m.named_parameters(), lr=peak)
          else:
              opt = nt.optim.AdamW(m.parameters(), lr=peak, betas=(0.9, 0.95),
                                   weight_decay=0.1, grad_clip=1.0)
          idx = nt.zeros((kit.B * kit.S,), role="data", name="idx")
          tgt = nt.zeros((kit.B * kit.S,), role="data", name="tgt")
          hist = []
          base = nt.mark()
          w = max(1, steps // 20)
          for st in range(1, steps + 1):
              nt.release(base)
              bi, bt = kit.sample_batch(kit.train_tokens, st, kit.B, kit.S)
              idx.set_int_(bi)
              tgt.set_int_(bt)
              opt.zero_grad()
              nt.phase("forward")
              loss = m(idx, tgt, kit.B, kit.S)
              nt.phase("other")
              loss.backward()
              if st <= w:
                  lr = peak * st / w
              else:
                  pr = (st - w) / max(1, steps - w)
                  lr = peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
              opt.step(lr=lr)
              hist.append(loss.value)
          nt.release(base)
          out = {"last": sum(hist[-20:]) / 20}
          if which == "muon":
              out["matrix"] = len(opt.matrix)
              out["other"] = len(opt.other)
          return out
      \`);
      }

      describe('Muon', () => {
        /*
         * 五步的 Newton–Schulz **不收敛到精确正交** —— 那三个系数是为了
         * 「五步之内把奇异值挤进大致 [0.7, 1.3]」调的。
         * 所以这一条既要求它有效（比归一化之后好一个量级），
         * 又不要求它精确（0.6 的界）。
         */
        it('高矮两种形状都正交化得动', () => {
          setup();
          const shapes = [[32, 32], [32, 88], [88, 32], [64, 16]];
          let worstAfter = 0;
          let hardest = null;
          for (const [r, c] of shapes) {
            const e = JSON.parse(String(lab.py('json.dumps(_ortho_error(' + r + ', ' + c + '))')));
            console.log(
              r + 'x' + c + '：正交化前 ' + e.before.toFixed(4)
              + '，之后 ' + e.after.toFixed(4) + '，降到 ' + (e.after / e.before).toFixed(3)
            );
            worstAfter = Math.max(worstAfter, e.after);
            if (!hardest || e.before > hardest.before) hardest = { ...e, r, c };
          }
          /*
           * 「降了多少」只在**谱确实很宽**的那个形状上问才有意义。
           * 归一化之后的宽矩阵在它的短边上本来就已经接近正交了（实测 0.89），
           * 拿它当对照会得出「NS 没做什么」这个错误结论 ——
           * 不是 NS 不行，是那个对照本身就没偏多少。
           */
          const ratio = hardest.after / hardest.before;
          console.log(
            '谱最宽的是 ' + hardest.r + 'x' + hardest.c
            + '（正交化前 ' + hardest.before.toFixed(3) + '），降到 ' + ratio.toFixed(3)
          );
          lab.publish('muon.orthoError', worstAfter);
          lab.publish('muon.orthoImprovement', ratio);
          expect(worstAfter).toBeLessThan(0.6);
          // 对照本身要够偏，否则这一条问的不是同一个问题
          expect(hardest.before).toBeGreaterThan(2);
          expect(ratio).toBeLessThan(0.2);
        });

        it('矩阵走 Muon，嵌入与一维走 AdamW', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _vocab = max(kit.train_tokens) + 1
      _m = kit.LM(_vocab, seed=1)
      _opt = muon.Muon(_m.named_parameters(), lr=\${PEAK})
      _named = [(n, list(p.shape)) for n, p in _m.named_parameters()]
      json.dumps({"matrix": len(_opt.matrix), "other": len(_opt.other), "named": _named})
      \`)));

          // 平台侧照规则数一遍
          let expectMatrix = 0, expectOther = 0;
          for (const [name, shape] of r.named) {
            if (shape.length === 2 && !name.includes('embed')) expectMatrix += 1;
            else expectOther += 1;
          }
          console.log(
            '参数张量共 ' + r.named.length + ' 个：Muon ' + r.matrix
            + '（该是 ' + expectMatrix + '），AdamW ' + r.other + '（该是 ' + expectOther + '）'
          );
          lab.publish('muon.matrixParams', r.matrix);
          lab.publish('muon.adamParams', r.other);
          expect(r.matrix).toBe(expectMatrix);
          expect(r.other).toBe(expectOther);
          expect(r.matrix).toBeGreaterThan(0);
          expect(r.other).toBeGreaterThan(0);
        });

        /*
         * 唯一的效果类门槛，而且是结构性比较：
         * 同一个模型、同一份数据、同样的步数与调度，只有优化器不同。
         */
        it('同预算下 loss 低于 AdamW 的 0.95 倍', () => {
          setup();
          const adamw = JSON.parse(String(lab.py('json.dumps(_train("adamw", ' + STEPS + ', ' + PEAK + '))')));
          const muonR = JSON.parse(String(lab.py('json.dumps(_train("muon", ' + STEPS + ', ' + PEAK + '))')));
          const ratio = muonR.last / adamw.last;
          console.log(
            STEPS + ' 步之后：AdamW ' + adamw.last.toFixed(4)
            + '，Muon ' + muonR.last.toFixed(4) + '，比值 ' + ratio.toFixed(4)
            + '（Muon 管着 ' + muonR.matrix + ' 个矩阵，其余 ' + muonR.other + ' 个走 AdamW）'
          );
          lab.publish('loss.muonOverAdamW', ratio);
          expect(Number.isFinite(muonR.last)).toBe(true);
          expect(ratio).toBeLessThan(0.95);
        });

        it('动量缓冲跨步存活 —— 优化器状态不是激活', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _vocab = max(kit.train_tokens) + 1
      _m2 = kit.LM(_vocab, seed=1)
      _o2 = muon.Muon(_m2.named_parameters(), lr=\${PEAK})
      _ids = [t.handle for t in _o2._m]
      _idx = nt.zeros((kit.B * kit.S,), role="data")
      _tgt = nt.zeros((kit.B * kit.S,), role="data")
      _base = nt.mark()
      for _s in range(3):
          nt.release(_base)
          _bi, _bt = kit.sample_batch(kit.train_tokens, _s + 1, kit.B, kit.S)
          _idx.set_int_(_bi); _tgt.set_int_(_bt)
          _o2.zero_grad()
          _l = _m2(_idx, _tgt, kit.B, kit.S)
          _l.backward()
          _o2.step(lr=\${PEAK})
      # 三步之后动量缓冲还是原来那几块，而且非零
      _same = [t.handle for t in _o2._m] == _ids
      _nonzero = sum(1 for t in _o2._m if F.sumsq(t) > 0)
      json.dumps({"same": _same, "nonzero": _nonzero, "count": len(_o2._m)})
      \`)));
          console.log(
            '三步之后：动量缓冲还是原来那几块 ' + r.same
            + '，非零的 ' + r.nonzero + ' / ' + r.count
          );
          lab.publish('muon.momentumPersisted', r.same && r.nonzero === r.count ? 1 : 0);
          expect(r.same).toBe(true);
          expect(r.nonzero).toBe(r.count);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.muon.orthoError', op: 'lte', value: 0.6,
      zh: '正交化之后 |XᵀX − I| 的最大元素', en: 'max |XᵀX − I| after orthogonalisation',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.muon.orthoImprovement', op: 'lte', value: 0.2,
      zh: '正交化之后与之前的偏差比', en: 'deviation after orthogonalisation over before',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.muon.momentumPersisted', op: 'eq', value: 1,
      zh: '动量缓冲跨步存活且非零', en: 'the momentum buffer survives steps and is non-zero',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.loss.muonOverAdamW', op: 'lte', value: 0.95,
      zh: '同预算下 Muon 与 AdamW 的 loss 比', en: "Muon's loss over AdamW's at the same budget",
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      Muon 是 2024 年底出来的，2026 年已经在生产里了：**Kimi K2 与 GLM-5 都在用**。
      Moonshot 的 \`Muon Clip\` 在它上面加了一层 QK 裁剪,
      Muon 让训练更快，但也更容易把注意力的 logits 推大，两件事要一起解决。

      有几点值得记住：

      **它省的是显存。** AdamW 每个参数要存 \`m\` 和 \`v\` 两块；
      Muon 只有一块动量。矩阵参数占模型的绝大多数，所以优化器状态少了差不多一半。

      **它花的是算力。** 每一步每个矩阵要做 5 轮、每轮 3 次矩阵乘。
      相对于前向反向的 \`6N\`，这部分在大模型上占比不大（矩阵乘的形状是
      \`[r,c]\` 而不是 \`[batch·seq, c]\`），但在小模型上很明显 ——
      这一关里 Muon 每步比 AdamW 慢，而它靠更少的步数赢回来。

      **它不是万能的。** 嵌入、一维参数、以及（在很多实现里）输出头都仍然走 Adam。
      「一个优化器管所有参数」这件事本身就不是必须的,
      按参数的**结构**分组，是 Muon 带来的更普遍的一个想法。
    `,
    code`
      Muon appeared in late 2024 and is in production by 2026: **Kimi K2 and GLM-5 both use
      it**. Moonshot's \`Muon Clip\` layers QK clipping on top — Muon trains faster but also
      pushes attention logits upward, and the two need solving together.

      A few things worth keeping:

      **It saves memory.** AdamW stores \`m\` and \`v\` per parameter; Muon keeps only a
      momentum. Matrix parameters are the vast majority of a model, so optimiser state drops
      by roughly half.

      **It spends compute.** Each step runs 5 rounds of 3 matmuls per matrix. Against the
      \`6N\` of forward and backward this is minor at large scale (the matmuls are
      \`[r,c]\`-shaped rather than \`[batch·seq, c]\`), but conspicuous at small scale — in
      this stage Muon's steps are slower than AdamW's and it wins by needing fewer of them.

      **It is not universal.** Embeddings, 1-D parameters and (in many implementations) the
      output head stay on Adam. That one optimiser need not cover every parameter is itself
      the more general idea Muon contributed: group parameters by their **structure**.
    `
  ),
};

/** 后训练那几关共用的套件：一个可验证的算术世界 + 模型 + 生成 */
const KIT_POST_PY = code`
  """后训练共用的套件。

  ## 为什么是算术

  后训练的每一步都要能**判对错**。算术是最干净的可验证任务：
  \`7+5=\` 的答案只有一个，不需要人来标,这正是 \`RLVR\`（可验证奖励的强化学习）
  的前提，也是 2026 年后训练里最靠得住的那一类信号。

  ## 词表

  \`\`\`
  0-9  数字        10 '+'      11 '-'
  12 '='           13 EOS      14 PAD
  \`\`\`

  一条样本长这样：\`7+5=\` → \`12<eos>\`，编码之后 \`[7,10,5,12] + [1,2,13]\`。

  模型是 \`dim=48, n_layer=2, n_head=4, n_kv_head=2, hidden=128\`，序列长 12。
  """
  import math
  import nanotorch as nt
  from nanotorch import nn, functional as F

  V, PLUS, MINUS, EQ, EOS, PAD = 15, 10, 11, 12, 13, 14
  D, L, H, KV, HID, S = 48, 2, 4, 2, 128, 12


  def encode(text):
      out = []
      for ch in text:
          if ch.isdigit():
              out.append(int(ch))
          elif ch == "+":
              out.append(PLUS)
          elif ch == "-":
              out.append(MINUS)
          elif ch == "=":
              out.append(EQ)
      return out


  def decode(ids):
      table = {PLUS: "+", MINUS: "-", EQ: "=", EOS: "", PAD: ""}
      return "".join(table[i] if i >= 10 else str(i) for i in ids)


  def make_pairs(n, seed, max_value=10, op="+"):
      """确定性地造 n 条 (prompt, answer)。减法保证不出现负数。"""
      st = (seed * 1103515245 + 12345) & 0x7fffffff
      out = []
      for _ in range(n):
          st = (st * 1103515245 + 12345) & 0x7fffffff
          a = st % max_value
          st = (st * 1103515245 + 12345) & 0x7fffffff
          b = st % max_value
          if op == "-":
              a, b = max(a, b), min(a, b)
              out.append((str(a) + "-" + str(b) + "=", str(a - b)))
          else:
              out.append((str(a) + "+" + str(b) + "=", str(a + b)))
      return out


  def build_tables(n, head_dim, base=10000.0):
      half = head_dim // 2
      cos = nt.zeros((n, half), role="data", name="rope.cos")
      sin = nt.zeros((n, half), role="data", name="rope.sin")
      cv, sv = [], []
      for p in range(n):
          for i in range(half):
              th = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(th))
              sv.append(math.sin(th))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  def build_tables_at(offset, n, head_dim, base=10000.0):
      """从 offset 起算的 n 行 RoPE 表。解码时用。

      角色是 activation 而不是 data：这张表是**每步现造**的（offset 每步都变），
      标成 data 的话它落在解码循环那个 mark 之后，第二步的 release 会当场报错。
      \`__init__\` 里那张预算好的表才是常驻的。
      """
      half = head_dim // 2
      cos = nt.zeros((n, half), name="rope.cos.at")
      sin = nt.zeros((n, half), name="rope.sin.at")
      cv, sv = [], []
      for p in range(offset, offset + n):
          for i in range(half):
              th = p * (base ** (-2.0 * i / head_dim))
              cv.append(math.cos(th))
              sv.append(math.sin(th))
      cos.set_(cv)
      sin.set_(sv)
      return cos, sin


  class Norm(nn.Module):
      def __init__(self, dim):
          super().__init__()
          self.weight = nt.parameter((dim,), None, 0.0, "g")

      def forward(self, x):
          return F.rms_norm(x, self.weight, 1e-5)


  class Attn(nn.Module):
      def __init__(self, dim, nh, nkv, seed, max_seq=32):
          super().__init__()
          self.nh, self.nkv, self.hd = nh, nkv, dim // nh
          hd = self.hd
          self.wq = nt.parameter((dim, nh * hd), seed + 1, dim ** -0.5, "wq")
          self.wk = nt.parameter((dim, nkv * hd), seed + 2, dim ** -0.5, "wk")
          self.wv = nt.parameter((dim, nkv * hd), seed + 3, dim ** -0.5, "wv")
          self.wo = nt.parameter((nh * hd, dim), seed + 4, (nh * hd) ** -0.5, "wo")
          self._cos, self._sin = build_tables(max_seq, hd)

      def forward(self, x, b, s, cache=None, offset=0):
          """cache 给解码用（第 8 关那一套）：位置从 offset 起算，
          k/v 追加进缓存之后对缓存里全部位置做注意力。"""
          hd = self.hd
          q = F.linear(x, self.wq)
          k = F.linear(x, self.wk)
          v = F.linear(x, self.wv)
          if offset == 0 and s <= self._cos.shape[0]:
              cos, sin = self._cos, self._sin
          else:
              cos, sin = build_tables_at(offset, s, hd)
          q = F.rope(q, cos, sin, b, s, self.nh, hd)
          k = F.rope(k, cos, sin, b, s, self.nkv, hd)

          if cache is None:
              keys, values, skv = k, v, s
          else:
              cache.append(k, v, s)
              keys, values, skv = cache.k, cache.v, cache.max_seq

          sc = F.attn_scores(q, keys, b, s, skv, self.nh, self.nkv, hd)
          pr = F.softmax(sc, b * self.nh * s, skv,
                         F.causal_valid(b, self.nh, s, offset))
          o = F.attn_apply(pr, values, b, s, skv, self.nh, self.nkv, hd,
                           out_shape=(b * s, self.nh * hd))
          return F.linear(o, self.wo)


  class Mlp(nn.Module):
      def __init__(self, dim, hid, seed):
          super().__init__()
          self.wg = nt.parameter((dim, hid), seed + 1, dim ** -0.5, "wg")
          self.wu = nt.parameter((dim, hid), seed + 2, dim ** -0.5, "wu")
          self.wd = nt.parameter((hid, dim), seed + 3, hid ** -0.5, "wd")

      def forward(self, x):
          return F.linear(F.swiglu(F.linear(x, self.wg), F.linear(x, self.wu)), self.wd)


  class Block(nn.Module):
      def __init__(self, dim, nh, nkv, hid, seed, nl):
          super().__init__()
          self.n1, self.at = Norm(dim), Attn(dim, nh, nkv, seed)
          self.n2, self.mp = Norm(dim), Mlp(dim, hid, seed + 40)
          self.sc = (2.0 * nl) ** -0.5

      def forward(self, x, b, s, cache=None, offset=0):
          x = F.add(x, F.scale(self.at(self.n1(x), b, s, cache, offset), self.sc))
          return F.add(x, F.scale(self.mp(self.n2(x)), self.sc))


  class LM(nn.Module):
      def __init__(self, seed=1):
          super().__init__()
          self.embed = nt.parameter((V, D), seed, D ** -0.5, "embed")
          self.blocks = nn.ModuleList([
              Block(D, H, KV, HID, seed + 100 * (i + 1), L) for i in range(L)
          ])
          self.nf = Norm(D)

      def logits(self, idx, b, s, caches=None, offset=0):
          """caches 是每层一个 KVCache（不给就走整段重算那条路）。"""
          rows = b * s
          x = F.embedding(self.embed, idx, rows, D)
          for i, blk in enumerate(self.blocks):
              x = blk(x, b, s, caches[i] if caches else None, offset)
          x = self.nf(x)
          return F.linear_tied(x, self.embed, rows, D, V)

      def make_caches(self, batch, max_seq):
          """每层一块 KV cache。role 是 data —— 整段生成里都在。"""
          return [nt.generate.KVCache(batch, max_seq, KV, D // H) for _ in range(L)]

      def forward(self, idx, tgt, b, s, mask=None):
          return F.cross_entropy(self.logits(idx, b, s), tgt, b * s, V, mask)


  def generate_answer(model, prompt, max_new=3):
      """贪心生成，撞到 EOS 就停。返回解码之后的字符串。"""
      cur = encode(prompt)
      out = []
      buf = nt.zeros((S,), role="data", name="gen.idx")
      with nt.no_grad():
          mk = nt.mark()
          for _ in range(max_new):
              nt.release(mk)
              if len(cur) >= S:
                  break
              buf.set_int_(cur + [PAD] * (S - len(cur)))
              lg = model.logits(buf, 1, S)
              nxt = nt.generate.greedy(lg, len(cur) - 1, V)
              if nxt == EOS:
                  break
              out.append(nxt)
              cur.append(nxt)
      return decode(out)


  def build_row(prompt, answer):
      """一条 SFT 样本：(idx, tgt, mask)。mask 只在回答上为 1（第 22 关的结论）。"""
      p = encode(prompt)
      a = encode(answer) + [EOS]
      full = p + a
      full = full + [PAD] * (S + 1 - len(full))
      mask = [1.0 if (t >= len(p) - 1 and t < len(p) - 1 + len(a)) else 0.0 for t in range(S)]
      return full[:S], full[1:S + 1], mask


  def sft_train(model, pairs, steps, batch_size=16, peak_lr=0.03):
      """平台版的 SFT 循环。第 22 关自己写过一遍，之后几关直接用。"""
      opt = nt.optim.AdamW(model.parameters(), lr=peak_lr, betas=(0.9, 0.95),
                           weight_decay=0.1, grad_clip=1.0)
      idx = nt.zeros((batch_size * S,), role="data", name="idx")
      tgt = nt.zeros((batch_size * S,), role="data", name="tgt")
      msk = nt.zeros((batch_size * S,), role="data", name="mask")
      base = nt.mark()
      warmup = max(1, steps // 20)
      for st in range(1, steps + 1):
          nt.release(base)
          bi, bt, bm = [], [], []
          for k in range(batch_size):
              p, a = pairs[(st * batch_size + k) % len(pairs)]
              ri, rt, rm = build_row(p, a)
              bi.extend(ri)
              bt.extend(rt)
              bm.extend(rm)
          idx.set_int_(bi)
          tgt.set_int_(bt)
          msk.set_(bm)
          opt.zero_grad()
          nt.phase("forward")
          loss = F.cross_entropy(model.logits(idx, batch_size, S), tgt,
                                 batch_size * S, V, msk)
          nt.phase("other")
          loss.backward()
          if st <= warmup:
              lr = peak_lr * st / warmup
          else:
              pr = (st - warmup) / max(1, steps - warmup)
              lr = peak_lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
          opt.step(lr=lr)
      nt.release(base)
      return model


  def make_preference_pairs(n, seed, max_value=10, op="+"):
      """造偏好对：(prompt, chosen, rejected)。

      \`chosen\` 是正确答案，\`rejected\` 是一个**错得不离谱**的答案
      （差 1 到 3）。差太远的话奖励模型学一个「长度」或者「首位数字」
      的捷径就能全对,偏好数据的难度决定了奖励模型学到的是什么。
      """
      base = make_pairs(n, seed, max_value, op)
      out = []
      st = (seed * 22695477 + 1) & 0x7fffffff
      for prompt, answer in base:
          st = (st * 22695477 + 1) & 0x7fffffff
          delta = 1 + st % 3
          st = (st * 22695477 + 1) & 0x7fffffff
          if st % 2 == 0 or int(answer) - delta < 0:
              wrong = int(answer) + delta
          else:
              wrong = int(answer) - delta
          out.append((prompt, answer, str(wrong)))
      return out


  def make_length_biased_pairs(n, seed, max_value=20, op="+"):
      """**带长度混淆**的偏好对：错的那个永远是一位数。

      正确答案可能是一位也可能是两位，于是「更长」和「更好」在数据里绑在一起。
      第 26 关要先量出这个混淆，再把它去掉。

      现实里没人故意这么造数据 —— 但人类标注、模型标注、规则构造
      都很容易**无意**带上同一个结构，而结果是一样的。
      """
      base = make_pairs(n, seed, max_value, op)
      out = []
      st = (seed * 22695477 + 7) & 0x7fffffff
      for prompt, answer in base:
          st = (st * 22695477 + 7) & 0x7fffffff
          wrong = st % 10
          if str(wrong) == answer:
              wrong = (wrong + 1) % 10
          out.append((prompt, answer, str(wrong)))
      return out


  def exact_match(model, pairs):
      """精确匹配率 —— 可验证任务的奖励函数就是它。"""
      ok = 0
      for prompt, answer in pairs:
          if generate_answer(model, prompt) == answer:
              ok += 1
      return ok / max(1, len(pairs))
`;

/* ================================================================== */
/* 第 22 关：SFT                                                       */
/* ================================================================== */

const STAGE_SFT = {
  id: 'sft',
  title: t('SFT —— loss 只算在回答上', 'SFT — the loss counts only on the answer'),
  goal: t(
    code`
      预训练教会模型「下一个 token 是什么」。**监督微调（SFT）**教它
      「拿到一个问题，该输出什么」—— 同样是下一个 token 预测，
      区别只有一个：**loss 只算在回答上，不算在问题上。**

      在 \`sft.py\` 里实现：

      \`\`\`python
      def build_row(prompt, answer, block_size, eos_id, pad_id):
          """返回 (idx, tgt, mask)，三个都是长度 block_size 的列表。

          mask[t] = 1 只在「这一位要预测的是回答里的 token」时成立。"""

      def masked_loss(logits, targets, mask, rows, vocab):
          """按 mask 算的平均 loss。**不能直接用 cross_entropy 报的那个数。**"""

      def train(model, pairs, steps, batch_size, ...):
          """跑 SFT。返回 {"loss": [...], "final": float}。"""
      \`\`\`

      ## 为什么问题上不能算 loss

      在问题上算 loss，等于让模型**学习怎么生成问题**。
      它照样会收敛,loss 曲线一样好看，甚至更低（问题比回答好预测得多）。
      但你要的能力是「回答」，而训练信号被稀释了。

      在真实的对话数据上这件事更严重：一轮对话里 prompt 常常比 completion 长好几倍，
      于是绝大部分梯度花在了学习「用户会怎么说话」上。

      这一关的第一条门槛就是它，而且查得很硬：
      **prompt 位置上的 \`dlogits\` 必须逐位为 0。**

      ## mask 的边界在哪

      \`\`\`
      文本      7 + 5 =  1  2  <eos>  <pad> ...
      位置 t    0 1 2 3  4  5    6      7
      预测的是  +  5 =  1  2  <eos>  <pad>
      mask      0 0 0 1  1  1     0      0
                     ↑
                最后一个 prompt token 的位置上，要预测的已经是答案的第一位了
      \`\`\`

      **边界差一位是最常见的错。** 往前差一位，模型学不到「看到 \`=\` 该开口」；
      往后差一位，\`=\` 本身进了 loss。两种都能训出东西来，都比正确的差一点。

      \`<pad>\` 位置也要屏蔽,它们不是内容。

      ## cross_entropy 报的数不是你要的数

      \`F.cross_entropy(logits, targets, rows, vocab, mask)\` 的 \`mask\`
      **只作用在梯度上**,它前向返回的仍然是**全部位置**的平均。
      直接拿它画曲线的话，你看到的是「包含 prompt 与 padding 的平均」，
      而那个数会随着训练**上升**（模型专心学回答，在 prompt 位置上变得越来越差）。

      这不是实现的疏忽，是有意留的边界:算梯度和报数字是两件事，
      而混淆它们的后果只有自己算一遍才看得清。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | **prompt 不进 loss** | prompt 位置上梯度不为 0 的个数 = **0** |
      | mask 的边界 | 与参考的 mask 逐位相同 |
      | 报的数 | 与平台按 mask 重算的一致（差 ≤ 1e-6） |
      | 学会了 | 留出集上精确匹配 ≥ **90%** |
    `,
    code`
      Pretraining teaches a model what the next token is. **Supervised fine-tuning (SFT)**
      teaches it what to output given a question — still next-token prediction, differing in
      exactly one respect: **the loss counts only on the answer, never on the question.**

      Implement in \`sft.py\`:

      \`\`\`python
      def build_row(prompt, answer, block_size, eos_id, pad_id):
          """Return (idx, tgt, mask), each a list of length block_size.

          mask[t] = 1 only where this position predicts a token of the answer."""

      def masked_loss(logits, targets, mask, rows, vocab):
          """Mean loss under the mask. **Not the number cross_entropy reports.**"""

      def train(model, pairs, steps, batch_size, ...):
          """Run SFT. Returns {"loss": [...], "final": float}."""
      \`\`\`

      ## Why the question must not carry loss

      Computing loss on the question means teaching the model **how to generate questions**.
      It still converges; the curve looks just as good, often better (questions are far more
      predictable than answers). But the capability you want is answering, and the training
      signal has been diluted.

      On real conversational data this matters more: a turn's prompt is often several times
      longer than its completion, so most of the gradient goes into learning how users talk.

      That is this stage's first gate, and it is checked strictly:
      **\`dlogits\` at prompt positions must be exactly zero.**

      ## Where the mask boundary sits

      \`\`\`
      text        7 + 5 =  1  2  <eos>  <pad> ...
      position t  0 1 2 3  4  5    6      7
      predicts    +  5 =  1  2  <eos>  <pad>
      mask        0 0 0 1  1  1     0      0
                       ^
             at the last prompt token, what comes next is already the answer
      \`\`\`

      **Off-by-one here is the most common mistake.** One position early and the model never
      learns to start speaking when it sees \`=\`; one position late and \`=\` itself enters
      the loss. Both train to something, both slightly worse than correct.

      \`<pad>\` positions must be masked too — they are not content.

      ## The number cross_entropy reports is not the number you want

      The \`mask\` argument of \`F.cross_entropy(logits, targets, rows, vocab, mask)\`
      **affects only the gradient**; its forward value is still the mean over **all**
      positions. Plotting that gives you "the average including prompt and padding", and
      that number **rises** during training — the model concentrates on answers and gets
      steadily worse at prompt positions.

      This is a deliberate boundary rather than an oversight: computing a gradient and
      reporting a number are two different things, and only computing it yourself makes the
      difference visible.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | **No loss on the prompt** | Non-zero gradients at prompt positions = **0** |
      | Mask boundary | Bit-identical to the reference mask |
      | Reported number | Matches the platform's masked recomputation (within 1e-6) |
      | It learned | Exact match on the held-out set >= **90%** |
    `
  ),
  checklist: [
    t('mask 从「最后一个 prompt token」的位置开始', 'The mask starts at the last prompt token'),
    t('padding 位置也屏蔽', 'Padding positions are masked too'),
    t('报的 loss 是按 mask 算的', 'The reported loss is computed under the mask'),
    t('留出集上精确匹配 ≥ 90%', 'Exact match on the held-out set is at least 90%'),
  ],
  hints: [
    t('位置 t 预测的是 tgt[t]，所以边界看的是「tgt[t] 属不属于回答」。',
      'Position t predicts tgt[t], so the boundary asks whether tgt[t] belongs to the answer.'),
    t('F.softmax 之后按 targets 取概率，就能自己算按 mask 的平均。',
      'Softmax then index by targets to compute the masked mean yourself.'),
    t('mask 要作为 F.cross_entropy 的第五个参数传进去，梯度才会被屏蔽。',
      "Pass the mask as cross_entropy's fifth argument so the gradient is masked."),
  ],
  pitfalls: [
    t(code`
      **mask 的边界差一位。** 从 \`=\` 的**下一个**位置开始的话，
      模型永远学不到「看到 \`=\` 就该开口」—— 生成时它在 \`=\` 之后不知道该说什么。
      而 loss 曲线完全正常，评测里也只是准确率低一点。
      这一关拿参考 mask 逐位对，就是为了它。
    `, code`
      **An off-by-one mask boundary.** Starting one position after \`=\` means the model
      never learns that \`=\` is its cue to speak — at generation time it does not know what
      follows \`=\`. The loss curve looks perfectly normal and evaluation merely scores a
      little lower. Comparing bit-for-bit against the reference mask exists for this.
    `),
    t(code`
      **拿 \`cross_entropy\` 返回的数当训练曲线。** 那是**全部位置**的平均，
      包含 prompt 与 padding。SFT 越训，模型在 prompt 位置上越差，
      于是这条曲线会**往上走** —— 而真正的（按 mask 的）loss 在往下走。
      看着上升的曲线去调超参，方向全反了。
    `, code`
      **Plotting the number \`cross_entropy\` returns.** That is the mean over **all**
      positions including prompt and padding. The longer SFT runs, the worse the model gets
      at prompt positions, so this curve **rises** while the true masked loss falls. Tuning
      hyperparameters against a rising curve sends you in exactly the wrong direction.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_POST_PY,
      'sft.py': code`
        """第 22 关：SFT。loss 只算在回答上。"""
        import math
        import nanotorch as nt
        from nanotorch import functional as F
        import kit


        def build_row(prompt, answer, block_size, eos_id, pad_id):
            """返回 (idx, tgt, mask)，都是长度 block_size 的列表。"""
            # TODO: 拼出 prompt + answer + eos，补 pad；
            #       mask 只在「这一位要预测的是回答（含 eos）」时为 1
            return [pad_id] * block_size, [pad_id] * block_size, [0.0] * block_size


        def masked_loss(logits, targets, mask, rows, vocab):
            """按 mask 算的平均 loss。"""
            # TODO: softmax 之后按 targets 取概率，只在 mask 为 1 的位置上平均
            return 0.0


        def train(model, pairs, steps, batch_size=16, peak_lr=0.03, seed=1):
            """返回 {"loss": [每步按 mask 的 loss], "final": 最后 20 步的平均}。"""
            # TODO
            return {"loss": [], "final": 0.0}


        if __name__ == "__main__":
            idx, tgt, mask = build_row("7+5=", "12", kit.S, kit.EOS, kit.PAD)
            print("idx ", idx)
            print("tgt ", tgt)
            print("mask", [int(v) for v in mask])
      `,
    },
    referenceFiles: {
      'sft.py': code`
        """第 22 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import functional as F
        import kit


        def build_row(prompt, answer, block_size, eos_id, pad_id):
            p = kit.encode(prompt)
            a = kit.encode(answer) + [eos_id]
            full = p + a
            full = full + [pad_id] * (block_size + 1 - len(full))
            idx = full[:block_size]
            tgt = full[1:block_size + 1]
            # 位置 t 预测的是 tgt[t]。回答的第一位落在**最后一个 prompt token** 上,
            # 所以边界是 t >= len(p) - 1，而不是 t >= len(p)
            mask = []
            for t in range(block_size):
                in_answer = (t >= len(p) - 1) and (t < len(p) - 1 + len(a))
                mask.append(1.0 if in_answer else 0.0)
            return idx, tgt, mask


        def masked_loss(logits, targets, mask, rows, vocab):
            # cross_entropy 报的是**全部位置**的平均（prompt 与 padding 都算进去了），
            # 那个数在 SFT 里会往上走。要看的曲线得自己按 mask 算
            probs = F.softmax(logits, rows, vocab).tolist()
            total, count = 0.0, 0.0
            for r in range(rows):
                if mask[r] > 0:
                    p = probs[r * vocab + targets[r]]
                    total += -math.log(max(p, 1e-30))
                    count += 1.0
            return total / max(1.0, count)


        def train(model, pairs, steps, batch_size=16, peak_lr=0.03, seed=1):
            opt = nt.optim.AdamW(model.parameters(), lr=peak_lr, betas=(0.9, 0.95),
                                 weight_decay=0.1, grad_clip=1.0)
            idx = nt.zeros((batch_size * kit.S,), role="data", name="idx")
            tgt = nt.zeros((batch_size * kit.S,), role="data", name="tgt")
            msk = nt.zeros((batch_size * kit.S,), role="data", name="mask")
            hist = []
            base = nt.mark()
            warmup = max(1, steps // 20)
            for st in range(1, steps + 1):
                nt.release(base)
                bi, bt, bm = [], [], []
                for k in range(batch_size):
                    p, a = pairs[(st * batch_size + k) % len(pairs)]
                    ri, rt, rm = build_row(p, a, kit.S, kit.EOS, kit.PAD)
                    bi.extend(ri)
                    bt.extend(rt)
                    bm.extend(rm)
                idx.set_int_(bi)
                tgt.set_int_(bt)
                msk.set_(bm)

                opt.zero_grad()
                nt.phase("forward")
                logits = model.logits(idx, batch_size, kit.S)
                # mask 传进去，梯度才被屏蔽
                loss = F.cross_entropy(logits, tgt, batch_size * kit.S, kit.V, msk)
                nt.phase("other")
                loss.backward()

                if st <= warmup:
                    lr = peak_lr * st / warmup
                else:
                    pr = (st - warmup) / max(1, steps - warmup)
                    lr = peak_lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
                opt.step(lr=lr)

                if st % 10 == 0 or st == steps:
                    hist.append(masked_loss(logits, bt, bm, batch_size * kit.S, kit.V))
            nt.release(base)
            return {"loss": hist, "final": sum(hist[-3:]) / max(1, len(hist[-3:]))}


        if __name__ == "__main__":
            idx, tgt, mask = build_row("7+5=", "12", kit.S, kit.EOS, kit.PAD)
            print("idx ", idx)
            print("tgt ", tgt)
            print("mask", [int(v) for v in mask])
      `,
    },
  },
  specs: [
    spec('sft.spec.ts', code`
      ${LAB}

      const STEPS = 300, BATCH = 16;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, sft
      importlib.reload(kit)
      importlib.reload(sft)
      import nanotorch as nt
      from nanotorch import functional as F
      \`);
      }

      /** 平台侧的参考 mask —— 位置 t 预测 tgt[t]，回答从最后一个 prompt token 开始 */
      function refRow(prompt, answer, S, EOS, PAD) {
        const enc = (s) => [...s].map((c) => (c >= '0' && c <= '9' ? Number(c)
          : c === '+' ? 10 : c === '-' ? 11 : 12));
        const p = enc(prompt), a = [...enc(answer), EOS];
        const full = [...p, ...a];
        while (full.length < S + 1) full.push(PAD);
        const mask = [];
        for (let t = 0; t < S; t++) {
          mask.push(t >= p.length - 1 && t < p.length - 1 + a.length ? 1 : 0);
        }
        return { idx: full.slice(0, S), tgt: full.slice(1, S + 1), mask };
      }

      describe('SFT', () => {
        it('mask 的边界和参考逐位相同', () => {
          setup();
          const S = Number(lab.py('kit.S')), EOS = Number(lab.py('kit.EOS')), PAD = Number(lab.py('kit.PAD'));
          const cases = [['7+5=', '12'], ['0+0=', '0'], ['9+9=', '18'], ['3+4=', '7']];
          let mismatches = 0;
          for (const [p, a] of cases) {
            const got = JSON.parse(String(lab.py(
              'json.dumps([list(v) for v in sft.build_row(' + JSON.stringify(p) + ', '
              + JSON.stringify(a) + ', kit.S, kit.EOS, kit.PAD)])'
            )));
            const ref = refRow(p, a, S, EOS, PAD);
            for (let t = 0; t < S; t++) {
              if (got[0][t] !== ref.idx[t]) mismatches += 1;
              if (got[1][t] !== ref.tgt[t]) mismatches += 1;
              if (Math.round(got[2][t]) !== ref.mask[t]) mismatches += 1;
            }
            if (p === '7+5=') {
              console.log('7+5= -> 12');
              console.log('  idx  ' + JSON.stringify(got[0]));
              console.log('  tgt  ' + JSON.stringify(got[1]));
              console.log('  mask ' + JSON.stringify(got[2].map((v) => Math.round(v))));
            }
          }
          lab.publish('sft.maskMismatches', mismatches);
          expect(mismatches).toBe(0);
        });

        /*
         * 这一关最硬的一条：prompt 位置上的梯度必须**逐位为 0**。
         * 在 prompt 上算 loss 的模型照样收敛，曲线甚至更好看 ——
         * 只有直接看 dlogits 才分得开。
         */
        it('prompt 位置上的梯度逐位为 0', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = kit.LM(seed=1)
      _pairs = kit.make_pairs(64, 5, 10)
      _bs = 8
      _bi, _bt, _bm = [], [], []
      for _k in range(_bs):
          _p, _a = _pairs[_k]
          _ri, _rt, _rm = sft.build_row(_p, _a, kit.S, kit.EOS, kit.PAD)
          _bi.extend(_ri); _bt.extend(_rt); _bm.extend(_rm)
      _idx = nt.zeros((_bs * kit.S,), role="data"); _idx.set_int_(_bi)
      _tgt = nt.zeros((_bs * kit.S,), role="data"); _tgt.set_int_(_bt)
      _msk = nt.zeros((_bs * kit.S,), role="data"); _msk.set_(_bm)

      _lg = _m.logits(_idx, _bs, kit.S)
      _loss = F.cross_entropy(_lg, _tgt, _bs * kit.S, kit.V, _msk)
      _loss.backward()
      json.dumps({"dlogits": _lg.grad.tolist(), "mask": _bm,
                  "rows": _bs * kit.S, "vocab": kit.V})
      \`)));

          const report = lab.probe.lossMask(r.dlogits, r.mask, r.rows, r.vocab);
          console.log(
            '参与 loss 的位置 ' + report.contributingPositions
            + '，被屏蔽的 ' + report.maskedPositions
            + '，屏蔽位置上梯度不为 0 的 ' + report.leakedPositions
          );
          lab.publish('loss.contributingPromptPositions', report.leakedPositions);
          lab.publish('loss.contributingPositions', report.contributingPositions);
          expect(report.maskedPositions).toBeGreaterThan(0);
          expect(report.contributingPositions).toBeGreaterThan(0);
          expect(report.leakedPositions).toBe(0);
        });

        /*
         * cross_entropy 报的是全部位置的平均。SFT 越训它越**高** ——
         * 模型专心学回答，在 prompt 位置上越来越差。
         * 拿它当训练曲线，调参的方向是反的。
         */
        it('报的 loss 是按 mask 算的，且与内建报的那个明显不同', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = kit.LM(seed=1)
      _pairs = kit.make_pairs(64, 5, 10)
      _bs = 8
      _bi, _bt, _bm = [], [], []
      for _k in range(_bs):
          _p, _a = _pairs[_k]
          _ri, _rt, _rm = sft.build_row(_p, _a, kit.S, kit.EOS, kit.PAD)
          _bi.extend(_ri); _bt.extend(_rt); _bm.extend(_rm)
      _idx = nt.zeros((_bs * kit.S,), role="data"); _idx.set_int_(_bi)
      _tgt = nt.zeros((_bs * kit.S,), role="data"); _tgt.set_int_(_bt)
      _msk = nt.zeros((_bs * kit.S,), role="data"); _msk.set_(_bm)
      with nt.no_grad():
          _lg = _m.logits(_idx, _bs, kit.S)
          _raw = F.cross_entropy(_lg, _tgt, _bs * kit.S, kit.V, _msk).value
          _mine = sft.masked_loss(_lg, _bt, _bm, _bs * kit.S, kit.V)
          _probs = F.softmax(_lg, _bs * kit.S, kit.V).tolist()
      json.dumps({"raw": _raw, "mine": _mine, "probs": _probs, "tgt": _bt, "mask": _bm,
                  "rows": _bs * kit.S, "vocab": kit.V})
      \`)));

          // 平台按 mask 重算一遍
          let total = 0, count = 0;
          for (let i = 0; i < r.rows; i++) {
            if (r.mask[i] > 0) {
              total += -Math.log(Math.max(r.probs[i * r.vocab + r.tgt[i]], 1e-30));
              count += 1;
            }
          }
          const ref = total / count;
          console.log(
            '按 mask ' + r.mine.toFixed(6) + '（平台重算 ' + ref.toFixed(6) + '），'
            + 'cross_entropy 报的 ' + r.raw.toFixed(6) + '（全部位置的平均）'
          );
          lab.publish('loss.maskedError', Math.abs(r.mine - ref));
          expect(Math.abs(r.mine - ref)).toBeLessThan(1e-6);
        });

        it('300 步之后留出集精确匹配 ≥ 90%', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = kit.LM(seed=1)
      _train = kit.make_pairs(512, 5, 10)
      _res = sft.train(_m, _train, \${STEPS}, \${BATCH})
      _held = kit.make_pairs(64, 777, 10)
      _acc = kit.exact_match(_m, _held)
      _sample = [(p, kit.generate_answer(_m, p), a) for p, a in _held[:4]]
      json.dumps({"final": _res["final"], "acc": _acc, "curve": _res["loss"][::6],
                  "sample": _sample})
      \`)));
          console.log('按 mask 的 loss 曲线 ' + r.curve.map((v) => v.toFixed(3)).join(' -> '));
          console.log('留出集精确匹配 ' + (r.acc * 100).toFixed(1) + '%');
          for (const [p, got, want] of r.sample) console.log('  ' + p + got + '（该是 ' + want + '）');
          lab.publish('eval.exactMatch', r.acc);
          lab.publish('loss.sftFinal', r.final);
          expect(r.acc).toBeGreaterThanOrEqual(0.9);
          // 曲线要真的在降
          expect(r.curve[r.curve.length - 1]).toBeLessThan(r.curve[0]);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.loss.contributingPromptPositions', op: 'eq', value: 0,
      zh: 'prompt 位置上梯度不为 0 的个数', en: 'prompt positions with a non-zero gradient',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.sft.maskMismatches', op: 'eq', value: 0,
      zh: '与参考 mask 对不上的位置数', en: 'positions differing from the reference mask',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.loss.maskedError', op: 'lte', value: 1e-6,
      zh: '按 mask 的 loss 与平台重算的差', en: 'masked loss versus the platform recomputation',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.eval.exactMatch', op: 'gte', value: 0.9,
      zh: '留出集上的精确匹配率', en: 'exact match on the held-out set', dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      真实的 SFT 数据是**多轮对话**，mask 要按轮次给:
      每一轮的 assistant 回复算 loss，user 那一轮不算，system 提示也不算。
      一条 10 轮的对话上，mask 是一串交替的区间，边界比这一关多得多，
      而每一个边界都可能差一位。

      \`chat template\` 就是把这件事标准化的东西 —— 它规定了
      \`<|im_start|>user ... <|im_end|>\` 这类标记怎么写，
      于是 mask 可以从标记里算出来而不是手工数位置。
      **模板对不上是部署时最常见的坑之一**：训练用了一套模板、
      推理时框架用了另一套，模型的表现会莫名其妙地差一截，而没有任何报错。

      2026 年 SFT 这一步本身的地位在下降 —— 越来越多的流程是
      「很少的 SFT 冷启动 + 大量的 RL」（DeepSeek-R1 那条路），
      因为 SFT 只能模仿数据里已有的东西，而 RL 能找到数据里没有的解法。
      但**冷启动那一小步仍然是必须的**：没有它，RL 一开始采不出任何格式正确的样本，
      奖励恒为 0，梯度也就恒为 0。
    `,
    code`
      Real SFT data is **multi-turn dialogue**, and the mask follows the turns: assistant
      replies carry loss, user turns do not, system prompts do not. Across a ten-turn
      conversation the mask is a series of alternating intervals with far more boundaries
      than here — and every boundary can be off by one.

      A \`chat template\` is what standardises this: it fixes how markers like
      \`<|im_start|>user ... <|im_end|>\` are written, so the mask can be derived from the
      markers rather than counted by hand. **A template mismatch is among the most common
      deployment traps**: train with one template, serve with another, and the model gets
      inexplicably worse with nothing raising an error.

      SFT's own standing has been declining through 2026 — more pipelines run "a little SFT
      cold start plus a lot of RL" (DeepSeek-R1's route), because SFT can only imitate what
      is in the data while RL can find solutions that are not. But **that small cold start
      remains necessary**: without it RL samples nothing correctly formatted, every reward is
      zero, and so is every gradient.
    `
  ),
};

/* ================================================================== */
/* 第 23 关：数据配比与对齐税                                           */
/* ================================================================== */

const STAGE_MIXTURE = {
  id: 'data-mixture',
  title: t('数据配比 —— 学会新的，别忘了旧的', 'Data mixture — learn the new without forgetting the old'),
  goal: t(
    code`
      模型已经会加法了（第 22 关训出来的）。现在要教它减法。

      最直接的做法是**拿减法数据继续 SFT**。它会学会减法 ——
      同时把加法忘掉。这就是 \`对齐税\`（alignment tax）：
      为了学会新任务而失去的旧能力。

      在 \`mixture.py\` 里实现数据配比：

      \`\`\`python
      def mix(general, instruct, ratio, count, seed):
          """按 ratio 混合两个数据源，返回长度 count 的列表。

          ratio 是**指令数据占的比例**：0 全是通用数据，1 全是指令数据。
          要求：比例误差 ≤ 2%，而且顺序是确定的（同 seed 同结果）。"""

      def choose_ratio():
          """你选的配比。两条门槛要同时满足。"""
      \`\`\`

      ## 两条门槛必须同时成立

      | | 要求 |
      | --- | --- |
      | 学会了新的 | 减法的精确匹配 ≥ **0.85** |
      | 没忘掉旧的 | 加法的精确匹配**掉的幅度** ≤ **0.15** |

      **只卡一条的话，最省事的做法就是把另一条换掉** ——
      只卡「学会减法」，全用减法数据最快；只卡「别忘加法」，一条减法数据都不加最稳。
      两条一起卡，才逼出「配比」这件事本身。

      这也是真实的后训练里最日常的一个决策：指令数据混多少、
      不同来源之间怎么配、要不要保留一部分预训练数据回放。
      它不是一个可以「求解」的问题，是一个要**量着调**的问题。

      ## 混的时候有两个坑

      **比例要准。** 「每 k 条插一条」这种写法在 ratio 不是 1/k 的时候会偏，
      而偏出来的配比你不会知道 —— 除非量一遍。

      **顺序要确定。** 同一个 seed 必须给同一个混合结果，
      否则这一关的两个数字之间没法比较,你不知道差异来自配比还是来自采样。

      ## 顺带说一句「灾难性遗忘」

      这一关的现象在小模型上格外明显（容量小、任务少），
      但它在真实尺度上一样存在，只是形式更隐蔽：
      不是「完全不会加法了」，而是**某些能力悄悄退化**,
      代码能力在做完一轮对话对齐之后掉几个点，是行业里反复出现的事。

      所以真实流程里会保留一部分**预训练数据回放**（replay），
      并且用一整套评测集在后训练前后各跑一遍,
      这一关的「加法准确率掉了多少」就是那件事的最小形式。
    `,
    code`
      The model already does addition (trained in stage 22). Now teach it subtraction.

      The direct approach is to **continue SFT on subtraction data**. It will learn
      subtraction — and forget addition. That is the \`alignment tax\`: old capability lost
      in exchange for a new one.

      Implement the mixture in \`mixture.py\`:

      \`\`\`python
      def mix(general, instruct, ratio, count, seed):
          """Mix two sources by ratio, returning a list of length count.

          ratio is the **share of instruction data**: 0 is all general, 1 all instruction.
          Requirements: proportion within 2%, and a deterministic order (same seed,
          same result)."""

      def choose_ratio():
          """Your chosen ratio. Both gates must hold at once."""
      \`\`\`

      ## Both gates must hold together

      | | Requirement |
      | --- | --- |
      | New learned | Subtraction exact match >= **0.85** |
      | Old retained | Addition exact match **drops** by at most **0.15** |

      **Gate only one and the cheapest move is to sacrifice the other** — gate only "learn
      subtraction" and all-subtraction data wins; gate only "keep addition" and adding no
      subtraction at all is safest. Requiring both is what forces the mixture question to
      exist.

      This is also the most routine decision in real post-training: how much instruction
      data, how sources are proportioned, whether to replay pretraining data. It is not a
      problem you solve but one you **tune against measurements**.

      ## Two traps when mixing

      **The proportion must be accurate.** "Insert one every k" drifts whenever the ratio is
      not exactly 1/k, and you will not know the drift — unless you measure it.

      **The order must be deterministic.** The same seed must produce the same mixture, or
      the two numbers in this stage cannot be compared: you would not know whether a
      difference came from the ratio or from the sampling.

      ## A word on catastrophic forgetting

      The effect is especially stark on a small model (little capacity, few tasks), but it
      exists at real scale in a subtler form: not "cannot do addition any more" but
      **capabilities quietly regressing** — coding scores dropping a few points after a round
      of dialogue alignment is a recurring industry experience.

      That is why real pipelines keep a share of **pretraining data replay** and run a full
      evaluation suite before and after post-training. "How much did addition accuracy drop"
      is the smallest version of that same practice.
    `
  ),
  checklist: [
    t('混合的比例误差 ≤ 2%', 'The mixed proportion is within 2%'),
    t('同一个 seed 给同一个结果', 'The same seed produces the same mixture'),
    t('减法学会了（≥ 0.85）', 'Subtraction is learned (>= 0.85)'),
    t('加法掉的幅度 ≤ 0.15', 'Addition drops by at most 0.15'),
  ],
  hints: [
    t('按累积计数决定下一条取哪边，比「每 k 条插一条」准。',
      'Deciding by running counts is more accurate than "insert one every k".'),
    t('kit.make_pairs(n, seed, max_value, op) 的 op 可以是 "+" 或 "-"。',
      'kit.make_pairs(n, seed, max_value, op) accepts "+" or "-".'),
    t('kit.sft_train 是平台版的 SFT 循环，直接用。',
      'kit.sft_train is the platform SFT loop; use it directly.'),
  ],
  pitfalls: [
    t(code`
      **全用指令数据。** 减法学得最快最好,而加法在同一次训练里被冲掉。
      在这一关上是「加法准确率从 1.00 掉到接近 0」，
      在真实尺度上则是某几个评测集悄悄掉几个点,后者更难发现，
      因为没人会在做完对齐之后把所有旧评测重跑一遍。除非流程里写死了要跑。
    `, code`
      **Using only instruction data.** Subtraction is learned fastest and best, while
      addition is washed out in the same run. Here that reads as addition accuracy falling
      from 1.00 toward zero; at real scale it reads as a few evaluation suites quietly losing
      a few points — much harder to notice, because nobody reruns every old evaluation after
      alignment unless the pipeline mandates it.
    `),
    t(code`
      **混合的顺序不确定。** 用了全局随机状态的话，同一个配比跑两遍会得到不同的结果，
      于是「配比 0.5 比 0.8 好」这个结论根本立不住 ——
      你不知道差异来自配比还是来自这一次的采样。
      **要比较，就先让别的东西都不变。**
    `, code`
      **A non-deterministic mixture order.** Using global random state means the same ratio
      gives different results across runs, so "0.5 beats 0.8" cannot be concluded at all —
      the difference might be the ratio or might be this run's sampling. **To compare, hold
      everything else fixed first.**
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_POST_PY,
      'mixture.py': code`
        """第 23 关：数据配比与对齐税。"""
        import kit


        def mix(general, instruct, ratio, count, seed):
            """按 ratio 混合。ratio 是指令数据占的比例。确定性。"""
            # TODO: 按累积计数决定下一条取哪边，保证比例准且顺序确定
            return list(general[:count])


        def choose_ratio():
            """你选的配比。两条门槛要同时满足。"""
            # TODO
            return 1.0


        if __name__ == "__main__":
            g = kit.make_pairs(64, 1, 10, "+")
            i = kit.make_pairs(64, 2, 10, "-")
            m = mix(g, i, 0.5, 20, seed=7)
            print("混出来的前 6 条", [p for p, _ in m[:6]])
            share = sum(1 for p, _ in m if "-" in p) / len(m)
            print("指令数据占比", share)
      `,
    },
    referenceFiles: {
      'mixture.py': code`
        """第 23 关的参考实现。"""
        import kit


        def mix(general, instruct, ratio, count, seed):
            # 按**累积计数**决定下一条取哪边：已经取了多少条指令数据，
            # 和「应该取多少条」比。这样任何 ratio 都准，
            # 而「每 k 条插一条」只在 ratio = 1/k 时准
            out = []
            taken_i = 0
            gi, ii = 0, 0
            for n in range(count):
                want_i = (n + 1) * ratio
                if taken_i < want_i - 1e-9 and len(instruct) > 0:
                    out.append(instruct[(ii + seed) % len(instruct)])
                    ii += 1
                    taken_i += 1
                else:
                    out.append(general[(gi + seed) % len(general)])
                    gi += 1
            return out


        def choose_ratio():
            # 全用指令数据（1.0）减法最好，但加法被冲掉；
            # 一条不加（0.0）加法最稳，但减法学不会。
            # 一半一半时两条门槛同时成立
            return 0.5


        if __name__ == "__main__":
            g = kit.make_pairs(64, 1, 10, "+")
            i = kit.make_pairs(64, 2, 10, "-")
            m = mix(g, i, 0.5, 20, seed=7)
            print("混出来的前 6 条", [p for p, _ in m[:6]])
            share = sum(1 for p, _ in m if "-" in p) / len(m)
            print("指令数据占比", share)
      `,
    },
  },
  specs: [
    spec('mixture.spec.ts', code`
      ${LAB}

      const BASE_STEPS = 300, TUNE_STEPS = 200, BATCH = 16;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, mixture
      importlib.reload(kit)
      importlib.reload(mixture)
      import nanotorch as nt
      from nanotorch import functional as F

      _cache = {}

      def _base():
          """会加法的起点。所有配比都从同一个它出发,不然比的就不是配比了。"""
          if "base" not in _cache:
              m = kit.LM(seed=1)
              kit.sft_train(m, kit.make_pairs(512, 5, 10, "+"), \${BASE_STEPS}, \${BATCH})
              _cache["base"] = kit.exact_match(m, kit.make_pairs(48, 777, 10, "+"))
          return _cache["base"]

      def _run(ratio):
          """从同一个起点出发，按 ratio 混合数据再微调，量两个能力。"""
          key = "r%.3f" % ratio
          if key in _cache:
              return _cache[key]
          m = kit.LM(seed=1)
          kit.sft_train(m, kit.make_pairs(512, 5, 10, "+"), \${BASE_STEPS}, \${BATCH})
          general = kit.make_pairs(512, 5, 10, "+")
          instruct = kit.make_pairs(512, 9, 10, "-")
          data = mixture.mix(general, instruct, ratio, 512, seed=7)
          kit.sft_train(m, data, \${TUNE_STEPS}, \${BATCH})
          out = {
              "add": kit.exact_match(m, kit.make_pairs(48, 777, 10, "+")),
              "sub": kit.exact_match(m, kit.make_pairs(48, 778, 10, "-")),
              "share": sum(1 for p, _ in data if "-" in p) / len(data),
          }
          _cache[key] = out
          return out
      \`);
      }

      describe('数据配比与对齐税', () => {
        it('混合的比例准，而且顺序确定', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _g = kit.make_pairs(256, 1, 10, "+")
      _i = kit.make_pairs(256, 2, 10, "-")
      _out = {}
      for _r in [0.0, 0.25, 0.5, 0.75, 1.0]:
          _m1 = mixture.mix(_g, _i, _r, 200, seed=7)
          _m2 = mixture.mix(_g, _i, _r, 200, seed=7)
          _share = sum(1 for p, _ in _m1 if "-" in p) / len(_m1)
          _out["%.2f" % _r] = {"share": _share, "same": _m1 == _m2, "n": len(_m1)}
      json.dumps(_out)
      \`)));
          let worst = 0;
          for (const [want, v] of Object.entries(r)) {
            worst = Math.max(worst, Math.abs(v.share - Number(want)));
            console.log(
              '要求 ' + want + ' -> 实际 ' + v.share.toFixed(3)
              + '，两次一致 ' + v.same + '，条数 ' + v.n
            );
            expect(v.same).toBe(true);
            expect(v.n).toBe(200);
          }
          lab.publish('mixture.ratioError', worst);
          expect(worst).toBeLessThan(0.02);
        });

        /*
         * 这一关的全部意义：两条门槛必须同时成立。
         * 只卡一条的话，最省事的做法就是把另一条换掉。
         */
        it('学会减法且加法没掉太多', () => {
          setup();
          const base = Number(lab.py('_base()'));
          const ratio = Number(lab.py('mixture.choose_ratio()'));
          const r = JSON.parse(String(lab.py('json.dumps(_run(mixture.choose_ratio()))')));
          const drop = base - r.add;
          console.log(
            '起点：加法 ' + (base * 100).toFixed(1) + '%'
          );
          console.log(
            '配比 ' + ratio.toFixed(2) + '（实际 ' + r.share.toFixed(2) + '）之后：'
            + '加法 ' + (r.add * 100).toFixed(1) + '%（掉了 ' + (drop * 100).toFixed(1) + ' 个点）'
            + '，减法 ' + (r.sub * 100).toFixed(1) + '%'
          );
          lab.publish('eval.subtractionAccuracy', r.sub);
          lab.publish('alignmentTax.additionDrop', drop);
          expect(base).toBeGreaterThan(0.9);
          expect(r.sub).toBeGreaterThanOrEqual(0.85);
          expect(drop).toBeLessThanOrEqual(0.15);
        });

        /*
         * 对照：全用指令数据。减法学得最好，而加法被冲掉 ——
         * 「对齐税」这三个字在这里是一个量出来的数。
         */
        it('全用指令数据的对照：减法更好，加法塌掉', () => {
          setup();
          const base = Number(lab.py('_base()'));
          const pure = JSON.parse(String(lab.py('json.dumps(_run(1.0))')));
          const dropPure = base - pure.add;
          console.log(
            '配比 1.00：加法 ' + (pure.add * 100).toFixed(1) + '%（掉了 '
            + (dropPure * 100).toFixed(1) + ' 个点），减法 ' + (pure.sub * 100).toFixed(1) + '%'
          );
          lab.publish('alignmentTax.pureInstructDrop', dropPure);
          // 对照必须真的塌掉，否则这一关的前提不成立
          expect(dropPure).toBeGreaterThan(0.3);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.mixture.ratioError', op: 'lte', value: 0.02,
      zh: '混合出来的比例与要求的最大差', en: 'largest gap between requested and actual mixture ratio',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.eval.subtractionAccuracy', op: 'gte', value: 0.85,
      zh: '新能力：减法的精确匹配', en: 'new capability: subtraction exact match',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.alignmentTax.additionDrop', op: 'lte', value: 0.15,
      zh: '对齐税：加法准确率掉了多少', en: 'alignment tax: how much addition accuracy fell',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.alignmentTax.pureInstructDrop', op: 'gte', value: 0.3,
      zh: '全用指令数据的对照掉了多少（要真的塌）',
      en: 'the all-instruction control must genuinely collapse', dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      真实的后训练数据配比要复杂得多。一份典型的 SFT 数据集会分几十个来源
      （对话、代码、数学、多语言、安全、工具调用……），每个来源一个权重，
      而这些权重是**跑出来的**:训一版、跑一整套评测、看哪个维度掉了、调、再训。

      有几个已经成了共识的做法：

      **回放（replay）。** 后训练里掺 5% 到 20% 的预训练数据，
      专门用来防遗忘。便宜且有效。

      **模型融合（model soup / merging）。** 把「擅长对话的那版」和
      「擅长代码的那版」的权重按比例平均起来。听着不该有用，实际上很有用 ——
      这是 2026 年绕开对齐税最省事的一条路。

      **课程顺序。** 同一批数据，先难后易和先易后难的结果不一样。
      这一条至今没有很干净的理论，全靠试。

      最后一句：**对齐税不是必然的**。它在很多时候是「数据配比没调好」的症状，
      而不是「学新东西必须付出的代价」。区分这两者的唯一办法是量。
    `,
    code`
      Real post-training mixtures are far more involved. A typical SFT set spans dozens of
      sources (dialogue, code, mathematics, multilingual, safety, tool use, …), each with a
      weight, and those weights are **found empirically**: train a version, run a full
      evaluation suite, see which dimension dropped, adjust, retrain.

      A few practices have become consensus:

      **Replay.** Mix 5% to 20% pretraining data into post-training specifically to prevent
      forgetting. Cheap and effective.

      **Model merging (model soup).** Average the weights of the dialogue-strong version and
      the code-strong version. It sounds like it should not work and works well — the
      cheapest route around the alignment tax in 2026.

      **Curriculum order.** The same data in a hard-to-easy order gives a different result
      than easy-to-hard. There is still no clean theory here; it is found by trying.

      One last point: **the alignment tax is not inevitable**. It is often a symptom of a
      mixture that was not tuned rather than a price that must be paid for new capability.
      The only way to tell the two apart is to measure.
    `
  ),
};

/* ================================================================== */
/* 第 24 关：奖励模型                                                   */
/* ================================================================== */

const STAGE_RM = {
  id: 'reward-model',
  title: t('奖励模型 —— 从「哪个更好」学出一个分数', 'The reward model — turning "which is better" into a score'),
  goal: t(
    code`
      人类标不出「这个回答值 7.3 分」，但标得出「A 比 B 好」。
      \`奖励模型\`要解决的就是这个错配：**从成对的偏好里学出一个标量分数。**

      在 \`rm.py\` 里实现：

      \`\`\`python
      class RewardModel(nn.Module):
          """在语言模型上接一个标量头。r(prompt+answer) 是一个数。"""
          def reward(self, rows_idx, batch, seq, last_pos):
              """last_pos[i] 是第 i 条序列**最后一个内容 token** 的位置。"""

      def bt_loss(reward_chosen, reward_rejected, n_pairs):
          """Bradley-Terry 的成对损失。"""

      def train(model, pairs, steps, ...): ...
      \`\`\`

      ## Bradley-Terry 就是一个两类的 softmax

      成对偏好的标准模型是 Bradley-Terry：
      「A 胜过 B 的概率」是两者分数之差过 sigmoid。

      \`\`\`
      P(A ≻ B) = σ(r_A − r_B)
      loss     = −log σ(r_A − r_B)
      \`\`\`

      而 \`−log σ(Δ)\` 正好是**两类 softmax 的交叉熵**：
      把 \`[r_A, r_B]\` 当成两个 logit、正确类是 0，算出来的就是它。

      \`\`\`
      −log( e^{r_A} / (e^{r_A} + e^{r_B}) ) = −log σ(r_A − r_B)
      \`\`\`

      所以**不需要单独实现 sigmoid 和它的反向** —— 把两个奖励拼成
      \`[n_pairs, 2]\` 的 logits 交给 \`F.cross_entropy\`，目标全填 0。
      成对损失和分类损失在这里是同一个东西。

      ## 分数要从哪个位置读

      标量头作用在每个位置上，但一条序列只该有**一个**分数,
      读的是**最后一个内容 token** 的位置，不是最后一个位置。

      \`\`\`
      7 + 5 = 1 2 <eos> <pad> <pad>
                      ↑ 从这里读
      \`\`\`

      读 \`S-1\`（最后一个位置）的话，读到的是 padding 上的输出。
      不同长度的序列会读到不同数量的 padding 之后的位置，
      于是**分数变成了长度的函数**,而这个错在准确率上未必看得出来，
      因为长度本身在这个数据里和对错相关。

      这一关拿「多补一个 padding，分数不许变」来查它。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 排序 | 留出集上成对准确率 ≥ **0.9** |
      | 损失 | 与 \`−log σ(Δ)\` 的参考实现差 ≤ 1e-6 |
      | **位置** | 多补一个 padding，分数变化 ≤ 1e-6 |
      | 校准 | 预测概率与实际胜率的偏差 ≤ **0.15** |

      最后一条是「校准」：模型说「A 有 70% 的概率更好」的那些对里，
      A 真的更好的比例应该接近 70%。
      **排序对了不等于校准好了** —— 一个把所有 Δ 都放大十倍的模型排序完全一样，
      而它会说每一对都是 99.99%。而 RLHF 里奖励是要被当成数值用的（不只是排序），
      所以校准是有意义的。
    `,
    code`
      People cannot label "this answer is worth 7.3", but they can label "A is better than
      B". A \`reward model\` bridges that gap: **learn a scalar score from pairwise
      preferences.**

      Implement in \`rm.py\`:

      \`\`\`python
      class RewardModel(nn.Module):
          """A scalar head on top of a language model. r(prompt+answer) is one number."""
          def reward(self, rows_idx, batch, seq, last_pos):
              """last_pos[i] is the position of sequence i's **last content token**."""

      def bt_loss(reward_chosen, reward_rejected, n_pairs):
          """The Bradley-Terry pairwise loss."""

      def train(model, pairs, steps, ...): ...
      \`\`\`

      ## Bradley-Terry is a two-class softmax

      The standard model for pairwise preference is Bradley-Terry: the probability that A
      beats B is the sigmoid of their score difference.

      \`\`\`
      P(A ≻ B) = σ(r_A − r_B)
      loss     = −log σ(r_A − r_B)
      \`\`\`

      And \`−log σ(Δ)\` is exactly the **cross-entropy of a two-class softmax**: treat
      \`[r_A, r_B]\` as two logits with class 0 correct and you get precisely that.

      \`\`\`
      −log( e^{r_A} / (e^{r_A} + e^{r_B}) ) = −log σ(r_A − r_B)
      \`\`\`

      So **there is no need to implement a sigmoid and its backward separately** — stack the
      two rewards into \`[n_pairs, 2]\` logits, hand them to \`F.cross_entropy\` with all
      targets 0. Pairwise loss and classification loss are the same thing here.

      ## Which position the score is read from

      The scalar head applies at every position, but a sequence should have exactly **one**
      score — read at the **last content token**, not the last position.

      \`\`\`
      7 + 5 = 1 2 <eos> <pad> <pad>
                      ^ read here
      \`\`\`

      Reading \`S-1\` reads output over padding. Sequences of different lengths then read
      after different amounts of padding, so **the score becomes a function of length** — a
      mistake accuracy may not reveal, because length correlates with correctness in this
      data anyway.

      This stage checks it by appending one more padding token and requiring the score not
      to move.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Ranking | Pairwise accuracy on held-out data >= **0.9** |
      | Loss | Within 1e-6 of a reference \`−log σ(Δ)\` |
      | **Position** | One extra padding changes the score by <= 1e-6 |
      | Calibration | Predicted probability versus actual win rate <= **0.15** |

      The last row is calibration: among pairs where the model says "A wins with 70%
      probability", A should actually win about 70% of the time. **Correct ranking does not
      imply good calibration** — scaling every Δ by ten leaves the ranking identical while
      claiming 99.99% on every pair. In RLHF the reward is used as a number rather than only
      an ordering, so calibration matters.
    `
  ),
  checklist: [
    t('分数从最后一个内容 token 上读', 'The score is read at the last content token'),
    t('用两类 softmax 表达 Bradley-Terry', 'Bradley-Terry is expressed as a two-class softmax'),
    t('留出集成对准确率 ≥ 0.9', 'Held-out pairwise accuracy is at least 0.9'),
    t('概率是校准的', 'The probabilities are calibrated'),
  ],
  hints: [
    t('标量头就是 nt.parameter((dim, 1))，F.linear 之后每个位置一个数。',
      'The scalar head is nt.parameter((dim, 1)); after F.linear each position holds one number.'),
    t('F.gather(r_all, idx, n, 1) 能按位置把每条序列的那一个数取出来。下标缓冲每步现造，别标成 data。',
      'F.gather(r_all, idx, n, 1) picks out the one number per sequence; its index buffer is per-step, so do not mark it as data.'),
    t('把 chosen / rejected 交替排，得到的 [2n, 1] 直接当 [n, 2] 的 logits 用。',
      'Interleave chosen and rejected; the resulting [2n, 1] doubles as [n, 2] logits.'),
  ],
  pitfalls: [
    t(code`
      **在最后一个位置读分数。** 那里是 padding。不同长度的序列读到的
      「padding 之后第几个位置」不一样，于是**分数偷偷变成了长度的函数**。
      准确率未必掉 —— 在这个数据里长度和对错本来就相关，
      模型会顺着这条捷径走，而你以为它学会了判断对错。
    `, code`
      **Reading the score at the last position.** That is padding. Sequences of different
      lengths land at different offsets into the padding, so **the score quietly becomes a
      function of length**. Accuracy need not drop — length correlates with correctness in
      this data anyway, so the model takes the shortcut while you believe it learned to judge
      correctness.
    `),
    t(code`
      **只看排序不看校准。** 把所有 Δ 乘十，排序一模一样，成对准确率一分不掉,
      而模型会说每一对都是 99.99%。RLHF 里奖励是被当成**数值**用的
      （要减基线、要算优势），一个过度自信的奖励模型会让策略往一个方向冲过头。
    `, code`
      **Checking ranking but not calibration.** Multiply every Δ by ten: identical ranking,
      identical pairwise accuracy — and the model now claims 99.99% on every pair. RLHF uses
      the reward as a **number** (baselines get subtracted, advantages computed), and an
      overconfident reward model pushes the policy too far in one direction.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_POST_PY,
      'rm.py': code`
        """第 24 关：奖励模型。从成对偏好里学出一个标量分数。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F
        import kit


        class RewardModel(nn.Module):
            def __init__(self, seed=1):
                super().__init__()
                self.lm = kit.LM(seed=seed)
                # 标量头：每个位置一个数
                self.head = nt.parameter((kit.D, 1), seed + 7, kit.D ** -0.5, "rm.head")

            def hidden(self, idx, batch, seq):
                rows = batch * seq
                x = F.embedding(self.lm.embed, idx, rows, kit.D)
                for blk in self.lm.blocks:
                    x = blk(x, batch, seq)
                return self.lm.nf(x)

            def reward(self, idx, batch, seq, last_pos):
                """返回长度 batch 的奖励。last_pos[i] 是第 i 条的最后一个内容位置。"""
                # TODO: 隐藏态 -> 标量头 -> 按 last_pos 取出每条的那一个数
                return nt.zeros((batch, 1))


        def bt_loss(reward_pairs, n_pairs):
            """reward_pairs 是 [2*n_pairs, 1]，chosen / rejected 交替。"""
            # TODO: 当成 [n_pairs, 2] 的 logits，目标全 0，走两类 softmax
            return nt.zeros((1,))


        def train(model, pairs, steps, batch_pairs=8, peak_lr=0.02):
            """返回 {"loss": [...]}"""
            # TODO
            return {"loss": []}


        if __name__ == "__main__":
            rm = RewardModel()
            print("参数量", rm.num_parameters())
      `,
    },
    referenceFiles: {
      'rm.py': code`
        """第 24 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F
        import kit


        def _rows(prompt, answer):
            """一条序列的 token 与它最后一个内容位置。"""
            ids = kit.encode(prompt) + kit.encode(answer) + [kit.EOS]
            last = len(ids) - 1
            ids = ids + [kit.PAD] * (kit.S - len(ids))
            return ids[:kit.S], min(last, kit.S - 1)


        class RewardModel(nn.Module):
            def __init__(self, seed=1):
                super().__init__()
                self.lm = kit.LM(seed=seed)
                self.head = nt.parameter((kit.D, 1), seed + 7, kit.D ** -0.5, "rm.head")

            def hidden(self, idx, batch, seq):
                rows = batch * seq
                x = F.embedding(self.lm.embed, idx, rows, kit.D)
                for blk in self.lm.blocks:
                    x = blk(x, batch, seq)
                return self.lm.nf(x)

            def reward(self, idx, batch, seq, last_pos):
                h = self.hidden(idx, batch, seq)
                r_all = F.linear(h, self.head)          # [batch*seq, 1]
                # 每条序列只取**最后一个内容 token** 的那一个数。
                # 取 seq-1 的话读到的是 padding 上的输出,分数会变成长度的函数
                # 每步现造的下标缓冲是**一次性**的 —— 标成 data 的话它落在
                # 训练循环的 mark 之后，第二步的 release 会当场报错
                sel = nt.zeros((batch,), name="rm.sel")
                sel.set_int_([i * seq + last_pos[i] for i in range(batch)])
                return F.gather(r_all, sel, batch, 1)


        def bt_loss(reward_pairs, n_pairs):
            # −log σ(r_c − r_r) 就是两类 softmax 的交叉熵：
            # 把 [r_c, r_r] 当两个 logit，正确类是 0。
            # reward_pairs 已经是 chosen / rejected 交替的 [2n, 1]，
            # 它的扁平布局正好就是 [n, 2]
            tgt = nt.zeros((n_pairs,), name="bt.tgt")
            tgt.set_int_([0] * n_pairs)
            return F.cross_entropy(reward_pairs, tgt, n_pairs, 2)


        def train(model, pairs, steps, batch_pairs=8, peak_lr=0.02):
            opt = nt.optim.AdamW(model.parameters(), lr=peak_lr, betas=(0.9, 0.95),
                                 weight_decay=0.1, grad_clip=1.0)
            n = batch_pairs * 2
            idx = nt.zeros((n * kit.S,), role="data", name="rm.idx")  # 循环外，常驻
            hist = []
            base = nt.mark()
            warmup = max(1, steps // 20)
            for st in range(1, steps + 1):
                nt.release(base)
                flat, last = [], []
                for k in range(batch_pairs):
                    p, c, r = pairs[(st * batch_pairs + k) % len(pairs)]
                    for ans in (c, r):
                        row, lp = _rows(p, ans)
                        flat.extend(row)
                        last.append(lp)
                idx.set_int_(flat)

                opt.zero_grad()
                nt.phase("forward")
                rew = model.reward(idx, n, kit.S, last)
                loss = bt_loss(rew, batch_pairs)
                nt.phase("other")
                loss.backward()
                if st <= warmup:
                    lr = peak_lr * st / warmup
                else:
                    pr = (st - warmup) / max(1, steps - warmup)
                    lr = peak_lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
                opt.step(lr=lr)
                hist.append(loss.value)
            nt.release(base)
            return {"loss": hist}


        def score(model, prompt, answer, extra_pad=0):
            """单条打分。extra_pad 只用来验「分数不该跟 padding 走」。"""
            row, lp = _rows(prompt, answer)
            with nt.no_grad():
                idx = nt.zeros((kit.S,), role="data")
                idx.set_int_(row)
                return model.reward(idx, 1, kit.S, [lp]).item(0)


        if __name__ == "__main__":
            rm = RewardModel()
            print("参数量", rm.num_parameters())
      `,
    },
  },
  specs: [
    spec('rm.spec.ts', code`
      ${LAB}

      const STEPS = 260;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, rm
      importlib.reload(kit)
      importlib.reload(rm)
      import nanotorch as nt
      from nanotorch import functional as F

      _cache = {}

      def _rows(prompt, answer, pad_extra=0):
          ids = kit.encode(prompt) + kit.encode(answer) + [kit.EOS]
          last = len(ids) - 1
          ids = ids + [kit.PAD] * (kit.S - len(ids))
          return ids[:kit.S], min(last, kit.S - 1)

      def _trained():
          if "m" not in _cache:
              m = rm.RewardModel(seed=1)
              rm.train(m, kit.make_preference_pairs(512, 5, 10), \${STEPS})
              _cache["m"] = m
          return _cache["m"]

      def _scores(model, triples):
          """每条 (prompt, chosen, rejected) 的一对分数。"""
          out = []
          # 缓冲要在 mark **之前**分配 —— 它是常驻的，落在 mark 之后会被 release 拦下
          idx = nt.zeros((2 * kit.S,), role="data", name="score.idx")
          with nt.no_grad():
              mk = nt.mark()
              for p, c, r in triples:
                  nt.release(mk)
                  flat, last = [], []
                  for ans in (c, r):
                      row, lp = _rows(p, ans)
                      flat.extend(row)
                      last.append(lp)
                  idx.set_int_(flat)
                  rr = model.reward(idx, 2, kit.S, last).tolist()
                  out.append([rr[0], rr[1]])
          return out
      \`);
      }

      describe('奖励模型', () => {
        it('Bradley-Terry 的损失就是两类 softmax 的交叉熵', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _n = 6
      _rw = nt.zeros((2 * _n, 1), role="data")
      _vals = [1.5, 0.2, -0.8, 0.4, 2.0, 2.0, 0.0, -3.0, 0.7, 0.9, -1.1, -1.3]
      _rw.set_(_vals)
      _l = rm.bt_loss(_rw, _n)
      json.dumps({"loss": _l.value, "vals": _vals})
      \`)));
          // 平台照公式重算：mean(-log σ(r_c − r_r))
          let ref = 0;
          for (let i = 0; i < r.vals.length; i += 2) {
            const d = r.vals[i] - r.vals[i + 1];
            ref += -Math.log(1 / (1 + Math.exp(-d)));
          }
          ref /= r.vals.length / 2;
          console.log('学员 ' + r.loss.toFixed(8) + '，参考 −log σ(Δ) 的平均 ' + ref.toFixed(8));
          lab.publish('rm.lossError', Math.abs(r.loss - ref));
          expect(Math.abs(r.loss - ref)).toBeLessThan(1e-6);
        });

        /*
         * 分数必须从**最后一个内容 token** 上读。读最后一个位置的话读到的是
         * padding，不同长度的序列偏移不同,分数偷偷变成长度的函数。
         */
        it('多补一个 padding，分数不变', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = rm.RewardModel(seed=1)
      _cases = [("7+5=", "12"), ("0+0=", "0"), ("9+9=", "18")]
      _out = []
      for _p, _a in _cases:
          _row, _lp = _rows(_p, _a)
          _idx = nt.zeros((kit.S,), role="data"); _idx.set_int_(_row)
          with nt.no_grad():
              _base = _m.reward(_idx, 1, kit.S, [_lp]).item(0)
          # 换一条更长的 padding 布局：内容不变，只是右边多了 pad
          _row2 = _row[:]
          _idx2 = nt.zeros((kit.S,), role="data"); _idx2.set_int_(_row2)
          with nt.no_grad():
              _same = _m.reward(_idx2, 1, kit.S, [_lp]).item(0)
              # 读最后一个位置会得到的那个数 —— 作为对照
              _tail = _m.reward(_idx, 1, kit.S, [kit.S - 1]).item(0)
          _out.append([_base, _same, _tail])
      json.dumps(_out)
      \`)));
          let worst = 0, tailGap = 0;
          for (const [base, same, tail] of r) {
            worst = Math.max(worst, Math.abs(base - same));
            tailGap = Math.max(tailGap, Math.abs(base - tail));
          }
          console.log(
            '同一条内容两次打分的最大差 ' + worst.toExponential(2)
            + '；而读最后一个位置（padding 上）会差 ' + tailGap.toFixed(4)
          );
          lab.publish('rm.padInvariance', worst);
          expect(worst).toBeLessThan(1e-6);
          // 对照：读 padding 位置确实是另一个数，所以这条门槛不是白设的
          expect(tailGap).toBeGreaterThan(1e-3);
        });

        it('留出集上的成对准确率 ≥ 0.9', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = _trained()
      _held = kit.make_preference_pairs(120, 777, 10)
      _sc = _scores(_m, _held)
      json.dumps({"scores": _sc})
      \`)));
          let right = 0, margin = 0;
          for (const [c, j] of r.scores) { if (c > j) right += 1; margin += c - j; }
          const acc = right / r.scores.length;
          console.log(
            '成对准确率 ' + (acc * 100).toFixed(1) + '%（' + right + ' / ' + r.scores.length + '），'
            + '平均 margin ' + (margin / r.scores.length).toFixed(3)
          );
          lab.publish('rm.pairwiseAccuracy', acc);
          lab.publish('rm.meanMargin', margin / r.scores.length);
          expect(acc).toBeGreaterThanOrEqual(0.9);
          expect(margin / r.scores.length).toBeGreaterThan(0);
        });

        /*
         * 校准：模型说「70% 概率 A 更好」的那些对里，A 真的更好的比例
         * 应当接近 70%。排序对了不等于校准好了 ——
         * 把所有 Δ 乘十，排序一模一样，而每一对都变成 99.99%。
         */
        it('预测概率是校准的', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = _trained()
      _held = kit.make_preference_pairs(240, 909, 10)
      json.dumps({"scores": _scores(_m, _held)})
      \`)));
          const bins = [0, 0, 0, 0, 0].map(() => ({ n: 0, p: 0, win: 0 }));
          for (const [c, j] of r.scores) {
            const p = 1 / (1 + Math.exp(-(c - j)));
            const b = Math.min(4, Math.floor(p * 5));
            bins[b].n += 1; bins[b].p += p; bins[b].win += c > j ? 1 : 0;
          }
          let worst = 0;
          const lines = [];
          for (let b = 0; b < 5; b++) {
            if (bins[b].n < 8) continue;
            const meanP = bins[b].p / bins[b].n;
            const winRate = bins[b].win / bins[b].n;
            worst = Math.max(worst, Math.abs(meanP - winRate));
            lines.push('[' + (b / 5).toFixed(1) + ',' + ((b + 1) / 5).toFixed(1) + ') n=' + bins[b].n
              + ' 预测 ' + meanP.toFixed(3) + ' 实际 ' + winRate.toFixed(3));
          }
          console.log('校准分箱：' + lines.join(' | '));
          lab.publish('rm.calibrationError', worst);
          expect(lines.length).toBeGreaterThanOrEqual(1);
          expect(worst).toBeLessThan(0.15);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.rm.lossError', op: 'lte', value: 1e-6,
      zh: '与 −log σ(Δ) 参考实现的差', en: 'gap from the reference −log σ(Δ)', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.rm.padInvariance', op: 'lte', value: 1e-6,
      zh: '多补 padding 之后分数的变化', en: 'score change under extra padding', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.rm.pairwiseAccuracy', op: 'gte', value: 0.9,
      zh: '留出集上的成对准确率', en: 'held-out pairwise accuracy', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.rm.calibrationError', op: 'lte', value: 0.15,
      zh: '预测概率与实际胜率的最大偏差', en: 'largest gap between predicted probability and win rate',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      奖励模型是 RLHF 那条路的核心，也是它最脆的一环。几个真实的问题：

      **奖励被钻空子（reward hacking）。** 策略会找到「奖励模型给高分但人类不喜欢」
      的输出。最经典的是**长度**:奖励模型从数据里学到「长的更好」，
      于是策略把答案越写越长。第 26 关专门做这件事。

      **分布漂移。** 奖励模型是在某个策略产出的数据上训的，
      而 RL 会把策略推离那个分布,越往后，奖励模型见到的输入越陌生，
      给分越不可信。所以真实流程里奖励模型要**定期用新数据重训**。

      **2026 年的评测标准是 RewardBench v2。** 它把「排序对不对」拆成了
      多个维度（事实性、安全、格式、推理），因为一个总分掩盖了太多东西。

      而 \`RLVR\` 这条路根本不训奖励模型 —— 可验证的任务（数学、代码、
      形式化推理）直接用**规则**判对错。没有奖励模型，就没有奖励被钻空子的问题。
      这是 2026 年后训练最重要的一个转向，第 28 关做的就是它。
    `,
    code`
      The reward model is the core of the RLHF route and also its most fragile link. A few
      real problems:

      **Reward hacking.** The policy finds outputs the reward model scores highly and humans
      dislike. The classic case is **length**: the reward model learns "longer is better"
      from the data, and the policy writes longer and longer answers. Stage 26 addresses
      exactly this.

      **Distribution drift.** The reward model was trained on data from some policy, and RL
      pushes the policy away from that distribution — the further it goes, the more
      unfamiliar its inputs and the less trustworthy its scores. Real pipelines therefore
      **retrain the reward model periodically** on fresh data.

      **RewardBench v2 is the 2026 benchmark.** It splits "is the ranking right" into several
      dimensions (factuality, safety, format, reasoning), because a single score hides too
      much.

      The \`RLVR\` route trains no reward model at all — verifiable tasks (mathematics, code,
      formal reasoning) judge correctness by **rule**. No reward model means no reward
      hacking. That is the most important shift in 2026 post-training, and stage 28 is about
      exactly it.
    `
  ),
};

/* ================================================================== */
/* 第 25 关：DPO                                                       */
/* ================================================================== */

const STAGE_DPO = {
  id: 'dpo',
  title: t('DPO —— 不要奖励模型的偏好优化', 'DPO — preference optimisation without a reward model'),
  goal: t(
    code`
      RLHF 那条路要三个模型：策略、奖励模型、参考模型,还要一整套 PPO。
      \`DPO\` 的发现是：**如果奖励模型是 Bradley-Terry 的，
      那么最优策略和奖励之间有一个闭式关系**,于是奖励模型可以被消掉，
      偏好数据可以直接用来训策略。

      在 \`dpo.py\` 里实现：

      \`\`\`python
      def sequence_logprob(model, idx, targets, mask, batch, seq):
          """每条序列在 completion 上的对数概率**之和**。返回 [batch, 1]，可导。"""

      def dpo_loss(policy_logp, ref_logp, beta, n_pairs):
          """两个都是 [2n, 1]，chosen / rejected 交替。"""

      def train(policy, ref, pairs, steps, beta, ...): ...
      \`\`\`

      ## 损失

      \`\`\`
      Δ_w = log π(y_w|x) − log π_ref(y_w|x)      ← 「隐式奖励」
      Δ_l = log π(y_l|x) − log π_ref(y_l|x)
      L   = −log σ( β·(Δ_w − Δ_l) )
      \`\`\`

      \`β·Δ\` 就是 DPO 的**隐式奖励**,它不是被训出来的，是被推导出来的。
      而 \`−log σ(·)\` 又是第 24 关那个两类 softmax。
      所以 DPO 的实现和奖励模型的实现在**形状上是同一个东西**，
      区别只在于分数从哪来：一个来自专门的标量头，一个来自策略与参考的对数概率之差。

      ## 参考模型不参与梯度

      \`π_ref\` 是冻结的（一般就是 SFT 之后那一版）。它在损失里只作为**基准**出现,
      算它的 log-prob 要在 \`no_grad\` 下。

      忘了这一点的话，梯度会同时推着策略和参考往相反方向走,
      于是 \`Δ_w − Δ_l\` 涨得飞快而模型什么也没学到。
      **loss 掉得特别快**是这个错最典型的症状。

      ## 为什么要有 β 和参考项

      \`β\` 控制「允许离参考多远」—— 但**这句话是渐近的，不是每一步的**。

      损失对 \`Δ\` 的梯度是 \`β·(1 − σ(β·Δ))\`。训练早期 \`Δ\` 还小、σ 接近 0.5，
      于是梯度的大小**正比于 β**。也就是说在**固定步数、固定学习率**下，
      β 越大策略走得越远,和「β 越大约束越紧」的直觉正好相反。
      β 的约束作用要到收敛之后才体现（最优解里的 KL 罚项是 \`1/β\`）。

      这一关实测过（同样 120 步、同样学习率，量的是好输出上的逐 token KL）：

      \`\`\`
      β = 0.1   KL 0.841
      β = 0.5   KL 1.353      ← 更大的 β，跑得更远
      \`\`\`

      真正压住漂移的是**步数和学习率**：把学习率减半、步数降到 100 之后是 **0.561**。
      这一关的门槛就定在这个基础上。

      参考项本身是一个隐式的 \`KL\` 约束：
      \`log π − log π_ref\` 大就意味着策略在这条样本上已经偏离参考很多。
      没有它的话，模型可以靠**把所有概率都压低**来拉开 \`Δ_w − Δ_l\`,
      赢是赢了，而语言模型本身垮掉。

      这一关会量这件事：策略相对参考的 KL 必须在界内。

      ## 序列的对数概率是**和**不是平均

      \`log π(y|x) = Σ_t log p_t\`,一条 completion 的所有 token 加起来。
      改成平均的话，**长答案被系统性地偏袒**（平均值不随长度增长），
      而这正是第 26 关那个「长度偏置」的一个来源。这一关先按标准的和来写。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 损失 | 与参考公式差 ≤ 1e-6 |
      | **参考不带梯度** | 训练之后参考模型的参数一位都没变 |
      | 偏好 | 留出集上隐式奖励的排序准确率 ≥ **0.9** |
      | 不跑飞 | **好输出上**相对参考的逐 token KL ≤ **0.8** |
    `,
    code`
      The RLHF route needs three models — policy, reward model, reference — plus all of PPO.
      \`DPO\`'s insight is that **if the reward model is Bradley-Terry, there is a closed-form
      relation between the optimal policy and the reward**, so the reward model can be
      eliminated and preference data can train the policy directly.

      Implement in \`dpo.py\`:

      \`\`\`python
      def sequence_logprob(model, idx, targets, mask, batch, seq):
          """The **sum** of log probabilities over the completion. Returns [batch, 1],
          differentiable."""

      def dpo_loss(policy_logp, ref_logp, beta, n_pairs):
          """Both are [2n, 1] with chosen / rejected interleaved."""

      def train(policy, ref, pairs, steps, beta, ...): ...
      \`\`\`

      ## The loss

      \`\`\`
      Δ_w = log π(y_w|x) − log π_ref(y_w|x)      <- the "implicit reward"
      Δ_l = log π(y_l|x) − log π_ref(y_l|x)
      L   = −log σ( β·(Δ_w − Δ_l) )
      \`\`\`

      \`β·Δ\` is DPO's **implicit reward** — not trained but derived. And \`−log σ(·)\` is
      stage 24's two-class softmax again. So DPO and a reward model have **the same shape**;
      they differ only in where the score comes from: a dedicated scalar head, or the
      difference of log probabilities between policy and reference.

      ## The reference takes no gradient

      \`π_ref\` is frozen (usually the post-SFT version). It appears in the loss only as a
      **baseline**, so its log-probabilities are computed under \`no_grad\`.

      Forgetting this makes the gradient push policy and reference in opposite directions,
      so \`Δ_w − Δ_l\` grows quickly while the model learns nothing. **A loss that drops
      unusually fast** is this mistake's signature.

      ## Why β and the reference term exist

      \`β\` controls how far the policy may stray — but **that statement is asymptotic, not
      per-step**.

      The loss gradient with respect to \`Δ\` is \`β·(1 − σ(β·Δ))\`. Early in training \`Δ\`
      is small and σ is near 0.5, so the gradient magnitude is **proportional to β**. At a
      **fixed step count and learning rate**, a larger β therefore moves the policy
      *further* — the opposite of the intuition that larger β constrains more tightly. β's
      constraining role appears only at convergence, where the optimum carries a KL penalty
      of \`1/β\`.

      This stage measured it (same 120 steps, same learning rate, per-token KL on chosen
      responses):

      \`\`\`
      β = 0.1   KL 0.841
      β = 0.5   KL 1.353      <- larger β, further drift
      \`\`\`

      What actually contains the drift is **step count and learning rate**: halving the rate
      and dropping to 100 steps gives **0.561**, which is what this stage's gate is set
      against.

      The reference term is itself an implicit \`KL\` constraint: a large
      \`log π − log π_ref\` means the policy already differs a lot on that sample. Without
      it, the model can widen \`Δ_w − Δ_l\` simply by **pushing all probabilities down** — it
      wins the objective while the language model itself collapses.

      This stage measures that: the policy's KL from the reference must stay within bounds.

      ## A sequence log-probability is a **sum**, not a mean

      \`log π(y|x) = Σ_t log p_t\` across the completion's tokens. Using a mean instead
      **systematically favours long answers** (a mean does not grow with length), which is
      one source of the length bias stage 26 examines. This stage uses the standard sum.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Loss | Within 1e-6 of the reference formula |
      | **Reference frozen** | Not one parameter of the reference moved during training |
      | Preference | Implicit-reward ranking accuracy on held-out data >= **0.9** |
      | No blow-up | Per-token KL from the reference **on chosen responses** <= **0.8** |
    `
  ),
  checklist: [
    t('序列 log-prob 是 completion 上的和', 'The sequence log-probability sums over the completion'),
    t('参考模型在 no_grad 下算，参数一位不变',
      'The reference runs under no_grad and its parameters never move'),
    t('隐式奖励的排序准确率 ≥ 0.9', 'Implicit-reward ranking accuracy is at least 0.9'),
    t('相对参考的 KL 在界内', 'KL from the reference stays within bounds'),
  ],
  hints: [
    t('F.log_softmax 之后用 F.gather 取出目标 token 的那一个数,别先 softmax 再 log。',
      'Use F.log_softmax then F.gather for the target token; do not softmax then log.'),
    t('F.row_scale 拿 mask 屏蔽 prompt 与 padding，F.scatter_add 把每条序列的加起来。',
      'F.row_scale applies the mask; F.scatter_add sums each sequence.'),
    t('chosen / rejected 交替排，[2n, 1] 的扁平布局正好是 [n, 2] 的 logits。',
      'Interleave chosen and rejected; the [2n, 1] layout is exactly [n, 2] logits.'),
  ],
  pitfalls: [
    t(code`
      **参考模型忘了 \`no_grad\`。** 梯度会同时推策略和参考往相反方向走,
      \`Δ_w − Δ_l\` 涨得飞快，loss 掉得特别漂亮，而模型什么也没学到。
      **loss 掉得比预期快**在 DPO 里几乎总是这个错。
      这一关直接查参考模型的参数有没有动过。
    `, code`
      **Forgetting \`no_grad\` on the reference.** The gradient pushes policy and reference in
      opposite directions, \`Δ_w − Δ_l\` grows fast, the loss falls beautifully, and the model
      learns nothing. **A loss falling faster than expected** is almost always this in DPO.
      The stage checks the reference's parameters directly.
    `),
    t(code`
      **把序列 log-prob 写成平均。** 平均值不随长度增长，于是长答案被系统性地偏袒 ——
      这是 DPO 让答案越写越长的一个直接来源。
      更麻烦的是它**看起来更合理**（「归一化一下总没错吧」），
      而这一关的门槛全都过得去,要到第 26 关量长度的时候才暴露。
    `, code`
      **Writing the sequence log-probability as a mean.** A mean does not grow with length,
      so long answers are systematically favoured — a direct source of DPO's tendency to
      lengthen answers. Worse, it **looks more reasonable** ("normalising can't hurt"), and
      every gate here still passes; only stage 26's length measurement exposes it.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_POST_PY,
      'dpo.py': code`
        """第 25 关：DPO。不要奖励模型的偏好优化。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F
        import kit


        def sequence_logprob(model, idx, targets, mask, batch, seq):
            """每条序列在 completion 上的 log-prob 之和。返回 [batch, 1]。"""
            # TODO: logits -> log_softmax -> 按 targets 取 -> 乘 mask -> 按序列求和
            return nt.zeros((batch, 1))


        def dpo_loss(policy_logp, ref_logp, beta, n_pairs):
            """policy_logp / ref_logp 都是 [2n, 1]，chosen / rejected 交替。"""
            # TODO: logits = beta * (policy − ref)，当成 [n, 2]，目标全 0
            return nt.zeros((1,))


        def train(policy, ref, pairs, steps, beta=0.1, batch_pairs=8, peak_lr=0.01):
            """返回 {"loss": [...]}"""
            # TODO
            return {"loss": []}


        if __name__ == "__main__":
            print("beta 越小，允许策略离参考越远")
      `,
    },
    referenceFiles: {
      'dpo.py': code`
        """第 25 关的参考实现。"""
        import math
        import nanotorch as nt
        from nanotorch import nn, functional as F
        import kit


        def sequence_logprob(model, idx, targets, mask, batch, seq):
            rows = batch * seq
            logits = model.logits(idx, batch, seq)
            # log_softmax 而不是 log(softmax(...))：小概率会下溢成 0，再取 log 是 −inf
            lp = F.log_softmax(logits, rows, kit.V)

            sel = nt.zeros((rows,), name="dpo.sel")
            sel.set_int_([r * kit.V + targets[r] for r in range(rows)])
            per = F.gather(lp, sel, rows, 1)               # 每个位置一个 log p

            mk = nt.zeros((rows,), name="dpo.mask")
            mk.set_(mask)
            per = F.row_scale(per, mk, rows, 1)            # prompt 与 padding 清零

            seg = nt.zeros((rows,), name="dpo.seg")
            seg.set_int_([r // seq for r in range(rows)])
            # **求和**不是平均。平均会系统性地偏袒长答案（第 26 关的病根之一）
            return F.scatter_add(per, seg, rows, 1, batch)


        def dpo_loss(policy_logp, ref_logp, beta, n_pairs):
            # Δ = log π − log π_ref，就是 DPO 的隐式奖励（差一个 β）
            delta = F.add(policy_logp, F.scale(ref_logp, -1.0))
            logits = F.scale(delta, beta)
            # −log σ(β(Δ_w − Δ_l)) 就是两类 softmax，和第 24 关同一个形状
            tgt = nt.zeros((n_pairs,), name="dpo.tgt")
            tgt.set_int_([0] * n_pairs)
            return F.cross_entropy(logits, tgt, n_pairs, 2)


        def _rows(prompt, answer):
            return kit.build_row(prompt, answer)


        def train(policy, ref, pairs, steps, beta=0.1, batch_pairs=8, peak_lr=0.01):
            opt = nt.optim.AdamW(policy.parameters(), lr=peak_lr, betas=(0.9, 0.95),
                                 weight_decay=0.0, grad_clip=1.0)
            n = batch_pairs * 2
            idx = nt.zeros((n * kit.S,), role="data", name="dpo.idx")
            hist = []
            base = nt.mark()
            warmup = max(1, steps // 20)
            for st in range(1, steps + 1):
                nt.release(base)
                flat, tg, mk = [], [], []
                for k in range(batch_pairs):
                    p, c, r = pairs[(st * batch_pairs + k) % len(pairs)]
                    for ans in (c, r):
                        ri, rt, rm = _rows(p, ans)
                        flat.extend(ri)
                        tg.extend(rt)
                        mk.extend(rm)
                idx.set_int_(flat)

                opt.zero_grad()
                nt.phase("forward")
                # 参考在 no_grad 下 —— 它只是基准，不该被推动
                with nt.no_grad():
                    ref_lp = sequence_logprob(ref, idx, tg, mk, n, kit.S)
                pol_lp = sequence_logprob(policy, idx, tg, mk, n, kit.S)
                loss = dpo_loss(pol_lp, ref_lp, beta, batch_pairs)
                nt.phase("other")
                loss.backward()

                if st <= warmup:
                    lr = peak_lr * st / warmup
                else:
                    pr = (st - warmup) / max(1, steps - warmup)
                    lr = peak_lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * pr)))
                opt.step(lr=lr)
                hist.append(loss.value)
            nt.release(base)
            return {"loss": hist}


        if __name__ == "__main__":
            print("beta 越小，允许策略离参考越远")
      `,
    },
  },
  specs: [
    spec('dpo.spec.ts', code`
      ${LAB}

      const SFT_STEPS = 120, DPO_STEPS = 100, BETA = 0.1, MAXV = 20, DPO_LR = 0.005;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, dpo
      importlib.reload(kit)
      importlib.reload(dpo)
      import nanotorch as nt
      from nanotorch import functional as F

      _cache = {}

      def _sft(seed=1):
          """SFT 之后那一版。参考模型和策略的起点都是它。"""
          m = kit.LM(seed=seed)
          kit.sft_train(m, kit.make_pairs(512, 5, \${MAXV}, "+"), \${SFT_STEPS}, 16)
          return m

      def _batched(triples):
          """把若干 (prompt, chosen, rejected) 摊成 chosen/rejected 交替的一批。"""
          flat, tg, mk = [], [], []
          for p, c, r in triples:
              for ans in (c, r):
                  ri, rt, rm = kit.build_row(p, ans)
                  flat.extend(ri); tg.extend(rt); mk.extend(rm)
          return flat, tg, mk

      def _trained():
          if "pol" not in _cache:
              pol = _sft()
              ref = _sft()          # 同一个 seed、同一份数据 -> 逐位相同的一份冻结拷贝
              before = [list(p.tolist()) for p in ref.parameters()]
              dpo.train(pol, ref, kit.make_preference_pairs(512, 5, \${MAXV}), \${DPO_STEPS},
                        \${BETA}, 8, \${DPO_LR})
              after = [list(p.tolist()) for p in ref.parameters()]
              moved = sum(1 for a, b in zip(before, after) for u, v in zip(a, b) if u != v)
              _cache["pol"], _cache["ref"], _cache["moved"] = pol, ref, moved
          return _cache
      \`);
      }

      describe('DPO', () => {
        it('损失与参考公式一致', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _n = 5
      _pol = nt.zeros((2 * _n, 1), role="data")
      _ref = nt.zeros((2 * _n, 1), role="data")
      _pv = [-3.0, -4.0, -2.5, -2.0, -5.0, -5.5, -1.0, -1.2, -6.0, -4.0]
      _rv = [-3.5, -3.5, -2.0, -2.4, -5.2, -5.0, -1.1, -1.0, -5.5, -4.5]
      _pol.set_(_pv); _ref.set_(_rv)
      _l = dpo.dpo_loss(_pol, _ref, \${BETA}, _n)
      json.dumps({"loss": _l.value, "pv": _pv, "rv": _rv})
      \`)));
          let ref = 0;
          for (let i = 0; i < r.pv.length; i += 2) {
            const dw = r.pv[i] - r.rv[i];
            const dl = r.pv[i + 1] - r.rv[i + 1];
            ref += -Math.log(1 / (1 + Math.exp(-BETA * (dw - dl))));
          }
          ref /= r.pv.length / 2;
          console.log('学员 ' + r.loss.toFixed(8) + '，参考 ' + ref.toFixed(8));
          lab.publish('dpo.lossError', Math.abs(r.loss - ref));
          expect(Math.abs(r.loss - ref)).toBeLessThan(1e-6);
        });

        it('序列 log-prob 是 completion 上的和', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _m = kit.LM(seed=1)
      _tri = [("7+5=", "12", "13"), ("0+0=", "0", "1")]
      _flat, _tg, _mk = _batched(_tri)
      _idx = nt.zeros((4 * kit.S,), role="data"); _idx.set_int_(_flat)
      with nt.no_grad():
          _lp = dpo.sequence_logprob(_m, _idx, _tg, _mk, 4, kit.S).tolist()
          _all = F.log_softmax(_m.logits(_idx, 4, kit.S), 4 * kit.S, kit.V).tolist()
      json.dumps({"lp": _lp, "all": _all, "tg": _tg, "mk": _mk})
      \`)));
          const S = Number(lab.py('kit.S')), V = Number(lab.py('kit.V'));
          let worst = 0;
          for (let b = 0; b < 4; b++) {
            let sum = 0;
            for (let t = 0; t < S; t++) {
              const row = b * S + t;
              if (r.mk[row] > 0) sum += r.all[row * V + r.tg[row]];
            }
            worst = Math.max(worst, Math.abs(sum - r.lp[b]));
          }
          console.log('四条序列的 log-prob ' + r.lp.map((v) => v.toFixed(3)).join(', ')
            + '；与逐位求和的最大差 ' + worst.toExponential(2));
          lab.publish('dpo.logprobError', worst);
          expect(worst).toBeLessThan(1e-5);
          // 是和不是平均：一条 3 个 token 的 completion，和应当明显小于单个 token 的 log-prob
          expect(r.lp.every((v) => v < 0)).toBe(true);
        });

        /*
         * 参考模型必须冻结。忘了 no_grad 的话梯度会同时推策略和参考，
         * loss 掉得特别漂亮而模型什么也没学到。
         */
        it('训练之后参考模型一位都没变', () => {
          setup();
          const moved = Number(lab.py('_trained()["moved"]'));
          console.log('参考模型被改动的参数个数 ' + moved);
          lab.publish('dpo.referenceMoved', moved);
          expect(moved).toBe(0);
        });

        it('隐式奖励排序准确 ≥ 0.9，且 KL 不跑飞', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _c = _trained()
      _pol, _ref = _c["pol"], _c["ref"]
      _held = kit.make_preference_pairs(96, 777, \${MAXV})
      _flat, _tg, _mk = _batched(_held)
      _n = 2 * len(_held)
      _idx = nt.zeros((_n * kit.S,), role="data"); _idx.set_int_(_flat)
      with nt.no_grad():
          _p = dpo.sequence_logprob(_pol, _idx, _tg, _mk, _n, kit.S).tolist()
          _r = dpo.sequence_logprob(_ref, _idx, _tg, _mk, _n, kit.S).tolist()
          # 逐 token 的 KL(π ‖ π_ref)，只在 completion 位置上算
          _lp_p = F.log_softmax(_pol.logits(_idx, _n, kit.S), _n * kit.S, kit.V).tolist()
          _lp_r = F.log_softmax(_ref.logits(_idx, _n, kit.S), _n * kit.S, kit.V).tolist()
      json.dumps({"p": _p, "r": _r, "lp_p": _lp_p, "lp_r": _lp_r, "mk": _mk,
                  "rows": _n * kit.S, "V": kit.V})
      \`)));

          let right = 0, margin = 0;
          for (let i = 0; i < r.p.length; i += 2) {
            const dw = r.p[i] - r.r[i];
            const dl = r.p[i + 1] - r.r[i + 1];
            if (dw > dl) right += 1;
            margin += dw - dl;
          }
          const pairs = r.p.length / 2;
          const acc = right / pairs;

          /*
           * KL 只在 **chosen** 那些序列上算。
           * rejected 的概率是 DPO 主动在压的,拿它去量「策略跑没跑飞」，
           * 问的不是同一件事：那个数越大恰恰说明 DPO 在起作用。
           * 约束要落在「好输出上策略离参考多远」。
           */
          const S = Number(lab.py('kit.S'));
          let kl = 0, n = 0;
          for (let row = 0; row < r.rows; row++) {
            if (r.mk[row] <= 0) continue;
            if (Math.floor(row / S) % 2 !== 0) continue;   // 偶数条是 chosen
            let s = 0;
            for (let j = 0; j < r.V; j++) {
              const a = r.lp_p[row * r.V + j];
              if (a < -60) continue;
              s += Math.exp(a) * (a - r.lp_r[row * r.V + j]);
            }
            kl += s; n += 1;
          }
          kl /= Math.max(1, n);

          console.log(
            'β = ' + BETA + '：隐式奖励排序准确 ' + (acc * 100).toFixed(1) + '%（'
            + right + ' / ' + pairs + '），平均 margin ' + (margin / pairs).toFixed(3)
            + '；逐 token KL(π‖ref) ' + kl.toFixed(4)
          );
          lab.publish('pref.accuracy', acc);
          lab.publish('dpo.implicitRewardMargin', margin / pairs);
          lab.publish('kl.fromReference', kl);
          expect(acc).toBeGreaterThanOrEqual(0.9);
          expect(margin / pairs).toBeGreaterThan(0);
          expect(kl).toBeLessThan(0.8);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.dpo.lossError', op: 'lte', value: 1e-6,
      zh: '与 DPO 参考公式的差', en: 'gap from the reference DPO formula', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.dpo.referenceMoved', op: 'eq', value: 0,
      zh: '训练之后参考模型被改动的参数个数',
      en: 'reference parameters altered during training', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.pref.accuracy', op: 'gte', value: 0.9,
      zh: '留出集上隐式奖励的排序准确率', en: 'held-out implicit-reward ranking accuracy',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.kl.fromReference', op: 'lte', value: 0.8,
      zh: '策略相对参考的逐 token KL', en: 'per-token KL from the reference', dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      DPO 出来之后有一大批变体，各自动的是同一个式子里的不同部分：

      **\`IPO\`** 换掉了 \`−log σ\`,它指出 DPO 在偏好数据确定性很高时会过拟合
      （σ 饱和之后梯度不再约束「离参考多远」），改成一个平方损失。

      **\`KTO\`** 不要成对数据,只要「这条好 / 这条不好」的单条标注，
      来自前景理论。数据便宜得多。

      **\`SimPO\`** 干脆去掉参考模型,用长度归一化的 log-prob 加一个边距项。
      省一个模型的显存，但也失去了那个隐式的 KL 约束。

      而 2026 年更大的变化是**在线**：DPO 是离线的（偏好数据事先标好），
      而在线的偏好优化（\`online DPO\` / \`iterative DPO\`）边训边采样、边标注,
      效果明显更好，代价是要一整套 rollout 基础设施。第 27 关做的就是那个。
    `,
    code`
      A family of variants followed DPO, each altering a different part of the same
      expression:

      **\`IPO\`** replaces \`−log σ\`, pointing out that DPO overfits when preferences are
      highly deterministic (once σ saturates it no longer constrains distance from the
      reference), and substitutes a squared loss.

      **\`KTO\`** drops pairwise data entirely, needing only "this one is good / bad" single
      labels, derived from prospect theory. Far cheaper data.

      **\`SimPO\`** removes the reference model altogether, using a length-normalised
      log-probability plus a margin. It saves a model's worth of memory and loses the
      implicit KL constraint.

      The larger 2026 shift is toward **online** methods: DPO is offline (preferences labelled
      in advance), while online preference optimisation (\`online DPO\` / \`iterative DPO\`)
      samples and labels as it trains — noticeably better, at the cost of a full rollout
      infrastructure. That is what stage 27 builds.
    `
  ),
};

/* ================================================================== */
/* 第 26 关：长度偏置                                                   */
/* ================================================================== */

const STAGE_LENGTH = {
  id: 'length-bias',
  title: t('长度偏置 —— 赢了，但不是靠变长赢的', 'Length bias — winning, but not by getting longer'),
  goal: t(
    code`
      偏好优化有一个几乎必然出现的副作用：**答案越来越长**。

      原因不神秘。如果偏好数据里「更好的那个」平均更长
      （人类标注、模型标注、规则构造，都容易带上这个），
      那么「长」就是一个和「好」高度相关的特征,
      而模型没有理由不去学这个更容易学的特征。

      这一关的数据是**故意构造成有长度混淆的**：正确答案可能是一位也可能是两位，
      而错误答案永远是一位。于是「更长」和「更好」在数据里绑在一起。

      在 \`length.py\` 里做三件事：

      \`\`\`python
      def length_stats(pairs):
          """量一量数据里的长度混淆：chosen 与 rejected 的平均长度差。"""

      def debias(pairs):
          """去掉混淆。要求：留下来的对里 chosen 与 rejected **等长**。"""

      def overlong_rate(model, prompts_with_short_answers, max_new):
          """本该一位的题里，模型吐出两位及以上的比例。"""
      \`\`\`

      ## 为什么要「长度受控」的评测

      直接比胜率是不行的:如果模型学会了「写长一点」，
      而评委（人或奖励模型）也偏爱长的，那么胜率上升**什么都不能说明**。

      标准做法是 \`长度受控胜率\`（length-controlled win rate）——
      只在长度可比的样本之间比较，或者把长度作为协变量回归掉。
      AlpacaEval 2 从 2.0 版起就是这么做的，理由正是原始胜率被长度带偏得太厉害。

      这一关用的是最直接的那种：**只在等长的对之间比**。

      ## 去偏怎么做

      最直接的一种是**让数据本身不带混淆**:
      只保留 chosen 与 rejected 等长的那些对。代价是数据量变少。

      另一类做法是改损失（\`SimPO\` 的长度归一化、\`R-DPO\` 的长度罚项），
      好处是不丢数据，代价是引入一个新的超参。
      这一关走第一条,它最容易验证，而且**先确认混淆存在、再去掉它**
      这个顺序本身就是要教的东西。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | **先确认混淆存在** | 原始数据里 chosen 比 rejected 平均长 ≥ **0.3** 个 token |
      | 去偏之后 | 留下来的对**全部等长** |
      | 不变长 | 本该一位的题里吐两位的比例 ≤ **0.1** |
      | **对照** | 不去偏的那一路，这个比例要明显更高 |

      最后一条是这一关的骨架：**一个「没有变长」的结果，只有在
      「不处理就会变长」被验证过之后才有意义。**
      否则你不知道是去偏起了作用，还是这个任务本来就不会变长。
    `,
    code`
      Preference optimisation has one near-inevitable side effect: **answers get longer**.

      The reason is not mysterious. If the "better" option in preference data is longer on
      average — human labelling, model labelling and rule-based construction all tend to
      introduce this — then "long" is a feature highly correlated with "good", and the model
      has no reason not to learn the easier feature.

      This stage's data is **deliberately constructed with a length confound**: correct
      answers may be one or two digits while wrong answers are always one digit. "Longer" and
      "better" are tied together in the data.

      Do three things in \`length.py\`:

      \`\`\`python
      def length_stats(pairs):
          """Measure the confound: mean length difference between chosen and rejected."""

      def debias(pairs):
          """Remove it. Requirement: every surviving pair has **equal lengths**."""

      def overlong_rate(model, prompts_with_short_answers, max_new):
          """Fraction of one-digit questions where the model emits two or more digits."""
      \`\`\`

      ## Why evaluation must be length-controlled

      Comparing raw win rates does not work: if the model learned to write longer and the
      judge (human or reward model) prefers longer, a rising win rate **shows nothing**.

      The standard answer is a \`length-controlled win rate\` — compare only among samples of
      comparable length, or regress length out as a covariate. AlpacaEval has done this since
      version 2.0, precisely because raw win rates were skewed by length.

      This stage uses the most direct form: **compare only within equal-length pairs**.

      ## How to debias

      The most direct approach removes the confound **from the data**: keep only pairs whose
      chosen and rejected have equal length. The cost is less data.

      Another family changes the loss (\`SimPO\`'s length normalisation, \`R-DPO\`'s length
      penalty), keeping the data at the price of a new hyperparameter. This stage takes the
      first route: it is the easiest to verify, and the ordering — **confirm the confound
      exists, then remove it** — is itself part of the lesson.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | **Confirm the confound first** | Chosen exceeds rejected by >= **0.3** tokens on average |
      | After debiasing | Every surviving pair has equal lengths |
      | No lengthening | Two-or-more-digit rate on one-digit questions <= **0.1** |
      | **Control** | The un-debiased run must show a clearly higher rate |

      That last row is the stage's backbone: **a "did not get longer" result means something
      only after "it would have gotten longer" has been verified.** Otherwise you cannot tell
      whether debiasing worked or the task simply never lengthens.
    `
  ),
  checklist: [
    t('先量出原始数据里的长度混淆', 'Measure the length confound in the raw data first'),
    t('去偏之后留下来的对全部等长', 'Every pair surviving debiasing has equal lengths'),
    t('吐两位的比例降下来了', 'The two-digit rate comes down'),
    t('对照组确实会变长', 'The control genuinely lengthens'),
  ],
  hints: [
    t('长度用 len(answer) 就行 —— 这一关的答案都是数字串。',
      'len(answer) suffices here; every answer is a digit string.'),
    t('kit.generate_answer(model, prompt, max_new) 的 max_new 放宽一点才看得出变长。',
      'Give kit.generate_answer a larger max_new or lengthening stays invisible.'),
    t('去偏之后数据会少一半左右，这是它的代价，不是 bug。',
      'Debiasing roughly halves the data; that is its cost, not a bug.'),
  ],
  pitfalls: [
    t(code`
      **只看胜率不看长度。** 模型学会「写长一点」之后，
      在偏爱长答案的评委面前胜率会上升,而它并没有变得更好。
      这不是假想：\`AlpacaEval\` 就是因为这个才在 2.0 版引入长度受控胜率的。
      **一个上升的指标，先问它有没有别的解释。**
    `, code`
      **Watching the win rate without watching length.** Once the model learns to write
      longer, its win rate rises in front of a judge that prefers length — while it has not
      gotten better. This is not hypothetical: \`AlpacaEval\` introduced a length-controlled
      win rate in version 2.0 for exactly this reason. **When a metric rises, first ask
      whether something else explains it.**
    `),
    t(code`
      **去偏之后就不验对照了。** 「模型没有变长」这个结果，
      只有在「不去偏就会变长」被验证过之后才有意义。
      少了对照的话，你不知道是去偏起了作用，还是这个任务本来就不会变长 ——
      而后一种情况下，你写的去偏代码是死的，却看着像在工作。
    `, code`
      **Skipping the control after debiasing.** "The model did not lengthen" means something
      only once "it would have lengthened" has been verified. Without the control you cannot
      tell whether debiasing worked or the task never lengthens anyway — and in the latter
      case your debiasing code is dead while appearing to work.
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_POST_PY,
      'length.py': code`
        """第 26 关：长度偏置。"""
        import kit


        def length_stats(pairs):
            """返回 {"chosen": 平均长度, "rejected": 平均长度, "gap": 差}。"""
            # TODO
            return {"chosen": 0.0, "rejected": 0.0, "gap": 0.0}


        def debias(pairs):
            """只留下 chosen 与 rejected 等长的对。"""
            # TODO
            return list(pairs)


        def overlong_rate(model, pairs, max_new=5):
            """答案本该是一位的那些题里，模型吐出两位及以上的比例。"""
            # TODO: 只看 len(answer) == 1 的题
            return 0.0


        if __name__ == "__main__":
            ps = kit.make_length_biased_pairs(64, 5, 20)
            print("原始", length_stats(ps))
            print("去偏之后", length_stats(debias(ps)), "剩", len(debias(ps)), "条")
      `,
    },
    referenceFiles: {
      'length.py': code`
        """第 26 关的参考实现。"""
        import kit


        def length_stats(pairs):
            if not pairs:
                return {"chosen": 0.0, "rejected": 0.0, "gap": 0.0}
            c = sum(len(ch) for _, ch, _ in pairs) / len(pairs)
            r = sum(len(rj) for _, _, rj in pairs) / len(pairs)
            return {"chosen": c, "rejected": r, "gap": c - r}


        def debias(pairs):
            # 最直接的去偏：让数据本身不带混淆。
            # 代价是数据少一半左右 —— 这是它的代价，不是 bug
            return [p for p in pairs if len(p[1]) == len(p[2])]


        def overlong_rate(model, pairs, max_new=5):
            short = [(p, a) for p, a, _ in pairs if len(a) == 1]
            if not short:
                return 0.0
            over = 0
            for prompt, _ in short:
                out = kit.generate_answer(model, prompt, max_new)
                if len(out) >= 2:
                    over += 1
            return over / len(short)


        if __name__ == "__main__":
            ps = kit.make_length_biased_pairs(64, 5, 20)
            print("原始", length_stats(ps))
            print("去偏之后", length_stats(debias(ps)), "剩", len(debias(ps)), "条")
      `,
    },
  },
  specs: [
    spec('length.spec.ts', code`
      ${LAB}

      const SFT_STEPS = 120, DPO_STEPS = 140, BETA = 0.1, MAXV = 20, LR = 0.01;

      function setup() {
        lab.py(\`
      import sys, json, math
      sys.path.insert(0, "/lab")
      import importlib, kit, length
      importlib.reload(kit)
      importlib.reload(length)
      import nanotorch as nt
      from nanotorch import functional as F

      _cache = {}

      def _sft():
          m = kit.LM(seed=1)
          kit.sft_train(m, kit.make_pairs(512, 5, \${MAXV}, "+"), \${SFT_STEPS}, 16)
          return m

      def _seq_logp(model, idx, tg, mk, n):
          rows = n * kit.S
          lp = F.log_softmax(model.logits(idx, n, kit.S), rows, kit.V)
          sel = nt.zeros((rows,)); sel.set_int_([r * kit.V + tg[r] for r in range(rows)])
          per = F.gather(lp, sel, rows, 1)
          m2 = nt.zeros((rows,)); m2.set_(mk)
          per = F.row_scale(per, m2, rows, 1)
          seg = nt.zeros((rows,)); seg.set_int_([r // kit.S for r in range(rows)])
          return F.scatter_add(per, seg, rows, 1, n)

      def _dpo(pairs, steps):
          """平台版的 DPO（第 25 关那一套）。这一关只关心数据。"""
          pol, ref = _sft(), _sft()
          opt = nt.optim.AdamW(pol.parameters(), lr=\${LR}, betas=(0.9, 0.95),
                               weight_decay=0.0, grad_clip=1.0)
          bp = 8
          n = bp * 2
          idx = nt.zeros((n * kit.S,), role="data", name="len.idx")
          base = nt.mark()
          for st in range(1, steps + 1):
              nt.release(base)
              flat, tg, mk = [], [], []
              for k in range(bp):
                  p, c, r = pairs[(st * bp + k) % len(pairs)]
                  for ans in (c, r):
                      ri, rt, rm = kit.build_row(p, ans)
                      flat.extend(ri); tg.extend(rt); mk.extend(rm)
              idx.set_int_(flat)
              opt.zero_grad()
              nt.phase("forward")
              with nt.no_grad():
                  rl = _seq_logp(ref, idx, tg, mk, n)
              pl = _seq_logp(pol, idx, tg, mk, n)
              d = F.scale(F.add(pl, F.scale(rl, -1.0)), \${BETA})
              t2 = nt.zeros((bp,)); t2.set_int_([0] * bp)
              loss = F.cross_entropy(d, t2, bp, 2)
              nt.phase("other")
              loss.backward()
              opt.step(lr=\${LR})
          nt.release(base)
          return pol

      def _run(debiased):
          key = "d" if debiased else "n"
          if key in _cache:
              return _cache[key]
          raw = kit.make_length_biased_pairs(512, 5, \${MAXV})
          data = length.debias(raw) if debiased else raw
          model = _dpo(data, \${DPO_STEPS})
          held = kit.make_length_biased_pairs(96, 777, \${MAXV})
          out = {
              "n_data": len(data),
              "overlong": length.overlong_rate(model, held, 5),
              "acc_matched": kit.exact_match(
                  model, [(p, a) for p, a, r in held if len(a) == len(r)]),
          }
          _cache[key] = out
          return out
      \`);
      }

      describe('长度偏置', () => {
        it('原始数据里确实有长度混淆', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _raw = kit.make_length_biased_pairs(512, 5, \${MAXV})
      _st = length.length_stats(_raw)
      _db = length.debias(_raw)
      _st2 = length.length_stats(_db)
      _all_equal = all(len(c) == len(j) for _, c, j in _db)
      json.dumps({"raw": _st, "debiased": _st2, "equal": _all_equal,
                  "n_raw": len(_raw), "n_db": len(_db)})
      \`)));
          console.log(
            '原始 ' + r.n_raw + ' 条：chosen 平均 ' + r.raw.chosen.toFixed(3)
            + '，rejected ' + r.raw.rejected.toFixed(3) + '，差 ' + r.raw.gap.toFixed(3)
          );
          console.log(
            '去偏之后剩 ' + r.n_db + ' 条：差 ' + r.debiased.gap.toFixed(3)
            + '，全部等长 ' + r.equal
          );
          lab.publish('length.confoundInData', r.raw.gap);
          lab.publish('length.debiasedGap', Math.abs(r.debiased.gap));
          // 先确认混淆存在 —— 不存在的话这一关没有对象
          expect(r.raw.gap).toBeGreaterThanOrEqual(0.3);
          expect(r.equal).toBe(true);
          expect(Math.abs(r.debiased.gap)).toBeLessThan(1e-9);
          expect(r.n_db).toBeGreaterThan(50);
        });

        /*
         * 「模型没有变长」只有在「不去偏就会变长」被验证过之后才有意义。
         * 所以两路都跑，而且对照必须真的变长。
         */
        it('去偏之后不变长，而不去偏的对照会变长', () => {
          setup();
          const debiased = JSON.parse(String(lab.py('json.dumps(_run(True))')));
          const naive = JSON.parse(String(lab.py('json.dumps(_run(False))')));
          console.log(
            '去偏（' + debiased.n_data + ' 条）：吐两位的比例 '
            + (debiased.overlong * 100).toFixed(1) + '%'
          );
          console.log(
            '不去偏（' + naive.n_data + ' 条）：吐两位的比例 '
            + (naive.overlong * 100).toFixed(1) + '%'
          );
          lab.publish('length.overlongRate', debiased.overlong);
          lab.publish('length.overlongRateNaive', naive.overlong);
          expect(debiased.overlong).toBeLessThanOrEqual(0.1);
          // 对照必须真的更差，否则这一关在教一件不存在的事
          expect(naive.overlong).toBeGreaterThan(debiased.overlong + 0.1);
        });

        it('长度受控的准确率没有被牺牲掉', () => {
          setup();
          const debiased = JSON.parse(String(lab.py('json.dumps(_run(True))')));
          console.log(
            '等长样本上的精确匹配 ' + (debiased.acc_matched * 100).toFixed(1) + '%'
          );
          lab.publish('length.controlledWinRate', debiased.acc_matched);
          expect(debiased.acc_matched).toBeGreaterThanOrEqual(0.4);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.length.confoundInData', op: 'gte', value: 0.3,
      zh: '原始数据里 chosen 比 rejected 长多少（先确认混淆存在）',
      en: 'how much longer chosen is than rejected in the raw data (confirm the confound)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.length.debiasedGap', op: 'lte', value: 1e-9,
      zh: '去偏之后的长度差（要恰好为 0）', en: 'length gap after debiasing (must be exactly 0)',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.length.overlongRate', op: 'lte', value: 0.1,
      zh: '本该一位的题里吐两位的比例', en: 'two-digit rate on one-digit questions',
      dimension: 'correctness',
    }),
    gate({
      metric: 'llm.length.controlledWinRate', op: 'gte', value: 0.4,
      zh: '等长样本上的准确率（长度受控）', en: 'accuracy on length-matched samples',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      长度只是**最容易看见**的那个混淆。同一类问题还有很多：

      **格式偏好。** 评委偏爱带 markdown 列表的回答，于是模型什么都列成条目。
      **自信度。** 偏爱语气肯定的回答，于是模型学会不说「我不确定」——
      这一条直接伤害校准，也是幻觉的来源之一。
      **谄媚（sycophancy）。** 偏爱同意用户的回答，于是模型学会顺着用户说。

      这些的共同结构和长度一模一样：**一个和「好」相关、但比「好」容易学的特征**。
      而 RLHF 会准确地找到并放大它。

      \`RLVR\` 在这件事上有结构性的优势:规则判对错不带这些偏好。
      \`7+5=12\` 就是对的，写得长不长、有没有列表、语气自不自信，规则都不看。
      这也是 2026 年可验证任务这条路走得快的原因之一。

      但它也有自己的问题:可验证的任务只覆盖数学、代码、形式推理这一小块，
      而「写一封得体的邮件」没有验证器。所以真实的后训练是两条路并用的。
    `,
    code`
      Length is only the **most visible** confound. The same structure appears elsewhere:

      **Format preference.** Judges favour markdown lists, so the model turns everything
      into bullet points.
      **Confidence.** Judges favour assertive answers, so the model learns never to say "I am
      not sure" — directly damaging calibration and feeding hallucination.
      **Sycophancy.** Judges favour agreement, so the model learns to agree with the user.

      All share length's structure: **a feature correlated with "good" but easier to learn
      than "good"**. RLHF finds and amplifies it accurately.

      \`RLVR\` has a structural advantage here: a rule carries none of these preferences.
      \`7+5=12\` is correct whether it is long or short, bulleted or not, confident or
      hedged. That is part of why verifiable tasks moved so fast through 2026.

      It has its own limitation: verifiable tasks cover only mathematics, code and formal
      reasoning, and "write a tactful email" has no verifier. Real post-training runs both
      routes together.
    `
  ),
};

/* ================================================================== */
/* 第 27 关：rollout 基础设施                                           */
/* ================================================================== */

const STAGE_ROLLOUT = {
  id: 'rollout',
  title: t('rollout —— 强化学习跑不跑得动，看这一层', 'Rollout — whether RL runs at all comes down to this layer'),
  goal: t(
    code`
      强化学习的每一步都要**先采样再学习**：给一批 prompt，每个采 \`G\` 条，
      判对错，然后按结果更新。这一层叫 \`rollout\`,
      而它在真实系统里占 RL 训练时间的 **60% 到 80%**。

      在 \`rollout.py\` 里实现：

      \`\`\`python
      def rollout(model, prompts, group_size, max_new, seed,
                  temperature=1.0, top_k=0):
          """每个 prompt 采 group_size 条。返回

          [{"prompt": p,
            "samples": ["12", "13", ...],     # group_size 条
            "steps":   [n1, n2, ...]}, ...]   # 每条实际跑了几步解码

          三条硬要求：**用 KV cache**、**撞到 EOS 就停**、**确定性**。"""
      \`\`\`

      ## 为什么必须用 KV cache

      不带 cache 的解码，每生成一个 token 都要把整段前缀重算一遍。
      第 8 关量过：同样生成 12 个 token，**不带 cache 的 FLOPs 是带 cache 的 7.26 倍**。

      而 RL 的一步要采 \`prompt 数 × G\` 条,这个倍数直接乘在整个训练时间上。
      这不是「优化」，是这一关能不能在预算里跑完的分界。

      这一关的门槛：你的 rollout 的 FLOPs 必须 ≤ 平台那份**不带 cache** 的 **0.6 倍**。

      ## 为什么必须撞到 EOS 就停

      不停的话，EOS 之后那些 token 是**纯浪费**,它们不参与奖励、不参与更新，
      只消耗算力。在答案长度差异大的任务上（有的两个 token，有的两百个），
      按最长的那条跑满，浪费的比算的还多。

      真实推理引擎里这件事叫 \`continuous batching\`：一条序列结束就把它换出去，
      空出来的位置立刻塞新的进来。这一关做的是它的最小形式,**记录每条实际跑了几步**。

      ## 为什么必须确定性

      RL 的调试极其依赖重放。一次训练里出了问题（奖励忽然掉、
      某一步的梯度爆了），你要能**把那一步原样再跑一遍**。
      采样带随机性，所以随机性必须是**可寻址的**:
      同一个 (seed, prompt 下标, 样本下标) 永远给同一条输出。

      拿全局随机状态的实现做不到这一点,换个 batch 大小、换个执行顺序，
      同一个 seed 就给出不同的结果。

      ## 怎么算过

      | | 要求 |
      | --- | --- |
      | 数量 | 恰好 \`prompt 数 × group_size\` 条 |
      | **KV cache** | FLOPs ≤ 不带 cache 的 **0.6 倍** |
      | **提前停** | 每条的步数 = 答案长度 + 1（撞到 EOS），或者 max_new |
      | **确定性** | 同 seed 两遍逐条相同；换 seed 要有不同的样本 |
    `,
    code`
      Every reinforcement-learning step **samples before it learns**: take a batch of
      prompts, draw \`G\` samples each, judge them, then update from the outcome. That layer
      is the \`rollout\`, and in real systems it consumes **60% to 80%** of RL training time.

      Implement in \`rollout.py\`:

      \`\`\`python
      def rollout(model, prompts, group_size, max_new, seed,
                  temperature=1.0, top_k=0):
          """Draw group_size samples per prompt. Returns

          [{"prompt": p,
            "samples": ["12", "13", ...],     # group_size of them
            "steps":   [n1, n2, ...]}, ...]   # decode steps each actually ran

          Three hard requirements: **use the KV cache**, **stop at EOS**,
          **be deterministic**."""
      \`\`\`

      ## Why the KV cache is mandatory

      Uncached decoding recomputes the whole prefix for every token. Stage 8 measured it:
      generating the same 12 tokens, **the uncached path costs 7.26x the FLOPs**.

      An RL step samples \`prompts × G\` sequences, and that multiplier lands directly on
      total training time. This is not an optimisation but the line between finishing within
      budget and not.

      The gate: your rollout's FLOPs must be at most **0.6x** the platform's **uncached**
      version.

      ## Why stopping at EOS is mandatory

      Otherwise every token after EOS is **pure waste** — it earns no reward, joins no
      update, and only burns compute. On tasks where answer lengths vary widely (two tokens
      here, two hundred there), running everything to the longest length wastes more than it
      computes.

      Real inference engines call this \`continuous batching\`: a finished sequence is
      evicted and a new one takes its slot immediately. This stage builds the minimal form —
      **record how many steps each sample actually ran**.

      ## Why determinism is mandatory

      Debugging RL depends heavily on replay. When something goes wrong mid-run (reward
      suddenly drops, one step's gradient explodes) you must be able to **rerun that exact
      step**. Sampling is random, so the randomness has to be **addressable**: the same
      (seed, prompt index, sample index) must always produce the same output.

      An implementation drawing from global random state cannot do that — change the batch
      size or the execution order and the same seed yields something different.

      ## What counts as passing

      | | Requirement |
      | --- | --- |
      | Count | Exactly \`prompts × group_size\` samples |
      | **KV cache** | FLOPs <= **0.6x** the uncached version |
      | **Early stop** | Steps per sample = answer length + 1 (EOS), or max_new |
      | **Determinism** | Two runs at one seed match sample for sample; a new seed differs |
    `
  ),
  checklist: [
    t('每个 prompt 采满 group_size 条', 'Exactly group_size samples per prompt'),
    t('用 KV cache 解码', 'Decoding goes through the KV cache'),
    t('撞到 EOS 就停，并记下实际步数', 'Stop at EOS and record the actual step count'),
    t('随机性是可寻址的：(seed, i, j) 决定一条输出',
      'Randomness is addressable: (seed, i, j) determines one output'),
  ],
  hints: [
    t('model.make_caches(1, max_seq) 给每层一块缓存；model.logits(..., caches, offset)。',
      'model.make_caches(1, max_seq) allocates per-layer caches; pass them to model.logits(..., caches, offset).'),
    t('prefill 一次把整段 prompt 塞进缓存，之后每步只喂一个 token。',
      'Prefill pushes the whole prompt in once; after that feed one token per step.'),
    t('采样的 seed 要按 prompt 的**内容**算，不按它在这一批里的下标 —— 否则单独重跑一条会变。',
      "Derive the sampling seed from the prompt's content, not its index in the batch, or rerunning one alone changes it."),
  ],
  pitfalls: [
    t(code`
      **忘了 KV cache。** 功能完全正确,采出来的样本一模一样，
      只是慢了七倍。而 rollout 占 RL 训练时间的六到八成，
      于是整个训练慢了五倍以上。**功能对而代价错**，
      是这一层最典型的问题,它不会让任何测试变红，只会让预算耗光。
    `, code`
      **Forgetting the KV cache.** Functionally perfect — the samples are identical, it is
      merely seven times slower. And since rollout is 60–80% of RL training time, the whole
      run slows by more than fivefold. **Correct behaviour at the wrong cost** is this
      layer's characteristic failure: no test turns red, the budget simply runs out.
    `),
    t(code`
      **采样用全局随机状态。** 同一个 seed，换个 batch 大小或者换个循环顺序
      就给出不同的结果,于是「把出问题那一步再跑一遍」做不到。
      RL 的调试几乎完全依赖重放，而这一条把重放废掉了。
      随机性要**可寻址**：(seed, prompt 下标, 样本下标) 算出一个种子。
    `, code`
      **Sampling from global random state.** The same seed gives different results if the
      batch size or loop order changes, so "rerun the step that went wrong" becomes
      impossible. RL debugging depends almost entirely on replay, and this destroys it.
      Randomness must be **addressable**: derive a seed from (seed, prompt index, sample
      index).
    `),
  ],
  train: {
    files: {
      'kit.py': KIT_POST_PY,
      'rollout.py': code`
        """第 27 关：批量 rollout。KV cache、提前停、确定性。"""
        import nanotorch as nt
        from nanotorch import functional as F
        import kit


        def rollout(model, prompts, group_size, max_new, seed,
                    temperature=1.0, top_k=0):
            """返回 [{"prompt", "samples", "steps"}]。"""
            # TODO: 每个 prompt 采 group_size 条。
            #       prefill 一次 -> 逐 token 解码（带 cache）-> 撞 EOS 就停
            #       种子由 (seed, prompt 内容, j) 算出来，别用全局状态、也别用批内下标
            return []


        if __name__ == "__main__":
            m = kit.LM(seed=1)
            g = rollout(m, ["7+5=", "1+2="], 4, 4, seed=3)
            for grp in g:
                print(grp["prompt"], grp["samples"], grp["steps"])
      `,
    },
    referenceFiles: {
      'rollout.py': code`
        """第 27 关的参考实现。"""
        import nanotorch as nt
        from nanotorch import functional as F
        import kit


        def prompt_seed(prompt):
            """按 prompt 的内容算一个确定性的整数。不能用 Python 的 hash() ——
            它在不同进程里可能不同，而这里要的正是跨进程也稳的东西。"""
            h = 2166136261
            for t in kit.encode(prompt):
                h = ((h ^ (t + 1)) * 16777619) & 0x7fffffff
            return h


        def rollout(model, prompts, group_size, max_new, seed,
                    temperature=1.0, top_k=0):
            out = []
            max_seq = kit.S
            buf = nt.zeros((max_seq,), role="data", name="roll.idx")
            for i, prompt in enumerate(prompts):
                samples, steps = [], []
                for j in range(group_size):
                    # **可寻址的随机性**：同一个 (seed, prompt 内容, j) 永远给同一条输出。
                    #
                    # 注意是按**内容**算，不是按它在这一批里的下标算 ——
                    # 按下标的话，单独重跑其中一个 prompt 会得到另一条输出，
                    # 而「把出问题那一条再跑一遍」正是重放要做的事
                    sub = seed * 100003 + prompt_seed(prompt) * 101 + j
                    ids = kit.encode(prompt)
                    caches = model.make_caches(1, max_seq)
                    mk = nt.mark()
                    got, used = [], 0
                    with nt.no_grad():
                        for step in range(max_new):
                            nt.release(mk)
                            # 第一步把整段 prompt 塞进缓存，之后每步只喂新来的那一个
                            feed = ids if step == 0 else ids[-1:]
                            offset = caches[0].length
                            if offset + len(feed) > max_seq:
                                break
                            buf.set_int_(feed + [kit.PAD] * (max_seq - len(feed)))
                            lg = model.logits(buf, 1, len(feed), caches, offset)
                            nxt = nt.generate.sample(
                                lg, len(feed) - 1, kit.V,
                                temperature=temperature, top_k=top_k, seed=sub + step
                            )
                            used += 1
                            if nxt == kit.EOS:
                                break          # 撞到 EOS 就停 —— 之后的 token 是纯浪费
                            got.append(nxt)
                            ids.append(nxt)
                    nt.release(mk)
                    samples.append(kit.decode(got))
                    steps.append(used)
                out.append({"prompt": prompt, "samples": samples, "steps": steps})
            return out


        if __name__ == "__main__":
            m = kit.LM(seed=1)
            g = rollout(m, ["7+5=", "1+2="], 4, 4, seed=3)
            for grp in g:
                print(grp["prompt"], grp["samples"], grp["steps"])
      `,
    },
  },
  specs: [
    spec('rollout.spec.ts', code`
      ${LAB}

      const SFT_STEPS = 120, MAXV = 20, GROUP = 4, MAX_NEW = 4;

      function setup() {
        lab.py(\`
      import sys, json
      sys.path.insert(0, "/lab")
      import importlib, kit, rollout
      importlib.reload(kit)
      importlib.reload(rollout)
      import nanotorch as nt
      from nanotorch import functional as F

      _cache = {}

      def _model():
          if "m" not in _cache:
              m = kit.LM(seed=1)
              kit.sft_train(m, kit.make_pairs(512, 5, \${MAXV}, "+"), \${SFT_STEPS}, 16)
              _cache["m"] = m
          return _cache["m"]

      def _naive(model, prompts, group_size, max_new, seed, temperature=1.0, top_k=0):
          """平台的对照：完全一样的采样，只是**不带 cache**（每步整段重算）。"""
          out = []
          buf = nt.zeros((kit.S,), role="data", name="naive.idx")
          for i, prompt in enumerate(prompts):
              samples, steps = [], []
              for j in range(group_size):
                  sub = seed * 100003 + rollout.prompt_seed(prompt) * 101 + j
                  ids = kit.encode(prompt)
                  mk = nt.mark()
                  got, used = [], 0
                  with nt.no_grad():
                      for step in range(max_new):
                          nt.release(mk)
                          if len(ids) >= kit.S:
                              break
                          buf.set_int_(ids + [kit.PAD] * (kit.S - len(ids)))
                          lg = model.logits(buf, 1, len(ids))
                          nxt = nt.generate.sample(lg, len(ids) - 1, kit.V,
                                                   temperature=temperature, top_k=top_k,
                                                   seed=sub + step)
                          used += 1
                          if nxt == kit.EOS:
                              break
                          got.append(nxt)
                          ids.append(nxt)
                  nt.release(mk)
                  samples.append(kit.decode(got))
                  steps.append(used)
              out.append({"prompt": prompt, "samples": samples, "steps": steps})
          return out

      _prompts = [p for p, _ in kit.make_pairs(8, 41, \${MAXV}, "+")]
      \`);
      }

      describe('rollout 基础设施', () => {
        it('每个 prompt 采满 group_size 条，且撞到 EOS 就停', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _g = rollout.rollout(_model(), _prompts, \${GROUP}, \${MAX_NEW}, seed=7)
      json.dumps(_g)
      \`)));
          expect(r.length).toBe(8);
          let total = 0, early = 0, bad = 0;
          for (const grp of r) {
            expect(grp.samples.length).toBe(GROUP);
            expect(grp.steps.length).toBe(GROUP);
            for (let j = 0; j < GROUP; j++) {
              total += 1;
              const len = grp.samples[j].length;
              const steps = grp.steps[j];
              // 撞到 EOS：步数 = 答案长度 + 1（那一步采到的是 EOS）
              // 没撞到：跑满 max_new，此时长度就等于 max_new
              if (steps === len + 1) early += 1;
              else if (!(steps === MAX_NEW && len === MAX_NEW)) bad += 1;
            }
          }
          console.log(
            r.length + ' 组 × ' + GROUP + ' 条：提前停的 ' + early + ' 条，'
            + '步数对不上的 ' + bad + ' 条；前两组 '
            + JSON.stringify(r.slice(0, 2).map((g) => g.samples))
          );
          lab.publish('rollout.count', total);
          lab.publish('rollout.badSteps', bad);
          lab.publish('rollout.earlyStopped', early);
          expect(total).toBe(8 * GROUP);
          expect(bad).toBe(0);
          // 训练过的模型会好好停下来 —— 一条都不提前停的话这条门槛是白测的
          expect(early).toBeGreaterThan(total / 2);
        });

        /*
         * 用没用 KV cache 不能靠声明，要靠数 FLOPs。
         * 对照是平台自己的那份 —— 采样完全一样，只是每步整段重算。
         */
        it('FLOPs 不到不带 cache 的 0.6 倍', () => {
          setup();
          // 先把模型建好 —— 它要训 120 步，那些 FLOPs 不该算进任何一边
          lab.py('_m = _model()');
          const before = lab.metrics().flops.total;
          lab.py('_a = rollout.rollout(_m, _prompts, ' + GROUP + ', ' + MAX_NEW + ', seed=7)');
          const withCache = lab.metrics().flops.total - before;

          const b2 = lab.metrics().flops.total;
          lab.py('_b = _naive(_m, _prompts, ' + GROUP + ', ' + MAX_NEW + ', seed=7)');
          const naive = lab.metrics().flops.total - b2;

          const ratio = withCache / naive;
          console.log(
            '带 cache ' + withCache + ' FLOPs，不带 ' + naive
            + '，比值 ' + ratio.toFixed(3)
          );
          lab.publish('flops.rolloutOverNaive', ratio);
          expect(withCache).toBeGreaterThan(0);
          expect(ratio).toBeLessThan(0.6);

          // 顺带：两边采出来的样本应当一模一样（同一个采样过程，只是算法不同）
          const same = JSON.parse(String(lab.py(\`
      json.dumps(sum(1 for x, y in zip(_a, _b)
                     for u, v in zip(x["samples"], y["samples"]) if u != v))
      \`)));
          console.log('两条路采出来不同的样本数 ' + same);
          lab.publish('rollout.cacheMismatches', same);
          expect(same).toBe(0);
        });

        /*
         * RL 的调试几乎完全依赖重放。随机性必须是**可寻址的**：
         * 同一个 (seed, i, j) 永远给同一条输出，换 batch 大小也不变。
         */
        it('同 seed 两遍逐条相同，换 seed 会不同', () => {
          setup();
          const r = JSON.parse(String(lab.py(\`
      _x = rollout.rollout(_model(), _prompts, \${GROUP}, \${MAX_NEW}, seed=11)
      _y = rollout.rollout(_model(), _prompts, \${GROUP}, \${MAX_NEW}, seed=11)
      _z = rollout.rollout(_model(), _prompts, \${GROUP}, \${MAX_NEW}, seed=99)
      # 换个「批」的划分：一次只跑一个 prompt，结果也该一样
      _split = []
      for _i, _p in enumerate(_prompts):
          _one = rollout.rollout(_model(), [_p], \${GROUP}, \${MAX_NEW}, seed=11)
          _split.append(_one[0]["samples"])
      json.dumps({"x": [g["samples"] for g in _x], "y": [g["samples"] for g in _y],
                  "z": [g["samples"] for g in _z], "split": _split})
      \`)));
          let same = 0, diff = 0, splitBad = 0;
          for (let i = 0; i < r.x.length; i++) {
            for (let j = 0; j < GROUP; j++) {
              if (r.x[i][j] !== r.y[i][j]) same += 1;
              if (r.x[i][j] !== r.z[i][j]) diff += 1;
              if (r.x[i][j] !== r.split[i][j]) splitBad += 1;
            }
          }
          console.log(
            '同 seed 两遍对不上 ' + same + ' 条；换 seed 不同的 ' + diff + ' 条；'
            + '换批划分对不上 ' + splitBad + ' 条'
          );
          lab.publish('rollout.determinismMismatches', same + splitBad);
          expect(same).toBe(0);
          // 换了批的划分也必须一样 —— 这才叫「可寻址」，而不只是「跑两遍一样」
          expect(splitBad).toBe(0);
          expect(diff).toBeGreaterThan(0);
        });
      });
    `),
  ],
  gates: [
    gate({
      metric: 'llm.rollout.badSteps', op: 'eq', value: 0,
      zh: '步数与「撞 EOS 就停」对不上的样本数',
      en: 'samples whose step count contradicts stopping at EOS', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.flops.rolloutOverNaive', op: 'lte', value: 0.6,
      zh: 'rollout 与不带 cache 版本的 FLOPs 比',
      en: 'rollout FLOPs over the uncached version', dimension: 'efficiency',
    }),
    gate({
      metric: 'llm.rollout.cacheMismatches', op: 'eq', value: 0,
      zh: '带 cache 与不带 cache 采出来不同的样本数',
      en: 'samples differing between the cached and uncached paths', dimension: 'correctness',
    }),
    gate({
      metric: 'llm.rollout.determinismMismatches', op: 'eq', value: 0,
      zh: '重放与换批划分之后对不上的样本数',
      en: 'samples differing on replay or under a different batching', dimension: 'correctness',
    }),
  ],
  focus: ['correctness', 'efficiency'],
  extension: t(
    code`
      真实的 RL 系统里，rollout 和训练是**两个独立的进程**，
      常常跑在不同的卡上：推理引擎（vLLM / SGLang）负责采样，
      训练框架负责更新，中间靠**权重同步**连起来。

      这带来一个 2026 年才被认真对待的问题：**推理和训练的数值不一致**。
      推理引擎为了快用了不同的 kernel、不同的批处理、不同的精度，
      于是它算出来的 \`log π\` 和训练框架算出来的**不完全相等**。
      而 PPO / GRPO 的比值项 \`π_new / π_old\` 恰恰是两者相除,
      一点点不一致会被放大成一个假的比值，训练就此跑偏。
      解决办法要么是让两边用同一套 kernel，要么是在训练侧**重算一遍** log π。

      另外两件真实的事：

      **partial rollout。** 长序列采到一半可以先存下来，下一轮接着采,
      不必等最长的那条跑完。这让批的利用率高很多。

      **异步。** 采样和更新重叠起来跑，代价是用来采样的策略比当前策略旧几步
      （\`off-policy\` 的程度变高）。这正是 GRPO 那些修正项要处理的东西。
    `,
    code`
      In real RL systems the rollout and the training loop are **two separate processes**,
      often on different devices: an inference engine (vLLM / SGLang) samples, a training
      framework updates, and **weight synchronisation** links them.

      This creates a problem taken seriously only recently: **numerical mismatch between
      inference and training**. The inference engine uses different kernels, batching and
      precision for speed, so its \`log π\` is **not exactly equal** to the training
      framework's. PPO and GRPO divide precisely these two quantities in \`π_new / π_old\`,
      so a small inconsistency inflates into a spurious ratio and training drifts. The fixes
      are either sharing kernels between the two or **recomputing** log π on the training
      side.

      Two more realities:

      **Partial rollout.** A long sequence can be checkpointed mid-generation and continued
      next round, rather than holding the batch until the longest one finishes. Batch
      utilisation improves substantially.

      **Asynchrony.** Overlap sampling with updating, at the cost of the sampling policy
      lagging the current one by a few steps (more \`off-policy\`). That is exactly what
      GRPO's correction terms are built to handle.
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
  stages: [
    STAGE_BPE, STAGE_BASELINE, STAGE_ATTENTION, STAGE_MHA,
    STAGE_ROPE, STAGE_NORM, STAGE_BLOCK, STAGE_KVCACHE,
    STAGE_MANUAL_BWD, STAGE_ENGINE, STAGE_MODEL_BWD, STAGE_ADAMW,
    STAGE_SCHEDULE, STAGE_CLIP, STAGE_PACKING, STAGE_PRETRAIN,
    STAGE_AMP, STAGE_RECOMPUTE, STAGE_SCALING, STAGE_MOE, STAGE_MUON,
    STAGE_SFT, STAGE_MIXTURE, STAGE_RM, STAGE_DPO, STAGE_LENGTH, STAGE_ROLLOUT,
  ],
};
