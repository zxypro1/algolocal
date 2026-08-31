/**
 * 预置工程的关卡前置知识。
 *
 * 任务定义负责接口、验收和参考实现。这个文件只负责在动手前把领域概念讲清楚。
 * 每段都假设读者会基本编程，但没有接触过对应的系统。
 */
const { t } = require('./definitions/_helpers');

const p = (...paragraphs) => paragraphs.join('\n\n');

const primers = {
  'database-engine': {
    pager: t(
      p(
        '数据库通常把存储空间切成固定大小的`页`。上层只用页号读写，不直接关心这块数据此刻在磁盘还是内存。`缓冲池`是页在内存中的缓存，它记录哪些页正在使用、哪些页被改脏，以及空间不够时该淘汰谁。',
        '读取页时，如果缓冲池里已经有副本，就叫`缓存命中`；否则要从磁盘读取，叫`缓存未命中`。容量满后，本关用 LRU 淘汰最久没有被访问的页。`writePage`只修改缓存并把页标成`脏页`，脏页被淘汰前必须写回。`flush`会批量写回所有脏页，再调用一次 fsync，明确告诉存储设备这些修改需要持久保存。'
      ),
      p(
        'Databases usually divide storage into fixed-size `pages`. Higher layers read and write by page number instead of caring whether the bytes currently live on disk or in memory. A `buffer pool` caches pages in memory and tracks which pages are in use, which have been modified, and which page may be evicted when the cache is full.',
        'Reading a page already in the buffer pool is a `cache hit`; loading it from disk is a `cache miss`. When capacity is full, this stage uses LRU to evict the page that has gone unused for the longest time. `writePage` changes only the cached copy and marks it as a `dirty page`, so a dirty page must be written back before eviction. `flush` writes every dirty page in one batch and then calls fsync once, asking the storage system to make those changes durable.'
      )
    ),
    'slotted-page': t(
      p(
        '一页里往往要放很多长度不同的记录。如果记录从页头连续排列，删除中间一条就会让后面的地址全部变化。`槽页`把记录内容放在页尾附近，把一个很小的槽目录放在页头。槽中只保存记录的偏移和长度，因此记录移动后，外部仍可用`页号 + 槽号`找到它。',
        '页内空闲空间位于槽目录和记录区之间。插入要同时为新槽和记录正文留位置，删除则要决定是否压紧碎片。这里的编码不是把对象直接塞进数组，而是定义一套稳定的字节布局。长度、空值和字段边界都必须能从字节中重新读出来。'
      ),
      p(
        'A page often stores many variable-length records. If records are laid out from the front with no indirection, deleting one record changes every address after it. A `slotted page` keeps record bodies near the end and a small slot directory at the front. Each slot stores an offset and length, so callers can keep using `page id + slot id` even when a record moves inside the page.',
        'Free space sits between the growing slot directory and the record area. An insertion must reserve room for both a slot and its bytes. Deletion may leave a hole or compact the remaining records. The encoder in this stage defines a stable byte layout rather than storing JavaScript objects directly. Lengths, null values, and field boundaries must all be recoverable from those bytes.'
      )
    ),
    'heap-file': t(
      p(
        '`堆文件`不是内存里的堆数据结构。数据库中的 heap file 是一组没有排序要求的数据页，新记录可以放进任何有空间的页。记录的位置通常写成`RID`，也就是页号和槽号的组合。索引和执行器以后会拿着 RID 回表读取完整记录。',
        '插入时逐页扫描虽然容易写，但表一大就会变慢，所以存储层通常要记住哪些页还有空位。`表扫描`则按页和槽遍历所有有效记录，并跳过已删除的槽。本关把前两关的页与槽组织成一张表，重点是让插入、按 RID 读取和全表遍历共享同一套位置语义。'
      ),
      p(
        'A database `heap file` is unrelated to the heap data structure used by priority queues. It is a collection of data pages with no required record order. New records may go into any page with enough space. A record location is commonly represented by an `RID`, a pair containing a page id and slot id. Later, an index can return an RID and the executor can use it to fetch the full record.',
        'Scanning every page to find insertion space is simple but becomes expensive as a table grows, so the storage layer normally remembers which pages still have room. A `table scan` walks pages and slots while skipping deleted entries. This stage combines pages and slots into one table abstraction whose insert, RID lookup, and scan operations agree on what a record location means.'
      )
    ),
    btree: t(
      p(
        '索引保存“键到记录位置”的映射，让数据库不用每次都扫描整张表。B+Tree 是一棵保持有序且高度平衡的多叉树。内部节点只负责把查找导向某个子节点，叶子节点保存键和 RID，并按顺序相连，方便范围查询。',
        '节点大小受一页容量限制。插入使节点溢出时，节点会分裂，并把分隔键交给父节点；父节点也可能继续分裂。所有叶子必须处在同一深度，否则一次查找的成本就不稳定。本关中的数组和节点对象是在模拟磁盘页，真正要守住的是键顺序、子指针数量和分裂后的可达性。'
      ),
      p(
        'An index stores a mapping from a key to a record location so the database does not scan the whole table for every lookup. A B+Tree is an ordered, height-balanced tree with many children per node. Internal nodes only direct a search toward a child. Leaf nodes store keys and RIDs and are linked in order, which also supports range scans.',
        'A node is limited by page capacity. When insertion overflows a node, the node splits and passes a separator key to its parent. That parent may split as well. Every leaf must remain at the same depth so lookup cost stays predictable. The arrays and node objects in this exercise model disk pages; the important invariants are key order, child counts, and reachability after each split.'
      )
    ),
    wal: t(
      p(
        '数据库不能假设一次写入会完整落盘。进程可能在数据页只写了一半时崩溃。`预写日志`简称 WAL，它要求描述修改的日志记录先持久化，数据页随后再写。日志中的`LSN`是递增位置，数据页记录自己已经包含到哪个 LSN，恢复程序据此判断是否需要重放。',
        '`redo`把已经承诺但尚未写进数据页的修改重新做一遍，`undo`撤销崩溃时还没有提交的事务。`checkpoint`只缩短恢复需要扫描的日志范围，并不替代日志。本关用内存对象模拟磁盘，但写入顺序仍然是核心：日志没有先出现，就没有足够信息判断崩溃后的数据是否可信。'
      ),
      p(
        'A database cannot assume that one write reaches storage atomically. The process may crash after only part of a data page has been written. `Write-ahead logging`, or WAL, requires the log record describing a change to become durable before the changed page is written. Each log position has an increasing `LSN`. A data page records the latest LSN it contains so recovery can decide whether a log record still needs to be applied.',
        '`Redo` repeats committed work that did not reach the data page. `Undo` removes work from transactions that had not committed when the crash happened. A `checkpoint` reduces how much of the log recovery must scan, but it does not replace the log. This exercise models storage with objects, yet ordering remains the central rule: without the earlier log record, recovery has no reliable description of the intended change.'
      )
    ),
    'lock-manager': t(
      p(
        '两个事务同时访问同一条记录时，需要先约定谁能读、谁能写。`共享锁`允许多个读者共存，`排他锁`只允许一个写者，并排斥其他读写。`两阶段锁`要求事务先进入只获取锁的阶段，开始释放后便不能再拿新锁，这样并发执行才等价于某个串行顺序。',
        '锁会带来等待。事务 A 等 B 的锁，B 又等 A，就形成`死锁`。锁管理器可以把等待关系画成有向图，图里出现环就说明一组事务无法自行前进。本关需要同时维护持有者、等待队列和等待图，唤醒顺序也要避免后来者绕过已经排队的人。'
      ),
      p(
        'When two transactions access the same record, they need rules for who may read and who may write. A `shared lock` allows multiple readers. An `exclusive lock` allows one writer and excludes other readers and writers. `Two-phase locking` says that a transaction first acquires locks, then enters a phase where it only releases them. Once release begins, it may not acquire another lock. This restriction makes the concurrent result equivalent to some serial order.',
        'Locks create waiting. If transaction A waits for B while B waits for A, the transactions are in a `deadlock`. A lock manager can represent waits as a directed graph; a cycle means that group cannot make progress without aborting someone. This stage maintains owners, wait queues, and the wait graph together. Wakeup order also matters because a new request must not skip a compatible request that has already been waiting.'
      )
    ),
    mvcc: t(
      p(
        '`MVCC`是多版本并发控制。一次更新不会立刻覆盖旧记录，而是追加一个带事务时间信息的新版本。读事务根据自己的快照选择可见版本，因此读者通常不需要挡住写者。版本链则把同一条逻辑记录的多个历史版本连在一起。',
        '`快照隔离`让一个事务在整个执行期间看到一致的数据视图，但它不等于完全串行化。两个事务可以读取同一旧状态，再分别修改不同记录，最后产生不满足业务约束的结果。本关要先把可见性规则和写写冲突处理正确：一个版本何时开始可见、何时结束可见，都必须由事务状态和时间戳共同决定。'
      ),
      p(
        '`MVCC` means multi-version concurrency control. An update does not immediately overwrite the old record. It creates a new version carrying transaction timing information. A reader chooses the version visible to its snapshot, so readers usually do not block writers. A version chain connects the historical versions of one logical record.',
        '`Snapshot isolation` gives a transaction one consistent view for its lifetime, but it is not the same as full serializability. Two transactions may read the same old state, update different records, and jointly break a business rule. This stage first makes visibility and write-write conflict handling precise. Whether a version is visible depends on its creator, its replacement time, and the states of the transactions involved.'
      )
    ),
    'sql-parser': t(
      p(
        'SQL 文本不能直接交给执行器。`词法分析器`先把字符分成 token，例如关键字、标识符、数字和运算符。`解析器`再按照语法把 token 组成 AST，也就是抽象语法树。AST 保留语句结构，但丢掉空格和多数标点这类执行时不需要的信息。',
        '`递归下降`为不同语法规则编写相互调用的函数。表达式还要处理运算符优先级，否则 `a + b * c` 会被错误地按从左到右计算。解析错误必须指出遇到了什么以及期望什么。本关只负责结构，不检查表名或列名是否真实存在，那是下一关绑定阶段的工作。'
      ),
      p(
        'SQL text cannot go directly to the executor. A `lexer` first groups characters into tokens such as keywords, identifiers, numbers, and operators. A `parser` then applies grammar rules to turn those tokens into an AST, or abstract syntax tree. The AST preserves statement structure while discarding whitespace and most punctuation that execution no longer needs.',
        '`Recursive descent` implements grammar rules as functions that call one another. Expression parsing must also respect operator precedence, or `a + b * c` will be grouped incorrectly. A useful syntax error reports both the token it found and what the grammar expected. This stage only builds structure. It does not decide whether a table or column really exists; that belongs to binding in the next stage.'
      )
    ),
    planner: t(
      p(
        '`目录`是数据库保存的元数据，包括有哪些表、每张表有哪些列以及列的类型。解析器看到的 `users.id` 仍只是几个名字，`绑定器`要查目录，把名字解析成唯一的表和列，并在这里报告不存在或含糊的引用。',
        '绑定后的语句会变成`逻辑计划`。逻辑计划描述要做什么，例如扫描、过滤、投影和连接，但暂时不决定使用哪个索引或哪种连接算法。把名字解析和执行策略分开后，后面的优化器可以替换计划节点，而不用重新理解 SQL 文本。本关的节点对象就是这层中间表示。'
      ),
      p(
        'The `catalog` is database metadata: which tables exist, which columns each table has, and the type of every column. After parsing, `users.id` is still only a sequence of names. The `binder` looks those names up in the catalog, resolves them to one table and column, and reports missing or ambiguous references.',
        'A bound statement becomes a `logical plan`. The logical plan says what work is required, such as scan, filter, projection, or join, but does not yet choose a particular index or join algorithm. Separating name resolution from execution strategy lets the optimizer replace plan nodes without parsing SQL again. The node objects in this stage are that intermediate representation.'
      )
    ),
    executor: t(
      p(
        '`火山模型`把每个执行步骤做成一个迭代器。父节点调用子节点的 `next()` 拉取一行，过滤节点可能丢掉它，投影节点可能改写它，直到根节点把结果交给客户端。常见接口还有 `open()` 初始化资源和 `close()` 释放资源。',
        '这种拉取方式让不同算子能流水执行，不必先把整张中间表放进内存。并非所有算子都能逐行产出，例如完整排序通常要先读完输入，这类算子叫阻塞算子。本关要让扫描、过滤和投影遵守同一套生命周期，并正确处理输入耗尽和提前关闭。'
      ),
      p(
        'The `Volcano model` represents every execution step as an iterator. A parent calls `next()` on its child to pull one row. A filter may discard that row, while a projection may reshape it, until the root returns a result to the client. Typical interfaces also include `open()` for initialization and `close()` for releasing resources.',
        'Pull-based execution lets operators form a pipeline without materializing every intermediate table. Some operators cannot produce rows incrementally. A full sort, for example, usually consumes all input first and is called a blocking operator. This stage makes scans, filters, and projections follow one lifecycle while handling input exhaustion and early close correctly.'
      )
    ),
    join: t(
      p(
        '`连接`按照条件把两份输入中的行配对。最直接的嵌套循环连接会让左边每一行和右边所有行比较，容易理解，但输入一大，比较次数就是两边行数的乘积。`哈希连接`先把一侧按连接键建成哈希表，再用另一侧逐行查找，等值连接通常会少做很多比较。',
        '建哈希表的一侧叫 build side，逐行查找的一侧叫 probe side。重复键必须保存多行，空输入和没有匹配也要返回正确结果。算法选择取决于条件类型、输入大小和可用内存。本关先实现行为正确的连接算子，并把比较次数或内存占用暴露给后续优化器。'
      ),
      p(
        'A `join` pairs rows from two inputs according to a condition. The simplest nested-loop join compares every left row with every right row. It is easy to understand, but the comparison count is the product of both input sizes. A `hash join` first groups one input by the join key in a hash table, then looks up matches for each row from the other input. For equality joins, this usually performs far fewer comparisons.',
        'The input used to build the hash table is the build side; the streamed input is the probe side. Duplicate keys must retain multiple rows, and empty or unmatched inputs still need defined results. Algorithm choice depends on the condition, input sizes, and available memory. This stage first builds correct join operators and exposes costs that the optimizer can use later.'
      )
    ),
    optimizer: t(
      p(
        '同一份逻辑计划可以有很多执行方法。全表扫描和索引扫描都能读取一张表，多个连接也可以换顺序。`代价优化器`用估算值比较这些候选方案，而不是靠固定规则猜一个。`基数`是某个节点预计输出的行数，`选择率`表示过滤后保留的比例。',
        '估算来自表的统计信息，例如总行数、不同值数量和取值分布。估算不可能永远准确，所以代价模型要简单、可解释，并在信息缺失时有稳定退路。本关会枚举有限的候选计划，逐层估算读取、比较和中间结果的成本，再选择估算代价最低的一棵执行树。'
      ),
      p(
        'One logical plan can have many physical implementations. A table may be read by a full scan or an index scan, and several joins can be reordered. A `cost-based optimizer` compares candidate plans using estimates instead of selecting one with a fixed rule. `Cardinality` is the estimated number of rows produced by a node. `Selectivity` is the fraction expected to remain after a filter.',
        'Estimates come from table statistics such as row count, distinct values, and value distribution. They will not always be exact, so the cost model should stay simple, explainable, and stable when information is missing. This stage enumerates a bounded set of plans, estimates reads, comparisons, and intermediate results, then chooses the execution tree with the lowest estimated cost.'
      )
    ),
  },

  'enterprise-auth': {
    'credential-store': t(
      p(
        '密码验证不需要把原密码找回来，所以密码不该加密后保存，而该经过单向的密码哈希函数。普通哈希计算太快，攻击者拿到数据库后可以高速尝试候选密码。密码哈希会故意消耗较多时间或内存，让每次猜测都有成本。',
        '`salt`是每条密码记录独有的随机值。它不需要保密，作用是让两个相同密码产生不同结果，也让攻击者不能复用一张预计算表。记录中还要保存算法和参数，验证时才能用同样设置重算，并在参数升级后逐步迁移旧记录。'
      ),
      p(
        'Password verification does not require recovering the original password, so passwords should not be stored with reversible encryption. They are processed by a one-way password hashing function. General-purpose hashes are too fast: after stealing a database, an attacker can test guesses at high speed. Password hashes deliberately consume more time or memory so every guess has a cost.',
        'A `salt` is a random value unique to each password record. It is not secret. It makes equal passwords produce different stored values and prevents reuse of one precomputed lookup table. The record must also store the algorithm and its parameters so verification can repeat the same work and old records can be upgraded when settings change.'
      )
    ),
    'session-token': t(
      p(
        '用户登录后，服务器需要在后续请求中识别他。无状态会话令牌把用户 id、签发时间和过期时间等`声明`放进令牌，并附上服务器才能生成的签名。服务器验证签名后就能相信这些字段没有被客户端改过，不必为每个请求查询会话表。',
        '签名不等于加密，令牌正文通常可以被客户端读到，因此不能放密码或其他秘密。验证还必须检查过期时间、签发者和允许的算法。只解析字符串而不验证签名，相当于允许调用方自己填写身份。本关会把编码、签发和验证分成明确步骤。'
      ),
      p(
        'After login, the server must recognize the user on later requests. A stateless session token places `claims` such as user id, issue time, and expiry in the token, then adds a signature that only the server can create. Once the signature is verified, the server knows the client did not alter those fields and can avoid a session lookup on every request.',
        'A signature is not encryption. Clients can usually read the token body, so it must not contain passwords or other secrets. Verification must also enforce expiry, issuer, and the permitted signing algorithm. Parsing a token without checking its signature lets the caller write their own identity. This stage keeps encoding, signing, and verification as separate operations.'
      )
    ),
    'refresh-rotation': t(
      p(
        '短期的 access token 用来访问接口，长期的 refresh token 用来换取新的 access token。这样泄漏的 access token 很快失效，同时用户不必频繁重新输入密码。refresh token 权限更大，所以服务器通常会保存它的状态，并在每次使用后换成一个新值。',
        '`轮转`把旧 refresh token 标记为已使用，再签发下一枚。正常客户端只会使用最新一枚；如果旧值再次出现，说明同一令牌可能被复制。服务器可以撤销这一整条 token family，而不是继续给攻击者发新令牌。本关的难点是让“检查旧值、作废、签发新值”成为不可分割的一次状态变更。'
      ),
      p(
        'A short-lived access token authorizes API calls. A longer-lived refresh token obtains a new access token. A stolen access token therefore expires soon, while the user does not need to enter a password repeatedly. A refresh token has greater power, so the server normally tracks its state and replaces it after every use.',
        '`Rotation` marks the old refresh token as used and issues the next token. A normal client uses only the newest value. Seeing an old value again suggests that someone copied it. The server can then revoke the entire token family instead of issuing more tokens to an attacker. The important state change in this stage is atomic: check the old token, consume it, and create its replacement as one operation.'
      )
    ),
    revocation: t(
      p(
        '无状态令牌的优点是验证时不查服务器状态，缺点是签发后很难提前收回。用户登出、设备丢失或账号被封时，系统不能只等令牌自然过期。`撤销`就是给原本无状态的验证过程补上一小块服务器状态。',
        '常见做法包括记录令牌 id 的 denylist、给用户维护 session version，或撤销某次登录产生的整个会话族。撤销记录至少要活到对应令牌过期，否则旧令牌会在记录清理后重新有效。本关要把登出范围说清楚：撤销一个令牌、一个设备会话和全部会话是三种不同操作。'
      ),
      p(
        'The advantage of a stateless token is that verification needs no server-side session lookup. The drawback is that an issued token is difficult to take back early. Logout, a lost device, or a disabled account cannot always wait for natural expiry. `Revocation` adds a small amount of server state to that otherwise stateless check.',
        'Common designs store token ids in a denylist, keep a session version per user, or revoke the whole family created by one login. A revocation record must live at least until the matching token expires, or the old token becomes valid again after cleanup. This stage distinguishes three scopes: one token, one device session, and every session for the account.'
      )
    ),
    'mfa-totp': t(
      p(
        '`TOTP`是一种随时间变化的一次性密码。服务器和用户的验证器共享一个秘密值，双方把当前时间切成固定长度的时间步，再用同样的算法算出短数字。网络中只传数字，不传共享秘密。数字很短，所以仍要限制尝试次数。',
        '两台设备的时钟可能有小偏差，验证器通常接受当前时间步附近的少量窗口，但窗口越大，可猜的有效代码也越多。恢复码用于用户失去验证器时登录，它们应当随机生成、以哈希形式保存，并且每个只能使用一次。本关会分别维护 TOTP 的时间窗口和恢复码的消费状态。'
      ),
      p(
        '`TOTP` is a time-based one-time password. The server and the user authenticator share a secret. Both divide current time into fixed steps and run the same calculation to obtain a short numeric code. Only the code crosses the network; the shared secret does not. Because the code is short, the server must still limit guesses.',
        'The two devices may have slightly different clocks, so verification often accepts a small window around the current time step. A wider window also means more valid codes can be guessed. Recovery codes let a user sign in after losing the authenticator. They should be random, stored as hashes, and consumed once. This stage tracks the TOTP window and recovery-code state separately.'
      )
    ),
    'oauth-code-pkce': t(
      p(
        'OAuth 2.0 解决的是“一个应用如何代表用户访问另一个服务”，并不直接定义用户身份。授权服务器先让用户批准权限，再把一个短期`授权码`交给客户端。客户端在后端用授权码换 token，这样长期凭据不会经过浏览器地址栏。',
        '公开客户端无法安全保存 client secret，因此使用 PKCE。客户端先生成随机 `verifier`，把它的摘要 `challenge` 放进授权请求；兑换授权码时再提交原 verifier。截获授权码的人没有 verifier，无法完成兑换。本关要保存授权码和 challenge 的绑定，并保证授权码只能使用一次。'
      ),
      p(
        'OAuth 2.0 answers how one application may access another service on behalf of a user. It does not by itself define the user identity. The authorization server asks the user to approve a scope, then gives the client a short-lived `authorization code`. The client exchanges that code for tokens through a back channel, so the lasting credential does not pass through the browser address bar.',
        'A public client cannot safely keep a client secret, so it uses PKCE. The client creates a random `verifier` and sends its digest, the `challenge`, with the authorization request. It sends the original verifier only when redeeming the code. Someone who intercepts the code still lacks the verifier. This stage binds code and challenge together and makes every code single use.'
      )
    ),
    'oidc-verify': t(
      p(
        'OpenID Connect 在 OAuth 2.0 之上增加身份层。身份提供方签发的 `ID token`说明谁完成了登录。接收方不能因为 token 长得像 JWT 就相信它，还要验证签名、签发者 `issuer`、接收者 `audience`、有效期和本次登录使用的 `nonce`。',
        '身份提供方会通过 JWKS 发布公钥，并用 `kid`说明当前 token 该用哪把钥匙验证。密钥轮转时，新旧公钥可能短暂共存，所以缓存既要减少网络请求，也要能在遇到未知 kid 时刷新。本关模拟这套取钥匙和校验流程，重点是不要把“能解析”误当成“可信”。'
      ),
      p(
        'OpenID Connect adds an identity layer on top of OAuth 2.0. An `ID token` issued by the identity provider states who completed the login. A relying party must not trust it merely because it looks like a JWT. It verifies the signature, `issuer`, intended `audience`, expiry, and the `nonce` created for this particular login.',
        'The provider publishes public keys through JWKS and puts a `kid` in each token to identify the verification key. During key rotation, old and new keys may coexist. A cache should avoid unnecessary network calls but refresh when it encounters an unknown kid. This stage models key lookup and validation, keeping “can be decoded” separate from “has been authenticated.”'
      )
    ),
    rbac: t(
      p(
        '`RBAC`按角色分配权限。用户拥有角色，角色拥有诸如 `invoice:read` 的权限，验证时把这些关系展开。角色继承可以让 `admin`包含 `editor` 的权限，但继承图出现环时，朴素递归会无限循环。',
        '通配权限让一个规则覆盖一组资源或动作，例如 `invoice:*`。匹配规则必须明确，不能用普通字符串前缀随便判断，否则相似名称也可能被放行。缓存展开后的权限可以提速，但角色关系改变时必须失效。本关先把继承遍历、去重和通配匹配做成确定的授权判断。'
      ),
      p(
        '`RBAC` assigns permissions through roles. A user has roles, and a role has permissions such as `invoice:read`. Authorization expands those relationships before making a decision. Role inheritance can let `admin` include the permissions of `editor`, but a cycle in the inheritance graph makes naive recursion run forever.',
        'Wildcard permissions let one rule cover a set of resources or actions, such as `invoice:*`. Matching rules must be explicit; arbitrary string-prefix checks can allow similarly named permissions by accident. Expanded permissions may be cached, but role changes must invalidate that cache. This stage turns inheritance traversal, deduplication, and wildcard matching into one deterministic authorization check.'
      )
    ),
    'abac-policy': t(
      p(
        '`ABAC`根据属性做决定，而不是只看角色。策略可以读取用户部门、资源所有者、请求动作或时间等输入。例如“用户是文档所有者并且动作是 read”就是一条条件策略。属性来自不同对象，因此同名字段要有清楚的命名空间。',
        '多条策略同时匹配时需要组合规则。安全系统通常先采用`默认拒绝`，只有明确允许才放行；显式拒绝还可以覆盖允许。策略求值不应在缺字段或类型不对时悄悄变成允许。本关会把条件、效果和组合顺序表示成数据，让结果可以测试和解释。'
      ),
      p(
        '`ABAC` makes a decision from attributes instead of roles alone. A policy may inspect the user department, resource owner, requested action, or time. For example, “the user owns the document and the action is read” is a conditional policy. Attributes come from different objects, so equally named fields need clear namespaces.',
        'When several policies match, the evaluator needs a combining rule. A secure system normally starts with `default deny`: access is denied unless a rule explicitly allows it. An explicit deny may also override an allow. Missing fields or type mismatches must not quietly become permission. This stage represents conditions, effects, and combination order as data so each decision can be tested and explained.'
      )
    ),
    'permission-cache': t(
      p(
        '一次权限判断可能需要展开角色、读取策略和资源属性。缓存能省掉重复工作，但缓存的键必须包含所有会影响结果的输入。只按 user id 缓存，会把用户对一个资源的允许结果错误地用于另一个资源。',
        '`TTL`只能限制错误结果最多保留多久，不能保证权限撤销立即生效。更及时的做法是给用户、角色或策略维护版本号，变更时让旧版本的缓存键自然失效，或主动删除相关条目。本关要同时处理命中、过期和变更通知，并保证拒绝结果不会因为缓存缺失而变成允许。'
      ),
      p(
        'One authorization decision may expand roles, read policies, and inspect resource attributes. Caching avoids repeating that work, but the cache key must include every input that can change the answer. A key containing only the user id can reuse permission for one resource when checking a different resource.',
        'A `TTL` only limits how long a stale decision survives; it does not make revocation immediate. A more direct design versions users, roles, or policies so a change makes old keys unreachable, or actively removes related entries. This stage handles hits, expiry, and change notifications while preserving the rule that a missing cache entry never turns a denial into an allow.'
      )
    ),
    'tenant-isolation': t(
      p(
        '多租户系统让多个组织共用一套服务，但每份业务数据都属于一个`tenant`。隔离不能只靠页面隐藏按钮，数据查询、缓存键、后台任务和审计记录都要带 tenant id。只要其中一层漏掉，合法登录的用户也可能读到别的组织数据。',
        'tenant id 应来自已经验证的身份上下文，而不是直接相信请求参数。存储接口最好要求调用方显式传入租户范围，让“不带租户的全局查询”很难写出来。本关会用两个租户的相同资源 id 制造冲突，检查读取、更新和缓存是否始终留在当前边界内。'
      ),
      p(
        'A multi-tenant system serves several organizations from one application, but every business record belongs to one `tenant`. Isolation cannot live only in hidden UI buttons. Database queries, cache keys, background jobs, and audit records all need the tenant id. Missing it in one layer can expose another organization to a user who is otherwise properly authenticated.',
        'The tenant id should come from an authenticated identity context rather than an untrusted request parameter. Storage APIs can require an explicit tenant scope, making an accidental global query difficult to express. This stage creates identical resource ids in two tenants and checks that reads, updates, and cache entries never cross the current boundary.'
      )
    ),
    'audit-hardening': t(
      p(
        '审计日志回答谁在什么时候做了什么。普通日志可以被改写或删除，`哈希链`则让每条记录包含前一条记录的摘要。中间记录一旦变化，后续摘要都会对不上。它不能阻止拥有存储权限的人删除整条链，但能发现链内的篡改和断点。',
        '登录入口还要面对撞库和暴力尝试。按账号和来源限制速率、记录失败原因、成功后清理失败状态，都比只做一个全局计数更准确。本关把登录加固产生的安全事件写入同一条审计链，并要求验证器能定位链从哪条记录开始损坏。'
      ),
      p(
        'An audit log answers who did what and when. Ordinary log entries can be edited or deleted. A `hash chain` makes every entry include a digest of the previous entry. Changing an entry then breaks every digest after it. This does not stop someone with storage access from deleting the entire chain, but it detects modification and gaps inside the retained history.',
        'The login boundary also faces credential stuffing and repeated guessing. Rate limits by account and source, explicit failure records, and cleanup after a successful login provide better control than one global counter. This stage writes security events into the same audit chain and requires the verifier to identify the first damaged entry.'
      )
    ),
  },

  'enterprise-im': {
    'connection-registry': t(
      p(
        '即时通讯依赖长连接。客户端连接成功后，服务器要记住“用户的哪个设备连在哪条连接上”，收到消息时才能找到投递目标。一个用户可能同时登录手机和电脑，所以注册表不能把 user id 简单映射成单条连接。',
        '`心跳`是连接空闲时定期发送的小消息，用来区分“暂时没有聊天”和“连接已经断了”。服务器记录最后一次活动时间，超过租约才清理连接。旧连接的迟到关闭事件不能误删同一设备刚建立的新连接，因此每条连接还需要自己的唯一标识。'
      ),
      p(
        'Instant messaging relies on long-lived connections. After a client connects, the server records which device for which user is attached to that connection, so later messages can find a destination. One user may have a phone and a laptop online at the same time, so the registry cannot map a user id to only one connection.',
        'A `heartbeat` is a small message sent during idle periods. It distinguishes a quiet conversation from a dead connection. The server records the last activity and removes a connection only after its lease expires. A delayed close event from an old connection must not remove a newer connection for the same device, so every connection also needs a unique identity.'
      )
    ),
    'message-seq': t(
      p(
        '会话里的消息需要一个单调递增的`序号`。客户端可以用序号排序、判断是否漏消息，并在断线后从某个位置继续拉取。服务器接收消息时分配序号，比相信客户端时间更可靠，因为不同设备的时钟和网络延迟都不一致。',
        '客户端超时后会重试发送，同一条逻辑消息可能到达多次。`幂等键`让服务器认出重复请求并返回第一次分配的序号，而不是再写一条消息。检查幂等键和增加会话序号必须作为一次原子操作，否则两个并发请求仍可能拿到不同序号。'
      ),
      p(
        'Messages in a conversation need a monotonically increasing `sequence number`. A client uses it to sort messages, detect gaps, and resume after disconnection. The server assigns the sequence when accepting a message. This is more reliable than client timestamps because device clocks and network delays differ.',
        'A client retries when a send appears to time out, so the same logical message may arrive more than once. An `idempotency key` lets the server recognize the duplicate and return the sequence assigned on the first attempt instead of storing another message. Checking that key and incrementing the conversation sequence must be one atomic operation, or concurrent retries can still receive different numbers.'
      )
    ),
    'offline-backlog': t(
      p(
        '设备离线时，消息仍会继续进入会话。重新上线后一次返回全部历史既慢又占内存，所以客户端带上自己已知的最后序号，服务器只返回更晚的消息。这种“从位置继续”的方式叫增量拉取。',
        '返回结果还要有上限，并用`游标`告诉客户端下一页从哪里开始。游标表示已经扫描到的位置，不应由数组下标充当，因为清理旧消息后数组下标会变化。本关要区分“这页没有更多数据”和“还有数据但达到本页上限”，并保证分页之间不重不漏。'
      ),
      p(
        'Messages continue to enter a conversation while a device is offline. Returning the entire history on reconnect is slow and memory hungry, so the client sends the last sequence it knows and the server returns only later messages. This is an incremental catch-up.',
        'Each response also needs a limit and a `cursor` telling the client where the next page begins. A cursor represents a stable scan position; an array index is unsuitable because removing old messages changes every later index. This stage distinguishes “there is no more data” from “this page reached its limit” and keeps consecutive pages free of gaps and duplicates.'
      )
    ),
    'device-sync': t(
      p(
        '同一账号的每台设备都有自己的同步进度。手机读到了序号 80，不代表关机中的电脑也收到了 80。服务器需要按 user、device 和 conversation 保存游标，设备重连时只推进自己的位置。',
        '游标只能向前移动。网络重排可能让一条旧确认晚到，如果直接覆盖，进度会倒退，下一次拉取就会重复大量消息。新设备通常从明确的初始位置开始，而不是偷用另一台设备的游标。本关把多设备看成相互独立的消费者，再由账号层汇总它们的状态。'
      ),
      p(
        'Every device for one account has its own synchronization progress. If the phone has received sequence 80, a powered-off laptop has not necessarily received it. The server stores a cursor for each user, device, and conversation, and a reconnecting device advances only its own position.',
        'A cursor may move forward but never backward. Network reordering can deliver an old acknowledgement late; replacing the stored value would rewind progress and cause a large duplicate fetch. A new device starts from an explicit initial position rather than borrowing another device cursor. This stage treats devices as independent consumers whose state can later be summarized at account level.'
      )
    ),
    'read-cursor': t(
      p(
        '`已读位点`是用户确认读到的最大消息序号。未读数不必为每条消息保存布尔值，可以根据会话最新序号和已读位点计算，或用索引统计位点之后仍可见的消息。位点同样只能前进。',
        '消息可能被删除、撤回或对某个成员不可见，所以“最新序号减已读序号”不一定永远等于真实未读条数。系统需要先定义本项目采用的可见性规则，再让写入和查询保持一致。本关用单调位点避免重复标记大量消息，并检查迟到更新不会增加未读数。'
      ),
      p(
        'A `read cursor` is the greatest message sequence a user confirms reading. The system does not need one boolean per message. It can derive unread state from the latest conversation sequence and the cursor, or count visible messages after that cursor. Like synchronization progress, a read cursor only moves forward.',
        'Deletion, recall, or per-member visibility can mean that “latest sequence minus read sequence” is not always the exact unread count. A system must define its visibility rule and use it consistently for writes and queries. This stage uses a monotonic cursor instead of updating many message records and checks that a late update cannot increase the unread count.'
      )
    ),
    receipts: t(
      p(
        '`送达`表示消息已经到达某台目标设备，`已读`表示用户在客户端确认看过。它们不是同一个状态，也不应由“连接在线”推断。群聊里还要按接收者分别记录，因为不同成员的进度不同。',
        '回执是一种状态机：未送达可以变成已送达，已送达可以变成已读，但迟到的旧事件不能让状态倒退。重复回执应当没有副作用。服务器还要决定按设备记录还是按用户汇总，本关会先保存细粒度状态，再提供稳定的聚合结果。'
      ),
      p(
        '`Delivered` means a message reached a target device. `Read` means the user explicitly confirmed viewing it. These are different states and cannot be inferred merely because a connection is online. In a group conversation, receipt state also belongs to each recipient because members progress independently.',
        'Receipts form a state machine: pending may become delivered, and delivered may become read, but a late old event must not move the state backward. Repeated receipts should have no additional effect. The server must also decide whether to expose device-level or user-level state. This stage stores the finer-grained facts first and derives a stable aggregate.'
      )
    ),
    'group-fanout': t(
      p(
        '群消息写入后要让许多成员都能看到。`写扩散`在发送时为每个接收者写一份收件箱记录，读取很快，但大群发送成本高。`读扩散`只写一份会话消息，成员读取时再按成员关系筛选，写入便宜，但列表和未读查询更复杂。',
        '没有一种方案对所有群规模都最好。实现通常根据成员数量、读取频率和存储预算选择，甚至混合两种方式。本关用一个阈值决定路径，并要求两条路径返回相同的用户结果。重点不是复制数组，而是明确一份消息、订阅关系和用户收件箱各自保存什么。'
      ),
      p(
        'After a group message is stored, many members must be able to see it. `Write fan-out` creates an inbox entry for every recipient at send time. Reads are cheap, but sending to a very large group is expensive. `Read fan-out` stores one conversation message and applies membership when each user reads. Writes are cheap, while conversation lists and unread queries become more involved.',
        'Neither design is best for every group size. Systems choose according to member count, read frequency, and storage budget, and may combine both approaches. This stage selects a path with a threshold and requires both paths to produce the same user-visible result. The main design question is what belongs in the shared message, membership relation, and per-user inbox.'
      )
    ),
    presence: t(
      p(
        '`在线状态`是短暂信息，不像消息那样必须永久保存。设备连接、心跳超时或主动断开都会改变状态，一个用户有任意设备在线时通常就算在线。状态还可能带有最后活跃时间，但这个时间不应比新事件倒退。',
        '把每个人的状态广播给所有人会产生巨大流量。`订阅`让客户端只关注联系人或当前会话成员，服务器也只通知这些观察者。订阅本身会变化，断开的观察者要清理。本关会把设备状态聚合成用户状态，并只向当前订阅者发送实际发生变化的通知。'
      ),
      p(
        '`Presence` is temporary information, unlike a message that must remain durable. Device connect, heartbeat expiry, and explicit disconnect all change it. A user is commonly considered online while any device is online. Presence may include a last-active time, but a late event must not move that time backward.',
        'Broadcasting every presence change to every user creates excessive traffic. A `subscription` lets clients watch only contacts or current conversation members, and the server notifies only those observers. Subscriptions change over time and disconnected observers must be removed. This stage aggregates device state into user state and sends notifications only when the visible value actually changes.'
      )
    ),
    'edit-recall': t(
      p(
        '编辑和撤回不应直接抹掉历史事实。客户端可能已经收到原消息，后来才收到修改事件。把变化表示成带版本号的事件，可以让不同设备按顺序应用，并在重复或乱序到达时保留最新状态。',
        '撤回还要检查作者、时间窗口和当前版本。编辑后的旧请求不能覆盖更新版本，重复撤回也不该再次产生副作用。客户端最终展示的是原消息和后续变更折叠后的视图。本关会保存不可变事件，再用 message id 和 version 计算当前可见内容。'
      ),
      p(
        'Edit and recall should not erase the fact that an earlier message existed. A client may already have received the original and receive a change event later. Representing changes as versioned events lets devices apply them in order and keep the newest state when delivery is duplicated or reordered.',
        'Recall also checks the author, allowed time window, and current version. An edit based on an old version must not overwrite a newer one, and repeated recall should add no second effect. The client view is a fold of the original message and later changes. This stage stores immutable events and derives current visible content from message id and version.'
      )
    ),
    'e2ee-session': t(
      p(
        '`端到端加密`表示消息在发送设备上加密，只在接收设备上解密。中间服务器负责转发密文，但不持有解密内容所需的会话密钥。每台设备需要可长期识别的身份密钥，还需要为一次会话协商出的短期密钥。',
        '密钥协商的目标是让双方通过公开信息得到同一个共享秘密，同时让旁观者无法得到它。会话还要防止同一密文被重复接受，所以消息通常带有递增计数或唯一 nonce。本关使用可测试的加密模型来练密钥状态、设备身份和重放保护，不把示例算法当作可直接上线的密码实现。'
      ),
      p(
        '`End-to-end encryption` means the sending device encrypts a message and only receiving devices decrypt it. The intermediate server transports ciphertext but does not hold the session key needed to read the content. Each device needs a long-lived identity key and shorter-lived key material negotiated for a session.',
        'Key agreement lets both parties derive the same shared secret from public exchanges while an observer cannot derive it. A session must also reject replayed ciphertext, so messages carry an increasing counter or unique nonce. This stage uses a testable cryptographic model to practise key state, device identity, and replay protection. Its example primitive is not a production cryptographic implementation.'
      )
    ),
    'push-wakeup': t(
      p(
        '移动系统会暂停后台应用，此时长连接不再可靠。推送服务只能负责“叫醒应用”，应用醒来后仍应按自己的同步游标向消息服务器补数据。把完整消息内容塞进推送，会让推送顺序、大小限制和隐私规则变得难以控制。',
        '短时间内到达很多消息时，每条都发一次推送会浪费电量并触发服务限额。`合并`把同一设备或会话的一批变化压成一次唤醒。服务器需要记录待发送状态和最晚发送时间，真正发送后再清理。本关会检查重复事件不会产生重复唤醒，新的消息也不会被过早清掉。'
      ),
      p(
        'Mobile operating systems suspend background applications, so a long-lived connection eventually becomes unavailable. A push service should wake the application; after waking, the app still catches up from its own synchronization cursor. Putting full message content into the push payload makes ordering, size limits, and privacy harder to control.',
        'Sending one push for every message wastes battery and may hit provider limits. `Coalescing` combines a burst for one device or conversation into one wakeup. The server tracks pending state and a latest send time, then clears state only after delivery. This stage checks that duplicate events do not create duplicate wakeups and that newly arrived work is not cleared too early.'
      )
    ),
    'im-server-e2e': t(
      p(
        '前面的模块解决了单个局部问题，组装时还要明确一次发送经过哪些状态：分配会话序号、持久化消息、更新收件进度、尝试在线投递，再为离线设备安排唤醒。任何一步重试都可能再次到达，所以边界处仍要保留幂等键。',
        '会话列表是 IM 中最常见也最容易变慢的查询。它通常需要最近一条消息、未读数和置顶顺序，不能每次扫描所有消息再现算。本关把已有的索引和游标组合成有界查询，并通过端到端用例检查发送、断线、重连和多设备读取是否共享同一套序号事实。'
      ),
      p(
        'The earlier modules solve local problems. Assembly must define the state transitions of one send: assign a conversation sequence, persist the message, update inbox progress, attempt online delivery, and schedule wakeup for offline devices. Any boundary may retry, so idempotency keys remain necessary even after the pieces are connected.',
        'The conversation list is one of the most frequent and easiest IM queries to make slow. It commonly needs the latest message, unread count, and ordering without scanning all messages on every request. This stage combines existing indexes and cursors into a bounded query, then checks send, disconnect, reconnect, and multi-device reads against the same sequence facts.'
      )
    ),
  },

  'message-broker': {
    'segment-log': t(
      p(
        '消息 broker 的核心存储通常是一份`追加日志`。新消息只写到尾部，不在中间插入或原地改写。每条消息得到一个递增 `offset`，消费者用它表示读取位置。顺序写入容易批量处理，也让恢复时可以从头重建状态。',
        '单个文件无限增长会让清理和恢复都变难，所以日志切成多个 `segment`。每段有自己的起始 offset 和容量，写满后滚动到新段。offset 是逻辑位置，不等于数组下标或字节位置。本关先维护段边界和全局 offset，并保证读取跨段时仍保持顺序。'
      ),
      p(
        'The core storage of a message broker is often an `append-only log`. New messages are written at the end instead of inserted or updated in place. Every message receives an increasing `offset`, which consumers use as a read position. Sequential writes batch well and allow state to be rebuilt by replaying the log.',
        'One file cannot grow forever, so the log is divided into `segments`. Each segment has a base offset and a capacity, and a full segment rolls over to a new one. An offset is a logical position, not an array index or byte address. This stage maintains segment boundaries and global offsets while preserving order across segments.'
      )
    ),
    'offset-index': t(
      p(
        'offset 告诉 broker 要找哪条消息，但消息位于哪个段、段内哪个位置还需要查找。为每条消息都建索引会占用大量内存。`稀疏索引`只记录部分 offset 到位置的映射，先找到不大于目标 offset 的最近索引项，再从那里顺序扫描。',
        '索引项按 offset 排序，可以二分查找。稀疏程度决定内存和扫描距离的取舍：记录越密，索引越大，命中后扫描越短。本关要处理段首、段尾和不存在的 offset，并让索引只加速定位，不改变日志本身的顺序语义。'
      ),
      p(
        'An offset identifies the desired message, but the broker still needs to find its segment and position within that segment. Indexing every message consumes substantial memory. A `sparse index` stores mappings for selected offsets. Lookup finds the closest indexed offset not greater than the target, then scans forward from that point.',
        'Because index entries are ordered by offset, they support binary search. Index density trades memory for scan distance: denser entries use more space but require less scanning after a hit. This stage handles segment beginnings, endings, and missing offsets. The index only accelerates location; it does not change the ordering semantics of the log.'
      )
    ),
    'produce-batching': t(
      p(
        '每条消息单独写入会重复支付函数调用、编码和刷盘等固定成本。`攒批`先把多条消息放进内存缓冲，再一次提交。批次达到大小上限时立即发送；流量较低时，`linger`计时器让第一条消息最多等待一小段时间，避免永远凑不满。',
        '批量提高吞吐，但会增加单条消息的等待时间，也会占用更多内存。并发生产者还可能同时触发提交，所以取走当前批次和换上新缓冲必须是原子状态变化。本关用虚拟时钟检查大小触发和时间触发，并要求一次失败不会让整批消息静默消失。'
      ),
      p(
        'Writing every message separately repeats fixed costs such as function calls, encoding, and flush setup. `Batching` collects messages in memory and submits several together. A full batch is sent immediately. Under low traffic, a `linger` timer limits how long the first message waits so a batch does not wait forever for more work.',
        'Batching improves throughput but adds per-message delay and uses memory. Concurrent producers may also trigger a flush at the same time, so detaching the current batch and installing a new buffer must be one state transition. This stage uses a virtual clock to test size and time triggers, and requires a failed flush not to make the batch disappear silently.'
      )
    ),
    'ack-visibility': t(
      p(
        '`至少一次投递`表示 broker 会一直重试，直到消费者确认 ack。它保证消息不会因为一次网络丢包直接消失，但允许同一消息被处理多次。消费者必须用幂等写入或去重来承受重复。',
        '消息交给消费者后会暂时进入不可见状态，并启动 `visibility timeout`。在超时前收到 ack 就提交消费位置；没有 ack 则重新变为可投递。ack 必须对应当前投递尝试，迟到的旧 ack 不能确认后来重新投递的消息。本关会显式维护可见、处理中和已确认三种状态。'
      ),
      p(
        '`At-least-once delivery` means the broker retries until the consumer acknowledges the message. It prevents one lost network response from silently dropping work, but it permits the same message to be processed more than once. Consumers need idempotent writes or deduplication to tolerate that duplicate.',
        'After delivery, a message becomes temporarily invisible and a `visibility timeout` starts. An acknowledgement before expiry commits progress; without one, the message becomes deliverable again. The acknowledgement must belong to the current delivery attempt, because a late acknowledgement from an older attempt must not confirm a later redelivery. This stage tracks visible, in-flight, and acknowledged states explicitly.'
      )
    ),
    'redelivery-dlq': t(
      p(
        '有些失败是暂时的，立即重试可能成功；有些消息本身有问题，每次处理都会失败。对所有失败做紧密循环重试会占满消费者并压垮下游。`退避`让每次重试等待更久，并给服务恢复时间。',
        '达到最大尝试次数后，消息进入`死信队列`，简称 DLQ。死信不是删除，而是把无法正常处理的消息和失败原因隔离出来，供排查或人工重放。计数必须跟随消息而不是跟随某次投递。本关要保证等待中的消息不会提前出现，进入 DLQ 后也不会继续占用主队列。'
      ),
      p(
        'Some failures are temporary and may succeed on retry. Other messages are malformed or always fail in the consumer. Retrying every failure in a tight loop occupies the consumer and can overload the downstream service. `Backoff` increases the delay between attempts and gives that service time to recover.',
        'After a maximum attempt count, the message moves to a `dead-letter queue`, or DLQ. Dead-lettering does not delete the message; it isolates the payload and failure information for inspection or controlled replay. Attempt count belongs to the message, not one delivery object. This stage ensures delayed messages cannot appear early and dead-lettered messages stop occupying the main queue.'
      )
    ),
    'fanout-subscriptions': t(
      p(
        '一份主题日志可以有多个独立订阅。每个订阅都保存自己的消费 offset，因此一个慢订阅不会阻止其他订阅读取，也不能因为另一个订阅 ack 就跳过消息。日志数据可以共享，进度状态必须分开。',
        '订阅内如果有多个消费者，它们可以分担消息；不同订阅之间则各自收到一遍。这两层关系容易混淆。本关先实现主题到订阅的一对多，再为每个订阅维护独立的可见性和提交位置，检查新增订阅从哪个 offset 开始也有明确规则。'
      ),
      p(
        'One topic log may serve several independent subscriptions. Each subscription keeps its own consumed offset, so a slow subscription does not block another and an acknowledgement in one cannot skip a message in another. Log data is shared; progress state is separate.',
        'Several consumers inside one subscription may divide messages among themselves, while different subscriptions each receive their own copy of the stream. These are two distinct layers. This stage first implements one topic with many subscriptions, then maintains visibility and committed position per subscription. It also defines the starting offset for a newly created subscription.'
      )
    ),
    'flow-control': t(
      p(
        '推送式 broker 如果只看“有没有消息”，可能不断向慢消费者发送，最终把消息堆在网络或客户端内存里。`credit`是消费者明确授予的接收额度。每发送一条或一批消息就扣除额度，消费者处理完成后再补充。',
        'credit 不是总消费进度，而是当前允许在途的数量。连接断开、ack 超时和重新投递都会影响额度归还，重复归还会突破上限。本关要让 broker 只在 credit 大于零时投递，并把额度变化和投递状态绑定起来，这就是一种端到端背压。'
      ),
      p(
        'A push-based broker that checks only for available messages can keep sending to a slow consumer until work piles up in the network or client memory. `Credit` is an explicit allowance granted by the consumer. Sending a message or batch consumes credit, and the consumer returns capacity after processing.',
        'Credit is not the committed offset. It is the number currently allowed in flight. Disconnects, acknowledgement timeout, and redelivery all affect when capacity returns, and returning it twice breaks the limit. This stage delivers only while credit is positive and ties every credit change to delivery state. That is end-to-end backpressure.'
      )
    ),
    'replication-isr': t(
      p(
        '为了让一台机器故障后消息仍存在，日志会复制到多个副本。leader 接收写入，follower 按 offset 复制。并不是所有已经写进 leader 的消息都能立即对消费者可见，因为 leader 可能在副本收到之前故障。',
        '`ISR`是当前跟得上 leader 的同步副本集合。`高水位`是这些副本都确认拥有的最大连续位置，消费者只读到高水位，故障切换后就不会看到已经返回又消失的尾部。副本确认可能乱序，本关要按连续 offset 推进水位，而不是简单取收到过的最大数字。'
      ),
      p(
        'To survive one machine failure, a log is copied to several replicas. The leader accepts writes and followers copy them by offset. A record stored only on the leader should not immediately become visible, because the leader may fail before any follower receives it.',
        'The `ISR` is the set of in-sync replicas currently keeping up with the leader. The `high watermark` is the greatest continuous position confirmed by the required replicas. Consumers read only through that watermark, so failover does not remove a tail they already observed. Replica acknowledgements may arrive out of order; this stage advances the watermark through continuous offsets rather than taking the largest number ever seen.'
      )
    ),
    'retention-compaction': t(
      p(
        '`保留策略`按时间或总大小删除旧日志段，用来限制磁盘占用。它关心消息有多旧，不关心键的业务含义。删除应以完整段为单位，避免一边读取一边改写正在使用的段。',
        '`日志压缩`解决的是另一件事：对于相同 key，只保留较新的值，让日志最终表示每个 key 的最新状态。墓碑记录表示删除，也要保留一段时间供下游看到。保留和压缩可以同时存在，但顺序和边界要明确。本关分别实现两种策略，不能把“旧”误当成“已被新值覆盖”。'
      ),
      p(
        'A `retention policy` removes old log segments by age or total size to bound disk use. It cares how old data is, not what a message key means. Removal normally happens at whole-segment boundaries so the broker does not rewrite a segment that readers are using.',
        '`Log compaction` solves a different problem. For repeated keys, it retains a newer value so the log eventually represents current state per key. A tombstone represents deletion and must remain long enough for downstream readers to observe it. Retention and compaction may coexist, but their order and boundaries must be explicit. This stage keeps “old” separate from “superseded by a newer value.”'
      )
    ),
    'session-heartbeat': t(
      p(
        '消费者组让多个实例共同处理一组分区。协调器记录组成员和分区归属。成员通过心跳续租，超时说明它可能已经失联，协调器便重新分配分区，这个过程叫`再平衡`。',
        '每次再平衡都会产生新的 generation。旧成员的迟到提交必须带着旧 generation 被拒绝，否则已经失去分区所有权的实例还能推进 offset。频繁加入和离开会造成抖动，本关先保证成员状态、分区分配和 generation 一起切换，再处理稳定的心跳续约。'
      ),
      p(
        'A consumer group lets several instances share a set of partitions. A coordinator tracks group members and partition ownership. Members renew a lease with heartbeats. When one expires, the coordinator assumes it is unavailable and redistributes partitions in a `rebalance`.',
        'Every rebalance creates a new generation. A late commit from an old member carries the old generation and must be rejected, or an instance that no longer owns a partition could still advance its offset. Repeated joins and leaves can cause churn. This stage first changes membership, assignment, and generation together, then handles stable heartbeat renewal.'
      )
    ),
    'client-quota': t(
      p(
        '一个客户端持续高速生产或消费时，可能挤占 broker 的磁盘、网络和处理时间。`配额`给每个客户端或租户规定一段时间内可使用的额度，超出后延迟或拒绝请求，而不是让最吵的调用方占满共享资源。',
        '公平调度不能只按请求到达顺序，因为持续有请求的客户端会让低流量客户端长期等待。轮转队列或带权调度会在活跃客户端之间分配机会。额度和调度是两层：前者限制总量，后者决定当前先服务谁。本关要求一个客户端被限速时，其他客户端仍能前进。'
      ),
      p(
        'A client producing or consuming continuously can monopolize broker disk, network, and processing time. A `quota` gives each client or tenant an allowance over a time interval. Work beyond that allowance is delayed or rejected instead of letting the noisiest caller consume the shared resource.',
        'Fair scheduling cannot use arrival order alone, because a client with a constant stream can keep a low-volume client waiting. Round-robin or weighted scheduling distributes turns among active clients. Quota and scheduling are separate layers: one bounds total use, the other chooses who runs now. This stage requires other clients to keep progressing while one client is throttled.'
      )
    ),
    'broker-e2e': t(
      p(
        '完整 broker 把主题拆成分区，每个分区是一条有序日志。生产者按 key 选择分区，消费者组把分区分给成员，副本高水位决定哪些 offset 可以读取。局部模块的状态必须围绕同一个 topic、partition 和 offset 身份对齐。',
        '`lag`是可读取的最新 offset 与消费者已提交 offset 之间的距离，它反映还有多少消息没有完成。lag 不能拿日志数组长度随便相减，因为保留策略可能已经删除早期段。本关把生产、复制、订阅、流控和提交连起来，并让状态查询以有界成本报告每个分区的进度。'
      ),
      p(
        'A complete broker divides a topic into partitions, each of which is an ordered log. Producers choose a partition from the message key, consumer groups assign partitions to members, and the replica high watermark decides which offsets are readable. The local modules must agree on one topic, partition, and offset identity.',
        '`Lag` is the distance between the latest readable offset and the consumer committed offset. It describes how much work remains. It cannot be calculated from raw array length because retention may have removed early segments. This stage connects produce, replication, subscriptions, flow control, and commits, then reports per-partition progress with bounded query cost.'
      )
    ),
  },

  'modern-compiler': {
    'lexer-spans': t(
      p(
        '编译器不会直接在整段源码字符串上判断语法。`词法分析`先把字符流切成 token，例如标识符、数字、括号和运算符。token 的类型说明它是什么，原始文本或数值保存它的内容。空白和注释通常影响位置，但不进入后续语法树。',
        '`源码区间`简称 span，记录 token 从哪个字符开始、到哪个字符结束。解析器和类型检查器以后只处理抽象节点，报错时仍要靠 span 指回用户写的代码。词法错误也要消费或定位非法字符，否则扫描器会停在原地死循环。本关建立 token、位置和错误三者的共同坐标系。'
      ),
      p(
        'A compiler does not apply grammar rules directly to one source string. `Lexing` first divides the character stream into tokens such as identifiers, numbers, parentheses, and operators. The token kind says what it is, while raw text or a parsed value carries its content. Whitespace and comments usually affect positions but do not enter the later syntax tree.',
        'A source `span` records the start and end character positions of a token. Parsers and type checkers later operate on abstract nodes, yet diagnostics still need spans to point back to the user code. A lexical error must also consume or identify the invalid character so scanning cannot loop at the same position. This stage gives tokens, positions, and errors one shared coordinate system.'
      )
    ),
    'pratt-parser': t(
      p(
        '解析表达式最麻烦的部分是优先级和结合方向。`Pratt 解析器`不为每一级优先级各写一套函数，而是给运算符定义 binding power。左边已经有一个表达式时，解析器根据下一个运算符的绑定强度决定继续组合还是返回上层。',
        '前缀位置可以出现数字、名字、括号和一元运算符；中缀位置可以出现二元运算符或函数调用。左结合的减法和右结合的赋值需要不同的左右绑定强度。每个 AST 节点还要合并子节点 span，这样后续错误能标出完整表达式，而不是只标一个 token。'
      ),
      p(
        'The difficult part of expression parsing is precedence and associativity. A `Pratt parser` avoids one parser function per precedence level by assigning binding powers to operators. Once it has a left expression, it examines the next operator and uses that power to decide whether to keep combining or return to its caller.',
        'Prefix position may contain a number, name, parenthesized expression, or unary operator. Infix position may contain a binary operator or function call. Left-associative subtraction and right-associative assignment need different left and right powers. Every AST node also combines child spans so a later diagnostic can mark the whole expression rather than one token.'
      )
    ),
    'name-resolution': t(
      p(
        '解析后的名字仍只是字符串。`名字解析`要判断每次使用具体指向哪次声明。块和函数会建立`词法作用域`，查找从当前作用域向外进行。内层重新声明同名变量叫遮蔽，它隐藏外层名字，但不改变外层绑定。',
        '给每次声明分配唯一 binding id 后，后续阶段就不必靠字符串猜身份。两个都叫 `x` 的变量会有不同 id，重命名或类型推导也更安全。解析器还要区分“当前作用域重复声明”和“合法遮蔽”，并在名字不存在时用该使用位置的 span 报错。'
      ),
      p(
        'After parsing, a name is still only a string. `Name resolution` decides which declaration every use refers to. Blocks and functions create `lexical scopes`, and lookup proceeds from the current scope outward. Declaring the same name in an inner scope is shadowing: it hides the outer binding without changing it.',
        'Assigning a unique binding id to each declaration means later phases no longer guess identity from text. Two variables both spelled `x` receive different ids, which makes renaming and type inference safer. The resolver also distinguishes a duplicate declaration in one scope from valid shadowing, and reports an unresolved name at the span where it was used.'
      )
    ),
    'type-inference': t(
      p(
        '类型推导把程序中的用法转换成约束。数字字面量产生 number，函数调用要求被调用值是一个函数，并要求实参类型和参数类型对应。暂时不知道的类型用`类型变量`表示，例如 `T1`。',
        '`合一`尝试让两个类型相等。类型变量可以绑定到具体类型，函数类型则递归合一参数和返回值。`occurs check`阻止把 `T`绑定成包含自身的类型，例如 `T = (T) -> number`，否则会得到无限展开的类型。本关需要在共享替换表中传播结果，并把冲突定位到产生约束的表达式。'
      ),
      p(
        'Type inference converts program uses into constraints. A numeric literal produces `number`. A call requires the callee to have a function type and each argument to match its parameter. An unknown type is represented by a `type variable` such as `T1`.',
        '`Unification` tries to make two types equal. A type variable may bind to a concrete type, while function types recursively unify their parameters and results. The `occurs check` prevents binding `T` to a type containing itself, such as `T = (T) -> number`, which would create an infinite type. This stage propagates substitutions through one shared table and locates conflicts at the expression that created the constraint.'
      )
    ),
    'ssa-lowering': t(
      p(
        'AST 适合表达源码结构，但不适合直接做数据流优化。编译器会把它`降级`成中间表示，也就是 IR。控制流被拆成基本块，每个块只有一个入口，末尾用跳转或返回明确指出下一步。复杂表达式也会拆成命名的简单指令。',
        '`SSA`要求每个值只定义一次。分支两边产生不同值，汇合块又要继续使用时，用 `phi`节点按前驱块选择来源。SSA 名字不是源码变量，而是一次计算的结果。本关要维护块、临时值和终结指令，并确保每条控制流边到达汇合点时都给 phi 提供输入。'
      ),
      p(
        'An AST represents source structure well but is awkward for data-flow optimization. A compiler `lowers` it into an intermediate representation, or IR. Control flow is divided into basic blocks, each with one entry, and every block ends with an explicit branch, jump, or return. Complex expressions become sequences of simple named instructions.',
        '`SSA` requires every value to be defined once. If two branches produce different values and a merge block uses the result, a `phi` node chooses the value associated with the predecessor block. SSA names are results of individual computations, not source variables. This stage maintains blocks, temporary values, and terminators, and gives every phi an input for each incoming control-flow edge.'
      )
    ),
    'cfg-dominators': t(
      p(
        '`控制流图`简称 CFG。节点是基本块，有向边表示一次跳转可能到达哪里。分析前要从入口遍历并标出可达块，因为没有任何路径能进入的死块不应影响多数结果。前驱列表则反向记录哪些块能跳到当前块。',
        '如果从入口到块 B 的每条路径都经过块 A，就说 A `支配` B。除 B 自身外离它最近的支配者叫 immediate dominator，这些关系组成支配树。支配信息用于放置 phi、判断定义是否覆盖使用位置，并支撑后续优化。本关通过反复求交前驱的支配集合得到稳定结果。'
      ),
      p(
        'A `control-flow graph`, or CFG, has basic blocks as nodes and possible jumps as directed edges. Analysis first walks from the entry and marks reachable blocks, because a dead block with no incoming path should not affect most results. Predecessor lists record the same edges in reverse: which blocks may jump into this one.',
        'Block A `dominates` block B when every path from entry to B passes through A. The nearest strict dominator of B is its immediate dominator, and those relations form the dominator tree. Dominance helps place phi nodes, check that definitions cover uses, and support later optimization. This stage repeatedly intersects predecessor dominator sets until the result stops changing.'
      )
    ),
    'optimization-pipeline': t(
      p(
        '`常量传播`记录哪些 SSA 值已经确定是常量，并把这些值带到使用位置。`常量折叠`随后在编译期计算诸如 `2 + 3` 的指令。分支条件变成常量后，某条控制流边可能永远不会走，更多值也会继续变成常量。',
        '`死代码删除`移除结果无人使用的指令，但不能删掉有副作用的操作。函数调用、存储或可能抛错的指令即使返回值没用，也可能改变程序行为。优化按轮次运行时，一轮的删除可能给下一轮创造机会。本关要迭代到稳定，并统计变化以避免无意义的无限循环。'
      ),
      p(
        '`Constant propagation` records which SSA values are known constants and substitutes that knowledge at uses. `Constant folding` then evaluates instructions such as `2 + 3` during compilation. Once a branch condition becomes constant, one control-flow edge may become impossible and more values can become constant in turn.',
        '`Dead-code elimination` removes instructions whose results are unused, but it must preserve side effects. A call, store, or instruction that may throw can change behavior even when its result is ignored. When passes run in rounds, a deletion in one round may create work for the next. This stage iterates to a fixed point and records changes so the pipeline cannot loop without progress.'
      )
    ),
    'linear-scan-registers': t(
      p(
        '机器只有少量寄存器，SSA 中间值却可以很多。`活跃区间`表示一个值从定义开始到最后一次使用之间需要保留。两个区间重叠的值不能占用同一个寄存器，不重叠的值则可以复用。',
        '`线性扫描`按区间起点排序，边向前扫描边释放已经结束的寄存器。寄存器不够时，要选择一个值 `spill`到栈上，使用前再加载。选择最晚结束的区间通常能给眼前的短值腾出空间。本关先计算区间，再让分配结果明确写出寄存器或栈槽，并保证复用只发生在区间结束之后。'
      ),
      p(
        'A machine has a small number of registers, while SSA may contain many temporary values. A `live interval` describes the range from a value definition through its last use. Values with overlapping intervals cannot share one register. Non-overlapping values may reuse it.',
        '`Linear scan` sorts intervals by start position, moves forward, and releases registers whose intervals have ended. When none is free, a value is `spilled` to a stack slot and loaded again before use. Choosing an interval that ends late can free a register for a short current value. This stage computes intervals, assigns each value a register or stack slot, and allows reuse only after the previous interval ends.'
      )
    ),
    'rv64-codegen': t(
      p(
        '代码生成把 IR 指令映射成目标机器指令。RV64 是 64 位 RISC-V 指令集，算术操作通常在寄存器之间进行，内存值要先 load，结果再 store。前一关分配到栈槽的值因此会在使用点附近产生额外访存。',
        '`调用约定`规定参数、返回值和需要保存的寄存器放在哪里，调用者和被调用函数才能独立编译后仍能合作。a0 到 a7 传前几个参数，返回值也使用 a0；调用其他函数时还要保护返回地址 ra。栈帧按约定对齐。本关生成一段可检查的 RV64 汇编文本，重点是位置和生命周期，不执行真实机器码。'
      ),
      p(
        'Code generation maps IR instructions to target-machine instructions. RV64 is the 64-bit RISC-V instruction set. Arithmetic normally operates on registers, so a memory value is loaded before use and stored afterward. Values assigned to stack slots by the previous stage therefore create additional loads and stores near their uses.',
        'A `calling convention` defines where arguments, return values, and saved registers live so separately compiled callers and callees cooperate. Registers a0 through a7 carry the first arguments, and a0 also carries a return value. A function making another call must preserve the return address in ra, and the stack frame follows the required alignment. This stage emits inspectable RV64 assembly text rather than executing machine code.'
      )
    ),
    'incremental-build': t(
      p(
        '大型工程不能每改一个文件就重编全部模块。编译系统先建立`模块图`，有向边表示一个模块依赖另一个模块。拓扑顺序保证依赖先编译；图中有环时，要么明确支持循环模块，要么在构建前报错，本关采用后者。',
        '增量缓存的命中条件不只是源码没变。依赖模块的输出、编译选项或编译器版本变化，都可能改变当前模块结果，所以`指纹`要包含这些输入。一次构建失败时不能把半成品写进正式缓存。本关先在临时结果中完成整轮编译，全部成功后再原子提交缓存。'
      ),
      p(
        'A large project cannot recompile every module after each file edit. The build system first creates a `module graph`, with a directed edge from a module to each dependency. A topological order compiles dependencies first. If the graph contains a cycle, the system must either define cycle semantics or report the cycle before building; this stage chooses the latter.',
        'An incremental cache hit requires more than unchanged source text. A dependency output, compiler option, or compiler version may change the module result, so its `fingerprint` includes those inputs. A failed build must not publish a half-complete cache. This stage compiles into temporary results and commits the cache atomically only after the whole build succeeds.'
      )
    ),
  },

  'modern-os-kernel': {
    'frame-allocator': t(
      p(
        '操作系统把物理内存按固定大小切成`页框`。常见页大小是 4096 字节，但本关把大小作为参数。内核启动时，固件会给出一张内存图，其中有可用内存、固件保留区和设备映射区。只有完整落在 usable 区域里的页框才能交给分配器。',
        '页框地址必须按页大小对齐。区域起点向上对齐，终点向下对齐，才能丢掉两端不完整的页。分配器还要区分空闲、已分配和启动阶段主动保留的页框。重复释放会让同一页框同时交给两个使用者，结果不是普通数组 bug，而是两块内核数据互相覆盖。'
      ),
      p(
        'An operating system divides physical memory into fixed-size `frames`. A common page size is 4096 bytes, although this stage accepts it as a parameter. During boot, firmware provides a memory map containing usable memory, reserved firmware ranges, and device mappings. The allocator may own only frames that fit completely inside usable ranges.',
        'A frame address must align to page size. Rounding a region start up and its end down discards incomplete frames at both edges. The allocator also distinguishes free, allocated, and explicitly reserved frames. A double free can hand the same physical frame to two kernel users, causing unrelated kernel data to overwrite each other.'
      )
    ),
    'virtual-memory': t(
      p(
        '程序使用的是`虚拟地址`，内存芯片接收的是物理地址。`页表`保存虚拟页到物理页框的映射，处理器访问内存时按当前地址空间查表。不同进程可以在同一个虚拟地址放不同数据，用户进程也无法直接映射内核页。',
        '页表项还带读、写、执行和用户态可访问等权限。`W^X`表示同一页不应同时可写又可执行，可以减少把数据改成代码运行的机会。映射、解除映射和权限检查都要按完整页面进行。本关用 Map 模拟硬件页表，但越权访问和重复映射仍按真实内核的边界处理。'
      ),
      p(
        'Programs use `virtual addresses`, while memory hardware ultimately accesses physical addresses. A `page table` maps virtual pages to physical frames, and the processor consults the current address space for each memory access. Different processes may store different data at the same virtual address, and a user process cannot directly map kernel pages.',
        'A page-table entry also carries read, write, execute, and user-access permissions. `W^X` means one page should not be writable and executable at the same time, reducing opportunities to turn modified data into running code. Mapping, unmapping, and permission checks operate on complete pages. This exercise models page tables with maps but keeps real kernel boundaries for duplicate mappings and forbidden access.'
      )
    ),
    'preemptive-scheduler': t(
      p(
        '调度器决定哪个可运行任务占用 CPU。任务通常处在 ready、running、blocked 或 finished 等状态。ready 表示能运行但正在排队，blocked 表示在等 I/O 或同步事件，不能继续消耗时间片。状态转换必须和队列变化一致。',
        '`抢占`表示任务即使没有主动让出 CPU，时钟 tick 也能在时间片用完后切走它。这样一个死循环不会永久饿死其他任务。上下文切换在真实机器上会保存寄存器，本关只模型化任务 id、剩余时间片和队列。公平性来自稳定轮转和正确唤醒，而不是给每个 tick 随机选任务。'
      ),
      p(
        'A scheduler decides which runnable task owns the CPU. Tasks commonly move among ready, running, blocked, and finished states. Ready means able to run but waiting in a queue. Blocked means waiting for I/O or synchronization and should not consume a time slice. Every state transition must agree with queue membership.',
        '`Preemption` means a timer tick can remove a task after its time slice even when the task never yields voluntarily. One infinite loop therefore cannot starve every other task. A real context switch saves registers; this stage models only task identity, remaining slice, and queues. Fairness comes from stable rotation and correct wakeup rather than randomly choosing a task on each tick.'
      )
    ),
    'syscalls-handles': t(
      p(
        '用户程序运行在受限的用户态，内核运行在能访问设备和页表的特权态。`系统调用`是受控入口：用户传入编号和参数，内核校验后分派到具体服务，再把结果或错误码返回。用户提供的数字和地址都不可信。',
        '`句柄`是进程句柄表里的小整数，指向内核对象。它避免把内核对象地址直接暴露给用户。句柄还带 rights，例如只读、可写或可复制，系统调用先检查权利再操作对象。这种设计接近 capability：拥有哪个句柄，就只拥有它明确授予的能力。'
      ),
      p(
        'User programs run in restricted user mode, while the kernel runs in a privileged mode that can access devices and page tables. A `system call` is a controlled entry: the user supplies a number and arguments, the kernel validates and dispatches them, then returns a result or error code. Every number and address from user mode is untrusted.',
        'A `handle` is a small integer in a process handle table that refers to a kernel object. It avoids exposing kernel object addresses directly. Handles also carry rights such as read, write, or duplicate, and a syscall checks those rights before touching the object. This resembles a capability: possession grants only the explicitly attached operations.'
      )
    ),
    vfs: t(
      p(
        '`VFS`是虚拟文件系统。它给不同文件系统提供统一的路径、打开、读取和写入接口。路径解析把 `/a/b`逐段查找：目录项把名字映射到文件对象，文件对象保存类型和内容。`.`、`..`和重复分隔符都需要一致规则。',
        '`文件描述符`是进程表中的整数，指向一次打开的文件状态。两个描述符可以指向同一文件，却有不同读写偏移和权限。文件本身与打开实例不能混为一个对象。本关先在内存中实现目录树，再让 open 返回带偏移的描述符，read 和 write 只通过描述符访问。'
      ),
      p(
        'A `VFS`, or virtual file system, gives different file systems one path, open, read, and write interface. Path resolution walks `/a/b` one component at a time. Directory entries map names to file objects, while file objects carry type and content. Components such as `.`, `..`, and repeated separators need consistent rules.',
        'A `file descriptor` is an integer in a process table that points to one open-file state. Two descriptors may refer to the same underlying file but have different offsets and permissions. The file and an open instance are not the same object. This stage builds an in-memory directory tree, then makes `open` return descriptors whose own offsets drive `read` and `write`.'
      )
    ),
    pipes: t(
      p(
        '`管道`是内核中的字节缓冲，一端写入，另一端读取。缓冲必须有容量上限，否则快速写者可以耗尽内核内存。缓冲为空时，读者要阻塞等待；缓冲已满时，写者也要阻塞或只写入可容纳的部分。',
        '关闭语义决定等待者何时醒来。所有写端关闭后，读者读完剩余字节会看到 EOF；所有读端关闭后，继续写入应得到 EPIPE，而不是永远等待。唤醒必须在改变缓冲或端点计数之后发生，并重新检查条件，因为多个等待者可能同时醒来。本关用等待队列模型这些状态。'
      ),
      p(
        'A `pipe` is a kernel byte buffer with a write end and a read end. The buffer needs a capacity limit, or a fast writer can exhaust kernel memory. A reader blocks when the buffer is empty. A writer blocks when it is full, or writes only the portion that fits.',
        'Close semantics determine when waiters wake. After every write end closes, a reader sees EOF once buffered bytes are drained. After every read end closes, another write returns EPIPE instead of waiting forever. Wakeup happens after changing buffer or endpoint state, and a woken task checks the condition again because several waiters may wake together. This stage models those states with explicit wait queues.'
      )
    ),
    'copy-on-write': t(
      p(
        '`fork`创建一个初始状态与父进程相同的子进程。立即复制全部内存很贵，而且子进程常常很快执行新程序。`写时复制`简称 COW，让父子页表先指向同一物理页框，并把映射改成只读。',
        '任一进程尝试写入时会触发页故障。内核查看页框引用计数：如果仍被共享，就分配新页、复制内容并只修改当前进程映射；如果只剩一个引用，可以直接恢复写权限。解除映射和进程退出都要减少引用计数。本关的关键是页表权限与页框引用数始终同步。'
      ),
      p(
        '`fork` creates a child process with the same initial memory as its parent. Copying every page immediately is expensive, and the child often replaces its program soon afterward. `Copy-on-write`, or COW, initially points both page tables at the same physical frames and changes those mappings to read only.',
        'A write then causes a page fault. The kernel checks the frame reference count. If the frame is still shared, it allocates a new frame, copies the content, and changes only the current process mapping. If one reference remains, it can restore write permission directly. Unmapping and process exit also decrease reference counts. This stage keeps page permissions and frame ownership in sync.'
      )
    ),
    'process-lifecycle': t(
      p(
        '进程退出后，内核可以释放地址空间和句柄，但不能立刻忘掉全部信息。父进程还需要通过 `wait`取得子进程的退出状态。已经结束但尚未被父进程 wait 的表项叫`僵尸进程`，它不再运行，只保留少量结果。',
        '父进程可能先退出，留下的子进程叫孤儿进程，需要被指定的收养者接管，否则它们结束后无人回收。wait 还要区分指定子进程和任意子进程，并在没有已退出目标时阻塞。本关维护父子关系、退出状态和等待队列，回收只发生一次。'
      ),
      p(
        'After a process exits, the kernel can release its address space and handles, but it cannot forget everything immediately. The parent still retrieves the child exit status through `wait`. An exited process table entry that has not yet been waited for is a `zombie`. It no longer runs and retains only a small result record.',
        'A parent may exit first, leaving orphan children that need a designated adopter so someone can later reap them. `wait` also distinguishes one child from any child and blocks when no matching child has exited. This stage maintains parent-child links, exit status, and wait queues, and permits each process to be reaped exactly once.'
      )
    ),
    'interrupts-deferred-work': t(
      p(
        '`中断`让设备或时钟打断当前执行，要求 CPU 进入一个编号对应的处理入口。编号叫 vector。中断上下文里通常不能做耗时工作，也不能等待普通锁，所以`上半部`只确认设备、记录最小状态，并把后续工作放入队列。',
        '队列中的`延迟工作`回到普通内核上下文再执行。mask 可以暂时阻止某个 vector 被处理，期间到达的事件要按定义保留或合并，不能悄悄丢失。一次只执行有限数量的延迟任务，能防止设备洪水长期占住 CPU。本关把 vector 表、mask、pending 队列和工作预算分开维护。'
      ),
      p(
        'An `interrupt` lets a device or timer stop current execution and enter a handler selected by a numeric vector. Interrupt context normally cannot perform slow work or wait on ordinary locks, so the `top half` acknowledges the device, records minimal state, and queues the remaining work.',
        '`Deferred work` runs later in normal kernel context. Masking temporarily prevents a vector from being handled; events arriving during that period must be retained or combined according to an explicit rule rather than silently lost. Running only a bounded number of deferred tasks at once prevents an interrupt storm from owning the CPU indefinitely. This stage keeps the vector table, masks, pending events, and work budget separate.'
      )
    ),
    futex: t(
      p(
        '`Futex`是 fast userspace mutex 的缩写。没有竞争时，用户态用原子操作改变一个整数，不进入内核。只有线程发现锁被占用时，才通过 futex wait 把自己放进内核等待队列；解锁者在需要时调用 wake。',
        'wait 必须先比较用户地址当前值是否仍等于预期值，再把线程入队。这两个动作在语义上要连在一起，否则值可能在比较后、入队前改变，唤醒已经发生而等待者仍去睡眠，这叫`丢失唤醒`。本关按地址维护 FIFO 队列，并让 wake、取消和超时都只能移除同一个等待者一次。'
      ),
      p(
        '`Futex` is short for fast userspace mutex. Without contention, user code changes an integer with atomic operations and never enters the kernel. Only when a thread finds the lock occupied does it call futex wait and join a kernel wait queue; an unlocker calls wake when necessary.',
        'Wait first checks that the user value still equals an expected value, then queues the thread. Those actions must be atomic in meaning. Otherwise the value can change after the check but before queueing, the wake can already happen, and the new waiter goes to sleep forever. That is a `lost wakeup`. This stage keeps one FIFO queue per address and ensures wake, cancellation, and timeout remove a waiter at most once.'
      )
    ),
  },

  'order-event-pipeline': {
    'schema-evolution': t(
      p(
        '`事件`是已经发生的事实，例如订单已创建。生产者写入后，多个消费者可能长期保存并重放它，所以不能像普通函数参数一样随意改字段。`schema version`说明载荷采用哪一版结构，消费者据此解释旧数据。',
        '新增可选字段通常向后兼容，删除或改名则可能让旧消费者失效。`upcaster`在读取时把旧版本逐步转换到当前结构，不需要重写整条历史。本关会定义版本识别和转换链，并拒绝未知的未来版本，避免用缺省值悄悄掩盖不理解的数据。'
      ),
      p(
        'An `event` is a fact that already happened, such as an order being created. After a producer writes it, several consumers may retain and replay it for a long time, so its fields cannot change as casually as function parameters. A `schema version` identifies the payload shape and lets consumers interpret old records.',
        'Adding an optional field is often backward compatible; removing or renaming one may break old consumers. An `upcaster` converts an older version step by step when it is read, avoiding a rewrite of the whole history. This stage defines version recognition and the conversion chain, and rejects an unknown future version instead of hiding misunderstood data behind defaults.'
      )
    ),
    'event-bus': t(
      p(
        '`事件总线`把发布者和订阅者分开。发布者只提交事件，不直接调用每个业务处理器；订阅者按事件类型注册。这样新增消费者不需要修改订单服务，但投递顺序、错误传播和取消订阅必须由总线明确规定。',
        '同步总线会在 publish 返回前执行处理器，异步总线则可能稍后完成。本关采用的契约决定 publish 何时算成功。一个订阅者失败时，不能让已执行和未执行的处理器处于无法解释的中间状态。实现要复制或稳定遍历当前订阅列表，避免处理器在回调中订阅或取消导致漏调用。'
      ),
      p(
        'An `event bus` separates publishers from subscribers. A publisher submits an event instead of calling every business handler directly, while subscribers register by event type. New consumers can then be added without changing the order service, but delivery order, error propagation, and unsubscribe behavior need explicit rules.',
        'A synchronous bus runs handlers before `publish` returns; an asynchronous bus may finish later. The contract in this stage defines when publish counts as successful. If one subscriber fails, the bus must leave a clear account of which handlers ran and which did not. Iteration also needs a stable subscriber snapshot so a callback that subscribes or unsubscribes cannot accidentally skip another handler.'
      )
    ),
    'partition-ordering': t(
      p(
        '全局只有一条队列可以保持绝对顺序，但也把吞吐限制在一个处理通道。`分区`把事件按 key 分到多条独立队列，同一订单始终进入同一分区，因此该订单内有序，不同订单可以并行处理。',
        '分区函数必须稳定，相同 key 在所有生产者上得到相同结果。扩容改变分区数时，简单取模会让许多 key 换位置，真实系统需要再平衡策略。本关先固定分区数，要求单分区串行、分区之间并行，并在一个处理器失败时不打乱该分区后续事件。'
      ),
      p(
        'One global queue can preserve total order, but it also limits throughput to one processing lane. `Partitioning` maps events by key into several independent queues. Every event for one order reaches the same partition and stays ordered, while different orders may run in parallel.',
        'The partition function must be stable so equal keys receive the same result across producers. Changing partition count can move many keys under simple modulo hashing, which real systems address during rebalancing. This stage keeps partition count fixed, runs one partition serially and different partitions concurrently, and preserves later order after a handler failure.'
      )
    ),
    middleware: t(
      p(
        '`中间件`是在核心处理器前后包一层通用行为，例如计时、日志或重试。洋葱模型中，中间件先做前置工作，调用 `next()`进入下一层，等下一层返回后再做后置工作。调用栈的嵌套顺序决定了返回时的逆序。',
        '每层只能调用 next 一次，否则下游可能重复处理同一事件。忘记 await next 会让外层过早完成，也无法捕获下游错误。本关会组合多个异步函数，检查进入与退出顺序，并让短路中间件可以在有意不调用 next 时停止链路。'
      ),
      p(
        '`Middleware` wraps a core handler with common behavior such as timing, logging, or retry. In the onion model, middleware performs work before calling `next()`, enters the next layer, then resumes for its after-work when that layer returns. Nested calls naturally produce reverse order on the way out.',
        'Each layer may call `next` at most once, or downstream code can process the same event twice. Failing to await it makes the outer layer finish early and prevents it from catching downstream errors. This stage composes asynchronous functions, checks enter and exit order, and allows intentional short-circuit middleware to stop the chain by not calling `next`.'
      )
    ),
    'consumer-group': t(
      p(
        '`消费者组`让多个实例共同处理一组分区，但同一时刻每个分区只归一个组成员。协调器跟踪成员并计算分配。新增、退出或超时会触发`再平衡`，重新决定所有权。',
        '再平衡期间的旧消费者可能仍在处理消息，所以每轮分配需要 generation。提交进度时同时校验成员和 generation，才能拒绝失去所有权后的迟到提交。分配还应尽量均匀且稳定。本关会把成员变化、分区分配和提交验证放在同一个组状态机里。'
      ),
      p(
        'A `consumer group` lets several instances share a set of partitions, while each partition belongs to only one group member at a time. A coordinator tracks membership and computes assignments. Join, leave, and timeout events cause a `rebalance` that chooses ownership again.',
        'An old consumer may still be processing during a rebalance, so every assignment round has a generation. Progress commits validate both member and generation to reject a late commit after ownership has been lost. Assignment should also remain reasonably even and stable. This stage puts membership changes, partition ownership, and commit validation in one group state machine.'
      )
    ),
    outbox: t(
      p(
        '订单服务常常既要更新数据库，又要发布事件。这是两个独立系统，先写数据库再发消息时，进程可能在两步之间崩溃；先发消息也可能产生数据库里不存在的订单。这叫`双写问题`。',
        '`事务性 outbox`把业务修改和一条待发布记录写进同一个数据库事务。后台 relay 再读取 outbox，发布成功后标记完成。relay 可能在发布成功、标记前崩溃，因此事件仍可能重复，消费者还需要幂等。本关模型化事务提交、领取记录和重试，而不是假设 publish 与数据库能组成一个原子操作。'
      ),
      p(
        'An order service often needs to update its database and publish an event. These are separate systems. If it writes the database first, the process may crash before publishing; if it publishes first, consumers may see an order that the database never committed. This is the `dual-write problem`.',
        'A `transactional outbox` writes the business change and a pending event record in one database transaction. A background relay reads the outbox, publishes the event, and marks it complete. The relay may crash after publish but before marking, so duplicates remain possible and consumers still need idempotency. This stage models commit, record claiming, and retry rather than pretending database and publish form one atomic operation.'
      )
    ),
    idempotency: t(
      p(
        '至少一次投递会产生重复事件。`幂等消费者`处理同一个 event id 多次，最终只产生一次业务效果。它通常在写业务结果的同一事务里记录已经处理的 id，否则可能业务写成功而去重记录丢失。',
        '暂时失败的事件可以重试，确定无法处理或超过次数的事件进入死信队列。去重和死信解决不同问题：前者挡重复，后者隔离持续失败。本关会跟踪处理状态和尝试次数，并保证并发收到相同 id 时只有一个执行者进入业务逻辑。'
      ),
      p(
        'At-least-once delivery creates duplicate events. An `idempotent consumer` may receive one event id several times but produces the business effect once. It commonly records the processed id in the same transaction as the business result; otherwise the result may commit while the deduplication record is lost.',
        'Temporary failures may retry, while an event that remains unprocessable moves to a dead-letter queue after its attempt limit. Deduplication and dead-lettering solve different problems: one blocks repeats, the other isolates persistent failure. This stage tracks processing state and attempt count, and allows only one concurrent delivery of the same id to enter business logic.'
      )
    ),
    saga: t(
      p(
        '跨多个服务的业务流程无法依赖一笔本地数据库事务。`Saga`把流程拆成一组本地步骤，每步成功后发布结果；后续步骤失败时，系统按相反方向执行`补偿操作`，尽量撤销已经完成的业务效果。补偿不是数据库回滚，可能也会失败。',
        'Saga 需要持久化当前步骤和已完成记录，重启后才能继续。命令和补偿都要幂等，因为超时会带来重复调用。某些动作不可逆，只能用新的业务动作修正。本关用状态机驱动步骤、失败和补偿，并明确 completed、compensating、failed 等终态。'
      ),
      p(
        'A business flow spanning several services cannot rely on one local database transaction. A `saga` divides the flow into local steps. After each succeeds, the process advances; if a later step fails, `compensating actions` run in reverse to counter earlier business effects. Compensation is not a database rollback and can fail too.',
        'The saga persists its current step and completed history so it can resume after restart. Commands and compensations must be idempotent because timeouts produce repeated calls. Some actions are irreversible and need a new business action instead of true undo. This stage drives steps, failure, and compensation with a state machine and explicit completed, compensating, and failed outcomes.'
      )
    ),
    'event-sourcing': t(
      p(
        '`事件溯源`把聚合的历史事件当作事实来源，不直接保存一个可覆盖的当前对象。读取订单时，从空状态开始按顺序 apply 每个事件，就能重建当前状态。命令先读取状态、检查规则，再产生新事件。',
        '历史越来越长时，每次从头重放会变慢。`快照`保存某个事件版本时的聚合状态，读取时从快照开始继续重放后续事件。快照只是缓存，丢失后仍应能从事件恢复。本关要校验事件版本，防止两个并发写者都基于同一个旧版本追加成功。'
      ),
      p(
        '`Event sourcing` treats an aggregate event history as the source of truth instead of overwriting one current object. To load an order, start from empty state and apply each event in sequence. A command reads that state, checks business rules, and produces new events.',
        'As history grows, replaying from the beginning becomes slow. A `snapshot` stores aggregate state at a particular event version, then loading replays only later events. The snapshot is a cache; losing it must not lose the ability to rebuild from events. This stage validates expected versions so two concurrent writers cannot both append based on the same old state.'
      )
    ),
    projection: t(
      p(
        '事件存储适合写入和追溯，但不一定适合页面查询。`投影`按事件更新一个专门的读模型，例如订单列表或状态统计。这个读模型可以按查询需要组织字段，不必复制写模型的结构。',
        '事件写入和投影更新通常不是同一事务，所以读模型会短暂落后，这叫`最终一致`。投影保存自己的 checkpoint，重启后从下一个事件继续。重复事件必须幂等，乱序事件要拒绝或缓冲。本关会让 checkpoint 与读模型更新一起提交，避免进度前进但数据没写成功。'
      ),
      p(
        'An event store is useful for writes and history but may not match page queries. A `projection` updates a purpose-built read model, such as an order list or status totals. That model can organize fields around the query instead of copying the write model shape.',
        'Event append and projection update are usually not one transaction, so the read model may briefly lag. This is `eventual consistency`. A projection stores a checkpoint and resumes from the next event after restart. Duplicate events need idempotent handling, while out-of-order events need rejection or buffering. This stage commits checkpoint and read-model change together so progress cannot advance without its data.'
      )
    ),
    reconciliation: t(
      p(
        '事件链路即使每个模块都重试，长期运行后仍可能因为代码缺陷、人工修改或过期消息产生漂移。`对账`从两个独立来源读取同一业务事实，例如订单总额和支付记录，按稳定 key 比较并找出缺失、重复或数值不一致。',
        '对账任务需要可重复运行，修复动作也要幂等。它不能只输出一个总数，而应保存能定位问题的差异记录和检查范围。大数据集通常分批扫描并保存游标。本关会先生成差异，再由单独步骤应用安全修复，避免检查过程中直接修改导致后续结果变化。'
      ),
      p(
        'Even with retries in every module, a long-running event pipeline can drift because of software defects, manual changes, or expired messages. `Reconciliation` reads the same business fact from two independent sources, such as order totals and payment records, then compares stable keys to find missing, duplicate, or inconsistent values.',
        'A reconciliation job must be repeatable and its repair actions idempotent. It should record differences and scan scope rather than return only a total. Large data sets are scanned in batches with a saved cursor. This stage produces differences first and applies safe repairs in a separate step, so checking does not modify the data being compared.'
      )
    ),
  },

  'rate-limited-gateway': {
    'sliding-window': t(
      p(
        '`限流`控制一个身份在一段时间内能通过多少请求。固定窗口把时间切成整段并为每段计数，容易实现，但窗口边界两侧可以短时间通过接近两倍额度。滑动窗口按“现在往前的一段时间”统计，边界更平滑。',
        '精确滑动窗口要保存每次请求时间，并在判断前删除过期记录。窗口内记录数量就是当前占用。时间必须单调，测试使用虚拟时钟，不能混用真实 Date。请求被拒绝时是否计入窗口也要有明确规则。本关会比较两种算法在边界上的不同结果。'
      ),
      p(
        '`Rate limiting` controls how many requests one identity may pass during an interval. A fixed window divides time into blocks and counts each block. It is simple, but a client can send near the end of one block and the start of the next, briefly passing almost twice the intended rate. A sliding window counts the interval immediately before now and smooths that boundary.',
        'An exact sliding window stores request times and removes expired entries before each decision. The remaining count is current usage. Time must be monotonic, and the exercise uses a virtual clock rather than real `Date`. The contract also defines whether rejected requests consume capacity. This stage compares both algorithms at window boundaries.'
      )
    ),
    'token-bucket': t(
      p(
        '`令牌桶`用两项参数描述速率：令牌按固定速度补充，桶容量限制最多积攒多少。一个请求先消耗令牌，有令牌就通过，没有就拒绝或等待。空闲期间积攒的令牌允许短时突发，但长期平均速率仍受补充速度限制。',
        '实现不需要定时器持续加令牌。每次请求到来时，根据距离上次更新时间经过了多久，按比例计算应补多少，并把数量封顶到容量。浮点令牌和边界时刻要稳定，时间倒退不能凭空增加额度。本关会检查长时间空闲、连续突发和刚好补足一个令牌的情况。'
      ),
      p(
        'A `token bucket` describes a rate with two values: tokens refill at a fixed speed, while bucket capacity limits how many can accumulate. A request consumes tokens before passing. If not enough are available, it is rejected or delayed. Tokens saved during idle time permit a short burst, while long-term average traffic remains limited by refill speed.',
        'The implementation does not need a timer that adds tokens continuously. On each request, it calculates refill from elapsed time since the last update and caps the result at capacity. Fractional tokens and exact boundaries need stable behavior, and time moving backward must not create capacity. This stage checks long idle periods, consecutive bursts, and the instant one whole token becomes available.'
      )
    ),
    quota: t(
      p(
        '真实网关常常同时按用户、租户、接口和全局容量限流。一次请求会占用多个`配额维度`，只有每一层都允许才能通过。只检查最具体的用户桶，会让大量用户共同打满服务；只检查全局桶，又无法阻止一个用户独占额度。',
        '多桶更新需要原子性。如果先扣用户额度，再发现租户额度不足，必须归还前面的扣减，否则被拒绝的请求也消耗额度。配额键还要包含完整维度，避免不同接口或租户共用错误状态。本关会先试算所有限制，再统一提交或全部不改。'
      ),
      p(
        'A real gateway often limits by user, tenant, endpoint, and total service capacity at the same time. One request consumes several `quota dimensions` and may pass only when every applicable limit allows it. Checking only the most specific user bucket lets many users jointly overload the service; checking only the global bucket lets one user consume everything.',
        'Updating several buckets needs atomic behavior. If user capacity is consumed before discovering that tenant capacity is exhausted, the earlier deduction must be restored or rejected traffic still spends quota. Keys also include every dimension so unrelated tenants or endpoints do not share state. This stage calculates all decisions first, then commits every deduction or none.'
      )
    ),
    'distributed-limit': t(
      p(
        '网关有多个实例时，每台机器各自维护完整额度，会让总流量按实例数放大。所有请求都访问一个中心计数器又会增加延迟和依赖。`租约`折中这两点：实例从全局额度中领取一小批本地许可，再在本地快速消费。',
        '租约有数量和过期时间。实例崩溃后，未用许可不能永久丢失；租约过期后也不能继续消费。领取过程必须在全局存储中原子扣减，续租或归还要识别租约 id。本关模型化中心协调器和多个实例，检查所有本地通过量加起来不会超过全局额度。'
      ),
      p(
        'With several gateway instances, giving each instance the full limit multiplies total traffic by instance count. Sending every request to one central counter adds latency and dependency. A `lease` is a compromise: an instance obtains a small batch of permits from global capacity and spends them locally at low cost.',
        'A lease has an amount and an expiry. Unused permits cannot disappear forever after an instance crashes, and an expired lease cannot continue serving requests. Acquisition atomically deducts global capacity, while renewal or return identifies the lease id. This stage models one coordinator and several instances and checks that all local approvals together stay within the global limit.'
      )
    ),
    'circuit-breaker': t(
      p(
        '下游持续失败时，继续把每个请求都发过去只会增加排队和超时。`熔断器`用状态机快速失败：closed 正常放行并统计结果，失败达到条件后进入 open，暂时拒绝请求；冷却时间后进入 half-open，只放少量探测。',
        '探测成功说明下游可能恢复，可以关闭熔断器；失败则重新打开。并发请求不能同时把 half-open 当成无限通道。统计窗口、失败类型和冷却时间都要从同一时钟读取。本关会检查状态转换和探测额度，业务返回的普通错误也不一定都应算作系统故障。'
      ),
      p(
        'When a downstream service keeps failing, sending every request adds queues and timeouts. A `circuit breaker` fails fast with a state machine. Closed state sends requests and records outcomes. After enough relevant failures it opens and rejects calls temporarily. After a cooldown it becomes half-open and allows only a small number of probes.',
        'Successful probes suggest recovery and close the breaker; a failed probe opens it again. Concurrent calls must not turn half-open into an unlimited path. The failure window, classified outcomes, and cooldown all use one clock. This stage checks state transitions and probe capacity, and does not automatically treat every normal business error as a service failure.'
      )
    ),
    'load-balancer': t(
      p(
        '`负载均衡`在多个下游实例之间选择一个目标。轮询依次选择，适合请求成本接近的场景；最少在途请求会考虑当前负载，但需要准确增加和减少计数。选择算法只在被认为健康的实例集合中运行。',
        '`健康检查`是周期性探测，不是一次失败就永久摘除。实例可能在 healthy、unhealthy 和 probing 之间变化，还需要成功或失败阈值防止抖动。请求完成、抛错或超时都必须释放在途计数。本关会让状态选择和请求生命周期配合，避免把所有流量集中到一个计数没有归零的实例。'
      ),
      p(
        '`Load balancing` selects one target among several downstream instances. Round robin advances through targets and suits requests with similar cost. Least-in-flight considers current load but requires accurate increment and decrement around every call. The algorithm chooses only from instances currently considered healthy.',
        'A `health check` is a repeated probe, not one failure followed by permanent removal. Instances move among healthy, unhealthy, and probing states, often with success and failure thresholds to prevent flapping. Completion, error, and timeout must all release the in-flight count. This stage connects health state to request lifetime so stale accounting cannot concentrate traffic on the wrong target.'
      )
    ),
    bulkhead: t(
      p(
        '`舱壁`借用船舱隔离进水的想法，把不同下游或业务类别放进独立并发池。一个慢服务占满自己的槽位时，其他服务仍有独立容量，不会被同一条全局队列拖死。',
        '每个池有运行上限和等待上限。运行满时，请求进入本池队列；队列也满就立即拒绝，给上游明确背压。完成和失败都要释放槽位并唤醒下一项，取消的排队请求不能以后又执行。本关会用并发慢请求验证故障只停留在对应隔离区。'
      ),
      p(
        'A `bulkhead` borrows the idea of sealed ship compartments and gives different downstream services or traffic classes separate concurrency pools. If one slow service fills its slots, other services keep their own capacity instead of waiting behind the same global queue.',
        'Each pool has a running limit and a queue limit. Work queues only within its own pool, and a full queue rejects immediately to provide explicit backpressure. Success and failure both release a slot and wake the next item, while cancelled queued work must not execute later. This stage uses concurrent slow calls to verify that saturation stays inside its assigned compartment.'
      )
    ),
    'retry-budget': t(
      p(
        '重试会增加成功机会，也会把流量放大。原始 100 个请求各重试两次，最坏会变成 300 次下游调用，恰好在下游故障时增加压力。`重试预算`把允许的额外调用限制为原始流量的一小部分。',
        '预算和单请求最大次数是两种限制。一个请求不能无限重试，所有请求合计也不能耗尽系统。只有可恢复错误才有资格重试，超时后的剩余时间也要足够。成功的首轮请求可以补充预算，失败风暴则很快耗尽。本关会统计 original 和 retry 请求，检查重试不会反客为主。'
      ),
      p(
        'Retries may recover a call, but they also amplify traffic. If 100 original requests each retry twice, the downstream can receive 300 calls precisely while it is already failing. A `retry budget` limits extra calls to a small portion of original traffic.',
        'The budget and a per-request attempt cap are different controls. One request cannot retry forever, and all requests together cannot consume the service. Only retryable failures qualify, and enough deadline must remain for another attempt. Successful original traffic may replenish budget, while a failure storm quickly exhausts it. This stage counts original and retry calls and ensures retries never become the majority workload.'
      )
    ),
    gateway: t(
      p(
        '一次网关请求会经过限流、排队、负载均衡、下游调用和可能的重试。`超时预算`是整条请求从入口到最终返回允许使用的总时间，不是每个步骤各拿一份完整超时。进入下一步时要计算剩余 deadline。',
        '如果每次重试都重新给 1 秒，三次尝试可能让用户等 3 秒以上。排队和退避也应消耗同一预算。组合模块时还要保持错误分类，限流、熔断、排队满和下游超时应返回不同结果。本关把前面的组件串起来，并用虚拟时间验证总耗时不超过入口预算。'
      ),
      p(
        'One gateway request passes through rate limiting, queueing, load balancing, a downstream call, and perhaps retry. A `timeout budget` is the total time allowed from entry to final response, not a fresh full timeout for every step. Each step receives the remaining deadline.',
        'If every retry starts a new one-second timeout, three attempts can make the caller wait more than three seconds. Queue time and backoff also consume the same budget. Composition must preserve error classes so rate limit, open circuit, full queue, and downstream timeout remain distinguishable. This stage connects the earlier components and uses virtual time to enforce the entrance budget.'
      )
    ),
    degradation: t(
      p(
        '`降级`是在依赖不可用时返回功能较少但仍有定义的结果，例如读取稍旧的缓存，而不是让整个页面失败。降级不是捕获所有异常后返回空对象；调用方必须能知道结果来自 fallback，以及哪些字段可能缺失。',
        '兜底数据也有可接受的新鲜度和适用错误。权限检查失败不能用旧允许结果降级，写请求也通常不能假装成功。本关为不同失败类型配置明确策略，并记录降级原因。只有主路径失败且策略允许时才进入 fallback，fallback 自身失败仍要正常上报。'
      ),
      p(
        '`Degradation` returns a smaller but defined result when a dependency is unavailable, such as slightly stale cached data instead of failing the whole page. It is not a blanket catch that returns an empty object. The caller needs to know that a fallback supplied the result and which fields may be missing.',
        'Fallback data has an acceptable age and applies only to certain failures. An authorization failure cannot degrade to an old allow decision, and a write usually cannot pretend to succeed. This stage configures explicit policies by failure type and records the degradation reason. Fallback runs only when the main path fails and policy permits it; failure of the fallback still propagates normally.'
      )
    ),
    shadowing: t(
      p(
        '`流量镜像`把线上请求的副本发送给新实现，用来观察新实现会怎样响应，但用户仍只收到主实现结果。镜像调用不能增加主请求延迟，也不能让新实现的写操作产生真实副作用，因此通常要删掉敏感字段并使用只读或隔离环境。',
        '`灰度`则让一小部分真实请求由新实现负责，需要稳定的分流键，避免同一用户在版本之间来回跳。比较主响应和镜像响应时要忽略时间戳等非确定字段。本关会异步执行 shadow、限制其并发，并把差异记录成指标而不是改变用户响应。'
      ),
      p(
        '`Traffic shadowing` sends a copy of a production request to a new implementation while the user still receives only the primary result. The shadow call must not add latency to the primary path or let the new implementation create real side effects. Systems normally redact sensitive fields and use a read-only or isolated target.',
        'A `canary` instead routes a small amount of real traffic to the new version. It needs a stable routing key so one user does not jump between versions. Response comparison also ignores nondeterministic fields such as timestamps. This stage runs shadows asynchronously with bounded concurrency and records differences as metrics without changing the user response.'
      )
    ),
  },

  'resilient-fetch-pipeline': {
    contract: t(
      p(
        '抓取管线接收一组目标并返回结果。第一步先定义`契约`：输入长什么样，成功结果保留哪些字段，单个请求失败时整批是抛错还是返回部分结果。没有稳定契约，后面的并发、重试和缓存都会各自发明错误格式。',
        '`错误边界`把外部网络失败转换成管线自己的错误类型，同时保留 url、状态码和原因。它不应把编程错误也伪装成普通网络失败。结果还要与输入建立稳定对应，才能在并发完成顺序变化后仍然知道每项属于谁。本关先写串行版本，用它固定以后所有关卡的行为。'
      ),
      p(
        'A fetch pipeline accepts a set of targets and returns results. The first stage defines its `contract`: the input shape, fields in a successful result, and whether one failed request rejects the batch or returns a partial result. Without a stable contract, concurrency, retries, and caching will each invent a different error shape.',
        'An `error boundary` translates external network failures into the pipeline error type while retaining the URL, status, and cause. It must not disguise programming defects as ordinary network errors. Results also need a stable relationship to inputs after concurrent completion changes their order. This stage builds a serial version that fixes behavior for every later stage.'
      )
    ),
    'concurrency-pool': t(
      p(
        '`并发`表示多个未完成请求在同一时间段内推进，不等于开很多线程。Promise 可以同时等待多个网络操作。`并发池`只允许最多 N 个任务在途，一个结束后再从队列启动下一个，既提高吞吐，也避免把下游和本机连接数打满。',
        '直接对所有输入 `Promise.all`没有上限；在循环里逐个 await 又完全串行。池需要跟踪下一个输入和当前 worker 数量，并在成功、失败时都释放槽位。输出顺序通常仍按输入顺序保存。本关使用虚拟延迟测量最大并发和总耗时，边界包括空输入与 limit 大于任务数。'
      ),
      p(
        '`Concurrency` means several unfinished requests make progress during the same interval; it does not require one thread per request. Promises can wait for many network operations together. A `concurrency pool` permits at most N operations in flight and starts another when one finishes, improving throughput without exhausting the downstream service or local connections.',
        'Calling `Promise.all` for every input has no limit, while awaiting inside a simple loop is fully serial. A pool tracks the next item and active workers, releasing a slot after both success and failure. Output commonly remains in input order. This stage measures maximum concurrency and virtual elapsed time, including empty input and a limit larger than the workload.'
      )
    ),
    'timeout-deadline': t(
      p(
        '`超时`通常限制一次操作能等多久。`deadline`是整条请求必须结束的绝对时刻。管线经过排队、网络和后续处理时，后面的步骤只能使用剩余预算，不能各自重新获得完整超时。',
        '超时需要和正在执行的 Promise 竞速，并在计时器先到时返回明确错误。即使底层请求无法真正取消，管线也不能再接受它的迟到结果。使用虚拟时钟时，所有时间计算都来自同一 `now()`。本关会让部分任务先在队列里等待，再检查它们实际能使用的网络时间已经减少。'
      ),
      p(
        'A `timeout` usually limits how long one operation may wait. A `deadline` is the absolute time by which the whole request must finish. After queueing, network work, and later processing, each step receives only the remaining budget rather than a fresh full timeout.',
        'Timeout handling races the operation against a timer and returns a clear error when the timer wins. Even if the underlying request cannot be cancelled, the pipeline must ignore its late result. Under the virtual clock, all calculations use the same `now()`. This stage lets some tasks wait in the queue and verifies that their available network time has already decreased.'
      )
    ),
    'retry-backoff': t(
      p(
        '网络请求可能因为短暂故障失败。`重试`重新执行同一操作，但只适合幂等且可恢复的失败。`指数退避`让等待时间按尝试次数增长，避免许多客户端在服务刚出问题时立刻连续轰炸。',
        '尝试次数、等待时间和总 deadline 要一起计算。睡眠后如果预算已经用完，就不该再发请求。真实系统常加入 jitter 打散客户端，本关用确定时间便于测试。最后一次失败要保留原始状态和尝试信息，不能只抛一个没有上下文的“重试失败”。'
      ),
      p(
        'A network request may fail because of a temporary fault. A `retry` executes the operation again, but only for recoverable failures and operations safe to repeat. `Exponential backoff` increases the wait with attempt count so many clients do not hammer a service continuously as soon as it becomes unhealthy.',
        'Attempt count, backoff, and the overall deadline are calculated together. If the budget expires during sleep, another request should not start. Real systems often add jitter to spread clients; this exercise uses deterministic timing for tests. The final failure retains the original status and attempt information instead of throwing a context-free “retry failed” error.'
      )
    ),
    'failure-policy': t(
      p(
        '不是所有失败都该重试。连接中断和部分 5xx 可能是暂时故障，参数错误等 4xx 通常重试也不会改变结果。429 表示服务正在限流，响应可能给出 `Retry-After`，调用方应尊重服务端建议，而不是使用更短的本地退避。',
        '`错误分类`把底层状态转换成 retry、fail、throttle 等明确决策。策略本身不发请求，只回答下一步怎么做，便于独立测试。未知错误应采用保守默认值。本关把分类与执行循环分开，并保证不可重试错误只调用一次，限流等待仍受总预算限制。'
      ),
      p(
        'Not every failure should retry. A connection interruption or some 5xx responses may be temporary, while a 4xx caused by invalid input normally remains invalid. Status 429 means the service is throttling and may provide `Retry-After`; the caller should respect that delay rather than choose a shorter local backoff.',
        '`Failure classification` converts low-level status into explicit decisions such as retry, fail, or throttle. The policy does not send requests; it only decides the next action and can be tested separately. Unknown failures use a conservative default. This stage separates classification from the execution loop, calls a non-retryable failure once, and keeps throttling delay within the total budget.'
      )
    ),
    hedging: t(
      p(
        '服务大多数请求很快，少数请求特别慢，这些慢尾部会拖高整体延迟。`对冲请求`在首个请求超过阈值仍未完成时，向另一个副本发出同样请求，采用最先成功的结果。它用额外流量换取更低尾延迟。',
        '对冲只适合安全重复的读取。首请求很快完成时绝不能启动副本；副本启动后也只能提交一次结果，另一份迟到响应要忽略或取消。对冲次数和并发需要上限，否则故障时会放大压力。本关会统计 duplicated 请求，检查正常快请求保持单次调用。'
      ),
      p(
        'Most requests to a service may be fast while a small tail is much slower. Those outliers increase overall latency. A `hedged request` starts a duplicate against another replica when the first call remains unfinished past a threshold, then uses the first successful result. It trades extra traffic for lower tail latency.',
        'Hedging is appropriate only for reads safe to repeat. A quickly completed primary must never start a duplicate. Once a duplicate starts, only one result may commit and the later response is ignored or cancelled. Hedge count and concurrency need limits to avoid amplifying an outage. This stage counts duplicated calls and confirms that normal fast requests still make one call.'
      )
    ),
    'cache-single-flight': t(
      p(
        '缓存把最近结果按 key 保存到过期时间，命中时不再访问下游。`TTL`从数据写入缓存时开始计算，过期条目必须重新获取。失败是否缓存要单独决定，随便缓存错误会让短暂故障在整个 TTL 内持续。',
        '同一个 key 在缓存未命中时可能同时收到很多请求。`single-flight`让它们共享一个正在进行的 Promise，只有第一个真正访问下游。请求完成后要清除 in-flight 记录，失败也一样，否则以后永远复用一个 rejected Promise。本关会区分已完成缓存和进行中去重这两张表。'
      ),
      p(
        'A cache stores a recent result by key until an expiry time and skips the downstream call on a hit. A `TTL` starts when data enters the cache, and an expired entry must be fetched again. Failure caching needs a separate decision; caching every error can extend one temporary fault through the whole TTL.',
        'Many requests for one missing key may arrive together. `Single-flight` makes them share one in-progress promise so only the first reaches the downstream service. The in-flight record is removed after completion, including failure, or later calls will reuse one rejected promise forever. This stage keeps completed cache entries separate from ongoing-request deduplication.'
      )
    ),
    'priority-scheduling': t(
      p(
        '优先级队列让紧急任务先拿到并发槽位，但高优先级流量持续不断时，低优先级任务可能永远等不到，这叫`饥饿`。调度器需要同时考虑初始优先级和等待时间。',
        '`aging`会随着等待增加任务的有效优先级，让低优先级最终也能运行。排序时还要为相同优先级保留稳定的先来后到，避免每次比较得到不同顺序。本关会在高优先级任务持续加入时检查旧任务仍有上界可等，并确保正在运行的任务不会被队列重新排序。'
      ),
      p(
        'A priority queue lets urgent work take a concurrency slot first. If high-priority traffic arrives continuously, low-priority work may wait forever; this is `starvation`. The scheduler needs to consider both initial priority and time already spent waiting.',
        '`Aging` raises effective priority as wait time grows, so low-priority work eventually runs. Equal priorities also keep stable arrival order rather than changing on every comparison. This stage keeps a bound on old-task waiting while new high-priority work continues to arrive, and never reorders work that is already running.'
      )
    ),
    backpressure: t(
      p(
        '上游产生任务比下游处理更快时，等待队列会持续增长。`背压`让这种过载向上游可见，而不是用内存把速度差暂时藏起来。有界队列到达容量后，可以拒绝、等待空间或按明确策略丢弃。',
        '队列上限和并发上限解决不同问题：并发限制正在运行的数量，队列限制尚未开始的数量。任务结束后需要唤醒一个等待生产者或启动下一个任务。取消和失败也必须释放占用。本关会在持续输入下检查内存中的任务总量始终有上限。'
      ),
      p(
        'When an upstream producer creates work faster than the downstream can process it, a waiting queue grows without bound. `Backpressure` makes overload visible to the producer instead of hiding the speed difference in memory. Once a bounded queue reaches capacity, the system may reject, wait for space, or drop by an explicit policy.',
        'Queue limit and concurrency limit solve different problems: concurrency bounds running work, while queue capacity bounds work not yet started. Completion wakes a waiting producer or starts another task. Cancellation and failure also release their occupied state. This stage sends sustained input and verifies that the total number of tasks held in memory remains bounded.'
      )
    ),
    pagination: t(
      p(
        '很多接口一次只返回一页数据，并附带 `nextCursor`。游标不是页码，它通常编码服务端排序中的继续位置。客户端把返回的游标原样交回，直到它为空。这样数据增长时不必用越来越大的 offset 跳过前面所有行。',
        '分页遍历要防止服务端返回重复游标，否则循环永远结束不了。空页也不一定表示结束，契约应以 nextCursor 为准。跨页结果可能重复，是否去重要看业务 key。本关会保存已见游标、累计结果，并让请求数和总 deadline 在所有页面之间共享。'
      ),
      p(
        'Many APIs return one page of data and a `nextCursor`. A cursor is not a page number; it usually encodes a continuation position in server ordering. The client passes it back unchanged until no next cursor remains. This avoids skipping an ever-growing prefix with a large numeric offset.',
        'A pagination loop must detect a repeated cursor or it can run forever. An empty page does not necessarily mean completion; the contract uses the next cursor as the signal. Results may repeat across pages, and deduplication depends on the business key. This stage records seen cursors and accumulated results while sharing request count and total deadline across every page.'
      )
    ),
    pipeline: t(
      p(
        '把并发、超时、重试、缓存和分页接到一起时，顺序会改变行为。缓存应围住哪一层、重试发生在单页还是整次遍历、并发槽位在退避期间是否占用，都需要由一个清楚的组件边界决定。',
        '可运维组件还要能配置上限并暴露状态，而不是把数字散落在实现里。本关定义一个统一入口，把依赖作为参数注入，方便测试和替换。错误仍保留阶段信息，调用方能分辨是排队、网络、分页还是预算耗尽，模块组合后不会只剩一个笼统失败。'
      ),
      p(
        'When concurrency, timeout, retry, cache, and pagination are connected, ordering changes behavior. The component boundary decides which layer caching wraps, whether retry applies to one page or the whole traversal, and whether backoff occupies a concurrency slot.',
        'An operable component also configures limits and exposes state rather than scattering numbers through implementation. This stage defines one entry point and injects dependencies so tests can replace them. Errors retain phase information, allowing callers to distinguish queueing, network, pagination, and budget exhaustion after the modules are composed.'
      )
    ),
    observability: t(
      p(
        '`指标`把大量请求压成可聚合数字，例如请求数、错误数、缓存命中率和延迟分布。平均延迟会掩盖少量特别慢的请求，所以系统还会观察分位数或至少保存可归因的慢请求记录。指标名称和标签必须有上限，不能把每个 URL 当成一个无限增长的标签。',
        '慢请求的总时间要拆成排队、退避、网络和处理等阶段，才能知道该优化哪里。一次请求可能重试，调用次数和用户请求数不能混为一谈。本关在已有管线中插入计时点和计数器，并要求观测代码不改变原有返回值、并发和超时行为。'
      ),
      p(
        '`Metrics` reduce many requests into aggregatable values such as request count, error count, cache hit rate, and latency distribution. An average hides a small number of very slow calls, so systems also inspect percentiles or retain attributable slow-request records. Metric names and labels need bounded cardinality; using every full URL as a distinct label grows without limit.',
        'Total slow time should be divided into queueing, backoff, network, and processing so an operator knows where to act. One user request may retry, so attempt count and user-request count are different. This stage adds timing points and counters to the existing pipeline without changing its return values, concurrency, or timeout behavior.'
      )
    ),
  },

  'llm-accelerator': {
    'first-kernel': t(
      p(
        'GPU 上的一次计算叫一次`kernel 启动`。启动时你要说清楚开多少线程，'
        + '而且线程是**分两层**组织的：若干个`线程块`（block）组成一张`网格`（grid），'
        + '每个 block 里有固定数量的线程。写成 `vecAdd<<<4, 256>>>(...)` 就是 4 个 block、每块 256 个线程。',
        '这两层不是摆设。同一个 block 里的线程跑在同一个 SM 上、能共享一小块高速内存、能互相同步；'
        + '不同 block 之间没有任何顺序保证，也不能直接通信。所以 block 内和 block 间是两套完全不同的编程方式。',
        '每个线程通过三个内建变量知道自己是谁：`threadIdx` 是它在 block 里的编号，'
        + '`blockIdx` 是它所在的 block 编号，`blockDim` 是每个 block 有多少线程。'
        + '把它们拼起来得到全局编号：`blockIdx.x * blockDim.x + threadIdx.x`。',
        '**线程数几乎总是比数据多。** 数据长度很少正好是 block 大小的整数倍，'
        + '所以每个 kernel 开头都要有一句边界检查，多出来的线程必须什么都不做。'
        + '让它们越界写，在真卡上就是踩坏别人的显存。'
      ),
      p(
        'One computation on a GPU is a `kernel launch`. You state how many threads to start, and threads '
        + 'are organised in **two levels**: a `grid` of `thread blocks`, each block holding a fixed number '
        + 'of threads. `vecAdd<<<4, 256>>>(...)` means 4 blocks of 256 threads.',
        'The two levels are not decoration. Threads in one block run on the same SM, share a small fast '
        + 'memory, and can synchronise with each other. Different blocks have no ordering guarantee and '
        + 'cannot communicate directly. Programming within a block and across blocks are two different things.',
        'Each thread learns who it is from three built-in variables: `threadIdx` is its index inside the '
        + 'block, `blockIdx` is which block it belongs to, and `blockDim` is how many threads a block has. '
        + 'Combine them for a global index: `blockIdx.x * blockDim.x + threadIdx.x`.',
        '**There are almost always more threads than data.** Lengths are rarely an exact multiple of the '
        + 'block size, so every kernel begins with a bounds check and the surplus threads do nothing. '
        + 'Letting them write out of range corrupts memory belonging to something else on a real GPU.'
      )
    ),
    coalescing: t(
      p(
        'GPU 的显存不是按单个数取的。硬件一次搬运的最小单位是一个 **32 字节的扇区**，'
        + '哪怕你只要其中 4 个字节，剩下的 28 个也会被一起搬过来然后扔掉。',
        '一个 `warp`（32 个线程，GPU 调度的最小单位）同时发出的 32 个访存请求会被硬件合并：'
        + '落在同一个扇区里的合成一次传输。于是同样是读 32 个 float，'
        + '**连续读**只要 4 个扇区（32 × 4 = 128 字节），'
        + '而**每个 lane 隔得很远**就要 32 个扇区，传输量差 8 倍，指令却一条没多。',
        '这就是「合并访问」。判断方法很简单：看同一个 warp 里相邻的线程，它们访问的地址是不是相邻的。'
        + '在 `ncu` 里对应的指标叫 `l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio`，'
        + '完美是 4.0，最坏是 32.0。',
        '几乎所有 GPU 访存优化最后都归到这一条。它也是矩阵转置为什么难的原因：'
        + '按行读就得按列写，两边不可能同时合并。'
      ),
      p(
        'GPU memory is not fetched one value at a time. The smallest unit the hardware moves is a '
        + '**32-byte sector**; asking for 4 bytes brings the other 28 along and then discards them.',
        'The 32 memory requests issued by one `warp` (32 threads, the GPU\'s scheduling unit) are coalesced: '
        + 'lanes landing in the same sector become one transfer. Reading 32 consecutive floats therefore '
        + 'costs **4 sectors** (32 × 4 = 128 bytes), while 32 scattered lanes cost **32 sectors**, 8x the '
        + 'traffic for exactly the same instructions.',
        'That is coalescing. The test is simple: do neighbouring threads in a warp touch neighbouring '
        + 'addresses? In `ncu` the metric is '
        + '`l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio`, 4.0 at best and 32.0 at worst.',
        'Nearly every GPU memory optimisation reduces to this rule. It is also why matrix transpose is hard: '
        + 'reading along rows forces writing along columns, and both cannot coalesce at once.'
      )
    ),
    'shared-memory-race': t(
      p(
        '`共享内存`是每个 block 独有的一小块内存，比显存快一个数量级，用 `__shared__` 声明。'
        + '它的典型用法是「中转」：先把一块数据按合并的方式读进来，'
        + '再按任意顺序从共享内存里取用，于是读和写都能保持合并。矩阵转置就是这么解的。',
        '但共享内存是**共用**的，这就带来了竞态。一个线程写 `tile[y][x]`、另一个线程读 `tile[x][y]`，'
        + '如果中间没有同步，读的人完全可能读到还没被写进去的旧值。'
        + '`__syncthreads()` 就是那道同步：整个 block 的线程都停在这里，等所有人都到齐了再一起走。',
        '**`__syncthreads()` 必须让整个 block 都执行到。** 把它写进 `if` 里，'
        + '只有一部分线程到达屏障，真卡上是未定义行为，通常直接挂死。',
        '竞态最麻烦的地方是它**不一定表现出来**。GPU 上 warp 的执行顺序不确定，'
        + '同一份有竞态的代码可能今天对、明天错，也可能在你的卡上一直对、在别人的卡上一直错。'
        + '所以不能靠「多跑几遍看看」，要用 `compute-sanitizer --tool racecheck`，'
        + '它给共享内存的每个字记住最近谁读谁写、中间过了几次屏障，冲突就报出来。'
      ),
      p(
        '`Shared memory` is a small per-block memory an order of magnitude faster than device memory, '
        + 'declared with `__shared__`. Its classic use is staging: read a tile in coalesced, then take '
        + 'values out of shared memory in any order, so both the read and the write stay coalesced. '
        + 'That is how matrix transpose is solved.',
        'But shared memory is **shared**, which introduces races. If one thread writes `tile[y][x]` and '
        + 'another reads `tile[x][y]` with nothing in between, the reader may well see a value that has '
        + 'not been written yet. `__syncthreads()` is the barrier: every thread in the block waits there '
        + 'until all of them have arrived.',
        '**`__syncthreads()` must be reached by the whole block.** Inside an `if`, only some threads reach '
        + 'it, which is undefined behaviour on real hardware and usually a hang.',
        'The hard part about races is that they **need not show up**. Warp scheduling is not deterministic, '
        + 'so the same racy code can be right today and wrong tomorrow, or always right on your GPU and '
        + 'always wrong on someone else\'s. Re-running proves nothing. Use '
        + '`compute-sanitizer --tool racecheck`: it shadows every shared-memory word with its last reader, '
        + 'last writer and barrier epoch, and reports the conflicts.'
      )
    ),
    'bank-conflicts': t(
      p(
        '共享内存不是一整块，它被切成 **32 个 bank**。哪个地址属于哪个 bank 只看一条规则：'
        + '`bank = (字节地址 / 4) % 32`。也就是说连续的 float 依次落在 bank 0、1、2……31，然后绕回 0。',
        '一个 warp 的 32 个 lane 同时访问共享内存时，落在**不同 bank** 上的可以一次做完；'
        + '落在**同一个 bank 的不同地址**上的必须排队，n 个不同地址就是 n 路串行。'
        + '所以最坏情况（32 个 lane 全挤在一个 bank）比最好情况慢 32 倍。',
        '有一个例外常被忽略：**同一个 bank 上访问同一个地址不算冲突**，那是广播，一点都不慢。'
        + '`s[0]` 被所有线程读、或者 `s[threadIdx.x / 2]` 这种一半 lane 读同一格，都是免费的。',
        '按列访问二维数组是最典型的冲突源。行宽 32 个 float 时，`tile[0][c]`、`tile[1][c]`、`tile[2][c]` '
        + '的地址依次差 128 字节，算出来的 bank 号完全一样。把行宽改成 33，每一行就整体错开一个 bank，冲突消失。'
        + '代价是每 32 行多占 32 个 float，换来 32 倍的吞吐。'
      ),
      p(
        'Shared memory is not one flat block; it is divided into **32 banks**, and which bank an address '
        + 'belongs to follows one rule: `bank = (byte address / 4) % 32`. Consecutive floats therefore land '
        + 'in banks 0, 1, 2 and so on up to 31, then wrap.',
        'When the 32 lanes of a warp access shared memory, lanes hitting **different banks** are serviced '
        + 'together. Lanes hitting **different addresses within one bank** are serialised, n distinct '
        + 'addresses costing n ways. The worst case, all 32 lanes in one bank, is 32 times slower than the best.',
        'One exception is often missed: **the same address in the same bank is a broadcast**, not a conflict, '
        + 'and costs nothing. Every thread reading `s[0]`, or half the lanes reading `s[threadIdx.x / 2]`, is free.',
        'Column-wise access of a 2D array is the classic conflict. With a row of 32 floats, `tile[0][c]`, '
        + '`tile[1][c]` and `tile[2][c]` are 128 bytes apart and map to identical banks. Widening the row to 33 '
        + 'shifts every row by one bank and the conflict disappears, at a cost of 32 extra floats per 32 rows '
        + 'in exchange for 32 times the throughput.'
      )
    ),
    'warp-reduce': t(
      p(
        'GPU 调度的最小单位是 `warp`，也就是 32 个线程。它们**共用一个程序计数器**：'
        + '一条指令下去，32 个 lane 一起执行。遇到 `if` 时如果 lane 之间的判断结果不一致，'
        + '硬件只能先把满足条件的那批跑一遍、再把另一批跑一遍，两边的时间都要花。这叫 `warp 发散`。',
        '发散不是「有分支就慢」，而是「**同一个 warp 内部**判断结果不一致才慢」。'
        + '`if (blockIdx.x % 2)` 整个 warp 走同一边，不发散；`if (threadIdx.x % 2)` 就把 warp 劈成两半。',
        '既然 warp 内的线程本来就在一起走，它们之间交换数据其实不必经过内存。'
        + '`__shfl_xor_sync(mask, v, delta)` 让每个 lane 直接读到 `lane ^ delta` 那个 lane 的寄存器。'
        + '做 5 次（delta 取 16、8、4、2、1），32 个值就两两归并成了一个，'
        + '**一次内存访问都没有，也不需要 `__syncthreads()`**。',
        '第一个参数 `mask` 说明哪些 lane 参与。全员参与时写 `0xffffffff`。'
        + '读一个没在掩码里的 lane，拿到的是未定义值，这是真卡上很难查的一类 bug。'
      ),
      p(
        'The GPU schedules in units of a `warp`, 32 threads that **share one program counter**: one '
        + 'instruction issues and all 32 lanes execute it. At an `if` whose condition differs between lanes, '
        + 'the hardware runs the taken lanes first and the others afterwards, paying for both. That is '
        + '`warp divergence`.',
        'Divergence is not "branches are slow" but "branches that disagree **inside one warp** are slow". '
        + '`if (blockIdx.x % 2)` sends a whole warp one way and costs nothing; `if (threadIdx.x % 2)` splits it in half.',
        'Since the threads of a warp already move together, exchanging data between them need not go through '
        + 'memory. `__shfl_xor_sync(mask, v, delta)` hands each lane the register held by lane `lane ^ delta`. '
        + 'Five rounds with delta 16, 8, 4, 2 and 1 pairwise collapse 32 values into one, '
        + '**with no memory traffic and no `__syncthreads()`**.',
        'The first argument, `mask`, states which lanes take part; `0xffffffff` means all of them. Reading a '
        + 'lane outside the mask yields an undefined value, a bug that is notoriously hard to track down on real hardware.'
      )
    ),
    occupancy: t(
      p(
        '`占用率`是一个 SM 上同时驻留了多少 warp，除以它能装下的最大 warp 数。'
        + '它重要是因为 GPU 隐藏延迟的方式就是切换 warp：一个 warp 在等显存，'
        + '调度器就去跑另一个。能同时驻留的 warp 越多，等待越容易被盖住。',
        '限制驻留数的资源有四个，每个 SM 上都是固定的：寄存器堆、共享内存、'
        + '最大 block 数、最大 warp 数。四条各算出能驻留几个 block，取最小的那个。'
        + '`ncu` 的 `Occupancy` 分节会直接告诉你是哪一条卡住了，这比数字本身有用得多。',
        '寄存器是最常见的瓶颈，而它有一个反直觉的地方：**线程私有的数组只有在下标全是编译期常量时'
        + '才能待在寄存器里**。出现一次动态下标，整个数组就会落到 `local memory`。'
        + '那块内存名字叫 local，实际住在显存里，每次访问都是一趟真正的访存。',
        '更麻烦的是，数组搬走之后寄存器数反而**变少**了，光看寄存器数会以为优化成功。'
        + '真正的证据是 local memory 的流量：它不为 0，就说明有东西掉出了寄存器。'
      ),
      p(
        '`Occupancy` is how many warps are resident on an SM divided by the maximum it can hold. It matters '
        + 'because switching warps is exactly how a GPU hides latency: while one warp waits on memory the '
        + 'scheduler runs another. More resident warps means more waiting gets covered.',
        'Four fixed per-SM resources limit residency: the register file, shared memory, the maximum block '
        + 'count and the maximum warp count. Each implies a number of resident blocks and the smallest wins. '
        + 'The `Occupancy` section of `ncu` names the limiter, which is far more useful than the number itself.',
        'Registers are the usual bottleneck, and they have a counter-intuitive property: **a thread-private '
        + 'array stays in registers only while every subscript is a compile-time constant**. One dynamic index '
        + 'and the whole array moves to `local memory`, which despite its name lives in device memory, making '
        + 'every access a real memory round trip.',
        'Worse, once the array moves out the register count *drops*, so that metric alone looks like a win. '
        + 'The real evidence is local-memory traffic: anything above zero means something fell out of registers.'
      )
    ),
    'naive-gemm': t(
      p(
        '矩阵乘法 `C = A × B` 是 LLM 里绝大部分算力的去处：每一层的投影、前馈网络、'
        + '注意力里的两次矩阵乘，全是它。所以 GPU 编程的大半功夫都花在把 GEMM 写快上。',
        '最直白的写法是每个线程负责 C 的一个元素，沿 k 维做一遍点积。'
        + '这样写一定是对的，但它有个致命的比例问题：算一个输出要读 2n 个数、做 n 次乘加，'
        + '也就是**每搬两个字节才做一次乘加**。',
        '衡量这件事的指标叫`算术强度`：每从显存搬一个字节，做了多少次浮点运算。'
        + '朴素 GEMM 的算术强度是 0.5。而 H100 的算力与带宽之比在几十 FLOP/byte，'
        + '差了两个数量级，这种 kernel 的时间全花在等数据上，算力完全闲置。',
        '`roofline` 图把这件事画成一张两段的屋顶：左边一段斜坡是带宽限制，'
        + '右边一段平台是算力限制，交界处叫拐点。优化一个 kernel 的第一步，'
        + '就是先看清它落在斜坡上还是平台上，因为这决定了该往哪个方向使劲。'
      ),
      p(
        'Matrix multiplication `C = A × B` is where nearly all the FLOPs in an LLM go: every projection, '
        + 'every feed-forward layer, both matmuls inside attention. Most of GPU programming effort goes '
        + 'into making GEMM fast.',
        'The direct version gives each thread one element of C and one dot product along k. It is '
        + 'certainly correct, but the ratio is fatal: each output reads 2n values and performs n '
        + 'multiply-adds, meaning **one multiply-add per two bytes moved**.',
        'The metric for this is `arithmetic intensity`: floating-point operations per byte fetched from '
        + 'memory. Naive GEMM sits at 0.5, while the compute-to-bandwidth ratio of an H100 is in the tens '
        + 'of FLOP/byte. Two orders of magnitude apart: such a kernel spends all its time waiting for data '
        + 'while the arithmetic units idle.',
        'A `roofline` chart draws this as a two-segment roof, a bandwidth-limited slope on the left and a '
        + 'compute-limited plateau on the right, meeting at the ridge point. The first step in optimising '
        + 'any kernel is seeing which segment it lands on, because that decides where the effort should go.'
      )
    ),
    'tiled-gemm': t(
      p(
        '朴素 GEMM 的浪费在于**同一份数据被反复从显存读回来**。A 的每一行被 n 个线程各读一遍，'
        + 'B 的每一列也是。128×128 的矩阵一共 128KB，却读了 8MB。',
        '`分块`的思路是：既然一个 block 里的线程要用的数据高度重叠，就先把那一块搬进共享内存，'
        + '再让所有线程从共享内存取。把 A 与 B 各切成 16×16 的小块，'
        + '外层循环沿 k 维一块一块推进，每块搬一次、用 16 次。DRAM 读量因此降到原来的 1/16 附近。',
        '流程是四步一轮：搬一块、同步、算这一块、再同步。'
        + '**两个屏障都不能少**，而且它们防的是不同的事：'
        + '第一个保证「所有人都搬完了才开始算」，第二个保证「所有人都算完了才开始覆盖」。'
        + '少了第二个，跑得快的线程会在别人还没读完时就把共享内存写掉。',
        '分块之后瓶颈会**换个地方**而不是消失：DRAM 不再紧张了，'
        + '但每做一次乘加仍然要从共享内存读两个数，于是共享内存的带宽成了新的限制。'
        + '这是优化的常态：解开一个瓶颈，下一个就浮出来。'
      ),
      p(
        'The waste in naive GEMM is that **the same data is fetched from memory over and over**. Each row '
        + 'of A is read by n threads, and so is each column of B. A 128×128 matrix is 128KB, yet 8MB gets read.',
        '`Tiling` starts from the observation that threads in one block need heavily overlapping data. '
        + 'Stage that data in shared memory first and let every thread read it from there. Cut A and B into '
        + '16×16 tiles, step the outer loop along k one tile at a time, fetch each tile once and use it '
        + 'sixteen times. DRAM traffic drops by roughly a factor of sixteen.',
        'Each round has four steps: stage a tile, synchronise, accumulate, synchronise again. '
        + '**Neither barrier is optional and they prevent different things**: the first guarantees everyone '
        + 'finished writing before anyone reads, the second guarantees everyone finished reading before '
        + 'anyone overwrites. Without the second, a fast thread clobbers the tile mid-read.',
        'After tiling the bottleneck **moves rather than disappears**. DRAM is no longer tight, but every '
        + 'multiply-add still reads two values out of shared memory, so shared-memory bandwidth becomes the '
        + 'new limit. That is normal: relieve one bottleneck and the next surfaces.'
      )
    ),
    'register-tiling': t(
      p(
        '分块把数据从显存搬进了共享内存，但读写比还是 2:1：每做一次乘加读两个数。'
        + '再往上一层的办法是让**一个线程算多个输出**，这样读进来的值能被复用更多次。',
        '让每个线程算 4×4 = 16 个输出：从共享内存读 4 个 A 的值和 4 个 B 的值（一共 8 次读），'
        + '就能做 16 次乘加。读写比从 2:1 变成 1:2，好了四倍。'
        + '这 16 个累加器全程待在寄存器里，寄存器的带宽比共享内存又高一个数量级。',
        '这里要用上第 6 关那条规则：**线程私有的数组只有在下标全是编译期常量时才待在寄存器里**。'
        + '写成 `float acc[4][4]` 再用循环变量索引，整个数组会落到 local memory，'
        + '性能不升反降。所以真实的 GEMM kernel 里这些累加器往往是手写展开的标量。',
        '这一层叫 thread tile，加上前面的 threadblock tile，'
        + '就是 CUTLASS 那套「分块层次」的雏形。真实的库还会在中间加一层 warp tile，'
        + '并用向量化访存与 swizzle 进一步压榨，但基本思路就是这两关的组合。'
      ),
      p(
        'Tiling moved data from device memory into shared memory, but the ratio is still 2:1, two reads '
        + 'per multiply-add. The next level up is to give **one thread several outputs** so each loaded '
        + 'value is reused more times.',
        'Let each thread compute 4×4 = 16 outputs: read 4 values of A and 4 of B, eight reads in total, '
        + 'then perform 16 multiply-adds. The ratio goes from 2:1 to 1:2, four times better. Those 16 '
        + 'accumulators stay in registers throughout, and register bandwidth is another order of magnitude '
        + 'above shared memory.',
        'This is where the stage-6 rule bites: **a thread-private array stays in registers only while every '
        + 'subscript is a compile-time constant**. Declaring `float acc[4][4]` and indexing it with a loop '
        + 'variable sends the whole thing to local memory and performance goes backwards. Real GEMM kernels '
        + 'therefore write these accumulators as hand-unrolled scalars.',
        'This layer is called the thread tile, and together with the threadblock tile it forms the seed of '
        + 'the CUTLASS tiling hierarchy. Production libraries add a warp tile in between and squeeze further '
        + 'with vectorised access and swizzling, but the underlying idea is exactly these two stages combined.'
      )
    ),
    'double-buffering': t(
      p(
        '分块 GEMM 的每一轮里有两个屏障，它们防的是不同的事：'
        + '第一个保证「大家都搬完了才开始算」，第二个保证「大家都算完了才开始覆盖」。'
        + '第二个之所以存在，只是因为下一轮要复用同一块共享内存。',
        '`双缓冲`把这个理由拿掉：开两套 buffer 轮流用。'
        + '算第 t 块的时候往另一套里搬第 t+1 块，两件事碰不到一起，一轮就只需要一个屏障。'
        + '这个手法在流水线设计里叫 `ping-pong`，从 CPU 的双缓冲画面到 GPU 的 tile 预取都是它。',
        '代价是共享内存翻倍。共享内存是每 SM 固定的资源，'
        + '吃得多了能同时驻留的 block 就少了，占用率会掉。'
        + '所以双缓冲不是无脑赢，要看少掉的屏障值不值那些占用率。',
        '真硬件上还能更进一步。Ampere 起有 `cp.async`：搬运指令发出去之后**不阻塞线程**，'
        + '也不占用寄存器，到真要用数据时再等。这样双缓冲才真正变成流水线，'
        + '而不只是省一个屏障。Hopper 又加了 TMA，一条指令搬一整块多维 tile。'
      ),
      p(
        'Each round of a tiled GEMM has two barriers guarding different things: the first ensures '
        + 'everyone finished staging before anyone computes, the second ensures everyone finished '
        + 'computing before anyone overwrites. The second exists only because the next round reuses the '
        + 'same shared tile.',
        '`Double buffering` removes that reason by keeping two sets of tiles and alternating. While '
        + 'computing on tile t, stage tile t+1 into the other set; the two never collide and one barrier '
        + 'per round suffices. The technique is called `ping-pong` in pipeline design and appears '
        + 'everywhere from CPU double-buffered graphics to GPU tile prefetch.',
        'The cost is twice the shared memory. Shared memory is a fixed per-SM resource, so using more of '
        + 'it means fewer resident blocks and lower occupancy. Double buffering is therefore not a free '
        + 'win: the barriers saved have to be worth the occupancy given up.',
        'Real hardware goes further. From Ampere, `cp.async` issues a staging instruction that **does not '
        + 'block the thread** and does not occupy registers; you wait only when the data is actually '
        + 'needed. Only then does double buffering become a true pipeline rather than one fewer barrier. '
        + 'Hopper adds TMA, moving a whole multidimensional tile with a single instruction.'
      )
    ),
    'tensor-core': t(
      p(
        '到目前为止每一次乘加都走 `FMA` 流水线，H100 上一个 SM 每周期 128 次。'
        + 'GPU 上还有一类专门为矩阵乘造的单元叫 `tensor core`，同样一个 SM 每周期能做 1024 次乘加，'
        + '八倍。深度学习这几年的算力增长，绝大部分来自这里而不是通用流水线。',
        'tensor core 的接口是 `wmma`，全称 warp matrix multiply-accumulate。'
        + '关键词是 **warp**：它不是一个线程的指令，而是**整个 warp 协作**完成一个 16×16×16 的矩阵乘。'
        + '数据装在叫 `fragment` 的对象里，它是不透明的，哪个 lane 拿了哪几个元素，'
        + '标准里就是未定义的，你不需要也不应该关心。',
        '典型配方是**输入 half、累加 float**。精度损失只发生在输入端（half 只有 10 位尾数），'
        + '而累加链条仍然在 fp32 上，所以几百项累加下来也不会垮。'
        + '这个不对称是有意设计的：矩阵乘的误差主要来自累加而不是单次乘法。',
        '再往后，Hopper 的 `wgmma` 与 Blackwell 的 `tcgen05` 把 MMA 变成了**异步**的：'
        + '发起之后线程可以接着干别的。于是高性能 kernel 开始做 `warp 专业化`，'
        + '一部分 warp 专门搬数据、另一部分专门算。FlashAttention-4 就是这么写的。'
      ),
      p(
        'Every multiply-add so far has gone through the `FMA` pipeline, 128 per SM per cycle on an H100. '
        + 'GPUs also carry units built purely for matrix multiplication, `tensor cores`, doing 1024 '
        + 'multiply-accumulates per SM per cycle. Most of the compute growth in deep learning over recent '
        + 'years came from these rather than from the general pipeline.',
        'The interface is `wmma`, warp matrix multiply-accumulate. The key word is **warp**: this is not a '
        + 'per-thread instruction but an **entire warp cooperating** on one 16×16×16 matmul. The data '
        + 'lives in `fragment` objects, which are opaque. Which lane holds which elements is undefined by '
        + 'the standard, and you neither need nor should care.',
        'The standard recipe is **half inputs, float accumulation**. Precision is lost only at the inputs '
        + '(half has ten mantissa bits) while the accumulation chain stays in fp32, so hundreds of terms '
        + 'still hold up. The asymmetry is deliberate: error in a matmul comes mostly from accumulation '
        + 'rather than from individual products.',
        'Beyond this, Hopper\'s `wgmma` and Blackwell\'s `tcgen05` make MMA **asynchronous**: once issued, '
        + 'the thread carries on with other work. High-performance kernels then adopt `warp specialisation`, '
        + 'dedicating some warps to moving data and others to computing. FlashAttention-4 is written that way.'
      )
    ),
    'online-softmax': t(
      p(
        'softmax 把一行数变成一个概率分布：`out[i] = exp(x[i]) / sum(exp(x[j]))`。'
        + '直接按定义算会溢出，因为 `exp` 涨得太快了，输入到 100 就已经是 inf。'
        + '标准做法是先减去这一行的最大值，结果完全等价，但每个指数的输入都不大于 0，永远安全。',
        '代价是要先知道最大值，于是朴素实现要读三遍：求 max、求和、写结果。'
        + '对于一个带宽受限的算子来说，读三遍就是慢三倍。',
        '`在线 softmax`把前两遍合成一遍，办法是边走边修正。'
        + '维护当前的最大值 m 与当前的和 s，遇到更大的值时把已经攒的和按 `exp(m_old - m_new)` 缩放。'
        + '这在数学上是恒等变形，不是近似。',
        '但它**不是免费的**：每次修正都要多算一个 `expf`，而 SFU 的吞吐只有 FMA 的八分之一。'
        + '省下的访存有一部分还给了 SFU。这个取舍在带宽紧张时划算、在 SFU 紧张时不划算，'
        + '而 FlashAttention 正是把它推到极致的地方。'
      ),
      p(
        'Softmax turns a row of numbers into a probability distribution: `out[i] = exp(x[i]) / '
        + 'sum(exp(x[j]))`. Computing that literally overflows, because `exp` grows too fast and an input '
        + 'of 100 is already inf. The standard fix subtracts the row maximum first: mathematically '
        + 'identical, but every exponent argument is now at most 0 and always safe.',
        'The cost is needing the maximum up front, so the naive implementation reads three times: max, '
        + 'sum, write. For a bandwidth-bound operator, three reads means three times slower.',
        '`Online softmax` merges the first two passes by correcting as it goes. Keep a running maximum m '
        + 'and running sum s; when a larger value appears, rescale the accumulated sum by '
        + '`exp(m_old - m_new)`. This is an algebraic identity, not an approximation.',
        'It is **not free**, though: each correction costs an extra `expf`, and SFU throughput is one '
        + 'eighth of FMA. Part of the memory traffic saved goes back to the SFU. The trade pays off when '
        + 'bandwidth is tight and not when the SFU is, and FlashAttention is where it gets pushed hardest.'
      )
    ),
    'welford-layernorm': t(
      p(
        '归一化在 Transformer 里无处不在：每一层前后各一次。'
        + '经典的 LayerNorm 算均值与方差再标准化；从 Llama 开始，主流模型大多改用 `RMSNorm`，'
        + '只算平方均值、不减均值，效果相当而计算量更小。',
        '这类算子的共同点是**带宽受限**：每个元素只做几次乘除，时间全花在读写上。'
        + '所以优化它们的唯一方向是减少访存次数，而不是减少运算。',
        '两遍写法（先求和、再写结果）会把张量读两次。'
        + '压成一遍的办法很直接：第一遍读的时候就把值**留在寄存器里**，写结果时直接用。'
        + '前提是每个线程负责的元素数是编译期已知的，而且要用常量下标，这正是第 6 关那条规则。',
        '真做 LayerNorm 时还有一个经典技巧：`Welford 算法`。'
        + '它维护 (count, mean, M2) 三元组增量更新，一遍算完均值与方差，'
        + '而且比「平方和减均值平方」那个公式稳定得多，后者在均值远大于方差时会灾难性抵消，'
        + '算出负的方差都有可能。'
      ),
      p(
        'Normalisation is everywhere in a Transformer, once before and once after every layer. Classic '
        + 'LayerNorm computes a mean and variance then standardises; from Llama onward most models use '
        + '`RMSNorm`, which needs only the mean square and skips the mean subtraction for comparable '
        + 'quality at lower cost.',
        'What these operators share is being **bandwidth-bound**: each element takes only a few '
        + 'multiplications, and the time goes into reading and writing. The only useful direction is '
        + 'fewer memory accesses, not fewer operations.',
        'A two-pass version reads the tensor twice. Collapsing it is direct: **keep the values in '
        + 'registers** during the first pass and reuse them when writing. That requires the per-thread '
        + 'element count to be known at compile time and the subscripts to be constants, which is exactly '
        + 'the stage-6 rule.',
        'Real LayerNorm has one more classic trick: `Welford\'s algorithm`. It keeps a (count, mean, M2) '
        + 'triple updated incrementally, produces mean and variance in one pass, and is far more stable '
        + 'than "sum of squares minus square of mean", which suffers catastrophic cancellation when the '
        + 'mean dwarfs the variance and can even yield a negative variance.'
      )
    ),
    'operator-fusion': t(
      p(
        '一个 Transformer 层的尾巴上挂着一串逐元素操作：加偏置、过激活函数、加残差。'
        + '每一步写成一个独立的 kernel 最省事，但每一步都要把整个张量读进来、写回去。'
        + '三步就是六趟访存，而真正的计算只有每个元素几次乘加。',
        '`算子融合`把它们合成一个 kernel：读一次、在寄存器里连着做完三步、写一次。'
        + '访存从六趟降到三趟，而这类算子的时间几乎全在访存上，所以收益差不多就是两倍。',
        '融合之所以是推理引擎里收益最直接的优化，正因为逐元素算子**全部**是带宽受限的。'
        + '给它们更多算力毫无意义，唯一能做的就是少搬几次数据。',
        '`torch.compile` 的主要工作之一就是自动做这件事，把一串逐元素操作编成一个 Triton 内核。'
        + '手写的库里，Liger-Kernel 把 LLM 常见的融合模式都实现了一遍。'
        + '再往上一层是把 GEMM 和它后面的逐元素操作也融进去，那叫 epilogue fusion。'
      ),
      p(
        'The tail of a Transformer layer is a chain of element-wise operations: add a bias, apply an '
        + 'activation, add the residual. Writing each as its own kernel is easiest, but every step reads '
        + 'the whole tensor and writes it back. Three steps means six trips through memory for what is '
        + 'only a handful of arithmetic operations per element.',
        '`Operator fusion` merges them into one kernel: read once, carry the value through all three '
        + 'steps in registers, write once. Memory traffic drops from six trips to three, and since these '
        + 'operators spend essentially all their time in memory, the speedup is close to two times.',
        'Fusion is the most directly profitable optimisation in an inference engine precisely because '
        + 'element-wise operators are **all** bandwidth-bound. Giving them more compute changes nothing; '
        + 'the only lever is moving data fewer times.',
        'One of the main jobs of `torch.compile` is doing this automatically, compiling a chain of '
        + 'element-wise operations into a single Triton kernel. Among hand-written libraries, '
        + 'Liger-Kernel implements the common LLM fusion patterns. One level up, fusing a GEMM with the '
        + 'element-wise work that follows it is called epilogue fusion.'
      )
    ),
    'naive-attention': t(
      p(
        '注意力回答的是「这个位置该关注序列里的哪些位置」。'
        + '公式是 `O = softmax(Q K^T / sqrt(d)) V`：Q 与 K 的点积给出每对位置之间的相关分数，'
        + 'softmax 把一行分数变成权重，再拿权重去加权 V。',
        '除以 `sqrt(d)` 不是可有可无的。点积是 d 项求和，量级随 d 增长；'
        + '不缩放的话进 softmax 的数就太大，指数一拉开就退化成 one-hot，梯度也几乎消失。',
        '按定义直接实现要先把分数矩阵 `S` 算出来。'
        + 'S 的形状是 seq × seq，也就是说**它的大小随序列长度平方增长**。'
        + 'seq=128 时只有 64KB，seq=8192 时单个头就是 256MB，再乘上头数与批大小就完全放不下了。',
        '这是长上下文的根本困难。研究界给出的路线大致三条：'
        + '稀疏注意力只算一部分分数、线性注意力换一种结合顺序绕开 seq×seq、'
        + '而 FlashAttention 选择了保留全部计算但**不把 S 存下来**。'
      ),
      p(
        'Attention answers the question of which positions in a sequence a given position should attend '
        + 'to. The formula is `O = softmax(Q K^T / sqrt(d)) V`: the dot product of Q and K gives a '
        + 'relevance score for each pair of positions, softmax turns a row of scores into weights, and '
        + 'those weights combine the rows of V.',
        'The `sqrt(d)` divisor is not optional. A dot product sums d terms and grows with d; without the '
        + 'scaling the numbers entering softmax are too large, the exponentials spread out into a nearly '
        + 'one-hot distribution, and gradients all but vanish.',
        'A literal implementation must build the score matrix `S` first. S has shape seq × seq, meaning '
        + '**its size grows with the square of the sequence length**. At seq=128 that is 64KB; at '
        + 'seq=8192 a single head is 256MB, and multiplying by head count and batch size makes it '
        + 'impossible to hold.',
        'This is the fundamental difficulty of long context. Research has taken roughly three routes: '
        + 'sparse attention computes only some scores, linear attention reassociates the products to '
        + 'avoid the seq×seq matrix entirely, and FlashAttention keeps the full computation but '
        + '**never stores S**.'
      )
    ),
    'flash-attention': t(
      p(
        'FlashAttention 的出发点是一句朴素的观察：**S 只是中间结果，没人需要它。**'
        + '既然最终要的是 `O`，那就一边算分数、一边做 softmax、一边加权 V，算完就扔。',
        '难点在 softmax 需要整行的最大值与和，而这两个量要走完整行才知道。'
        + '在线 softmax 解决了它：维护当前的 (m, l)，见到更大的分数就把已经攒的部分'
        + '按 `exp(m_old - m_new)` 缩放一下。**输出累加器也要按同一个因子缩放** --'
        + '它和分母是在同一个 max 下算出来的，只修正一个就会算错。',
        '于是显存从 O(seq²) 降到 O(seq)：只需要几个标量寄存器，不需要任何 seq×seq 的缓冲区。'
        + '真实现还会在这之上分块：K 与 V 按块搬进共享内存，于是访存量也降下来。',
        'FlashAttention-4 在 2026 年 3 月发布，针对 Blackwell 重写。'
        + '有意思的地方在于**瓶颈换了**：tensor core 变快了而 SFU 没跟上，'
        + 'softmax 里那个指数运算变得和矩阵乘一样贵，于是要在两个 tile 之间 ping-pong，'
        + '让一块的矩阵乘和另一块的指数重叠。它也因此从 Triton 退回了 CuTe DSL --'
        + 'Blackwell 的 TMA 与 TMEM 需要 tile 级控制，Triton 的抽象暴露不出来。'
      ),
      p(
        'FlashAttention starts from a plain observation: **S is only an intermediate and nobody needs '
        + 'it**. Since the goal is `O`, compute scores, apply softmax and weight V in a single pass, '
        + 'discarding each score as soon as it has been used.',
        'The obstacle is that softmax needs the maximum and sum of the whole row, and neither is known '
        + 'until the row is finished. Online softmax solves it: keep a running (m, l) and rescale what '
        + 'has been accumulated by `exp(m_old - m_new)` whenever a larger score appears. **The output '
        + 'accumulator must be rescaled by the same factor**, since it was built under the same running '
        + 'maximum; correcting only one of them gives a wrong answer.',
        'Memory then drops from O(seq²) to O(seq): a handful of scalar registers and no seq×seq buffer '
        + 'at all. Real implementations tile on top of this, staging blocks of K and V through shared '
        + 'memory so that memory *traffic* falls as well.',
        'FlashAttention-4 shipped in March 2026, rewritten for Blackwell. The interesting part is that '
        + '**the bottleneck moved**: tensor cores got faster while the SFU did not, so the exponentials '
        + 'in softmax became as expensive as the matmuls. The kernel now ping-pongs between two tiles to '
        + 'overlap one tile\'s matmuls with the other\'s exponentials. It also moved back from Triton to '
        + 'CuTe DSL, because Blackwell\'s TMA and TMEM need tile-level control that Triton does not expose.'
      )
    ),
    'kv-cache': t(
      p(
        '自回归解码是一个一个 token 往外吐的：算出第 n 个，把它接回输入，再算第 n+1 个。'
        + '每一步都要对**前面所有位置**做注意力，也就是说每一步都需要那些位置的 k 与 v。',
        '最直白的写法是每一步重新算一遍。这在数学上没有任何问题，'
        + '同样的输入配同样的权重，投影出来当然是同一个 k。'
        + '问题在于代价：第 n 步要投影 n 个位置，跑完 N 步就是 N 平方 / 2 次投影。',
        '而自回归有一个关键性质救了这件事：**已经生成过的位置，它的 k 和 v 永远不会再变。**'
        + '因果注意力只让每个位置看它自己和它前面的，所以后面新增的 token 影响不到前面。'
        + '既然不会变，算一次存起来就行，这就是 KV cache。',
        '它把每一步的投影量从 O(n) 降到 O(1)，代价是显存。而这个代价相当可观：'
        + '一个 70B 模型在 fp16 下大约是每个 token 每层 320KB，80 层加起来 2.5MB，'
        + '一条 4K 上下文的序列光 KV cache 就要 10GB。'
        + '从这里开始，推理引擎的工程几乎全在跟这块显存较劲。'
      ),
      p(
        'Autoregressive decoding emits one token at a time: compute the nth, feed it back, compute '
        + 'the n+1th. Every step attends over **all previous positions**, so every step needs the k '
        + 'and v of those positions.',
        'The most literal implementation recomputes them each step. Mathematically nothing is wrong '
        + 'with that: the same input and the same weights obviously project to the same k. The '
        + 'problem is the cost. Step n projects n positions, so N steps cost N squared over two.',
        'One property of autoregression rescues this: **once a position has been generated, its k '
        + 'and v never change.** Causal attention lets each position see only itself and what came '
        + 'before, so later tokens cannot affect earlier ones. If they never change, compute them '
        + 'once and keep them. That is the KV cache.',
        'It takes the projection work per step from O(n) to O(1), paid for in memory, and the '
        + 'payment is steep: roughly 320KB per token per layer for a 70B model in fp16, 2.5MB '
        + 'across 80 layers, so a single 4K-context sequence needs 10GB of cache. From here on, '
        + 'almost all inference engineering is a fight over that memory.'
      )
    ),
    'paged-kv-cache': t(
      p(
        '一整片连续的 KV cache，在多条序列一起跑的时候立刻遇到一个问题：'
        + '你不知道每条序列最后会有多长。于是只能按最坏情况预留，'
        + '每条序列都按最长上下文划一片，而真实负载的长度差别极大，'
        + '一条 5 个 token 的请求占着 4096 个位置的地方，浪费掉 99.9%。',
        '操作系统三十年前就解决过同一个问题：分页。'
        + '把显存切成固定大小的块，序列需要了才给一块，用完还回去。'
        + '序列在物理上不再连续，靠一张块表记录「逻辑第 b 块在物理第几块」。'
        + 'attention kernel 因此要多做一次间接寻址，'
        + '真实的 vLLM paged attention kernel 收的 block_tables 参数就是这张表。',
        '效果在 vLLM 的论文里有数字：显存浪费从 60 到 80 个百分点降到 4 以下，'
        + '同样一张卡能同时装下的序列数翻了好几倍。'
        + '值得注意的是吞吐的提升主要来自这里，不是来自 kernel 变快 --'
        + '装得下更多序列，批就更大，GPU 才不至于在解码时闲着。',
        '分页还顺手带来一件事：块可以共享。几个请求用同一个系统提示词时，'
        + '那部分的块表可以指向同一批物理块，一份 KV 服务所有请求，'
        + '再配上写时复制就是前缀缓存。'
        + '代价和操作系统一样是一次间接寻址，所以块大小是取舍：'
        + '太小则块表变长、间接开销占比高，太大则最后一块的内部碎片变大。'
      ),
      p(
        'One contiguous KV cache hits a problem the moment several sequences run together: you do '
        + 'not know how long each will end up. So you reserve for the worst case, a full '
        + 'max-context slab per sequence. Real workloads vary enormously in length, so a five-token '
        + 'request holding 4096 positions wastes 99.9% of them.',
        'Operating systems solved this thirty years ago with paging. Cut memory into fixed-size '
        + 'blocks, hand one out when a sequence needs it, take it back when it finishes. Sequences '
        + 'are no longer physically contiguous, so a block table records which physical block holds '
        + 'logical block b, and the attention kernel does one extra indirection. That table is '
        + 'exactly the block_tables argument the real vLLM paged attention kernel takes.',
        'The vLLM paper puts numbers on it: memory waste falls from 60 to 80 percent down to under '
        + '4, so a single card holds several times as many concurrent sequences. Note where the '
        + 'throughput comes from: not faster kernels, but bigger batches, because fitting more '
        + 'sequences is what keeps the GPU from idling during decode.',
        'Paging brings something else along: blocks can be shared. When requests share a system '
        + 'prompt, their block tables can point at the same physical blocks, one copy of the KV '
        + 'serving everyone, and copy-on-write turns that into prefix caching. The cost is the same '
        + 'one operating systems pay, an indirection, so block size is a trade: too small and the '
        + 'table grows while indirection dominates, too large and the last block wastes more.'
      )
    ),
    'quantization': t(
      p(
        '量化是拿精度换显存与带宽。把 KV cache 从 fp32 换成 fp8，'
        + '显存降到四分之一，读它的带宽也降到四分之一 --'
        + '而解码本来就是访存受限的，所以这一步同时省显存和提吞吐。',
        '难的不是格式转换，是 scale。fp8 的 E4M3 只覆盖不到 19 个二进制数量级，'
        + '所以必须先乘一个 scale 把数搬进这个范围。'
        + 'scale 怎么定，决定了量化是几乎无损还是彻底毁掉。',
        'SmoothQuant 给了最直白的算法：设通道 i 的最大值是 mi、整个矩阵的最大值是 m，'
        + '那么通道 i 实际用得上的量化格点数就是 2 的 8 次方乘以 mi 除以 m。'
        + '真实激活里离群通道能比正常通道大一百倍，于是正常通道在 256 个格点里'
        + '只剩两三个。而《Massive Activations》在 LLaMA2-7B 上量到的最大激活值是 2622、'
        + '中位数 0.2，差一万倍，那时候正常值连一个格点都分不到，直接归零。',
        '解法是把 scale 的粒度做细：每若干个元素一个 scale，'
        + '离群值被关进它自己那一小块，别的块不受影响。'
        + '为什么不干脆每个通道一个 scale？因为那和 GEMM kernel 不兼容 --'
        + 'scale 必须能在归约维度上提出来。'
        + '整条 microscaling 硬件路线（NVFP4 每 16 个元素一个 scale、MXFP4 每 32 个）'
        + '就是为了让硬件原生支持这件事。'
      ),
      p(
        'Quantisation trades accuracy for memory and bandwidth. Moving the KV cache from fp32 to '
        + 'fp8 cuts memory to a quarter and cuts the bandwidth needed to read it by the same factor. '
        + 'Decoding is memory-bound to begin with, so this saves memory and raises throughput at once.',
        'The hard part is not the format conversion, it is the scale. fp8 E4M3 covers under 19 '
        + 'binary orders of magnitude, so values must be multiplied by a scale to land inside that '
        + 'range. How that scale is chosen decides whether quantisation is nearly lossless or '
        + 'completely destructive.',
        'SmoothQuant gives the cleanest arithmetic: if channel i has maximum mi and the whole matrix '
        + 'has maximum m, the effective number of levels available to channel i is 2 to the 8th '
        + 'times mi over m. Real activations have outlier channels a hundred times larger than the '
        + 'rest, leaving normal channels two or three of the 256 levels. Massive Activations '
        + 'measured a maximum of 2622 against a median of 0.2 in LLaMA2-7B, a factor of ten '
        + 'thousand, at which point normal values do not get a single level and go straight to zero.',
        'The fix is finer scale granularity: one scale per small group of elements, so an outlier '
        + 'is confined to its own group and the rest are untouched. Why not one scale per channel? '
        + 'Because that is incompatible with GEMM kernels, where the scale has to factor out along '
        + 'the reduction dimension. The whole microscaling hardware line, NVFP4 with one scale per '
        + '16 elements and MXFP4 per 32, exists so hardware can do this natively.'
      )
    ),
    'cuda-graph': t(
      p(
        '解码的处境很特别：每一步只算一个 token，计算量极小，'
        + '而要起的 kernel 不少，真实的一层 Transformer 有几十个，80 层就是上千个。'
        + '真卡上每次提交有几微秒的固定开销，于是提交本身成了瓶颈，'
        + 'GPU 大部分时间在等下一个 kernel 被交上来。',
        'CUDA Graph 把一串 launch 录下来，之后一次性提交。'
        + '省下来的纯粹是提交开销，kernel 该干的活一点没少，'
        + 'block 数、FMA 数全都不变。'
        + '这也解释了它为什么对预填充几乎没用：'
        + '一次算几千个 token 时每个 kernel 本来就跑很久，几微秒可以忽略。'
        + 'CUDA Graph 是解码专属的优化。',
        '用起来有一个硬约束：图录下来的是**捕获那一刻的实参值**。'
        + '指针是稳定的地址，重放没问题；而按值传的标量录下来就定死了。'
        + '所以真实引擎会把所有随步数变化的量都做成显存里的值，'
        + '让 kernel 从指针读，序列长度、批里每条序列的状态，全都如此。',
        '还有一个后果值得留意：图是按形状固定的。'
        + '批大小变了、序列长度跨过某个桶了，就得换一张图。'
        + '于是引擎预先为若干个批大小各捕获一张，运行时挑最接近的、'
        + '把多余的位置填成 padding。'
        + '你看到连续批处理的批大小往往是几个固定档位而不是任意数，原因就在这里。'
      ),
      p(
        'Decoding is peculiar: each step computes a single token, almost no work, across quite a '
        + 'few kernels. A real Transformer layer has dozens, and eighty layers means thousands. On '
        + 'real hardware each submission costs a few microseconds of fixed overhead, so submission '
        + 'becomes the bottleneck and the GPU spends most of its time waiting for more work.',
        'CUDA Graphs record a run of launches and submit them in one go. What is saved is purely '
        + 'the submission overhead: the kernels do the same work, the same blocks, the same FMAs. '
        + 'That also explains why graphs do almost nothing for prefill, where each kernel already '
        + 'runs a long time and microseconds are noise. Graphs are a decode-side optimisation.',
        'There is one hard constraint. A graph records the argument values **at capture time**. '
        + 'Pointers are stable addresses so replay is fine, but a scalar passed by value is frozen. '
        + 'Real engines therefore make every step-varying quantity device-resident and have kernels '
        + 'read it through a pointer: sequence lengths, per-sequence state in the batch, all of it.',
        'One more consequence is worth noticing: graphs are fixed by shape. Change the batch size, '
        + 'or cross a sequence-length bucket, and you need a different graph. So engines capture one '
        + 'per batch size ahead of time and pick the nearest at runtime, padding the unused slots. '
        + 'That is why continuous batching tends to use a handful of fixed batch sizes rather than '
        + 'arbitrary ones.'
      )
    ),
    'continuous-batching': t(
      p(
        'GPU 喜欢大批量，可是解码时每条序列的长度差别极大：'
        + '有的两个 token 就结束，有的要生成几百个。'
        + '朴素的静态批是凑够一批一起跑、等全部结束再收下一批 --'
        + '于是短的那条跑完之后，它的槽位要空转到最长那条结束为止。'
        + '空转不是免费的：padding 的槽位在真卡上照样占着计算资源走完一遍。',
        '连续批处理的做法很简单：不等整批结束，哪个槽位空了就立刻从队列里'
        + '取下一个请求塞进去。批是流动的，不是一批一批的。'
        + 'Orca 那篇论文（OSDI 2022）提出了它，现在 vLLM、TensorRT-LLM、SGLang '
        + '全都是这么做的，TensorRT-LLM 管它叫 in-flight batching。',
        '它和分页 KV 是一对：连续批处理让批一直是满的，分页 KV 让满的批装得下。'
        + '没有分页，每条序列按最长上下文预留显存，同时能装的序列数很少，'
        + '连续批处理也就没多少可调度的余地。两件事是一起起作用的。',
        '真实调度器要处理的比这多得多：预填充和解码要不要混在同一批里、'
        + '显存不够时抢占谁、怎么不让长请求被饿死、'
        + '以及批大小只能是 CUDA Graph 预先捕获过的那几档 --'
        + '所以调度器挑的往往不是最优的批，而是最接近某一档的批。'
        + '还有一件量不出来但很重要的事：连续批处理改善的是吞吐，'
        + '对单个请求的延迟可能是负面的，因为你的请求要和更多别人的挤在一起。'
        + '生产里因此同时盯首 token 时延与每 token 时延，而不是只看吞吐。'
      ),
      p(
        'GPUs like big batches, but decoding sequence lengths vary enormously: some finish in two '
        + 'tokens, some generate hundreds. Naive static batching gathers a batch, runs it, and waits '
        + 'for all of it before taking the next, so once the short sequence finishes its slot idles '
        + 'until the longest one is done. Idling is not free: a padded slot still occupies compute on '
        + 'real hardware for the whole step.',
        'Continuous batching is simple: do not wait for the batch; the moment a slot frees, pull the '
        + 'next request from the queue into it. The batch flows rather than proceeding in lockstep. '
        + 'The Orca paper (OSDI 2022) introduced it and vLLM, TensorRT-LLM and SGLang all work this '
        + 'way now, with TensorRT-LLM calling it in-flight batching.',
        'It pairs with paged KV: continuous batching keeps the batch full, paging makes a full batch '
        + 'fit. Without paging each sequence reserves memory for its maximum context, few fit at '
        + 'once, and there is little left to schedule. The two work together.',
        'Real schedulers handle far more: whether to mix prefill and decode in one batch, whom to '
        + 'preempt when memory runs out, how to keep long requests from starving, and the fact that '
        + 'batch sizes must be ones a CUDA Graph was captured for, so the scheduler usually picks '
        + 'not the optimal batch but the one nearest a captured size. One more thing that is hard to '
        + 'measure but matters: continuous batching improves throughput and can hurt an individual '
        + 'request latency, since your request now shares the GPU with more of everyone else. '
        + 'Production systems therefore watch time to first token and time per output token '
        + 'alongside throughput, not throughput alone.'
      )
    ),
    'ring-allreduce': t(
      p(
        '数据并行的每一步都要做一次 all-reduce：每张卡各算出一份梯度，'
        + '加起来，人人都要拿到这个和。'
        + '最直白的做法是全都发给 0 号卡、加完再广播回去 --'
        + '结果对，但 0 号卡成了瓶颈，它一张卡要过 2(n-1) 份的量，'
        + '别的卡只过 2 份。',
        'ring all-reduce 把缓冲区切成 n 块，分两个阶段各走 n-1 步。'
        + '第一阶段每张卡把某一块发给右邻居、把收到的加进自己的，'
        + '走完之后每张卡手上有一块完整的和；'
        + '第二阶段再转一圈，把这 n 块和分给所有人。'
        + '每一步只搬一块，所以每张卡搬的总量是 2(n-1)/n 个缓冲区。',
        '有一件事值得盯着看：ring 并没有减少搬运的总量。'
        + '朴素版搬多少字节，ring 就搬多少字节，一个不差。'
        + '差别全在分布，朴素版把这些字节全压在 0 号卡的端口上，'
        + 'ring 让每张卡各扛一份。瓶颈的差距是 n 除以 2，卡越多差得越远。',
        '代价也看得见：消息数涨了 n 倍。每条消息都有固定开销，'
        + '所以缓冲区小的时候 ring 反而更慢 --'
        + '这正是 NCCL 对小消息改用 tree 算法的原因，'
        + '它会按消息大小、卡数、拓扑自动选算法。'
        + '而 2(n-1)/n 这个数就是 nccl-tests 里 all-reduce 的 busbw 修正因子：'
        + '算法带宽是用户视角，总线带宽才反映硬件实际搬了多少。'
      ),
      p(
        'Every step of data parallelism needs an all-reduce: each GPU computes its own gradients, '
        + 'they are summed, and everyone needs the sum. The obvious approach sends everything to '
        + 'GPU 0, which sums and broadcasts back. The result is right, but GPU 0 becomes the '
        + 'bottleneck, moving 2(n-1) buffers through its own port while every other GPU moves two.',
        'Ring all-reduce splits the buffer into n chunks across two phases of n-1 steps. In the '
        + 'first, each GPU sends one chunk to its right neighbour and adds what arrives, so that '
        + 'afterwards every GPU holds one fully reduced chunk. In the second, those n chunks are '
        + 'passed around so everyone has all of them. Each step moves one chunk, so each GPU moves '
        + '2(n-1)/n buffers in total.',
        'One thing is worth staring at: the ring does not reduce the total bytes moved. It moves '
        + 'exactly as many as the naive version. The difference is entirely distribution: the naive '
        + 'version puts all of it through GPU 0, the ring gives every GPU a share. The bottleneck '
        + 'improves by n over two, and that grows with the cluster.',
        'The cost is visible too: n times as many messages. Every message carries fixed overhead, so '
        + 'for small buffers the ring is actually slower, which is why NCCL switches to tree '
        + 'algorithms there and picks an algorithm from message size, GPU count and topology. And '
        + '2(n-1)/n is the busbw correction factor for all-reduce in nccl-tests: algorithm bandwidth '
        + 'is the user view, bus bandwidth is what the hardware actually moved.'
      )
    ),
    'nccl-data-parallel': t(
      p(
        '数据并行是最简单的并行策略：每张卡放一份完整的模型、喂不同的数据，'
        + '反向传播之后把梯度加起来，人人都拿到同一个和，再各自更新。'
        + '加梯度这一步就是 all-reduce，真实工程里用 NCCL 做。',
        'NCCL 的调用是流序异步的，不是同步返回的函数。'
        + '单线程管多张卡时必须用 group 语义：把所有卡的调用夹在 '
        + 'ncclGroupStart 与 ncclGroupEnd 之间一起发。'
        + '因为每个 NCCL 调用都可能阻塞在等对端上，不成组就会死锁 --'
        + '这一条 NVIDIA 的文档里明写着。',
        '真正的性能问题在别处。一个模型有几十上百层，'
        + '每层的梯度大小差别极大：有的几百万个参数，有的只有几个偏置。'
        + '为几个 float 发一次 all-reduce，等于为几十字节的数据付一整套 ring '
        + '的固定开销。解法是分桶：把连续的层攒到一定大小再发一次。',
        'PyTorch 的 DDP 默认就这么做，桶大小默认 25 MiB。'
        + '还有一个更妙的细节：DDP 是按参数的反向顺序分桶的。'
        + '因为反向传播从最后一层往前算，最后一层的梯度最先就绪；'
        + '按反向顺序分桶，第一个桶在反向刚开始不久就能发出去，'
        + '于是通信和剩下的反向计算重叠了起来。'
        + '值得注意的是分桶前后搬运的总字节数一个不差，'
        + '省的全是每消息的固定开销，通信优化几乎从来不是少搬点数据。'
      ),
      p(
        'Data parallelism is the simplest strategy: every GPU holds a full copy of the model, is fed '
        + 'different data, and after backpropagation the gradients are summed so everyone has the '
        + 'same total before updating. Summing them is an all-reduce, done with NCCL in practice.',
        'NCCL calls are stream-ordered and asynchronous, not synchronous functions. With one thread '
        + 'driving several GPUs, group semantics are mandatory: put every GPU call between '
        + 'ncclGroupStart and ncclGroupEnd. Each NCCL call can block waiting on a peer, so without '
        + 'grouping you deadlock, and NVIDIA documents this explicitly.',
        'The real performance problem is elsewhere. A model has dozens or hundreds of layers whose '
        + 'gradients vary enormously: millions of parameters in some, a handful of biases in others. '
        + 'Issuing an all-reduce for a few floats means paying a full ring of fixed overhead to move '
        + 'a few dozen bytes. The fix is bucketing: batch consecutive layers up to a size and send '
        + 'once.',
        'PyTorch DDP does this by default with a 25 MiB bucket. There is a neater detail too: DDP '
        + 'buckets in reverse parameter order, because backpropagation runs from the last layer '
        + 'backwards and the last layer is ready first. In reverse order the first bucket can go out '
        + 'shortly after backward starts, overlapping communication with the rest of the backward '
        + 'pass. Note that bucketing moves exactly the same total bytes; all it saves is per-message '
        + 'overhead. Communication optimisation is almost never about moving less data.'
      )
    ),
    'tensor-parallel': t(
      p(
        '模型大到一张卡放不下时，就得把单个权重矩阵切开放到多张卡上。'
        + '切法有讲究：一个前馈层是两次矩阵乘，'
        + '第一次按列切（每张卡算出中间结果的一竖条，各算各的、不需要通信），'
        + '第二次按行切（每张卡拿自己那一竖条乘对应的横条，得到一个部分和）。'
        + '所有部分和加起来才是答案，这需要一次 all-reduce。',
        '关键在于列并行的输出形状正好是行并行想要的输入形状。'
        + '于是一整层只需要末尾一次通信。'
        + '换成先行后列，中间就得凑一次，一层要两次 all-reduce --'
        + 'Megatron-LM 那篇论文最核心的设计就是这个顺序。'
        + '注意力层是同一个套路：QKV 投影按头切等价于列并行，输出投影按行切。',
        '张量并行的通信频率极高。数据并行一步只 all-reduce 一次，'
        + '而张量并行一个 Transformer 层就要两次（注意力一次、前馈一次），'
        + '反向再两次，80 层的模型每步就是 320 次集合操作。'
        + '这个频率决定了它对延迟极其敏感，也决定了它不能跨机。',
        '机内的 NVLink 和跨机的 InfiniBand 带宽差将近一个数量级，延迟差三倍。'
        + '所以现实中的并行策略是分层的：张量并行只在机内，'
        + '流水线并行跨机（每级之间只传一次激活），'
        + '数据并行在最外层（每步一次 all-reduce，频率最低）。'
        + '这几个维度的排布顺序，几乎完全由「这一维通信多频繁」决定。'
      ),
      p(
        'When a model no longer fits on one GPU, individual weight matrices get split across GPUs, '
        + 'and how you split them matters. A feed-forward layer is two matmuls: split the first by '
        + 'columns (each GPU computes a vertical strip of the intermediate, independently, with no '
        + 'communication) and the second by rows (each GPU multiplies its strip by the matching '
        + 'horizontal strip and gets a partial sum). Summing the partials needs one all-reduce.',
        'The key is that column-parallel output has exactly the shape row-parallel wants as input, '
        + 'so a whole layer needs one collective at the end. Row-then-column would need one in the '
        + 'middle as well, two per layer. That ordering is the core design of the Megatron-LM paper. '
        + 'Attention follows the same pattern: splitting QKV by head is equivalent to column '
        + 'parallel, and the output projection splits by row.',
        'Tensor parallelism communicates extremely often. Data parallelism all-reduces once per '
        + 'step; tensor parallelism does it twice per Transformer layer (attention, feed-forward) '
        + 'plus twice more in backward, so an 80-layer model issues 320 collectives per step. That '
        + 'frequency makes it acutely latency-sensitive, and it is why it cannot span nodes.',
        'In-node NVLink and cross-node InfiniBand differ by nearly an order of magnitude in '
        + 'bandwidth and threefold in latency. Real parallel strategies are therefore layered: '
        + 'tensor parallelism stays in-node, pipeline parallelism goes across nodes (one activation '
        + 'transfer per stage boundary), and data parallelism sits outermost with one all-reduce per '
        + 'step. The ordering of these dimensions is decided almost entirely by how often each one '
        + 'communicates.'
      )
    ),
    'sequence-parallel': t(
      p(
        '张量并行只切了矩阵乘，矩阵乘之间的那些算子没切 --'
        + 'LayerNorm、dropout、残差加，这些逐元素的操作在每张卡上都是'
        + '在完整的激活上重复做一遍。重复计算还是小事，'
        + '真正贵的是激活要留着给反向用：几十层的模型，'
        + '每张卡都得存几十份完整的激活。',
        '序列并行的做法很直接：既然这些算子是逐元素的，'
        + '那就按序列维度切开，每张卡只做 1/n、只存 1/n。'
        + '有意思的是通信怎么接。张量并行末尾的 all-reduce 之后每张卡都有完整的结果，'
        + '而序列并行只想要 1/n，这两件事合起来正好是一次 reduce-scatter；'
        + '等到下一个矩阵乘需要完整输入时，再用 all-gather 凑回来。',
        '关键在于 reduce-scatter 加 all-gather 的通信量和一次 all-reduce 完全相同。'
        + 'ring all-reduce 本来就是这两个阶段拼起来的，各占 (n-1)/n，'
        + '加起来正好 2(n-1)/n。所以序列并行是白拿的：'
        + '通信一个字节不多，激活显存降到 1/n，逐元素的计算也降到 1/n。',
        '值得体会的是这一关和前几关的对照。手写 ring 是把通信量摊开、'
        + '梯度分桶是把消息数降下来、序列并行是通信完全不动而换来显存与计算 --'
        + '三次优化，通信总量一次都没降。这不是巧合：'
        + '集合通信的总量由算法的语义定死了，能动的只有分布、粒度、'
        + '以及用哪个集合操作把它接到别的优化上。'
      ),
      p(
        'Tensor parallelism splits only the matmuls; the operators between them are not split. '
        + 'LayerNorm, dropout and the residual add are repeated on the full activation by every GPU. '
        + 'The repeated compute is the smaller problem. The expensive part is that activations are '
        + 'kept for the backward pass, so a model with dozens of layers stores dozens of full '
        + 'activations per GPU.',
        'Sequence parallelism is direct about it: since those operators are elementwise, split them '
        + 'along the sequence so each GPU does and stores 1/n. The interesting part is how the '
        + 'communication connects. After tensor parallelism\'s all-reduce every GPU has the whole '
        + 'result while sequence parallelism wants only 1/n, and those two together are exactly a '
        + 'reduce-scatter. When the next matmul needs the full tensor, an all-gather reassembles it.',
        'The key is that reduce-scatter plus all-gather costs exactly as much as one all-reduce. A '
        + 'ring all-reduce is those two phases stitched together, each costing (n-1)/n, together '
        + '2(n-1)/n. So sequence parallelism is free: not one extra byte of communication, '
        + 'activation memory down to 1/n, elementwise compute down to 1/n.',
        'The contrast with earlier stages is worth sitting with. Hand-written ring spreads the '
        + 'communication out, gradient bucketing reduces the message count, and sequence parallelism '
        + 'leaves communication untouched while buying memory and compute. Three optimisations and '
        + 'the total volume never dropped once. That is not a coincidence: the volume of a '
        + 'collective is fixed by its semantics. What you can change is the distribution, the '
        + 'granularity, and which collective connects it to another optimisation.'
      )
    ),
    'pipeline-parallel': t(
      p(
        '张量并行只能在机内，模型再大就得按层切：每台机器负责几层，'
        + '激活像流水线一样一级一级往前传。'
        + '问题是流水线要填满才满负荷，第一个 microbatch 走到最后一级之前，'
        + '后面的级都闲着；最后一个 microbatch 走完之前，前面的级也闲着。'
        + '这段空转叫气泡。',
        'GPipe 的排程是把所有 microbatch 的前向做完，再全部做反向。'
        + '这有两个代价：前向流水线要完全排空才开始反向，'
        + '于是填充与排空各付了两次；而且每一级要同时存下所有 microbatch 的激活，'
        + '因为每一份都得留到它自己的反向。',
        '1F1B 把这两件事一起解决。它让每一级热身若干次前向之后进入稳态，'
        + '在稳态里前向反向交替、一步只做一件事。'
        + '操作总数一件不多一件不少，变的只是顺序。'
        + '流水线因此不再排空，气泡少一半；'
        + '而且反向紧跟着前向，一份激活用完就能立刻复用，'
        + '每级只需要与级数相当的槽位，而不是与 microbatch 数相当。',
        '再往下还有 interleaved 1F1B：把每台机器负责的层拆成几段不连续的，'
        + '一台机器在流水线里出现多次，级数翻倍而气泡进一步下降，代价是通信次数成倍增加。'
        + '还有 zero-bubble 的路子：把反向拆成算输入梯度与算权重梯度两半，'
        + '后者不阻塞流水线、可以填进气泡里。'
        + '这些都建立在同一个观察上，气泡是排程问题，不是带宽问题。'
      ),
      p(
        'Tensor parallelism has to stay in-node, so larger models get split by layer: each machine '
        + 'owns a few layers and activations flow through like a pipeline. The catch is that a '
        + 'pipeline has to fill before it runs at capacity. Until the first microbatch reaches the '
        + 'last stage the later stages sit idle, and until the last microbatch finishes the earlier '
        + 'stages sit idle. That idleness is the bubble.',
        'GPipe schedules all forwards first, then all backwards. That costs twice: the forward '
        + 'pipeline drains completely before backward begins, so fill and drain are each paid twice, '
        + 'and every stage holds the activations of all microbatches at once, since each must '
        + 'survive until its own backward.',
        '1F1B fixes both. Each stage warms up with some forwards and then enters a steady state '
        + 'alternating forward and backward, one operation per step. The number of operations is '
        + 'unchanged; only the order differs. The pipeline never drains, roughly halving the bubble, '
        + 'and because each backward closely follows its forward an activation can be reused as soon '
        + 'as it is consumed, so a stage needs about as many slots as there are stages rather than '
        + 'as many as there are microbatches.',
        'Beyond this lies interleaved 1F1B, splitting each machine into several non-contiguous '
        + 'chunks so it appears in the pipeline more than once, multiplying the stage count and '
        + 'shrinking the bubble further at the cost of proportionally more transfers. There is also '
        + 'the zero-bubble line, splitting backward into input gradients and weight gradients where '
        + 'the latter does not block the pipeline and can be dropped into the bubbles. All of them '
        + 'rest on the same observation: the bubble is a scheduling problem, not a bandwidth one.'
      )
    ),
    'comm-compute-overlap': t(
      p(
        '先算完再发，是分布式训练里最自然也最浪费的写法：'
        + '反向传播的整段时间里通信链路完全闲着，'
        + 'all-reduce 的整段时间里计算单元又完全闲着。'
        + '两件事本来可以同时做。',
        '做法是分块加多流。把梯度分成若干块，每算完一块就立刻发出去，'
        + '同时接着算下一块。计算挂在一个流上、通信在另一个流上 --'
        + '同一个流上是严格串行的，放在一起等于没重叠，'
        + '而代码看起来完全像是重叠了。这是这类优化里最常见的假重叠。',
        '重叠是「不改变工作量、只改变时间安排」这一类优化里最纯粹的一个：'
        + '通信总量不变、消息数不变、计算量不变，变的只是发起的时机。'
        + '真实系统里它无处不在，DDP 按反向顺序分桶、'
        + 'ZeRO-3 在用到某层权重之前就把它取回来、'
        + '流水线并行里一级的通信和另一级的计算天然重叠。',
        '重叠的上限由两件事定死：通信时间与计算时间的比值，'
        + '以及依赖链允许你提前多久发出去。'
        + '如果通信本来就比计算长，重叠再好也只是把计算藏进通信里，'
        + '总时间还是通信时间，这时候该做的是降低通信本身。'
        + '所以真实调优的顺序通常是先量通信与计算的比值，'
        + '比值小于一才值得花力气做重叠。'
      ),
      p(
        'Computing everything before sending anything is the most natural and most wasteful shape in '
        + 'distributed training: the links idle through the whole backward pass, and the compute '
        + 'units idle through the whole all-reduce. Both could be happening at once.',
        'The technique is chunking plus multiple streams. Split the gradients, send each chunk as '
        + 'soon as it is computed, and keep computing the next one meanwhile. Put the compute on one '
        + 'stream and the communication on another, because a single stream is strictly serial and '
        + 'putting both on it overlaps nothing while the code looks exactly as though it does. That '
        + 'is the most common false overlap in this kind of work.',
        'Overlap is the purest member of the "same work, different schedule" family: same total '
        + 'bytes, same message count, same computation, only the timing of the issue changes. Real '
        + 'systems overlap everywhere, from DDP bucketing in reverse order, to ZeRO-3 fetching a '
        + 'layer weights before they are needed, to pipeline parallelism where one stage '
        + 'communication naturally covers another stage compute.',
        'Two things cap what overlap can buy: the ratio of communication time to compute time, and '
        + 'how far ahead the dependency chain lets you issue. If communication already takes longer '
        + 'than compute, perfect overlap merely hides the compute inside it and the total is still '
        + 'the communication time, at which point the thing to do is reduce communication itself. '
        + 'Real tuning therefore starts by measuring that ratio and only invests in overlap when it '
        + 'is below one.'
      )
    ),
    'expert-parallel': t(
      p(
        'MoE 把前馈层换成一组专家，每个 token 只走其中一两个。'
        + '参数量涨几十倍而每个 token 的计算量几乎没变 --'
        + '这是 2026 年大模型几乎清一色用 MoE 的原因。'
        + '专家并行把这些专家摊到多张卡上，token 按路由结果被发到对应的卡上算、'
        + '算完再收回来，这一去一回就是两次 all-to-all。',
        '命门在路由。路由器学出来的分布从来不均匀，'
        + '几个热门专家吃掉大半 token，冷门的只收到零星几个。'
        + '而一步的时间由最慢的那张卡决定 --'
        + '于是冷门专家所在的卡大部分时间在等，整机算力用不出来。',
        '推理侧的标准解法是容量因子加重路由：给每个专家设一个上限，'
        + '超出的 token 改投当前最闲的。'
        + '容量因子设多大是个真实的取舍，太小则重路由太多、token 走错专家、质量下降，'
        + '太大则不均度压不下来。'
        + '早期的做法是直接丢掉超出的 token，现在主流是 drop-less，把它们重路由出去。',
        '训练侧则是加一个辅助的负载均衡损失，逼路由器分匀一些 --'
        + '代价是它和主损失打架，分得太匀路由就失去了专家各有所长的意义。'
        + 'DeepSeek 后来改用无辅助损失的做法，给每个专家一个按历史负载动态调整的偏置、不进梯度。'
        + '还有一条是专家放置：既然路由分布长期稳定，'
        + '那就把热门专家复制到多张卡、冷门专家几个挤一张卡。'
        + '通信这一侧同样棘手，MoE 的 all-to-all 是稀疏且不规则的，'
        + '每张卡发给别的卡的量都不一样而且每步都在变。'
      ),
      p(
        'MoE replaces the feed-forward layer with a set of experts, each token visiting only one or '
        + 'two. Parameters grow by tens of times while per-token compute barely moves, which is why '
        + 'nearly every large model in 2026 is an MoE. Expert parallelism spreads the experts across '
        + 'GPUs, dispatching tokens to whichever GPU holds their expert and combining the results '
        + 'back, a round trip of two all-to-alls.',
        'The weak point is the routing. A learned router is never uniform: a few popular experts take '
        + 'most of the tokens while others get a handful. Since a step takes as long as the slowest '
        + 'GPU, the ones holding cold experts spend most of their time waiting and the machine '
        + 'delivers a fraction of its compute.',
        'At inference the standard fix is a capacity factor plus rerouting: cap each expert and send '
        + 'overflow to whichever is least loaded. Choosing the factor is a real trade, since too '
        + 'small reroutes too many tokens to the wrong expert and hurts quality, while too large '
        + 'leaves the imbalance in place. Early systems simply dropped the overflow; the mainstream '
        + 'now is drop-less rerouting.',
        'In training the usual answer is an auxiliary load-balancing loss pushing the router toward '
        + 'uniformity, which fights the main loss, because perfect balance destroys the '
        + 'specialisation that made experts worth having. DeepSeek later moved to an '
        + 'auxiliary-loss-free scheme with a per-expert bias adjusted from observed load and kept out '
        + 'of the gradient. Another angle is expert placement: since the distribution is stable over '
        + 'time, replicate hot experts and pack cold ones together. The communication side is equally '
        + 'awkward, since MoE all-to-all is sparse and irregular, with every GPU sending a different '
        + 'amount to every other and the pattern changing each step.'
      )
    ),
    'disaggregated-serving': t(
      p(
        'prefill 与 decode 是两种完全不同的负载。'
        + 'prefill 一次算几千个 token，受限于算力，本来就把 GPU 喂饱了；'
        + 'decode 一次只算一个 token，受限于访存与提交开销，批越大越好。'
        + '混在一起跑两边都被拖累：一个大 prefill 插进来，'
        + '所有正在 decode 的请求都要等它算完 --'
        + '这就是首 token 时延好看而每 token 时延发抖的来源。',
        '所以生产里把它们分到不同的卡上，prefill 完的 KV cache 传给 decode 那一侧接着跑。'
        + '最大的好处不是吞吐，而是两条 SLO 可以分开调：'
        + 'prefill 集群按首 token 时延调，decode 集群按每 token 时延调，'
        + '两边的批大小、并行策略、甚至卡型都可以不一样。'
        + '代价是 KV cache 要跨卡传，一条长上下文的 KV 可能有好几个 GB，'
        + '传它的时间可能比 prefill 本身还长 --'
        + '所以真实系统会走 NVLink 而不是网络、一边 prefill 一边分层传、'
        + '以及把 KV 量化到 fp8 再传。',
        '容错这一侧，几百上千张卡跑上几个月，掉一张是常态而不是意外。'
        + '一张卡掉出总线之后，对它的所有调用都返回错误 --'
        + '不检查返回值的话，下一次起 kernel 就直接崩。'
        + '发现之后要做的是把请求转移到还活着的卡上，而不是跳过它：'
        + '容错的意思是转移，不是放弃。'
        + '也不能全都压给同一张备用卡，那只是把瓶颈换了个位置。',
        '值得对比的是训练侧的容错难得多。推理的请求是无状态的，转走就行；'
        + '训练的整个集群共享一份同步的状态，掉一张卡意味着整步作废、'
        + '得从检查点恢复。所以训练侧的功夫花在检查点写得多快、'
        + '以及能不能只重算掉的那一部分上。'
      ),
      p(
        'Prefill and decode are entirely different workloads. Prefill computes thousands of tokens '
        + 'at once, is compute-bound, and already saturates the GPU; decode computes one token, is '
        + 'bound by memory and launch overhead, and wants the largest batch it can get. Run together '
        + 'both suffer, because one large prefill forces every decoding request to wait for it. That '
        + 'is where good time-to-first-token with jittery time-per-output-token comes from.',
        'Production therefore splits them across GPUs, handing the finished KV cache to the decode '
        + 'side. The biggest benefit is not throughput but that the two SLOs can be tuned '
        + 'separately, with different batch sizes, parallel strategies and even GPU models on each '
        + 'side. The cost is moving the KV cache between GPUs: a long-context sequence can carry '
        + 'several GB and transferring it can take longer than the prefill itself, so real systems '
        + 'move it over NVLink rather than the network, stream it layer by layer as prefill '
        + 'proceeds, and quantise it to fp8 first.',
        'On the fault-tolerance side, run hundreds or thousands of GPUs for months and losing one is '
        + 'routine rather than exceptional. Once a GPU falls off the bus every call to it returns an '
        + 'error, and without checking return values the next launch simply crashes. The response is '
        + 'to migrate the request to a live GPU rather than skip it: fault tolerance means migrating, '
        + 'not abandoning. Nor should everything pile onto one spare, which just moves the bottleneck.',
        'Training fault tolerance is much harder by comparison. Inference requests are stateless and '
        + 'can be moved; a training cluster shares synchronised state, so losing one GPU invalidates '
        + 'the step and requires recovering from a checkpoint. Effort there goes into how fast '
        + 'checkpoints can be written and whether only the lost portion can be recomputed.'
      )
    ),
  },

  'intranet-k8s': {
    'first-workload': t(
      p(
        '直接创建 `Pod` 很少见，因为它不会自愈：节点挂了它就没了。日常用的是 `Deployment`，你声明「要三个这样的副本」，它建一个 `ReplicaSet`，ReplicaSet 负责让 Pod 的数量始终等于三。改了镜像版本，Deployment 会新建一个 ReplicaSet 并逐步把流量从旧的挪过去，这就是`滚动更新`。',
        '`标签`（label）是这套机制的粘合剂。ReplicaSet 靠 `selector` 认领属于自己的 Pod，Pod 靠 `metadata.labels` 表明身份。两边对不上，ReplicaSet 就会以为一个 Pod 都没有，于是不停地建新的。',
        '`Service` 是集群内部的稳定入口。Pod 的 IP 随时会变（重建一次就换一个），Service 有一个固定的 ClusterIP 和一个 DNS 名字。它同样靠 `selector` 找后端，匹配到的 Pod 地址被写进一个叫 `Endpoints` 的对象里，转发时就查这张表。',
        '于是有一种很典型的故障：Pod 全部 Running，Service 也有 ClusterIP，但访问不通。原因是 Service 的 selector 和 Pod 的标签对不上，Endpoints 是空的。`kubectl get svc` 看不出这件事，`kubectl get endpoints` 一眼就能看出来。这是排查「服务不通」时该敲的第一条命令。'
      ),
      p(
        'Creating a `Pod` directly is rare because a bare pod does not heal: if its node dies, it is gone. Day to day you use a `Deployment`. You declare "I want three replicas like this", it creates a `ReplicaSet`, and the ReplicaSet keeps the pod count at three. Change the image version and the Deployment creates a new ReplicaSet, gradually shifting traffic from the old one. That is a `rolling update`.',
        '`Labels` are the glue. A ReplicaSet claims its pods through a `selector`; pods declare their identity through `metadata.labels`. When the two disagree, the ReplicaSet believes it owns no pods and keeps creating more.',
        'A `Service` is a stable in-cluster entrypoint. Pod IPs change constantly (every recreation brings a new one), while a Service has a fixed ClusterIP and DNS name. It also finds backends through a `selector`, and the matching pod addresses are written into an `Endpoints` object that forwarding consults.',
        'This produces a very characteristic failure: every pod is Running, the Service has a ClusterIP, and nothing can reach it. The Service selector does not match the pod labels, so Endpoints is empty. `kubectl get svc` will not reveal this; `kubectl get endpoints` shows it immediately. It is the first command to run when a service is unreachable.'
      )
    ),

    'containerize': t(
      p(
        '一个容器镜像是若干`层`叠起来的。Dockerfile 里每条会改动文件系统的指令（`COPY`、`ADD`、`RUN`）产生一层，每层只记录相对上一层的差异。运行时把这些层按顺序叠成一个完整的根文件系统，上面再盖一个可写层。',
        '分层带来两个后果，一好一坏。好的是`构建缓存`：只要某一层的输入没变，这一层就直接复用。所以先 `COPY package.json` 再 `npm ci`、最后才 `COPY` 源码，改一行业务代码不会让依赖重装一遍；顺序反过来则每次都重装。',
        '坏的是`层是不可变的历史`。某一层里写进去的文件，后面的层只能用一条「删除标记」把它遮住，字节本身还在镜像里。所以 `COPY . .` 把密钥带进去、再 `RUN rm` 删掉，最终文件系统确实干净，但 `docker save` 导出来一翻就找得到。真正的做法是让它根本不进构建上下文（`.dockerignore`），或者用`多阶段构建`把构建期的东西留在前一个阶段。',
        '还有两个和运行时直接相关的字段。`USER` 决定容器里的进程以谁的身份跑，默认是 root，而以 root 跑容器是绝大多数安全基线的第一条禁令。`CMD` 有两种写法：exec form（`["node","server.js"]`）让应用进程直接成为容器里的 1 号进程，shell form（`node server.js`）会先起一个 `/bin/sh`，信号只发给 sh，应用收不到，优雅退出就无从谈起。'
      ),
      p(
        'A container image is a stack of `layers`. Every Dockerfile instruction that changes the filesystem (`COPY`, `ADD`, `RUN`) produces one, and each layer records only its difference from the one below. At runtime the layers are stacked into a complete root filesystem with a writable layer on top.',
        'Layering has two consequences, one good and one bad. The good one is the `build cache`: as long as a layer’s inputs are unchanged, it is reused. That is why you `COPY package.json` first, then `npm ci`, and only then copy the source: changing one line of business code no longer reinstalls every dependency. Reverse the order and it reinstalls every time.',
        'The bad one is that `layers are immutable history`. A file written into one layer can only be hidden by a deletion marker in a later layer; the bytes remain in the image. So copying a secret in and then removing it leaves a genuinely clean final filesystem, and a recoverable secret for anyone who runs `docker save`. The real fixes are keeping it out of the build context entirely (`.dockerignore`) or using a `multi-stage build` so build-time material stays in an earlier stage.',
        'Two more fields matter at runtime. `USER` decides which identity the process runs as; the default is root, and running as root is the first thing nearly every security baseline forbids. `CMD` has two forms: exec form (`["node","server.js"]`) makes your application PID 1 inside the container, while shell form (`node server.js`) starts a `/bin/sh` first, so signals go to the shell and never reach your application, which makes graceful shutdown impossible.'
      )
    ),

    'pull-credentials': t(
      p(
        '镜像存放在`仓库`（registry）里。公开的仓库（Docker Hub、registry.k8s.io）谁都能拉，公司内部的仓库（Harbor、Nexus、ECR）通常要认证。认证信息不是「一个密码」这么简单：Docker 生态里它是一份 JSON，按仓库主机名分别记着用户名和密码，存在 `~/.docker/config.json` 里，`docker login` 写的就是它。',
        '关键在于**谁去拉镜像**。你在跳板机上 `docker login`，那份凭据在跳板机的磁盘上。而 Pod 的镜像是由它所在节点上的 `kubelet` 去拉的，那是另一台机器，它读不到你的家目录。所以集群需要自己的一份凭据。',
        '这份凭据在 Kubernetes 里就是一个 `Secret`，类型是 `kubernetes.io/dockerconfigjson`，内容和 `~/.docker/config.json` 一模一样。`kubectl create secret docker-registry` 会替你拼出来。Pod 通过 `spec.imagePullSecrets` 引用它，kubelet 拉镜像时就带上。注意 Secret 是命名空间级的，引用只能在同一个命名空间里。',
        '还要分清两种失败。镜像名字打错、tag 不存在，报的是「manifest unknown」；有镜像但没权限，报的是 401。两者在 `kubectl get pods` 里都显示成 `ImagePullBackOff`，只有 `kubectl describe pod` 底下的 Events 能区分。查错方向完全不同，所以第一件事永远是去看 Events。'
      ),
      p(
        'Images live in a `registry`. Public registries (Docker Hub, registry.k8s.io) serve anyone; internal ones (Harbor, Nexus, ECR) usually require authentication. That credential is not just a password: in the Docker ecosystem it is a JSON document keyed by registry host, stored in `~/.docker/config.json`, which is what `docker login` writes.',
        'The crucial question is **who does the pulling**. When you run `docker login` on a jump host, the credential lands on that host. A pod image, however, is pulled by the `kubelet` on whichever node runs the pod, which is a different machine that cannot read your home directory. The cluster therefore needs its own copy.',
        'In Kubernetes that copy is a `Secret` of type `kubernetes.io/dockerconfigjson`, whose contents are exactly a `~/.docker/config.json`. `kubectl create secret docker-registry` assembles it for you. A pod references it through `spec.imagePullSecrets`, and the kubelet presents it when pulling. Secrets are namespaced, so the reference only works within the same namespace.',
        'Two failures also need separating. A misspelled name or missing tag reports "manifest unknown"; an existing image without permission reports 401. Both surface as `ImagePullBackOff` in `kubectl get pods`, and only the Events at the bottom of `kubectl describe pod` tell them apart. The investigations are completely different, so reading Events is always the first move.'
      )
    ),

    'config-and-secrets': t(
      p(
        '把配置写死在镜像里，意味着改一个日志级别要重新构建、重新推送、重新部署。Kubernetes 把配置拆出来放在两种对象里：`ConfigMap` 存普通配置，`Secret` 存敏感数据。两者的结构几乎一样，区别在于 Secret 的值是 base64 编码的，并且在集群里有一些额外的保护（可以加密存储、不会被随手打印在事件里）。注意 base64 不是加密，任何人拿到 Secret 都能一行命令解开。',
        '注入方式有两种。`环境变量`（`env.valueFrom.configMapKeyRef` / `secretKeyRef`，或者 `envFrom` 整份铺进去）在容器启动时一次性写入进程环境，之后不再变化。`卷挂载`把每个键变成一个文件，kubelet 会在后台同步更新它们，所以应用如果自己重新读文件，就能感知到配置变化。',
        '引用了不存在的 ConfigMap 或 Secret 时，Pod 会停在 `CreateContainerConfigError`。这个状态很值得记住：容器**从未启动**，所以 `kubectl logs` 是空的，去翻应用日志毫无意义。原因写在 `kubectl describe pod` 的 Events 里，而且会区分「对象不存在」和「对象在但键不存在」。',
        '最后一件反直觉的事：改了 ConfigMap，正在跑的 Pod 不会重启。对环境变量注入来说，这意味着新值根本不会生效。Kubernetes 不会替你做这个决定，因为重启是有代价的。通行做法是在 Pod 模板上放一个配置内容的哈希注解，配置变了哈希就变，模板变了 Deployment 才会滚动出新的一批 Pod。'
      ),
      p(
        'Baking configuration into an image means rebuilding, repushing, and redeploying to change a log level. Kubernetes separates it into two objects: a `ConfigMap` for ordinary settings and a `Secret` for sensitive data. Their structure is nearly identical; a Secret stores base64-encoded values and gets some extra protection in the cluster (it can be encrypted at rest and is not casually printed into events). Note that base64 is not encryption: anyone holding the Secret can decode it in one command.',
        'There are two ways to inject them. `Environment variables` (`env.valueFrom.configMapKeyRef` or `secretKeyRef`, or `envFrom` for a whole map) are written into the process environment once at container start and never change afterwards. `Volume mounts` turn each key into a file, and the kubelet keeps those files in sync, so an application that rereads the file can notice a change.',
        'Referencing a ConfigMap or Secret that does not exist leaves the pod in `CreateContainerConfigError`. That state is worth memorising: the container **never started**, so `kubectl logs` is empty and reading application logs is pointless. The reason appears in the pod Events, which distinguish "object not found" from "object exists but the key does not".',
        'One last counterintuitive fact: editing a ConfigMap does not restart running pods. With environment-variable injection that means the new value simply never takes effect. Kubernetes will not make that decision for you, because restarting has a cost. The common practice is an annotation on the pod template holding a hash of the configuration: the config changes, the hash changes, the template changes, and only then does the Deployment roll out new pods.'
      )
    ),

    'probes-and-shutdown': t(
      p(
        'kubelet 靠`探针`判断容器的状态，一共三种，回答三个不同的问题。`就绪探针`（readinessProbe）问「现在能不能给它流量」，失败时这个 Pod 会被从 Service 的 Endpoints 里摘掉，但容器不重启。`存活探针`（livenessProbe）问「这个进程还有没有救」，连续失败到阈值就重启容器。`启动探针`（startupProbe）专门照顾启动慢的应用：它没通过之前，存活探针不生效。',
        '探针的形式有 HTTP、TCP 和执行命令三种。HTTP 探针最常用，也最容易配错：端口写成了应用没在听的那个，或者路径写成了应用没实现的那个。表现是 Pod 一直 Running 但 `READY` 那一列是 `0/1`，应用日志里什么异常都没有，因为应用确实什么问题都没有。证据只在 `kubectl describe pod` 的 Events 里，那里会有一条 `Readiness probe failed`。',
        '把存活探针配得和就绪探针一样激进是常见的放大器。下游变慢的时候，本该只是「暂时摘掉流量」的情况会变成「整批 Pod 同时重启」，一次抖动就此升级成一次故障。经验做法是：就绪探针可以敏感，存活探针要迟钝。',
        '`优雅终止`是另一半。删除一个 Pod 时，kubelet 先发 SIGTERM，等 `terminationGracePeriodSeconds`（默认 30 秒），还没退出才发 SIGKILL。但这里有个时间差：摘除 Endpoints 和发送 SIGTERM 是**并行**发生的，Endpoints 的变更传播到所有节点需要时间，这段时间里的新请求仍然会打到正在退出的 Pod 上。所以通行做法是加一个 `preStop` 钩子先睡几秒，把这段传播时间让出来，再让进程开始退出。滚动更新时把 `maxUnavailable` 设成 0，则保证任何时刻可用副本数都不低于期望值。'
      ),
      p(
        'The kubelet judges container state with `probes`. There are three, and they answer three different questions. A `readinessProbe` asks "can this take traffic right now"; when it fails the pod is removed from the Service Endpoints but the container is not restarted. A `livenessProbe` asks "is this process beyond saving"; enough consecutive failures restart the container. A `startupProbe` exists for slow-starting applications: until it passes, liveness is suspended.',
        'Probes come in HTTP, TCP, and exec forms. HTTP is the most common and the easiest to misconfigure: a port the application does not listen on, or a path it does not implement. The symptom is a pod that stays Running with `0/1` in the READY column while the application logs show nothing wrong, because nothing is wrong with the application. The evidence lives only in the pod Events, as a `Readiness probe failed` line.',
        'Making liveness as aggressive as readiness is a common amplifier. When a dependency slows down, what should be "temporarily remove from traffic" becomes "restart every pod at once", turning a blip into an outage. The rule of thumb: readiness may be sensitive, liveness should be dull.',
        '`Graceful termination` is the other half. Deleting a pod makes the kubelet send SIGTERM, wait `terminationGracePeriodSeconds` (30 by default), and then SIGKILL. There is a race in there: Endpoints removal and SIGTERM happen **in parallel**, and the Endpoints change takes time to reach every node, so new requests keep arriving at a pod that is already shutting down. The usual remedy is a `preStop` hook that sleeps for a few seconds, giving that propagation time before the process begins exiting. Setting `maxUnavailable` to 0 during rollouts additionally guarantees the available replica count never dips below the desired one.'
      )
    ),

    'resources-and-qos': t(
      p(
        '容器声明资源有两个字段，管的是两件事。`requests` 是给调度器看的：调度器按它做装箱，把 Pod 放到「已承诺容量」还够的节点上。`limits` 是运行时的硬约束，落到 cgroup 上。两者可以不相等，也可以只写一个，不同的写法会得到不同的后果。',
        '内存和 CPU 的超限行为完全不同。内存是不可压缩资源：用量超过 limit，内核直接 OOMKill 这个容器，退出码 137（128+9，SIGKILL），日志经常来不及写完。CPU 是可压缩资源：超过 limit 只是被限流，进程继续跑，只是变慢，表现为 P99 变差而不是进程消失。所以「应用没崩但突然变慢了」和「应用被杀了」要往两个方向查。',
        '`QoS 等级`不是自己填的，是 kubelet 根据 requests 与 limits 推出来的：每个容器的 cpu 和 memory 都写了且 requests 等于 limits，是 `Guaranteed`；一个都没写，是 `BestEffort`；其余是 `Burstable`。这个等级决定节点内存不够时谁先被赶走：BestEffort 最先，然后是用量超过自己 requests 的 Burstable，Guaranteed 最后。',
        '于是有一个很容易走进去的死胡同：容器被 OOMKill 了，把 limits 删掉「就不会被杀了」。确实不会，但它同时变成了 BestEffort，节点一紧张第一个被驱逐，只是把一种死法换成了另一种。正确的做法是先量出实际用量再设定数字。生产里有 VPA 的 recommender 帮忙算，以及 LimitRange 给命名空间兜一个默认值。'
      ),
      p(
        'A container declares resources with two fields that govern two different things. `requests` is for the scheduler: it bin-packs by requests, placing pods on nodes that still have promised capacity. `limits` is a runtime constraint enforced by cgroups. The two need not be equal, and either may be omitted, with different consequences.',
        'Memory and CPU behave completely differently when exceeded. Memory is incompressible: cross the limit and the kernel OOM-kills the container with exit code 137 (128+9, SIGKILL), often before the logs finish flushing. CPU is compressible: crossing the limit only throttles the process, which keeps running but slower, showing up as a degraded P99 rather than a missing process. "The app did not crash but suddenly got slow" and "the app was killed" therefore point in different directions.',
        'The `QoS class` is derived, not declared. The kubelet computes it from requests and limits: every container declaring both cpu and memory with requests equal to limits is `Guaranteed`; declaring nothing is `BestEffort`; anything else is `Burstable`. That class decides who is evicted first when a node runs short of memory: BestEffort first, then Burstable pods exceeding their own requests, and Guaranteed last.',
        'This creates an easy dead end. A container gets OOM-killed, so you remove the limit and it stops being killed. True, but it has also become BestEffort and is now first in line for eviction: one way of dying traded for another. The right move is to measure actual usage and set numbers from that. Production adds the VPA recommender to compute them and a LimitRange to give the namespace sane defaults.'
      )
    ),

    'gateway-migration': t(
      p(
        '集群里的服务默认只能在集群内部访问。要让外面进得来，需要一个`入口`。早年的做法是 `Ingress`：一个对象里写着域名、路径和后端 Service，再由某个 Ingress 控制器（nginx、traefik 之类）把它翻译成真正的反向代理配置。Ingress 的规范只覆盖了最基础的 HTTP 路由，超出的部分全靠 annotation，于是每家控制器一套写法，配置无法在实现之间迁移。',
        '`Gateway API` 是它的继任者，2023 年 GA。最大的变化是把一个对象拆成三个，按`角色`分开：`GatewayClass` 由平台方提供，声明「这套入口由哪个控制器实现」；`Gateway` 由集群管理员建，决定监听哪些端口、用什么证书、暴露到哪个网段；`HTTPRoute` 由应用团队自己写，只管路径怎么分发到哪个 Service。谁能改什么，从此在 RBAC 上划得清。',
        '一条请求进来要经过两层匹配。先看 Gateway 的 `listener`：端口对不对、`hostname` 对不对。再看挂在这个 Gateway 上的 HTTPRoute：`hostnames` 对不对、`rules.matches` 里的路径对不对。两层都过了才转给 `backendRefs` 指的 Service。任何一层没匹配上，Gateway 会回 404 而不是拒绝连接，因为 Gateway 本身是活着的。这个区别决定了排查方向：404 去查路由，连不上去查 Gateway。',
        '状态写在两处，都值得先看。Gateway 的 `Programmed` 条件说明控制器有没有把配置下发下去，`status.addresses` 里是真正的访问地址。HTTPRoute 的 `status.parents[].conditions` 里有 `Accepted` 和 `ResolvedRefs`，后者会直接说出后端 Service 是不是不存在，省掉一轮猜测。'
      ),
      p(
        'Services in a cluster are only reachable from inside it by default. Letting outside traffic in requires an `ingress point`. The original mechanism was `Ingress`: one object holding hostnames, paths, and backend Services, translated into real reverse-proxy configuration by some Ingress controller (nginx, traefik, and others). The Ingress spec only covered basic HTTP routing, so everything beyond it lived in annotations, every controller invented its own, and configuration could not move between implementations.',
        '`Gateway API` is the successor, GA since 2023. Its central change is splitting that one object into three along `role` lines. `GatewayClass` is offered by the platform and names the controller implementing it. `Gateway` is created by the cluster administrator and decides which ports to listen on, which certificates to use, and which network it is exposed on. `HTTPRoute` is written by the application team and only says which path goes to which Service. Who may change what is finally expressible in RBAC.',
        'An incoming request passes two matching layers. First the Gateway `listener`: correct port, correct `hostname`. Then the HTTPRoutes attached to that Gateway: correct `hostnames`, correct path in `rules.matches`. Only if both pass does traffic go to the Service in `backendRefs`. If either fails, the Gateway returns 404 rather than refusing the connection, because the Gateway itself is alive. That distinction sets the direction of an investigation: a 404 means look at routing, a refused connection means look at the Gateway.',
        'Status lives in two places and both are worth reading first. The Gateway `Programmed` condition says whether the controller pushed configuration down, and `status.addresses` holds the real address. An HTTPRoute carries `Accepted` and `ResolvedRefs` in `status.parents[].conditions`, and the latter states outright whether the backend Service is missing, saving a round of guessing.'
      )
    ),

    'certificates-and-pki': t(
      p(
        'HTTPS 的信任建立在一条`证书链`上。服务端出示一张`叶子证书`，上面写着它是谁（`Subject`）、能代表哪些域名（`SAN`，Subject Alternative Name）、有效期、以及公钥。这张证书由某个`证书颁发机构`（CA）用私钥签过名。客户端手里有一份`信任库`，里面是它信任的根 CA。验证的过程就是从叶子往上找签它的那一级，一级级找到信任库里的某个根为止。',
        '实际的 PKI 很少只有一层。通常是一个离线保存的根 CA，签出若干个`中间 CA`，日常签发全用中间 CA 做。好处是根的私钥可以锁在保险柜里，中间 CA 泄漏了也能单独吊销。代价是**服务端必须把中间证书一起发给客户端**：客户端信任库里只有根，它不认识那张中间 CA，链就断在那里。',
        '这个坑之所以难查，是因为它不是必然失败。浏览器可能之前访问别的站点时缓存过同一张中间证书，或者按证书里的 AIA 扩展自己去下载补齐；而 curl、Go 与 Java 写的服务都不做这些事。于是现象是「浏览器能打开，服务之间调不通」。判断的办法只有一个：看服务端实际发出来的是几张证书。',
        '`SAN` 是另一处常见问题。2017 年之后所有主流验证器都不再看 `CN` 字段，只认 SAN。一张 CN 写对但 SAN 里没有这个名字的证书会被拒绝，报错是「certificate is valid for A, not B」。Kubernetes 里这些事通常交给 `cert-manager`：`Issuer` 声明用哪个 CA，`Certificate` 声明要签什么，控制器把签好的叶子**连同签发链**一起写进一个 `kubernetes.io/tls` 类型的 Secret，链不完整这个错自然就不会犯。'
      ),
      p(
        'HTTPS trust rests on a `certificate chain`. A server presents a `leaf certificate` stating who it is (`Subject`), which names it may represent (`SAN`, Subject Alternative Name), how long it is valid, and its public key. That certificate is signed by some `certificate authority` (CA). The client holds a `trust store` of root CAs it trusts, and verification walks upward from the leaf, level by level, until it reaches one of those roots.',
        'Real PKIs rarely have a single level. The usual shape is an offline root CA that signs several `intermediate CAs`, with day-to-day issuance done by an intermediate. The root private key can then live in a safe, and a compromised intermediate can be revoked on its own. The price is that **the server must send the intermediate along with the leaf**: the client only trusts the root, does not recognise the intermediate, and the chain breaks there.',
        'This is hard to diagnose because it does not always fail. A browser may have cached the same intermediate from another site, or fetch it itself via the AIA extension in the certificate; curl, Go services, and Java services do neither. The symptom is "the browser opens it, service-to-service calls fail". There is one reliable check: look at how many certificates the server actually sends.',
        '`SAN` is the other frequent problem. Since 2017 no mainstream verifier reads the `CN` field; only SAN counts. A certificate with the right CN but a SAN that omits the name is rejected with "certificate is valid for A, not B". In Kubernetes this is normally handled by `cert-manager`: an `Issuer` names the CA, a `Certificate` describes what to issue, and the controller writes the leaf **together with its issuing chain** into a `kubernetes.io/tls` Secret, which makes the incomplete-chain mistake impossible to commit.'
      )
    ),

    'network-policy': t(
      p(
        '集群里的 Pod 默认可以互相访问，不分命名空间。`NetworkPolicy` 是收紧这件事的对象：它按标签选中一批 Pod，然后声明这批 Pod 的入向（`ingress`）和出向（`egress`）允许什么。没有任何策略选中某个 Pod 时，这个 Pod 完全开放；一旦被选中，对应方向就变成默认拒绝，只有明确写出来的才放行。',
        '有两件事经常被搞混。第一，`policyTypes` 决定这条策略管哪个方向：写了 `Egress` 却不写任何 egress 规则，等于「这批 Pod 什么都出不去」，包括查 DNS。第二，`from` 和 `to` 里的每一个元素是「或」的关系，但同一个元素内部的 `podSelector` 和 `namespaceSelector` 是「与」。写成两个元素就是「这个命名空间的所有 Pod，或者任何命名空间里叫这个名字的 Pod」，比想要的宽得多。另外，只写 `podSelector` 不写 `namespaceSelector` 时，它只在策略自己所在的命名空间里找。',
        '最关键、也最容易踩的一点：`NetworkPolicy` 只是一个被 apiserver 收下的对象，真正拦不拦包取决于 CNI。flannel 这类只做网络连通的插件根本不看这些对象，策略写得再对也是一张废纸；Cilium、Calico 这类才会把它翻译成数据面规则。所以「加了策略但行为没变」时，第一个要确认的不是策略写得对不对，而是集群里到底有没有人在执行它。',
        '被策略拒绝的连接表现为`超时`，不是`拒绝`。丢包意味着对端不会回 RST，客户端只能等到自己的超时时间。这个区别很有用：`Connection refused` 说明包已经到了对端而那里没有进程在听，和策略无关；`timeout` 才值得去看策略、路由和防火墙。'
      ),
      p(
        'Pods can reach each other freely by default, across namespaces. `NetworkPolicy` is how you tighten that: it selects pods by label and declares what their inbound (`ingress`) and outbound (`egress`) traffic may be. A pod that no policy selects stays fully open; once selected, that direction becomes deny-by-default and only what you spell out gets through.',
        'Two details cause most of the confusion. First, `policyTypes` decides which directions the policy governs: listing `Egress` without writing any egress rule means "these pods may not reach anything", DNS lookups included. Second, entries in `from` and `to` are ORed together, but `podSelector` and `namespaceSelector` inside a single entry are ANDed. Writing them as two entries means "every pod in that namespace, or any pod with that label in any namespace", which is far wider than intended. And a bare `podSelector` with no `namespaceSelector` only matches within the policy own namespace.',
        'The most important point, and the easiest to miss: a `NetworkPolicy` is only an object the apiserver accepts. Whether packets get dropped depends on the CNI. Plugins like flannel provide connectivity and never read these objects, so a perfectly correct policy does nothing at all; Cilium and Calico translate them into real data plane rules. When a policy changes no behaviour, the first thing to check is not the policy but whether anything is enforcing it.',
        'A connection denied by policy shows up as a `timeout`, not a `refusal`. Dropping a packet means no RST comes back, so the client waits out its own deadline. That distinction is useful: `Connection refused` means the packet arrived and no process was listening, which has nothing to do with policy, while a `timeout` is what sends you looking at policies, routing, and firewalls.'
      )
    ),

    'gitops-with-argocd': t(
      p(
        '`GitOps` 把「集群里应该跑什么」这个答案从集群搬到了仓库。一个 Git 仓库存着全部 manifest，一个控制器不停地把仓库和集群比对，不一致就补齐。改配置的方式从「敲 kubectl」变成「提交一次代码」，于是每一次变更天然有作者、有时间、有 review、能回滚。',
        '`Argo CD` 是最常见的实现。它的核心对象是 `Application`：`spec.source` 指到仓库的某个路径与某个分支，`spec.destination` 指到集群的某个命名空间。控制器把那个路径下的 YAML 渲染出来，和集群里的现状比一比，结果写进 `status`。要强调的是它读的是**远端仓库**：本地 commit 了没 push，对它来说等于什么都没发生。',
        '`status` 里有两栏，代表两件完全不同的事，混在一起看会误判。`sync.status` 是 `Synced` 还是 `OutOfSync`，说的是「现状和仓库一不一致」；`health.status` 是 `Healthy` / `Progressing` / `Degraded`，说的是「服务好不好」。一个刚被人手工扩容过的服务是 OutOfSync 但 Healthy；一个刚同步完但镜像拉不下来的服务是 Synced 但 Degraded。',
        '同步行为由 `syncPolicy` 上三个独立的开关决定，各管各的：不写 `automated` 时它只比对、只报告，什么都不动；写了 `automated` 之后仓库一变就自动 apply；再加 `selfHeal: true`，集群里的手工改动也会被拉回仓库的样子；再加 `prune: true`，仓库里删掉的对象才会在集群里被删除。想手动触发一次同步，写 `operation` 字段就行，`argocd app sync` 做的正是这件事。'
      ),
      p(
        '`GitOps` moves the answer to "what should be running" out of the cluster and into a repository. One Git repository holds all the manifests, a controller continuously compares repository against cluster, and reconciles any difference. Changing configuration becomes committing code, so every change comes with an author, a timestamp, a review, and a way back.',
        '`Argo CD` is the common implementation. Its central object is the `Application`: `spec.source` points at a path and revision in a repository, `spec.destination` at a namespace in a cluster. The controller renders the YAML under that path, compares it with live state, and writes the outcome into `status`. Note that it reads the **remote** repository: a local commit that was never pushed may as well not exist.',
        'Two fields in `status` mean two entirely different things, and conflating them causes misdiagnosis. `sync.status` (`Synced` or `OutOfSync`) says whether live state matches the repository. `health.status` (`Healthy`, `Progressing`, `Degraded`) says whether the workload is well. A service someone just hand-scaled is OutOfSync but Healthy; a freshly synced service whose image will not pull is Synced but Degraded.',
        'Sync behaviour comes from three independent switches under `syncPolicy`. Without `automated`, the controller only compares and reports, never acts. With `automated`, repository changes get applied. Adding `selfHeal: true` also pulls hand edits in the cluster back to what the repository says. Adding `prune: true` deletes objects that no longer exist in the repository. To trigger one sync by hand, write the `operation` field, which is exactly what `argocd app sync` does.'
      )
    ),

    'helm-chart': t(
      p(
        '同一个服务要在开发、预发、生产各跑一套，manifest 之间只差几个值：副本数、镜像 tag、资源上限。复制粘贴三份是最直接的做法，也是最先坏掉的做法：改一处忘了改另外两处，环境之间就开始漂，而漂到什么程度没人说得清。`Helm` 解决的就是这件事：一份模板，差异全部落在 `values` 里。',
        '一个 `chart` 是一个目录：`Chart.yaml` 写名字与版本，`values.yaml` 是默认值，`templates/` 下是模板。模板用的是 Go 的 `text/template` 加上 `sprig` 函数库，`{{ .Values.replicaCount }}` 取值，`{{ .Release.Name }}` 取这次安装的名字，`{{ .Chart.Name }}` 取 chart 名。装的时候用 `-f values-prod.yaml` 或 `--set key=value` 覆盖默认值，后者优先级更高。',
        '有两个细节几乎人人踩一次。第一是`名字`：对象名里必须带 `.Release.Name`，写死的话同一个 chart 装第二个 release 时会去改第一个的对象，而且没有任何报错。惯例是定义一个 `fullname` 辅助模板，所有对象都用它。第二是`缩进`：模板输出的是文本，缩进错了就是 YAML 错。`nindent N` 会先换行再缩进 N 个空格，`{{- ` 和 ` -}}` 吃掉两侧空白，套在 `include` 与 `toYaml` 外面基本就对了。',
        '排查模板永远从 `helm template <release> <chart> -f <values>` 开始。它只渲染不安装，出来的 YAML 就是最终会被提交的东西，客户端渲染，没有服务端魔法。装上去再看集群是把两类问题混在了一起：模板写错了，和集群拒绝了。另外 Helm 会在集群里记下每次 release 渲染了哪些对象，所以 `helm upgrade` 能删掉上一版有、这一版没有的东西，`helm uninstall` 能收干净一整套。'
      ),
      p(
        'The same service runs in development, staging, and production, and the manifests differ by a handful of values: replica count, image tag, resource limits. Copying the file three times is the obvious move and the first thing to break, because changing one copy and forgetting the others makes environments drift in ways nobody can enumerate. `Helm` exists for exactly this: one template, with every difference living in `values`.',
        'A `chart` is a directory: `Chart.yaml` names and versions it, `values.yaml` holds defaults, `templates/` holds the templates. Templates are Go `text/template` plus the `sprig` function library. `{{ .Values.replicaCount }}` reads a value, `{{ .Release.Name }}` gives the name of this installation, `{{ .Chart.Name }}` the chart name. At install time `-f values-prod.yaml` or `--set key=value` override the defaults, with `--set` winning.',
        'Two details catch almost everyone once. First, `naming`: object names must include `.Release.Name`. Hardcode them and installing a second release rewrites the first release objects, silently. The convention is a `fullname` helper template used by every object. Second, `indentation`: templates emit text, so wrong indentation is wrong YAML. `nindent N` emits a newline then indents by N spaces, and `{{- ` / ` -}}` trim surrounding whitespace; wrapping `include` and `toYaml` with those covers most cases.',
        'Debugging templates always starts at `helm template <release> <chart> -f <values>`. It renders without installing, and the YAML it prints is exactly what would be submitted: rendering is client-side, with no server-side magic. Installing first and then inspecting the cluster conflates two different problems, a wrong template and a rejecting cluster. Helm also records in the cluster which objects each release rendered, which is how `helm upgrade` deletes what the previous revision had and this one does not, and how `helm uninstall` cleans up a whole set.'
      )
    ),

    'kustomize-overlays': t(
      p(
        '`kustomize` 和 Helm 常被拿来比，但它们解决的不是同一个问题。Helm 是模板：被打包的一方先把参数挖好（`{{ .Values.x }}`），你只能改对方想到的那些点。kustomize 不是模板，它是对 YAML 做结构化修改：不需要对方配合，任何一份 manifest 都能被改。所以「自己的服务」适合写 chart，「别人给的东西」适合套 overlay。它内置在 `kubectl` 里：`kubectl kustomize <dir>` 只渲染，`kubectl apply -k <dir>` 渲染并提交。',
        '结构是 `base` 加 `overlays`。`base` 是一份能直接 apply 的完整 manifest；每个 overlay 是一个目录，里面的 `kustomization.yaml` 用 `resources: [../../base]` 指回 base，然后只写差异。关键在于 base 保持原样：上游升级时整个目录换掉，你的修改都在 overlay 里，一条都不会丢。',
        '有一批常见改动不用写 patch，`kustomization.yaml` 里一行就够：`namespace` 改命名空间，`namePrefix` / `nameSuffix` 加前后缀，`labels` 打统一标签，`images` 改镜像仓库或 tag，`replicas` 改副本数，`configMapGenerator` 从文件生成 ConfigMap 并自动带上内容哈希后缀（内容一变名字就变，Pod 因此会滚动重启）。只有这些表达不了的，才需要 `patches`。',
        '`patches` 有两种写法，行为差别很大。`strategic merge patch` 是写一份不完整的 YAML，读起来自然，但**列表的合并取决于 merge key**：容器列表的 merge key 是 `name`，patch 里漏写它，kustomize 不会报错，而是把整个 `containers` 替换成你写的那一项，镜像、端口、资源全都没了。`JSON patch`（`op` / `path` / `value`）啰嗦但精确，`/spec/template/spec/containers/0/env/-` 明确表示追加到第 0 个容器的 env 末尾，不存在猜的余地。'
      ),
      p(
        '`kustomize` gets compared to Helm constantly, but they solve different problems. Helm is templating: the packager has to anticipate every parameter (`{{ .Values.x }}`), so you can only change what they thought of. Kustomize is not templating; it edits YAML structurally, needing no cooperation from the author, so any manifest can be changed. Charts suit your own services, overlays suit what other people hand you. It ships inside `kubectl`: `kubectl kustomize <dir>` renders, `kubectl apply -k <dir>` renders and submits.',
        'The structure is a `base` plus `overlays`. The base is a complete, directly appliable manifest. Each overlay is a directory whose `kustomization.yaml` points back with `resources: [../../base]` and then states only the difference. The point is that the base stays pristine: when upstream ships a new version the whole directory is replaced, and because every change of yours lives in the overlay, nothing is lost.',
        'A whole class of changes needs no patch at all, just a line in `kustomization.yaml`: `namespace` moves everything, `namePrefix` / `nameSuffix` rename, `labels` stamps labels, `images` rewrites registry or tag, `replicas` sets counts, and `configMapGenerator` builds a ConfigMap from files with a content hash appended to its name, so changing the content changes the name and rolls the pods. Reach for `patches` only for what these cannot express.',
        '`patches` come in two forms that behave very differently. A `strategic merge patch` is partial YAML, natural to read, but **list merging depends on the merge key**. For containers that key is `name`; omit it and kustomize does not complain, it replaces the entire `containers` list with the single entry you wrote, losing the image, ports, and resources. A `JSON patch` (`op` / `path` / `value`) is verbose but exact: `/spec/template/spec/containers/0/env/-` says append to the env of container zero, with nothing left to infer.'
      )
    ),

    'follow-the-packet': t(
      p(
        '排查网络问题最费时间的从来不是修，是在错误的层里找。而现象本身已经把层次说清楚了，只要认得出来。一条 TCP 连接从发起到拿到响应，要顺次经过：名字解析、路由可达、目标端口有没有人听、中间有没有人丢包、TLS 握手、最后才是应用的回答。每一层失败的样子都不一样。',
        '`Connection refused` 说明包**到了**对端，而那里没有进程在听。Kubernetes 里最常见的成因是 Service 的 selector 没选中任何 Pod：Endpoints 为空，kube-proxy 直接回 RST。注意 `kubectl get svc` 这时看上去完全正常，有 ClusterIP、有端口；要看的是 `kubectl get endpoints`。',
        '`timeout` 说明包被**丢**了，对端不回任何东西。防火墙、安全组、路由不通、NetworkPolicy 都长这样。这也是为什么策略拒绝表现为卡住而不是立刻失败：丢包的一方按定义不会告诉你它丢了。看到超时，该问的是「谁在丢包」，而不是「服务是不是挂了」。',
        '`404`、`502`、`503` 这类 HTTP 状态码意味着**连接是成功的**。这是应用或者代理给的回答，说明下面每一层都通了。Gateway 回 404 是「我活着，但没有路由认领这个域名或路径」，去看 HTTPRoute 的 `hostnames` 与 `rules`；连不上才是 Gateway 本身的问题。再往前一层，如果连 DNS 都没解析出来，那连接压根没发起过，`dig` 和 `/etc/resolv.conf` 才是现场。'
      ),
      p(
        'The expensive part of debugging a network problem is never the fix, it is searching in the wrong layer. The symptom already tells you the layer, if you can read it. A TCP connection passes through name resolution, route reachability, something listening on the target port, nobody dropping the packet, a TLS handshake, and only then the application answer. Each layer fails differently.',
        '`Connection refused` means the packet **arrived** and no process was listening. In Kubernetes the usual cause is a Service selector matching no pods: Endpoints is empty and kube-proxy resets the connection. Note that `kubectl get svc` looks perfectly healthy at that moment, with a ClusterIP and ports; the thing to read is `kubectl get endpoints`.',
        '`timeout` means the packet was **dropped** with no reply. Firewalls, security groups, missing routes, and NetworkPolicy all look like this. It is also why a policy denial hangs instead of failing fast: whoever drops the packet, by definition, does not tell you. A timeout should prompt "who is dropping packets", not "is the service down".',
        'HTTP status codes such as `404`, `502`, and `503` mean the **connection succeeded**. They are an answer from the application or the proxy, which means every layer below worked. A Gateway returning 404 is saying "I am alive and no route claimed this hostname or path", so read the HTTPRoute `hostnames` and `rules`; a Gateway that is actually broken refuses the connection instead. One layer earlier, if DNS never resolved, no connection was attempted at all and the scene of the crime is `dig` and `/etc/resolv.conf`.'
      )
    ),

    'service-mesh-ambient': t(
      p(
        '`NetworkPolicy` 判的是「这个 IP 属于一个带某某标签的 Pod」，而标签只是 apiserver 里的一个字段，有权限的人随时能改。服务网格判的是另一件事：**对面出示的证书属于谁**。每个工作负载拿到一张由集群 CA 签发的证书，身份写在 SAN 里，格式是 `SPIFFE`：`spiffe://cluster.local/ns/<命名空间>/sa/<ServiceAccount>`。注意身份来自 ServiceAccount，不是 Pod 名也不是标签；所有服务都用 `default` 这个 SA 的集群，上了网格也分不出谁是谁。',
        '`Istio ambient` 是 2026 年的主流形态，和早年的 sidecar 模式差别很大：不再给每个 Pod 塞一个 Envoy，而是每个节点跑一个 `ztunnel`（DaemonSet）负责 L4：建立 mTLS、校验对端身份、按身份与端口授权。接入方式是给命名空间打一个标签 `istio.io/dataplane-mode=ambient`，Pod 不用改、不用重启。`istioctl ztunnel-config workload` 里 PROTOCOL 那一列是 HBONE 就说明接进来了。',
        '要按 HTTP 方法或路径授权、要重试与熔断，就得再加一层 `waypoint`，也就是一个 `gatewayClassName: istio-waypoint` 的 Gateway，按命名空间或按服务挂。这条分层是 ambient 最常见的困惑来源：带 `methods` 或 `paths` 的 `AuthorizationPolicy` 在没有 waypoint 的时候**根本不会被求值**，而 apiserver 照样收下它。`istioctl analyze` 会把这类问题直接报出来。',
        '`AuthorizationPolicy` 的判定顺序值得单独记：任何一条 DENY 命中就拒绝；没有任何 ALLOW 策略选中这个工作负载则放行；一旦有 ALLOW 策略选中它，只有命中某条 rule 才放行，**其余一律拒绝**。所以给一个服务加第一条 ALLOW 策略，等于同时把「默认拒绝」也打开了，很多人以为自己只是多放行了一个来源。还有一点：被网格拒绝表现为连接被重置（ztunnel 回 RST），而不是超时；超时是丢包，指向 NetworkPolicy 那一层。'
      ),
      p(
        '`NetworkPolicy` decides based on "this IP belongs to a pod carrying that label", and a label is just a field in the apiserver that anyone with access can change. A service mesh answers a different question: **whose certificate did the peer present**. Each workload gets a certificate from the cluster CA with its identity in the SAN, in `SPIFFE` form: `spiffe://cluster.local/ns/<namespace>/sa/<serviceaccount>`. Identity comes from the ServiceAccount, not the pod name or its labels, so a cluster where everything runs as `default` gains nothing by enrolling.',
        '`Istio ambient` is the mainstream shape in 2026 and differs sharply from the older sidecar model: instead of an Envoy beside every pod, one `ztunnel` per node (a DaemonSet) handles L4, establishing mTLS, verifying peer identity, and authorizing by identity and port. Enrolling is a namespace label, `istio.io/dataplane-mode=ambient`, with no pod changes and no restarts. In `istioctl ztunnel-config workload`, a PROTOCOL of HBONE means enrolled.',
        'Authorizing by HTTP method or path, or doing retries and circuit breaking, needs one more layer: a `waypoint`, a Gateway with `gatewayClassName: istio-waypoint`, attached per namespace or per service. This layering is the most common confusion in ambient, because an `AuthorizationPolicy` with `methods` or `paths` is **never evaluated** without a waypoint, while the apiserver accepts it happily. `istioctl analyze` reports exactly this class of problem.',
        'The evaluation order of `AuthorizationPolicy` is worth memorising: any matching DENY refuses; with no ALLOW policy selecting the workload, traffic is permitted; once some ALLOW policy selects it, only traffic matching a rule is permitted and **everything else is refused**. So adding the first ALLOW policy to a service also turns on default-deny, which surprises people who thought they were merely permitting one more caller. One more distinction: a mesh denial arrives as a connection reset, because ztunnel answers with an RST, whereas a timeout means dropped packets and points at the NetworkPolicy layer.'
      )
    ),

    'identity-and-rbac': t(
      p(
        '一个请求打到 apiserver，要过两道关，它们回答的是完全不同的问题。`认证`回答「你是谁」：客户端证书、ServiceAccount 的 token、或者 OIDC 发下来的 id_token，形式不同，产物都是同一个东西：一个用户名加一组 `group`。`鉴权`回答「你能不能做这件事」，这才是 RBAC 的活。所以「接了 OIDC 之后大家还是什么都干不了」是正常的中间状态，不是接错了。',
        'RBAC 有四个对象，两两成对：`Role` 与 `ClusterRole` 描述「能对什么资源做什么动作」，`RoleBinding` 与 `ClusterRoleBinding` 描述「谁拿到这套权限」。最容易记混的组合是 `RoleBinding` 引用 `ClusterRole`：这时权限的**范围由 Binding 决定**，拿到的只是那一个命名空间里的权限。这是「一套只读角色复用到每个命名空间」的标准写法，不必给每个命名空间各抄一份 Role。',
        '规则里有几处不是望文生义的。动词上，`get` 和 `list` 是两件事，只写 `get` 的规则挡不住也放不开 `list`；`watch` 又是第三件。资源上，看日志和进容器是**子资源**，要写成 `pods/log`（动词 `get`）和 `pods/exec`（动词 `create`，不是 get）。`resourceNames` 能把权限限定到具体对象，但它只对指名道姓的请求生效；`list` 与 `watch` 没有名字，带 `resourceNames` 的规则对它们一律不匹配。',
        '最关键的一条：RBAC **只有允许，没有拒绝**。写不出「除了 Secret 之外都可以」，只能把 Secret 之外的都列出来。这意味着加规则永远只会让权限变大，收权限的唯一办法是改掉或删掉已有的绑定；在一条 cluster-admin 绑定旁边再写一个小角色，一点用都没有。检查的办法是 `kubectl auth can-i <动词> <资源> --as=<用户> --as-group=<组>`，加 `--list` 会把这个身份能做的事全列出来。人对自己写的 RBAC 判断准确率相当低，这条命令是直接问服务端要答案。'
      ),
      p(
        'A request reaching the apiserver passes two gates that answer completely different questions. `Authentication` answers "who are you": a client certificate, a ServiceAccount token, or an OIDC id_token, all producing the same thing, a username plus a set of `groups`. `Authorization` answers "may you do this", and that is RBAC job. So "we wired up OIDC and everyone still cannot do anything" is a normal intermediate state, not a broken integration.',
        'RBAC has four objects in two pairs. `Role` and `ClusterRole` describe what verbs apply to what resources; `RoleBinding` and `ClusterRoleBinding` describe who gets them. The combination people misremember is a `RoleBinding` referencing a `ClusterRole`: **scope comes from the binding**, so the subject gains those permissions in that one namespace. This is the standard way to reuse one read-only role across namespaces instead of copying a Role into each.',
        'Several details in a rule are not what they look like. On verbs, `get` and `list` are separate, so a rule granting only `get` neither blocks nor permits `list`, and `watch` is a third. On resources, reading logs and execing are **subresources**, written `pods/log` (verb `get`) and `pods/exec` (verb `create`, not get). `resourceNames` narrows a rule to specific objects, but only for requests that name one: `list` and `watch` carry no name, so such rules never match them.',
        'The most important property: RBAC **only allows, it never denies**. There is no way to say "anything except Secrets"; you enumerate everything else. Adding rules can therefore only widen access, and the only way to reduce it is to change or delete an existing binding, which is why writing a smaller role next to a cluster-admin binding accomplishes nothing. To check, use `kubectl auth can-i <verb> <resource> --as=<user> --as-group=<group>`, and add `--list` to print everything that identity can do. People predict their own RBAC badly; this command asks the server instead.'
      )
    ),

    'policy-as-code': t(
      p(
        '`准入`是对象写进 etcd 之前的最后一道关。它和鉴权回答的问题不同：鉴权看「谁在做什么」，准入看**对象本身长什么样**：特权容器、没写 limits、镜像没签名，都是在这一层被拦下来的。这一层分两块：Kubernetes 内置的插件，和以 webhook 形式接进来的外部组件。',
        '`PSA`（Pod Security Admission）是内置的那块，2025 年起替代了被删掉的 PodSecurityPolicy。它只有三档预置标准：`privileged` 什么都不管，`baseline` 挡住已知的提权途径（特权容器、hostPath、host 命名空间、额外 capability），`restricted` 再加上强化要求（非 root、丢掉所有 capability、seccomp、禁止提权）。开关是命名空间上的标签，三种模式各自独立：`enforce` 拦下来，`audit` 记日志，`warn` 回一条警告。只打 `warn` 而以为拦住了，是这一层最常见的误会。另一件要记住的：**PSA 只看 Pod**，违规的 Deployment 照样 apply 得进去，然后一个 Pod 都起不来，原因在 ReplicaSet 的事件里。',
        '`Kyverno` 是外部那块，管的是 PSA 表达不了的公司自定义规矩：必须有 owner 标签、镜像只能来自内网仓库、名字要符合约定。规则写在 `ClusterPolicy` 里，`validate.pattern` 是它自己那套结构匹配（`?*` 表示要有值，`!` 表示不能等于，`|` 是或），`validate.cel` 直接写 CEL 表达式。它是集群里的一个工作负载：停掉它，所有策略立刻失效，而 `kubectl get cpol` 照样看得见。能交给 PSA 的规则不要在这里重写一遍：上游发现新的提权途径时，PSA 会跟着升级，你的规则不会。',
        '供应链那条靠 `cosign`。要点是它签的是镜像的 **digest** 而不是 tag：换个 tag 指向同一个 digest，签名依然有效；tag 不变而 digest 变了，签名立刻失效。准入时由 Kyverno 的 `verifyImages` 拿公钥验。但这条保证的边界要说清楚：它只证明「这坨字节被某把私钥认过」，不证明镜像里没有漏洞，也不证明签它的人有资格签。所以密钥归属、轮转、以及 SBOM 与来源证明是配套的，只做验签的话，安全性就等于「有人签过」这四个字。'
      ),
      p(
        '`Admission` is the last gate before an object reaches etcd. It answers a different question from authorization: authorization looks at who is doing what, while admission looks at **what the object contains**: a privileged container, missing limits, an unsigned image. The layer splits in two: plugins built into Kubernetes, and external components wired in as webhooks.',
        '`PSA` (Pod Security Admission) is the built-in half, replacing the removed PodSecurityPolicy. It offers exactly three preset levels: `privileged` checks nothing, `baseline` blocks known escalation paths (privileged containers, hostPath, host namespaces, extra capabilities), and `restricted` adds hardening (non-root, drop all capabilities, seccomp, no privilege escalation). The switch is a namespace label, and the three modes are independent: `enforce` blocks, `audit` records, `warn` returns a warning. Labelling only `warn` and believing it blocks is the classic mistake here. Also remember that **PSA only inspects Pods**: a violating Deployment applies cleanly and then yields no pods, with the reason sitting in the ReplicaSet events.',
        '`Kyverno` is the external half, covering what PSA cannot express: an owner label must exist, images must come from the internal registry, names must follow a convention. Rules live in a `ClusterPolicy`; `validate.pattern` is its own structural matching (`?*` requires a value, `!` negates, `|` is or) and `validate.cel` takes CEL expressions directly. It runs as a workload in the cluster, so stopping it disables every policy while `kubectl get cpol` still lists them. Do not reimplement PSA rules here: when upstream learns of a new escalation path, PSA follows on upgrade and your copy does not.',
        'The supply-chain rule uses `cosign`. The key fact is that it signs the image **digest**, not the tag: retagging the same digest keeps the signature valid, while pushing new content under the same tag invalidates it immediately. At admission time Kyverno `verifyImages` checks it with the public key. Be clear about the boundary of that guarantee: it proves these bytes were vouched for by some private key, not that the image is free of vulnerabilities nor that the signer was entitled to sign. Key custody, rotation, SBOMs, and build provenance go with it; signature checking alone guarantees only that somebody signed.'
      )
    ),

    'external-secrets': t(
      p(
        '先说清楚一件常被误解的事：Kubernetes 的 `Secret` **不是加密的**，它只是 base64。`kubectl get secret -o yaml` 拿到的值，接一句 `base64 -d` 就是明文。Secret 在集群里唯一的保护是 RBAC，也就是「谁有权 get 它」。所以把口令写进 Secret 并不算「保护」了它，只是换了个地方放。',
        '更麻烦的是 GitOps 带来的矛盾：仓库要能被所有人读，密钥不能。把 Secret 的 YAML 提交进 Git，等于把明文分发给每一个有仓库权限的人，而且留在历史里删不掉。`External Secrets Operator` 的答案是让仓库里只放「去哪儿取」的说明：`SecretStore` 说去哪个密钥库、用什么身份，`ExternalSecret` 说取哪几个键、放进哪个 Secret。真值由控制器在集群里生成，谁都不用提交明文。',
        '外部密钥库这里用 `OpenBao`（Vault 改协议之后 fork 出来的开源版本）。它的 KV v2 引擎有一处容易绊人：挂载路径和读写路径不是一回事，引擎挂在 `kv/` 上时，`bao kv get kv/payments/db` 实际读的是 `kv/data/payments/db`。SecretStore 里的 `path` 指的是挂载路径，`remoteRef.key` 里就不要再重复写它。另外 KV v2 保留版本历史，读到的默认是最新一版。',
        '认证方式的选择比工具选择更要紧。用静态令牌是个死循环：为了保护密钥，你得先保护一把能读所有密钥的令牌，而那把令牌只能存在集群里的另一个 Secret 里。`Kubernetes 认证`跳出了这个循环：身份由集群自己签发、短期有效、绑定到具体的 ServiceAccount，泄露一个 Pod 的 token 也只拿得到那个 SA 的权限。云上的 IRSA 与 Workload Identity 是同一思路的不同实现。最后记住 ESO 同步出来的 Secret 归控制器管：手改会被下一轮同步盖回去，`refreshInterval` 决定这一轮有多久。'
      ),
      p(
        'Start with a common misconception: a Kubernetes `Secret` is **not encrypted**, it is base64. Take the value from `kubectl get secret -o yaml`, pipe it through `base64 -d`, and there is the plaintext. The only protection a Secret has inside the cluster is RBAC, meaning who may get it. Putting a password into a Secret does not protect it, it relocates it.',
        'GitOps sharpens the problem: the repository must be readable by everyone and secrets must not be. Committing Secret YAML distributes plaintext to everyone with repository access and leaves it in history where deleting does not help. The `External Secrets Operator` answers by keeping only the instructions in Git: a `SecretStore` says which vault and which identity, an `ExternalSecret` says which keys to fetch into which Secret. The controller materialises the real values in the cluster and nobody commits plaintext.',
        'The external store here is `OpenBao`, the open-source fork created after Vault changed its licence. Its KV v2 engine trips people on paths: the mount path and the read path differ, so with the engine at `kv/`, `bao kv get kv/payments/db` actually reads `kv/data/payments/db`. In a SecretStore the `path` field is the mount, so `remoteRef.key` should not repeat it. KV v2 also keeps version history, and a read returns the latest version by default.',
        'Choosing the authentication method matters more than choosing the tool. A static token is circular: protecting your secrets requires protecting a token that reads all of them, and that token can only live in another Secret in the cluster. `Kubernetes auth` breaks the circle, because identity is issued by the cluster, short lived, and bound to a specific ServiceAccount, so a leaked pod token buys only that ServiceAccount permissions. IRSA and Workload Identity are the same idea in the clouds. Finally, the Secret ESO produces belongs to the controller: hand edits are overwritten on the next sync, and `refreshInterval` decides how long that takes.'
      )
    ),

    'metrics-and-alerts': t(
      p(
        '`Prometheus` 是**拉**模型：它按配置找到一批目标，每隔一段时间（默认 15 秒）去每个目标的 `/metrics` 上采一次。数据模型很小：一条`序列`由指标名加一组标签唯一确定，值按时间点存。这个模型带来两个直接后果：两次采样之间发生的事看不见（只活十秒的 Pod 可能一个点都没有），以及目标挂掉之后它此前的指标还会在图上停留一个回看窗口（默认五分钟）才消失。',
        '在 Kubernetes 里，采集配置写成 `ServiceMonitor`：按标签选中一批 Service，去它们后面的 Pod 上拉。这里有个**两层选择器**的坑：Prometheus 实例自己有一个 `serviceMonitorSelector`，先由它选中 ServiceMonitor，再由 ServiceMonitor 的 `selector` 选中 Service。少配任何一层的结果都是一条指标都采不到，而两个对象看起来都完全正常。`up` 这个指标是 Prometheus 自己合成的，不来自目标，它是判断「采不采得到」的第一手依据。',
        '`PromQL` 里最要紧的区分是 `counter` 与 `gauge`。counter 只增不减（请求总数、错误总数），直接看它的值没有意义，要用 `rate(x[5m])` 求每秒增量；gauge 可以上下浮动（内存、队列长度），直接看瞬时值。错误率是**两个 rate 相除**：`sum(rate(errors[5m])) by (job) / sum(rate(total[5m])) by (job)`。两侧必须聚合到同一组标签上，否则配不上，表达式返回空，而返回空的告警永远不会触发，也不会报错。另外比较运算符是`过滤`不是求布尔值：`up == 0` 返回的是那些确实为 0 的序列。',
        '告警规则写在 `PrometheusRule` 里，`expr` 加 `for`。`for` 的意思是「条件持续成立这么久才真的告警」，中间处于 `pending`；条件一旦不成立就整条清掉，所以抖动不会累积。两条实践值得记：一是 apiserver 收 PrometheusRule 时**不校验表达式**，写错了照样收下，所以上线前要 `promtool check rules` 加 `promtool query instant` 各跑一遍；二是`告症状不告原因`：「错误率超过 5%」用户感受得到，「某个 Pod 内存高」不一定有影响，按原因告警的系统很快就没人看了。'
      ),
      p(
        '`Prometheus` is a **pull** model: it discovers a set of targets and scrapes `/metrics` on each at a fixed interval, 15 seconds by default. The data model is tiny: a `series` is identified by a metric name plus a set of labels, with values stored per timestamp. Two consequences follow directly. Anything happening between scrapes is invisible, so a pod that lived ten seconds may contribute no samples at all. And after a target dies, its earlier metrics linger for one lookback window (five minutes by default) before disappearing.',
        'In Kubernetes the scrape config is a `ServiceMonitor`: select Services by label, scrape the pods behind them. There is a **two-selector** trap here: the Prometheus instance has its own `serviceMonitorSelector` which picks ServiceMonitors, and each ServiceMonitor has a `selector` which picks Services. Missing either layer collects nothing, while both objects look perfectly healthy. The `up` metric is synthesised by Prometheus rather than coming from the target, which makes it the first thing to check when nothing appears.',
        'The distinction that matters most in `PromQL` is `counter` versus `gauge`. A counter only increases (requests served, errors returned) and its raw value means little; use `rate(x[5m])` for per-second increase. A gauge moves both ways (memory, queue depth) and is read directly. An error rate is **one rate divided by another**: `sum(rate(errors[5m])) by (job) / sum(rate(total[5m])) by (job)`. Both sides must be aggregated to the same label set or they will not match and the expression returns nothing, and an alert whose expression returns nothing never fires and never complains. Note also that comparison operators `filter` rather than produce booleans: `up == 0` returns the series that really are zero.',
        'Alerting rules live in a `PrometheusRule` as an `expr` plus a `for`. The `for` means the condition must hold that long before the alert really fires, staying `pending` meanwhile, and the whole thing clears the moment the condition stops holding, so blips do not accumulate. Two practices worth keeping: the apiserver does **not validate expressions** when accepting a PrometheusRule, so run `promtool check rules` and `promtool query instant` before shipping; and `alert on symptoms, not causes`, because users feel "error rate above 5%" while "this pod uses a lot of memory" may mean nothing, and cause-based alerting quickly stops being read.'
      )
    ),

    'progressive-delivery': t(
      p(
        'Deployment 的滚动更新只回答一个问题：新的 Pod 起来了没有。而「起来了」和「好用」是两回事：一个进程活着、探针全过、日志干净，但大半请求返回 500 的版本，滚动更新会毫不犹豫地把它铺到 100%。`渐进式发布`补的就是这一段：把「什么叫好」写进发布流程本身。',
        '`Argo Rollouts` 用 `Rollout` 替代 Deployment（是替代不是补充，一个工作负载只能由其中之一管）。它多出来的是 `strategy.canary.steps`：一串按顺序执行的步骤。`setWeight` 调整金丝雀占多少副本，`pause` 停一下（带 `duration` 就是等那么久，不带就是无限期等人来 `promote`），`analysis` 起一次分析。控制器用 `status.currentStepIndex` 记着走到第几步，每步做完才往前挪一格。',
        '`AnalysisTemplate` 描述判据：一条 PromQL 加一个 `successCondition`（形如 `result < 0.05`）。任何一条不满足，整个发布`中止`。要特别注意中止的含义，它不是「停在原地」，而是**回到稳定版本**：金丝雀缩到 0，稳定版拉回满副本。这也是自动回滚的实现，不需要人介入。另一个必写的字段是 `initialDelay`：金丝雀刚起来的那几秒计数器还是 0、采样点不够两个，这时候算出来的是稳定版的错误率，看着很好，然后就把坏版本放行了。',
        '判据本身要写成`比例`而不是计数。`sum(rate(errors[5m])) > 0` 会让任何一个 5xx 都毁掉发布，而真实系统永远有零星的 5xx，结果是没有版本发得出去，最后有人把分析这一步删掉。还有一条实践：**金丝雀的判据应该和告警的判据是同一个表达式**，否则会出现「发布时看着没事、上线后告警响」，那说明「什么叫坏」被定义了两遍。',
        '另一半是节点维护。`PodDisruptionBudget` 管的是`自愿中断`，也就是有人主动发起的那些：节点维护、缩容、驱逐。`kubectl drain` 走的是 Pod 的 `eviction` 子资源，会先问 PDB，违反就收到 429 并重试；而 `kubectl delete pod` 走的是普通删除，谁也拦不住。这是两条命令行为不同的根源。PDB 保证的是「不会被人为打空」，不是「永远有 N 个副本」：节点掉电、OOMKill、被抢占都不在它管辖内。还有一个反效果要避开：`minAvailable` 写成和副本数一样大，任何驱逐都会被拒，节点永远维护不了。'
      ),
      p(
        'A rolling update answers one question: did the new pods start. Starting is not the same as working, and a version whose process is alive, probes pass, and logs are clean while three requests in ten return 500 will be spread to 100% without hesitation. `Progressive delivery` fills that gap by writing "what good looks like" into the release process itself.',
        '`Argo Rollouts` replaces a Deployment with a `Rollout` (replaces, not supplements: a workload is managed by one or the other). What it adds is `strategy.canary.steps`, an ordered list. `setWeight` sets how many replicas are canary, `pause` stops (with a `duration` it waits that long, without one it waits indefinitely for a `promote`), and `analysis` runs an evaluation. The controller tracks progress in `status.currentStepIndex`, advancing only when a step completes.',
        'An `AnalysisTemplate` describes the criterion: a PromQL query plus a `successCondition` such as `result < 0.05`. If any metric fails, the rollout `aborts`. Note what aborting means: not stopping in place but **returning to the stable version**, scaling the canary to zero and stable back to full. That is the automatic rollback, with nobody in the loop. The other field you must write is `initialDelay`: in the first seconds a canary counter is still zero with fewer than two samples, so what you compute is the stable version error rate, which looks great and lets the bad version through.',
        'The criterion must be a `ratio` rather than a count. `sum(rate(errors[5m])) > 0` fails a release on any single 5xx, real systems always have a few, nothing ever ships, and eventually somebody deletes the analysis step. One more practice: **the canary criterion and the alerting criterion should be the same expression**, or you get "looked fine during rollout, paged afterwards", which means "bad" was defined twice.',
        'The other half is node maintenance. A `PodDisruptionBudget` governs `voluntary` disruptions, the ones somebody initiates: maintenance, scale-down, eviction. `kubectl drain` goes through the Pod `eviction` subresource, which consults the PDB and returns 429 with a retry when it would be violated, while `kubectl delete pod` is an ordinary delete that nothing stops. That is why the two commands behave differently. A PDB guarantees nobody drains you to zero, not that N replicas always exist: power loss, OOMKill, and preemption are all outside its remit. And avoid the counterproductive setting where `minAvailable` equals the replica count, because then every eviction is refused and the node can never be maintained.'
      )
    ),

    'disaster-recovery': t(
      p(
        '接手一个系统之后最该问的一句话不是「有没有备份」，是「上次从备份恢复是什么时候」。这两句差得很远：备份任务天天绿，不代表那个桶里的东西能把服务拉起来。这一关要做的就是把第二句变成真的。',
        'Kubernetes 里的数据分两层，这一层的所有困惑都从这儿来。`PersistentVolumeClaim` 是一个**对象**，住在 apiserver 里；盘上的字节不在 apiserver 里，它们在存储后端上。所以把 apiserver 里的对象全导出来，得到的是一份完整的 YAML 和**零字节数据**。恢复出来是一个一模一样的空盘，而 `kubectl get pvc` 看不出空盘和满盘的区别。',
        '要把字节也带上，得靠 `CSI 卷快照`。三个对象：`VolumeSnapshotClass` 说谁来拍、拍完怎么处置，`VolumeSnapshot` 是应用侧的一次请求，`VolumeSnapshotContent` 是存储上真正那张。快照是`时间点`：拍完之后往盘里再写什么都跟它无关。另外要留意拍快照的是 `snapshot-controller` 这个工作负载，它和 CSI 驱动是两个东西，只装驱动的话 VolumeSnapshot 建得出来然后永远不就绪。',
        '`Velero` 把这两件事缝起来：它自己导出对象图放进桶里，卷数据则委托给 CSI 快照。缝的地方有一个标签：`velero.io/csi-volumesnapshot-class: "true"`。没有任何快照类打这个标签时，Velero **不报错**，备份照样 `Completed`，只是 warnings 加一，卷数据一个字节都没进去。所以判断一次备份好不好，要看的是 `volumeSnapshotsCompleted` 而不是 `phase`。',
        '恢复这一侧有一条默认行为要记住：Velero **跳过**已经存在的对象。所以往原地恢复的结果通常是「跑完了，phase 是 PartiallyFailed，集群一点没变」，很容易被读成「恢复成功，只是有点小问题」。演练要用 `--namespace-mappings` 恢复到一个新命名空间，进去读一行真数据出来对一下，再把它删掉。',
        '最后是灾难本身。`kubectl delete namespace` 不只是删掉一堆对象，它会一起带走 PVC；回收策略是 `Delete` 的话，盘和盘上的字节跟着消失，apiserver 里再也查不到它存在过。一条命令、一个词的差别，带走的是整个环境，这也正是备份存在的理由。'
      ),
      p(
        'The first question to ask about a system you have just inherited is not whether it has backups, it is when somebody last restored from one. Those are far apart: a backup job going green every day says nothing about whether the contents of that bucket can bring the service back. This stage is about making the second sentence true.',
        'Data in Kubernetes lives on two levels, and every confusion here comes from that split. A `PersistentVolumeClaim` is an **object** in the apiserver; the bytes on the volume are not, they live on the storage backend. So exporting every object from the apiserver gives you a complete set of YAML and **zero bytes of data**. What comes back is an identical empty disk, and `kubectl get pvc` shows no difference between an empty one and a full one.',
        'Carrying the bytes as well takes `CSI volume snapshots`. Three objects: a `VolumeSnapshotClass` says who takes them and what happens afterwards, a `VolumeSnapshot` is the request from the application side, and a `VolumeSnapshotContent` is the real snapshot on the storage system. A snapshot is a `point in time`: whatever is written to the volume afterwards is not in it. Note also that snapshots are taken by the `snapshot-controller` workload, which is separate from the CSI driver: install only the driver and a VolumeSnapshot will be created and then never become ready.',
        '`Velero` stitches the two together: it exports the object graph into the bucket itself and delegates volume data to CSI snapshots. The seam is a label, `velero.io/csi-volumesnapshot-class: "true"`. When no snapshot class carries it, Velero does **not** fail. The backup still reports `Completed`, just with one more warning, and not a byte of volume data goes in. So the health of a backup is read from `volumeSnapshotsCompleted`, not from `phase`.',
        'On the restore side there is one default worth memorising: Velero **skips** resources that already exist. Restoring in place therefore usually means "it ran, phase is PartiallyFailed, and nothing in the cluster changed", which reads a lot like "restored, with minor issues". Drill with `--namespace-mappings` into a fresh namespace, read a row of real data out of it, and delete it afterwards.',
        'Finally the disaster itself. `kubectl delete namespace` does not just remove a pile of objects, it takes the PVCs with it; with a `Delete` reclaim policy the volume and every byte on it go too, leaving no record in the apiserver that they ever existed. One command, one word of difference, and an entire environment is gone, which is the whole reason backups exist.'
      )
    ),

    'elastic-capacity': t(
      p(
        '机器从哪儿来，是这一层的第一个问题。内网集群没有云厂商的弹性伸缩组，机器要么是人手装的，要么是 `Cluster API` 声明出来的。它的形状和工作负载那一套故意长得一样：`MachineDeployment` 对 Deployment，`MachineSet` 对 ReplicaSet，`Machine` 对 Pod。改副本数就是加机器，换模板就是换一批。',
        'Machine 和 Node 是两个对象，这个区别要记牢。Machine 是「我要一台机器」，Node 是「这台机器上的 kubelet 报到了」。中间隔着装机时间，表现为三段：`Provisioning`（provider 在造）、`Provisioned`（Node 对象出现但 NotReady）、`Running`（kubelet 报到，调度器才看得见它）。`kubectl get machines` 里 NODENAME 那一列在第一段是空的。另外机器的规格写在 infra 模板上，不在 MachineDeployment 上，「我改了副本数为什么新机器还是老规格」的答案就在这个分层里。',
        '`cluster-autoscaler` 做的事只有两件，而且都不看负载。扩容：看到**调度不上**的 Pod，问一句「加一台这种机器，它能落上去吗」，能就加，不能就一台都不加。所以一个请求 32 核的 Pod 在最大 8 核的池子里会永远 Pending 而机器数纹丝不动。这不是坏了，是它算出来加了也没用，理由写在 Pod 的 `NotTriggerScaleUp` 事件里。缩容：看到利用率低的节点，问一句「上面的 Pod 挪得走吗」。',
        '它怎么知道哪些机器组归它管？靠 MachineDeployment 上的两个注解：`cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size` 和 `...-max-size`。没打注解的机器组它**看都不看**，这是「伸缩器装了但不工作」最常见的原因。上限不是调优参数，它是闸：一个写错的副本数或者一段死循环的重试，能让机器一台台加到天亮。',
        '缩容那一侧有三道门：利用率够低、闲得够久（默认十分钟）、上面的 Pod 挪得走。第三道最容易卡住，而且卡住的时候伸缩器是沉默的。能钉住一台机器的东西有：PDB 不允许再驱逐、Pod 没有属主（删了就不会被重建）、以及打了 `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` 的 Pod。最后这一条最阴：加的时候是为了保护某个关键任务，忘了摘，那台机器就永远还不回去了。',
        '最后分清两件常被混着说成「自动扩容」的事：`HPA` 加的是**副本**，看的是指标；伸缩器加的是**机器**，看的是调度结果。顺序是 HPA 先加出一批调度不上的 Pod，伸缩器再为它们加机器。还要记住扩容有代价：装机要几分钟，这几分钟里请求是排队的，所以真要扛突发流量得靠预留容量，不能指望伸缩器。'
      ),
      p(
        'Where machines come from is the first question at this layer. An intranet cluster has no cloud autoscaling group: machines are either installed by hand or declared through `Cluster API`. Its shape deliberately mirrors the workload API: `MachineDeployment` to Deployment, `MachineSet` to ReplicaSet, `Machine` to Pod. Changing a replica count adds machines; changing the template replaces a batch of them.',
        'Machine and Node are two objects, and the difference matters. A Machine is "I want a machine"; a Node is "the kubelet on that machine has reported in". Between them sits provisioning time, visible as three phases: `Provisioning` (the provider is building it), `Provisioned` (the Node object exists but is NotReady), and `Running` (the kubelet reported and the scheduler can finally see it). The NODENAME column of `kubectl get machines` is empty during the first phase. Note also that machine size lives on the infra template, not on the MachineDeployment, which is the answer to "I changed the replica count, why are the new machines still the old size".',
        '`cluster-autoscaler` does exactly two things, and neither of them looks at load. Scaling up: for pods that **cannot be scheduled**, it asks whether one more machine of this shape would fit them, and adds machines only if the answer is yes. A pod requesting 32 cores in a pool whose largest machine is 8 will therefore stay Pending forever while the machine count never moves. That is not a malfunction, it is the answer to the question, and the reason is recorded in a `NotTriggerScaleUp` event on the pod. Scaling down: for underutilised nodes, it asks whether the pods on them can move.',
        'How does it know which node groups are its business? Two annotations on the MachineDeployment: `cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size` and `...-max-size`. A group without them is invisible to it, which is the usual reason an installed autoscaler does nothing. The maximum is not a tuning parameter but a brake: a wrong replica count or a retry loop can walk a group up machine by machine all night.',
        'Scaling down has three gates: utilisation low enough, idle long enough (ten minutes by default), and the pods on the node able to move. The third is the one that jams, and the autoscaler is silent when it does. Things that pin a machine: a PDB that allows no further eviction, a pod with no controller (delete it and nothing recreates it), and any pod annotated `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`. That last one is the sneakiest, added to protect something important and then forgotten, and the machine never goes back.',
        'Finally, separate the two things routinely called autoscaling. `HPA` adds **replicas** based on metrics; the autoscaler adds **machines** based on scheduling outcomes. The order is that HPA produces pods that cannot be scheduled and the autoscaler then provides machines for them. And remember that scaling up costs time: provisioning takes minutes during which requests queue, so genuine burst traffic is absorbed by headroom you kept, not by the autoscaler.'
      )
    ),

    'write-an-operator': t(
      p(
        '到这一关为止，你见过的每一个东西都是同一个形状：一个描述期望的对象，加一个把期望变成现实的控制器。Deployment 是这样，Gateway、Certificate、Rollout、Backup、MachineDeployment 全是这样。这一关要做的就是自己写一个，从而看清这个形状本身。',
        '`CustomResourceDefinition` 负责前半段：让 apiserver 多认识一种类型。认识之后，REST 端点、watch、RBAC 里的资源名、`kubectl get`、YAML apply，全套白送，所以写 Operator 的重点从来不在 CRD 上。CRD 上真正要想清楚的只有几件：`scope` 是命名空间级还是集群级、要不要 `subresources.status`（不声明的话 status 不是子资源，写 status 会连带改到 spec）、以及 `additionalPrinterColumns`，因为 `kubectl get` 打出来什么样，决定了这个自助入口好不好用。',
        '后半段是 `reconcile`。它最容易被误解成事件处理器，其实它收到的只有一句「这个对象该看一眼了」，不告诉你变的是什么。所以正确的写法永远是`照着现在的 spec 把世界收敛过去`，而不是「根据这次变化做个增量」。这条决定了它必须**幂等且可重入**：全量 resync、别人改坏了、你自己写 status 触发的那一次，都会让它被重复调用。',
        '要想修偏差，就得 watch 自己造出来的那个类型。只 watch 主类型的话，别人手工改坏了你造的东西，你要等到下一次有人动主对象才会发现，那不叫持续收敛。而顺着`属主引用`找回主对象，正是「附属对象变了该 reconcile 谁」的答案，所以属主引用不只是为了删除。',
        '删除通常不用写代码：属主引用挂对了，垃圾回收会把附属对象一起带走。真正需要 `finalizer` 的是**集群外面的状态**：你在别处开了一个 DNS 记录、一个云上的桶，这些东西 apiserver 不知道，只能靠 finalizer 拦住删除、清理完再放行。代价是 finalizer 摘不掉的对象会永远卡在 Terminating。',
        '最后是 `status` 的两条纪律。一是 status 只放**观察到的事实**，随时可以重新算出来；期望放在 spec 里，只有人能改。放反了的话，status 一被清掉控制器就不知道该收敛到哪儿。二是只在**真的变了**的时候才写 status：写 status 会产生一个 watch 事件，事件触发 reconcile，reconcile 又写 status，每次都写一个新时间戳的控制器会把自己吵醒，CPU 跑满而且什么都没做。'
      ),
      p(
        'Everything you have met up to this point has the same shape: an object describing desired state, plus a controller that makes it real. Deployment is that shape, and so are Gateway, Certificate, Rollout, Backup, and MachineDeployment. This stage is about writing one yourself, so the shape itself becomes visible.',
        'A `CustomResourceDefinition` covers the first half: it teaches the apiserver one more type. After that, REST endpoints, watch, the resource name in RBAC, `kubectl get`, and YAML apply all come free, which is why writing an operator is never really about the CRD. The few things worth thinking about on it: `scope` (namespaced or cluster), whether to declare `subresources.status` (without it status is not a subresource and writing status also rewrites spec), and `additionalPrinterColumns`, because what `kubectl get` prints decides whether the self-service entry point is pleasant to use.',
        'The second half is `reconcile`. It is easily mistaken for an event handler, but all it receives is "take another look at this object", never what changed. The correct shape is therefore always `converge the world to the spec as it is now`, not "apply a delta for this change". That is what makes it necessarily **idempotent and re-entrant**: a full resync, somebody editing your output, and the pass your own status write triggered will all call it again.',
        'Repairing drift requires watching the kind you create. Watch only the primary kind and a hand-edited child stays broken until somebody happens to touch the primary object again, which is not continuous convergence. And following the `owner reference` back to the primary object is exactly how "a child changed, whom do I reconcile" is answered, so owner references are not only about deletion.',
        'Deletion usually needs no code: with owner references attached, garbage collection takes the children with the parent. What genuinely needs a `finalizer` is state **outside** the cluster, a DNS record or a bucket you created elsewhere that the apiserver knows nothing about; a finalizer holds the deletion until you have cleaned it up. The price is that an object whose finalizer never clears sits in Terminating forever.',
        'Finally, two rules about `status`. It holds **observed fact** only, recomputable at any time; desire lives in spec where only humans change it. Reverse them and the controller no longer knows what to converge to once status is cleared. And write status only when something actually changed: writing status produces a watch event, the event triggers reconcile, and reconcile writes status again, so a controller that stamps a fresh timestamp every pass wakes itself up forever, burning CPU and achieving nothing.'
      )
    ),

    'take-over-cluster': t(
      p(
        '`Kubernetes` 是一套管理容器的系统。你不直接告诉它「在哪台机器上起一个进程」，而是声明「我要三个这样的副本」，它自己去凑够三个。这套「声明期望、由控制器不断向期望收敛」的做法，是理解后面所有关卡的前提。',
        '和集群打交道的入口是 `kubectl`，它读一个叫 `kubeconfig` 的文件（默认在 `~/.kube/config`）来决定：连哪个集群（`cluster`，一个 API 地址）、用什么身份（`user`，一份凭据）、默认在哪个命名空间里操作（`namespace`）。这三样打包成一个 `context`，一份 kubeconfig 里可以有很多个 context，`current-context` 指着当前用哪个。',
        '一个人手里同时有生产、预发、测试几套环境是常态，所以「我现在连的是哪一套」是每次操作前都要确认的事。`kubectl config get-contexts` 列出全部，带星号的是当前那个；`kubectl config use-context <name>` 切换。切错了不会有任何提示，命令照样执行，只是打在了别的集群上。',
        '`节点`（Node）是集群里的一台机器。`kubectl get nodes` 列出它们和各自的状态；`Ready` 表示这台机器上的 kubelet 正常上报、可以接收工作负载。接手一个陌生集群，先看节点是最省事的健康检查：三台里挂了一台，很多现象都能从这里解释。'
      ),
      p(
        '`Kubernetes` manages containers. Instead of telling it "start a process on this machine", you declare "I want three replicas like this" and controllers keep working until three exist. That idea, declaring the desired state and letting controllers converge toward it, underpins every later stage.',
        'You talk to a cluster through `kubectl`, which reads a `kubeconfig` file (`~/.kube/config` by default) to decide which cluster to reach (`cluster`, an API endpoint), which identity to use (`user`, a credential), and which namespace to default to. Those three are bundled into a `context`; one kubeconfig can hold many contexts, and `current-context` selects the active one.',
        'Holding production, staging, and test environments at once is normal, so "which one am I on?" is a question to answer before every operation. `kubectl config get-contexts` lists them all with a star on the current one; `kubectl config use-context <name>` switches. Picking the wrong one produces no warning: commands still run, just against a different cluster.',
        'A `Node` is a machine in the cluster. `kubectl get nodes` lists them with their status; `Ready` means that machine’s kubelet is reporting in and can accept workloads. When inheriting an unfamiliar cluster, checking nodes first is the cheapest health check available: one dead node out of three explains a surprising number of symptoms.'
      )
    ),
  },
  'llm-from-scratch': {
    'byte-bpe': t(
      p(
        '模型不认识字符，只认识`整数`。把文本变成整数的那一步叫`分词`（tokenization），2026 年绝大多数模型用的是同一个算法：`字节对编码`（BPE，byte pair encoding）。',
        '为什么从`字节`开始而不是字符：从字符开始的话，你立刻要回答「表里放哪些字符」，中文有几万个、emoji 每年还在加，而漏掉一个就会出现「不认识的字符」。字节只有 256 个，任何文本都能表示，永远不会遇到未登录字符。这正是 Llama 3 与 GPT-4o 都用字节级 BPE 的原因。',
        '算法本身只有三步：把文本变成一串字节，这是初始词表；数一数哪一对相邻 token 出现得最多，把它合并成一个新 token；重复第二步直到词表到达目标大小。每次合并记下来就得到一张`merge 表`。编码时按这张表的顺序反复合并，解码时按 id 展开回字节再解 UTF-8。',
        '有一个细节必须提前定死：`平局`。「出现最多的那一对」经常不止一个，不定规则的话同一份语料两次训练会得到不同的词表，而两次都是对的。真实实现都会规定一个确定的顺序，我们的规则是先比频次，频次相同时取第一次出现位置更靠前的那一对。',
        '最后，这一关会跑得有点慢，纯 Python 的循环比编译语言慢两个数量级。这不是实现问题：HuggingFace 之所以把 `tokenizers` 用 Rust 重写，正是因为这一步在真实语料上要跑几个小时。'
      ),
      p(
        'A model does not see characters, only `integers`. Turning text into integers is `tokenization`, and in 2026 almost every model uses the same algorithm: `byte pair encoding` (BPE).',
        'Why start from `bytes` rather than characters: starting from characters forces you to answer "which characters go in the table", there are tens of thousands of Chinese ones and new emoji every year, and anything you miss becomes an unknown character. Bytes are only 256, can represent any text, and never produce an out-of-vocabulary symbol. That is why Llama 3 and GPT-4o both use byte-level BPE.',
        'The algorithm is three steps: turn the text into bytes, which is the initial vocabulary; count which adjacent pair occurs most often and merge it into a new token; repeat until the vocabulary reaches the target size. Recording every merge gives a `merge table`. Encoding replays that table in order; decoding expands ids back to bytes and decodes UTF-8.',
        'One detail must be pinned down first: `ties`. "The most frequent pair" is often not unique, and without a rule two runs over the same corpus produce different vocabularies while both are correct. Every real implementation fixes an order; ours is highest count first, and on a tie the pair whose first occurrence is earlier.',
        'Finally, this stage runs a little slowly, pure Python loops are two orders of magnitude slower than compiled code. That is not a flaw in the setup: HuggingFace rewrote `tokenizers` in Rust precisely because this step takes hours on real corpora.'
      )
    ),
    baselines: t(
      p(
        '后面十几关的门槛都是「loss 要低于某个数」。而一个 loss 是好是坏，`单看它是判断不了的`，取决于词表多大、语料多规整。所以第一件事是把地板测出来。',
        '三条基线，从笨到不那么笨。`均匀基线`假设每个 token 等概率，交叉熵恰好是 `ln(V)`。`unigram 基线`只看每个 token 出现的频率，不看上下文。`bigram 基线`只看前一个 token，按转移频率给出预测。',
        'bigram 是最要紧的那一条：它代表「完全不理解语言、只记住了相邻搭配」能达到的水平。一个模型如果打不穿 bigram，说明它的注意力根本没在工作，后面几关的门槛正是建立在这个判断上的。',
        '`交叉熵`是 `-1/N · Σ log p(实际出现的那个 token)`，单位是 nat。`困惑度`是 `exp(交叉熵)`，直觉是「模型平均在多少个候选里犹豫」；均匀分布的困惑度恰好等于词表大小。',
        '还有一件必须做的事是`平滑`。留出集里一定会出现训练集没见过的搭配，不平滑的话概率是 0、对数是负无穷，整条基线就废了。这里用加一平滑：`p(b|a) = (count(a,b) + 1) / (count(a) + V)`，注意分母也要加。'
      ),
      p(
        'Most gates from here on read "loss below X". But a loss on its own `tells you nothing`, it depends on vocabulary size and how regular the corpus is. So the first job is to measure the floor.',
        'Three baselines, from dumb to less dumb. The `uniform baseline` assumes every token is equally likely, giving cross-entropy exactly `ln(V)`. The `unigram baseline` uses each token frequency and ignores context. The `bigram baseline` looks only at the previous token and predicts from transition counts.',
        'Bigram is the one that matters: it is what "understands nothing, merely memorised adjacent pairs" achieves. A model that cannot beat bigram has attention that is not working at all, several later gates rest on exactly that judgement.',
        '`Cross-entropy` is `-1/N · Σ log p(the token that actually occurred)`, measured in nats. `Perplexity` is `exp(cross-entropy)`, read as "how many candidates is the model hesitating between"; a uniform model has perplexity equal to the vocabulary size.',
        'One more thing is mandatory: `smoothing`. The held-out set will contain pairs the training split never saw, and without smoothing the probability is zero, the logarithm is negative infinity, and the baseline is unusable. We use add-one smoothing: `p(b|a) = (count(a,b) + 1) / (count(a) + V)`, and note that the denominator is smoothed too.'
      )
    ),
    'causal-attention': t(
      p(
        '注意力回答一个很具体的问题：预测第 t 个位置时，前面每个位置各应该占多大权重。做法是给每个位置算三样东西,`查询`（query）、`键`（key）、`值`（value），都是同一个向量乘不同的权重矩阵得到的。',
        '第 i 个位置的查询和第 j 个位置的键做点积，得到一个`分数`,它衡量「i 有多想看 j」。分数除以 `sqrt(head_dim)` 之后过 softmax 变成一组和为 1 的权重，再拿这组权重去对所有位置的值做加权求和。这就是全部。',
        '除以 `sqrt(head_dim)` 不是装饰。点积的方差随维度线性增长，不缩放的话 softmax 很快进入饱和区：一个位置拿到接近 1 的权重、其余接近 0，梯度也就跟着消失。缩放让分数的方差回到 1 附近。',
        '`因果掩码`是自回归模型的命门：预测第 t 个位置时只许看 `0..t`，看到 `t+1` 就是看到了答案。漏掉它的模型训练 loss 会明显更低、曲线更漂亮，而生成时一个字都对不上,这个错在任何 loss 曲线上都看不出来。',
        '掩码有两种做法。一种是给被掩的分数加一个很大的负数，softmax 之后它们接近 0；另一种是让它们根本不参与 softmax，于是概率是`硬 0`。我们用后者:因果性要靠「改未来、看现在有没有变」来验，而逐位比较容不下 1e-30 这样的残留。'
      ),
      p(
        'Attention answers a specific question: when predicting position t, how much weight should each earlier position get? Each position produces three things,a `query`, a `key` and a `value`, all obtained by multiplying the same vector by different weight matrices.',
        'The query at position i dotted with the key at position j gives a `score` measuring how much i wants to look at j. Divide the scores by `sqrt(head_dim)`, push them through softmax to get weights summing to 1, and take the weighted sum of all values. That is the whole mechanism.',
        'The `sqrt(head_dim)` division is not decoration. Dot-product variance grows linearly with dimension, and without scaling softmax saturates quickly: one position takes nearly all the weight, the rest take almost none, and gradients vanish with them. Scaling brings the score variance back near 1.',
        'The `causal mask` is what makes an autoregressive model work: predicting position t may look at `0..t` only, and seeing `t+1` means seeing the answer. A model that omits it has a visibly lower training loss and a prettier curve while generating nothing usable,and no loss curve reveals this.',
        'There are two ways to mask. One adds a large negative number to the masked scores so softmax pushes them near zero; the other excludes them from softmax entirely so the probability is a `hard zero`. We use the latter: causality is verified by changing the future and checking that the present is bit-identical, and a bit-exact comparison has no room for a 1e-30 remainder.'
      )
    ),
    'multi-head-gqa': t(
      p(
        '一个头只能表达一种「看哪里」的模式。`多头注意力`把维度切成几份，每份各算一套查询/键/值，各自注意各自的东西，最后把结果拼起来再过一个输出投影。切分是免费的:总的计算量和一个大头一样，但表达能力强得多。',
        '`head_dim = dim // n_head`。八个头、每个 64 维的模型，和一个 512 维的单头，浮点运算量相同。',
        '`GQA`（分组查询注意力）动的是键和值:让若干个查询头**共用**一套键值。查询头仍然是 8 个，键值头可以只有 2 个,每 4 个查询头共享一份 kv。',
        '这么做的理由在推理侧。解码时每生成一个 token 都要读一遍整个 `KV cache`，而 cache 的大小正比于键值头数。8 个头减到 2 个，cache 就小 4 倍,在解码这种访存瓶颈的场景里是实打实的加速，而质量几乎没掉。Llama 2 70B 起就是这么配的。',
        '`n_kv_head = n_head` 时 GQA 退化成普通多头；`n_kv_head = 1` 时叫 MQA（多查询注意力），省得最多但质量掉得也明显。2 到 8 之间是常见的折中。'
      ),
      p(
        'A single head can express only one pattern of "where to look". `Multi-head attention` splits the dimension into groups, computes a separate query/key/value set for each, lets each attend independently, then concatenates and applies an output projection. The split is free: total compute matches one large head, while expressiveness is much greater.',
        '`head_dim = dim // n_head`. Eight heads of 64 dimensions each cost the same floating-point work as one head of 512.',
        '`GQA` (grouped-query attention) changes the keys and values: several query heads **share** one key/value set. There can still be 8 query heads while only 2 key/value heads exist,every 4 query heads share one KV set.',
        'The reason lives on the inference side. Decoding reads the entire `KV cache` for every generated token, and the cache scales with the number of key/value heads. Going from 8 to 2 makes it four times smaller,a real speedup in a memory-bound regime, at almost no quality cost. Llama 2 70B onward ships this configuration.',
        'With `n_kv_head = n_head` GQA degenerates to ordinary multi-head; with `n_kv_head = 1` it is MQA (multi-query attention), which saves the most but visibly costs quality. Values between 2 and 8 are the usual compromise.'
      )
    ),
    'rope': t(
      p(
        '注意力本身对顺序一无所知。把一句话的词打乱重排，注意力算出来的结果只是跟着换个位置,它看不出「谁在前谁在后」。所以位置信息必须另外喂进去。',
        '早期做法是`绝对位置编码`：给第 0 个位置配一个向量、第 1 个配另一个，加到词向量上。它能用，但有个硬伤,训练时只见过 0..1023 这些位置，第 1024 个位置的编码从没见过，模型到那里就废了。',
        '`RoPE`（旋转位置编码）换了个思路：不加，而是`转`。把每个头的维度两两配对当成复平面上的点，第 p 个位置就整体转 p·θ 的角度。',
        '妙处在于点积。两个向量各自转过 i·θ 和 j·θ 之后再做点积，结果只跟 `i − j` 有关,转的绝对角度抵消掉了。于是注意力天然看到的是`相对距离`，而不是绝对下标。',
        '不同的维度对配不同的频率：低维转得快，管相邻几个位置；高维转得慢，管几百上千的尺度。合起来像一把刻度从毫米到米的复合尺子。频率的底数叫 `base`，原论文取 10000,把它调大再微调一小段，就是今天把上下文从几千拉到十万的常规手段。',
        'RoPE 只转`查询`和`键`,分数是它们算出来的，位置该影响的是「看哪里」。`值`不转：值是取回来的内容，内容不该带着位置跑。'
      ),
      p(
        'Attention itself knows nothing about order. Shuffle a sentence and its outputs merely move with the tokens,it cannot tell what came first. Position has to be supplied separately.',
        'The early approach was `absolute position embeddings`: a vector for position 0, another for position 1, added to the token embedding. It works, with one hard limitation,training only ever saw positions 0..1023, so position 1024 has an embedding the model never learned, and everything breaks there.',
        '`RoPE` (rotary position embedding) takes another route: it rotates instead of adding. Pair up the dimensions of each head as points on the complex plane, and rotate position p by an angle of p·θ.',
        'The trick is in the dot product. Rotate two vectors by i·θ and j·θ, take their dot product, and the result depends only on `i − j`,the absolute angles cancel. Attention therefore sees `relative distance` rather than absolute indices.',
        'Different dimension pairs get different frequencies: low dimensions rotate fast and cover neighbours; high dimensions rotate slowly and cover hundreds or thousands of positions. Together they form a ruler graduated from millimetres to metres. The frequency base is called `base`, and the original paper used 10000,enlarging it and fine-tuning briefly is the standard way today to stretch context from thousands to a hundred thousand.',
        'RoPE rotates only `queries` and `keys`,they produce the scores, and position should shape where to look. `Values` are left alone: a value is the content fetched, and content should not carry a position with it.'
      )
    ),
    'rmsnorm-prenorm': t(
      p(
        '深网络训不动的经典原因是激活的量级失控:一层放大一点，二十层之后就是几个数量级。`归一化`是把每层的输入重新拉回一个固定的尺度。',
        '`LayerNorm` 的做法是减均值、除标准差，再乘一个可学的增益、加一个可学的偏置。`RMSNorm` 砍掉了减均值和偏置，只除均方根 `sqrt(mean(x²))`。省下大约 7% 的开销，效果基本持平,Llama 之后这就是默认。',
        '一个能拿来验证的推论：给输入整体加一个常数，LayerNorm 的输出不变（均值被减掉了），RMSNorm 的输出会变。写错了哪一个，这个性质会当场告诉你。',
        '归一化`放在哪`比用哪一种更要紧。`post-norm` 是 `norm(x + f(x))`,归一化挡在残差通路上；`pre-norm` 是 `x + f(norm(x))`,残差是一条干净的恒等通路，梯度可以不经任何缩放地从输出回到输入。原始 Transformer 用的是前者，需要精心设计的 warmup 才训得动；今天基本都是后者。',
        'pre-norm 的代价是残差流会随深度变大:每层往上加一份，L 层之后大约是 `sqrt(1 + L·σ²)`。把每层输出乘 `1/sqrt(2L)` 就能把它压回与深度无关,GPT-2 起就是这么初始化的，一行代码，但没有它，深模型的前几百步会明显更难走。'
      ),
      p(
        'The classic reason deep networks fail to train is activation scale running away: each layer amplifies a little, and twenty layers later you are orders of magnitude off. `Normalisation` pulls every layer input back to a fixed scale.',
        '`LayerNorm` subtracts the mean, divides by the standard deviation, then applies a learned gain and a learned bias. `RMSNorm` drops the mean subtraction and the bias, dividing only by the root mean square `sqrt(mean(x²))`. About 7% cheaper at essentially the same quality,the default since Llama.',
        'One consequence is directly testable: add a constant to the whole input and LayerNorm is unchanged (the mean was subtracted away) while RMSNorm moves. Whichever one you meant to write, this property tells you which one you actually wrote.',
        '`Where` normalisation sits matters more than which one you pick. `post-norm` is `norm(x + f(x))`,normalisation blocks the residual path. `pre-norm` is `x + f(norm(x))`,the residual stays a clean identity, and gradients travel from output to input without passing through any scaling. The original Transformer used the former and needed a carefully tuned warmup to train at all; today almost everything uses the latter.',
        'Pre-norm costs you a residual stream that grows with depth: each layer adds a share, so after L layers the scale is about `sqrt(1 + L·σ²)`. Multiplying each layer output by `1/sqrt(2L)` flattens that back to depth-independent,how GPT-2 has initialised from the start. One line, but without it the first few hundred steps of a deep model are visibly harder.'
      )
    ),
    'swiglu-block': t(
      p(
        '一层 Transformer 由两块组成：注意力负责`在位置之间搬运信息`，前馈网络负责`对每个位置各自做变换`。注意力是横着看的，前馈是竖着看的,少了任何一块，模型都会明显变弱。',
        '前馈网络的参数其实是大头。一层里注意力约 `4·dim²`，前馈约 `8·dim²`,三分之二的参数在这块看着最平平无奇的地方。',
        '传统写法是 `down(gelu(up(x)))`，隐藏维取 `4·dim`。`SwiGLU` 改成三个矩阵：`gate` 和 `up` 各投影一次，`silu(gate) · up` 逐元素相乘，再 `down` 投回去。多出来的那条`门控`路让网络能学「这一维要不要通过」，而不只是「通过多少」。',
        '三个矩阵要是都按 `4·dim` 开，参数就比原来多 50%。Llama 的解法是把隐藏维乘 `2/3` 再向上取到 8 或 256 的倍数,参数量持平，效果更好。取整不是洁癖：矩阵乘的分块和张量核心按 8/16/32 对齐，一个不对齐的宽度会掉进慢路径。',
        '整层的形状是两条 pre-norm 残差:`x = x + attn(norm1(x))`，然后 `x = x + mlp(norm2(x))`。把两条支路的出口权重清零，整层就应该是`恒等映射`,这是检查残差接对没接对最利落的办法。',
        '还有一个值得记住的数：一次前向大约是 `2N` 次浮点运算每 token（N 是参数量），反向约两倍，一个训练步合计约 `6N`。所有的算力预算都从这个式子开始算。'
      ),
      p(
        'A Transformer layer has two halves: attention `moves information between positions`, and the feed-forward network `transforms each position on its own`. Attention looks sideways, the FFN looks down,drop either and the model gets visibly weaker.',
        'Most parameters actually live in the FFN. Per layer, attention costs about `4·dim²` and the feed-forward about `8·dim²`,two thirds of the parameters sit in the least glamorous part.',
        'The classic form is `down(gelu(up(x)))` with a hidden width of `4·dim`. `SwiGLU` uses three matrices instead: project through `gate` and `up`, multiply `silu(gate) · up` elementwise, then project back with `down`. That extra `gating` path lets the network learn whether a dimension should pass at all, not merely how much.',
        'Three matrices at `4·dim` each would cost 50% more parameters. Llama scales the width by `2/3` and rounds up to a multiple of 8 or 256,parameter count holds while quality improves. The rounding is not fastidiousness: matmul tiling and tensor cores align to 8/16/32, and an unaligned width falls onto a slow path.',
        'A whole layer is two pre-norm residuals: `x = x + attn(norm1(x))` then `x = x + mlp(norm2(x))`. Zero the output weights of both branches and the layer must become the `identity`,the cleanest way to check that the residuals are wired correctly.',
        'One more number worth keeping: a forward pass costs roughly `2N` floating-point operations per token (N being the parameter count), the backward about twice that, so a training step is about `6N`. Every compute budget starts from this formula.'
      )
    ),
    'sampling-kvcache': t(
      p(
        '训练时整段序列一次算完,因果掩码保证第 t 个位置只看得见前面。生成时不行：第 t 个 token 还不存在，必须先采出来才能往下走。这就是`自回归解码`。',
        '朴素的写法是每生成一个 token 就把整段前缀重新跑一遍。第 t 步是 O(t)，生成 n 个是 `O(n²)`。生成 1000 个 token 要做的工作是生成 100 个的一百倍,这不是慢一点，这是不能用。',
        '关键的观察是：前面那些位置的`键`和`值`，每一步算出来的都一模一样。既然一样，存下来就好。这就是 `KV cache`,每步只算新来的那一个位置的 k/v，追加进缓存，然后对缓存里全部位置做注意力。每步 O(1)，全程 O(n)。',
        '代价是显存。缓存的大小是 `2 · 层数 · batch · 序列长 · kv头数 · 头维 · 位宽`,一个 70B 模型在长上下文、大 batch 下，缓存能比权重本身还大。GQA 减 kv 头数、量化减位宽、分页分配减碎片，这三条都是冲着它去的。',
        '带缓存和不带缓存算的是同一个函数，所以结果应当`逐位相同`。对不上通常是三件事：RoPE 的位置没跟着已生成长度走、因果掩码忘了传偏移、往缓存里追加时 batch 之间串了位。这三个错都不报异常,生成出来的东西照样像句子。',
        '采样这一侧，`temperature` 缩放 logits（越小越确定），`top-k` 只留概率最高的 k 个，`top-p` 留累计概率到 p 的那些。三者叠加的顺序是先 k 后 p,和 HuggingFace 一致。要能重放，采样必须确定性：同一份 logits 加同一个 seed 必须给同一个 token，概率相同的候选按 id 排序。'
      ),
      p(
        'Training computes the whole sequence at once,the causal mask keeps position t from seeing ahead. Generation cannot: token t does not exist yet and must be sampled before anything can follow. That is `autoregressive decoding`.',
        'The naive approach reruns the entire prefix for each new token. Step t costs O(t), so n tokens cost `O(n²)`. Generating 1000 tokens is a hundred times the work of generating 100,not somewhat slower, but unusable.',
        'The key observation is that the `keys` and `values` of earlier positions come out identical at every step. Since they are identical, store them. That is the `KV cache`: compute k/v only for the new position, append, and attend over everything the cache holds. O(1) per step, O(n) overall.',
        'The cost is memory. The cache is `2 · layers · batch · length · kv_heads · head_dim · width`,on a 70B model with long context and large batches it can exceed the weights themselves. GQA cuts head count, quantisation cuts width, and paged allocation cuts fragmentation; all three target this.',
        'Cached and uncached decoding compute the same function, so results must be `bit-identical`. Mismatches are usually one of three things: RoPE positions not following the generated length, a forgotten offset on the causal mask, or appends that cross batch boundaries. None of them raises an error,the output still reads like language.',
        'On the sampling side, `temperature` scales the logits (lower is more deterministic), `top-k` keeps the k most probable tokens, and `top-p` keeps the smallest set reaching cumulative probability p. They stack k first, then p,matching HuggingFace. For replay to work sampling must be deterministic: the same logits and seed must give the same token, with ties broken by id.'
      )
    ),
    'manual-backward': t(
      p(
        '前向把输入变成 loss，反向回答一个问题：**每个参数动一点点，loss 会动多少**。这个「多少」就是梯度,有了它，优化器才知道往哪个方向调。',
        '链式法则说的是：一条计算链上的导数是各段导数的乘积。反向传播就是把这句话组织成一次从后往前的遍历,每个算子只需要知道「拿到我输出的梯度，怎么算出我输入的梯度」，不需要知道自己身处什么模型。这种局部性是整个深度学习框架能存在的原因。',
        '矩阵乘的反向值得手推一次。`y = x @ W` 里，`dx = dy @ Wᵀ`，`dW = xᵀ @ dy`。不用背,看形状就能定：`dx` 必须和 `x` 同形，能凑出这个形状的乘法只有一种。',
        '交叉熵的反向是整套里最漂亮的。softmax 和交叉熵单独求导都很啰嗦，合起来之后中间的东西全部消掉，只剩 `(预测概率 − 真实概率) / 样本数`。这也是真实框架总把这两步融在一个算子里的原因,不只是快，还避免了中间那块 `[样本数, 词表大小]` 的显存。',
        '`ctx` 是前向留给反向的口袋。它存在的理由是显存：**没被存进去的中间结果可以立刻扔掉**。一个只存了必要几样的实现，和一个把什么都留着的实现，在大模型上差的是能不能跑得起来。',
        '还有一件容易忽略的事：`backward` 收到的 `grad_output` 不一定是 1。从 loss 出发时它是 1，但这个算子放进更深的图里、或者用了梯度累积之后就不是了。忘了乘它的实现，在最简单的场景下一切正常。'
      ),
      p(
        'The forward pass turns inputs into a loss; the backward pass answers one question: **if each parameter moves a little, how much does the loss move**. That "how much" is the gradient, and it is what tells the optimiser which way to go.',
        'The chain rule says the derivative along a chain is the product of the per-step derivatives. Backpropagation organises that into a single pass from the end backwards,each operator only needs to know how to turn the gradient of its output into the gradient of its input, without knowing what model it sits in. That locality is why deep learning frameworks can exist at all.',
        'The matmul backward is worth deriving once. For `y = x @ W`, `dx = dy @ Wᵀ` and `dW = xᵀ @ dy`. There is nothing to memorise: shapes decide it, since `dx` must match `x` and only one product produces that shape.',
        'The cross-entropy backward is the prettiest result here. Differentiating softmax and cross-entropy separately is tedious; together everything in the middle cancels and only `(predicted probability − true probability) / count` remains. That is also why real frameworks fuse the two into one operator,not merely for speed, but to avoid materialising a `[count, vocab]` intermediate.',
        '`ctx` is the pocket the forward leaves for the backward. It exists for memory: **anything not saved can be discarded immediately**. On a large model the difference between saving only what is needed and saving everything is the difference between running and not.',
        'One more thing that is easy to miss: the `grad_output` a `backward` receives is not always 1. It is 1 when you start from the loss, but not once the operator sits deeper in a graph or gradient accumulation is in play. An implementation that forgets to multiply it behaves perfectly in the simplest case.'
      )
    ),
    'autograd-engine': t(
      p(
        '每个算子都知道自己那一步的反向之后，还缺一个`调度`：谁先算、谁后算、谁的梯度什么时候算齐。这就是自动微分引擎干的事,十几行代码，但顺序错了不会报错，只会给出偏小的梯度。',
        '前向的每一步都在偷偷记账：算出来的张量记着「我是谁算出来的」（parents）和「怎么把梯度散回去」（backward 函数）。这张记账本叫`带`（tape），反向就是倒着读它一遍。',
        '关键约束是：一个节点要往上散梯度之前，它自己的梯度必须**已经攒齐**,所有用到它的下游都得先算完。满足这个约束的顺序就是`拓扑序`，而后序遍历天然给出一个。',
        '分水岭是`菱形图`:同一个中间结果被两处用到。这时它的梯度是两条路的**和**。一个在遍历时没有去重的实现，会把这个节点的 backward 调两次，梯度正好翻倍,而在一条直链上完全正常。所以「只在链上验过」是不够的。',
        '播种也别忘：起点的梯度是 1，因为 `d(loss)/d(loss) = 1`。少了这一步整张图的梯度全是 0,不报错，表现和「学习率设成了 0」一模一样。',
        '你写的这十几行就是 PyTorch autograd 的骨架。真实的那个多了跨线程的依赖计数、`retain_graph`、钩子、以及对不需要梯度的子图的剪枝,骨架是一样的。'
      ),
      p(
        'Once every operator knows its own backward step, one thing is still missing: `scheduling`,who goes first, who goes last, and when a gradient is complete. That is what an autograd engine does. It is a dozen lines, and getting the order wrong raises no error; it simply produces gradients that are too small.',
        'Every forward step quietly keeps a ledger: each resulting tensor records who produced it (its parents) and how to scatter gradients back (its backward function). That ledger is the `tape`, and the backward pass reads it in reverse.',
        'The key constraint is that a node may only scatter once its own gradient is **complete**,every downstream user must have finished. An order satisfying that is a `topological order`, and a post-order traversal produces one for free.',
        'The dividing line is the `diamond`: one intermediate used in two places. Its gradient is the **sum** of both paths. A traversal without deduplication calls that node backward twice and doubles the gradient,while behaving perfectly on a straight chain. Testing only on a chain is not enough.',
        'Do not forget to seed: the root gradient is 1, because `d(loss)/d(loss) = 1`. Without it every gradient in the graph stays zero,no error, and symptoms identical to setting the learning rate to zero.',
        'The dozen lines you write here are the skeleton of PyTorch autograd. The real one adds cross-thread dependency counting, `retain_graph`, hooks, and pruning of subgraphs that need no gradient,the skeleton is the same.'
      )
    ),
  },
};

function attachStagePrimers(project) {
  const projectPrimers = primers[project.id];
  if (!projectPrimers) {
    throw new Error(`没有为工程 ${project.id} 配置前置知识`);
  }

  return {
    ...project,
    stages: (project.stages || []).map((stage) => {
      const primer = projectPrimers[stage.id];
      if (!primer) {
        throw new Error(`工程 ${project.id} 的关卡 ${stage.id} 缺少前置知识`);
      }
      return { ...stage, primer };
    }),
  };
}

module.exports = { attachStagePrimers, primers };
