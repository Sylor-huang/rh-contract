# RobinTimeLock — ERC20 时间锁仓

把自己钱包里的 ERC20 锁进合约，到你自己定的时间才能取回。每个 lock 完全独立：有自己的 id、代币、数量、解锁时间、归属人。

- 合约源码：`contracts/RobinTimeLock.sol`
- 交互脚本：`scripts/timelock.js`
- 可运行示例：`examples/timelock.js`
- 测试：`test/RobinTimeLock.test.js`
- 网络：Robinhood Chain 主网 `4663` / 测试网 `46630`

---

## 1. 信任模型

这是这个合约存在的全部理由，逐条对应：

| 要求 | 实现方式 |
|---|---|
| 无管理员提款 | 全合约只有 `deposit()` 和 `withdraw()` 两个改状态的函数，没有任何地址能从别人的 lock 里取钱 |
| 无升级代理 | 不继承任何 proxy，不写 `delegatecall`；部署即终局 |
| 无 owner | 不继承 `Ownable` / `AccessControl`，构造函数无参数，没有 `initialize()` |
| 无后门 | 不能缩短解锁时间、不能暂停、不能拉黑地址、不能扫走余额、没有 `selfdestruct` |
| 每个 lock 独立 | `mapping(uint256 lockId => Lock)`，一条记录一个 lock，互不影响 |
| owner 固定为存入者 | `withdraw()` 硬校验 `lock.owner == msg.sender`，不存在"指定受益人"的参数 |
| 到时间才能取 | `block.timestamp >= unlockTime` 才放行 |
| 只能取自己的 lock | 同上，他人调用直接 revert `NotLockOwner` |
| SafeERC20 | `using SafeERC20 for IERC20`，兼容 USDT 这类不返回 `bool` 的代币 |
| 事件 | `LockCreated` / `Withdrawn`，两者的 `owner`、`token` 都是 `indexed` |

部署者（deployer）**没有任何特权**：部署交易除了部署不产生任何效果，也没有任何"初始化"步骤。

这条信任模型已经被测试固化：只要有人往 ABI 里加一个 owner / 暂停 / 救援函数，测试立刻失败。

---

## 2. 接口速查

```solidity
// 写操作（全部就这两个）
function deposit(address token, uint256 amount, uint256 unlockTime) returns (uint256 lockId);
function withdraw(uint256 lockId);

// 读操作
function getLock(uint256 lockId) view returns (Lock);
function getUserLocks(address user) view returns (LockView[]);
function getUserLockCount(address user) view returns (uint256);
function lockCount() view returns (uint256);
function MAX_LOCK_DURATION() view returns (uint256);   // 365 days
```

### deposit —— 加锁

| 参数 | 说明 |
|---|---|
| `token` | ERC20 合约地址，必须是已部署的合约（EOA 地址会被拒） |
| `amount` | 数量，按代币最小单位（例如 18 位小数就是 `1000 * 10^18`） |
| `unlockTime` | **unix 秒级时间戳**，必须严格大于当前区块时间，且最远不能超过 `当前时间 + 365 天` |
| 返回 | `lockId`，从 1 开始自增，之后凭它查询和取回 |

调用前需要先 `approve` 本合约足够的额度。

### withdraw —— 取回

只接受一个参数 `lockId`。全额、一次性取出到存入者地址。以下情况会 revert：

- 不是这个 lock 的存入者（`NotLockOwner`）
- 还没到解锁时间（`LockNotMatured`）
- 已经取回过（`AlreadyWithdrawn`）
- lock 不存在（`LockNotFound`）

### getLock —— 查单个 lock

```solidity
struct Lock {
    address token;
    address owner;
    uint256 amount;      // 已取回时变成 0
    uint256 unlockTime;
}
```

lock 存在 ⟺ `lockId != 0 && lockId <= lockCount`。不存在的 id 会返回全零记录。

### getUserLocks —— 一次查完"我还锁着什么、各多少、还剩多久"

这是给前端/脚本用的主查询接口。一次 `eth_call` 返回该地址**尚未取回**的全部 lock：

```solidity
struct LockView {
    uint256 lockId;
    address token;
    uint256 amount;               // 一定 > 0（取回后就不在这个列表里了）
    uint256 unlockTime;
    uint256 secondsUntilUnlock;   // 还剩多少秒解锁；已到期、可立即取回时为 0
}
```

三个要点：

- **已取回的 lock 不会出现在列表里**，所以拿到的一定是"还能领的"
- `secondsUntilUnlock === 0` 就是"现在就能取"
- **顺序不稳定**：取回时会用"把最后一个元素换到空位"的方式移除条目，所以列表顺序和创建顺序无关，请当成无序集合用

前端常用判断：

```js
const ready  = locks.filter((l) => l.secondsUntilUnlock === 0n);   // 已到期、可立即取回
const locked = locks.filter((l) => l.secondsUntilUnlock > 0n);     // 还在锁定期
```

**那已取回的历史记录去哪了？** 记录本身没删（`getLock(id)` 仍能读到完整的 token / 数量 / 解锁时间，只是 `amount` 变成 0），只是不在这个列表里了。要列历史，用 `LockCreated` / `Withdrawn` 事件扫：

```js
const history = await timeLock.queryFilter(
  timeLock.filters.LockCreated(null, owner),
  0,
  "latest"
);
```

`getUserLockCount(user)` 返回这个列表的长度，也就是"还有几个待领取"。


> 说明：这个索引（`_activeLockIds`）是**纯记账数据，只服务于这两个 view 函数，不参与任何权限判断**。`withdraw()` 只读 lock 记录本身。索引写错最多让某个 lock 在列表里看不见，永远不可能让任何人动到资金。

### lockCount / MAX_LOCK_DURATION —— 常量

- `lockCount()`：历史创建总数，等于当前最大的 lockId（不会因为取回而减少）
- `MAX_LOCK_DURATION()`：`31536000`（= 365 天）——**只约束 `deposit()` 能设定多远的解锁时间，不影响领取**

---

## 3. 事件

```solidity
event LockCreated(
    uint256 indexed lockId,
    address indexed owner,
    address indexed token,
    uint256 amount,
    uint256 unlockTime
);

event Withdrawn(
    uint256 indexed lockId,
    address indexed owner,
    address indexed token,
    uint256 amount
);
```

三个字段都带 `indexed`，所以在 Blockscout 上可以直接按地址过滤出全部历史记录，也可以用来在链下重建索引（不依赖 `getUserLocks`）。

---

## 4. 错误

用自定义 error 而不是字符串，revert 时会把具体数值带出来，前端能直接展示：

| 错误 | 触发条件 |
|---|---|
| `ZeroAddress` / `NotAContract` | token 是零地址 / 不是合约 |
| `ZeroAmount` | 数量为 0 |
| `UnlockTimeNotInFuture(unlockTime, currentTime)` | 解锁时间不在未来 |
| `UnlockTimeTooFar(unlockTime, maxUnlockTime)` | 解锁时间超过 365 天 |
| `UnexpectedTransferAmount(expected, received)` | 实际到账 ≠ 声明数量（手续费 / 弹性供应代币） |
| `LockNotFound(lockId)` | lock id 不存在 |
| `NotLockOwner(lockId, caller)` | 不是这个 lock 的存入者 |
| `LockNotMatured(lockId, unlockTime, currentTime)` | 还没到期 |
| `AlreadyWithdrawn(lockId)` | 已提取过 |

---

## 5. 时间规则

- 时间单位是 **秒级 unix 时间戳**（不是毫秒）
- 最早：`当前区块时间 + 1 秒`。等于当前时间会被拒（`UnlockTimeNotInFuture`）
- 最晚：`当前区块时间 + 31536000`（365 天），超出会被拒（`UnlockTimeTooFar`）
- 边界行为：`block.timestamp == unlockTime` 那一刻就**可以**取，有测试专门卡这一秒
- `block.timestamp` 在 L2 上由 sequencer 产出，可能被小幅拨动（秒级到分钟级）。锁仓语义不受影响，但别把它当秒级精确的闹钟

算时间戳：

```bash
date -v+30d +%s          # macOS：30 天后
date -v+1y +%s           # macOS：1 年后
date -d "+30 days" +%s   # Linux
```

> 想锁满 1 年请用 `+364d` 这种留一点余量的值。`+365d` 正好卡在上限上，如果链上时间已经比你本地时钟大几秒，就会被 `UnlockTimeTooFar` 拒掉。

### 到期后没有"过期作废"

**锁仓到期后，无论过了多久都还能取。** 忘记领取一年、三年、十年都没关系。

原因是 `withdraw()` 里只有一句检查：

```solidity
if (block.timestamp < unlockTime) revert LockNotMatured(...);
```

只有下界，**没有上界**。`MAX_LOCK_DURATION` 只出现在 `deposit()` 里，用来拦住"解锁时间设得太远"的输入（也顺便拦住把毫秒当秒传的错误），它跟"能不能领"完全无关。

合约里不存在任何形式的过期、罚没、归集逻辑。这条保证有专门的测试盯着（存进去之后跳过 800 天再取，仍然成功）。

唯一会妨碍你领取的是外部因素，不是合约：

- 你没有 ETH 付 gas（这条链用 ETH 做 gas）
- 代币本身被发行方冻结 / 暂停（见第 7 节）
- 链本身停止出块

---

## 6. 为什么入口检查这么严

因为没有管理员就**没有任何补救手段**，所以凡是"可能让资金永久卡死"的输入都必须在入口挡掉：

- **token 必须是合约**：`SafeERC20` 对无代码地址调用会"成功返回空数据"，从而被当成不返回 `bool` 的代币放行——钱会直接烧掉。所以先查 `code.length`。
- **拒绝手续费代币**：用余额差校验，若实际到账少于记录数量，说明账目比实际持有更多，最后一个提取者会取不出来。因此整笔回滚。
- **拒绝超过 365 天的解锁时间**：防止把"毫秒"当"秒"传进来（例如 `1735689600000` 会被当成公元 56955 年）。
- **先改状态再转账 + `nonReentrant`**：双保险，恶意代币在转账回调里重入也取不走第二笔。
- **不收 ETH**：没有 `receive` / `fallback`，误转 ETH 直接 revert，不会卡在合约里。

---

## 7. 已知边界（重要）

合约本身可以做得很干净，但**风险不只是合约**：

1. **代币本身的权限才是最大风险。** 如果代币是代理合约、有 owner、可暂停、有黑名单，发行方依然能冻结余额或拉黑本合约——任何锁仓合约都挡不住，它只能保证自己不加第二道后门。
2. **Robinhood 的 Stock Tokens 属于这一类。** 其转账受 `AccessControlsRegistry`（`isBlocked`）门控，且 ArbOS 层有 sequencer 级合规过滤。两个直接后果：
   - **部署后必须先用一笔小额真实交易验证 `deposit()` 能否成功**。如果本合约地址不在 allowlist 内，`transferFrom` 会直接 revert，根本锁不进去。
   - 反过来，即使锁进去了，发行方在代币层面仍有冻结能力——**技术上的锁仓不等于法律或证券意义上的锁仓**。
3. **股票代币的公司行为**：Stock Tokens 实现了 ERC-8056（`uiMultiplier`），拆股 / 分红时"显示余额"会变，而 raw `balanceOf` 不变。本合约按 raw 数量记账，取回的就是当初存进去的 raw 数量，名义价值可能已经不同。
4. **没有 owner = 没有客服。** 私钥丢了或被盗，没有人能帮你把钱取出来。
5. **取回时你需要自付 gas。** 到期后必须由你自己发起 `withdraw()`。如果那时你手上没有 ETH、或链停摆，钱就一直躺在合约里。
6. **不可升级 = 永远不可修。** 这是你要的特性，但也是代价：任何逻辑问题都没有补丁路径。
7. **脚本与私钥**：`.env` 里是明文私钥；脚本只 `approve` 精确额度，不做无限授权。大额建议用硬件钱包通过浏览器交互。

**结论：合约层面可以做到真·无后门（并已用测试固化）；但"整体风险很小"只在同一个前提下成立——你锁的是一种没有 owner、不可暂停、不可升级、无黑名单的 ERC20。**

---

## 8. 部署

```bash
# 测试网
npx hardhat run scripts/deploy-timelock.js --network robinhoodTestnet

# 主网
npx hardhat run scripts/deploy-timelock.js --network robinhood
```

脚本按 hardhat 网络名做白名单（`robinhood` / `robinhoodTestnet` / `localhost`），并额外核对 chainId 与 RPC 是否一致，避免 RPC 配错导致"以为在测试网、实际在主网"。忘了带 `--network` 会落到一次性的内存链上，脚本会直接拒绝。

部署后把地址写进 `.env`：

```bash
TIME_LOCK_ADDRESS=0x...
```

验证源码：

```bash
npx hardhat verify --network robinhood <地址>
```

---

## 9. 完整调用示例

下面给五种方式，按需选一种即可。

### 方式 A：用仓库自带的脚本（最省事）

```bash
node scripts/timelock.js create <token> <amount> <when>   # 加锁（额度不足时自动精确 approve）
node scripts/timelock.js info <lockId>                    # 查看单个 lock（含已取回的历史）
node scripts/timelock.js list <owner>                     # 某地址待领取的 lock（getUserLocks）
node scripts/timelock.js list                             # 列出全链所有 lock（扫事件）
node scripts/timelock.js withdraw <lockId>                # 到期后取回
```

选项：`--network local|testnet|mainnet`（默认 testnet）、`--address 0x...`、`--from <block>`。

`<when>` 支持 `+30d` / `+12h` / `+90m` / `+2w` / `+364d`、unix 秒级时间戳、或 ISO 日期（`2026-12-31T00:00:00Z`）。

实际输出长这样（取回一个之后，它就从列表里消失了）：

```bash
$ node scripts/timelock.js list 0xf39F...2266
Locks of 0xf39F...2266 (2) - not withdrawn yet:

lock 3  [locked for 18d 23h]
  token:      0xe7f1...0512 (MOCK)
  amount:     300.0 MOCK
  unlockTime: 1791013154 (2026-10-03T07:39:14Z)
  time left:  18d 23h

lock 2  [locked for 8d 23h]
  token:      0xe7f1...0512 (MOCK)
  amount:     200.0 MOCK
  unlockTime: 1790149154 (2026-09-23T07:39:14Z)
  time left:  8d 23h

2 lock(s) still to claim.
```

> 注意上面 `lock 3` 排在 `lock 2` 前面：这是 swap-and-pop 移除的结果，列表顺序不代表创建顺序。

已经取回的 lock 用 `info` 仍然查得到：

```bash
$ node scripts/timelock.js info 1
lock 1
  owner:      0xf39F...2266
  token:      0xe7f1...0512 (MOCK)
  amount:     0 (already withdrawn)
  unlockTime: 1791013154 (2026-10-03T07:39:14Z)
  status:     withdrawn - nothing left to claim
```

### 方式 B：跑 examples/timelock.js

`examples/timelock.js` 是带详细中文注释的可运行模板，每一步都拆成独立函数，方便直接搬进自己的项目：

```bash
node examples/timelock.js                                  # 只读：列出我待领取的 lock
node examples/timelock.js locks 0x某个地址                 # 只读：列出指定地址待领取的 lock
node examples/timelock.js info  <lockId>                   # 只读：查看单个 lock（含已取回的历史）
node examples/timelock.js lock  <token> <amount> <when>    # 加锁：lock 0xToken 1000 +30d
node examples/timelock.js claim <lockId>                   # 到期后取回
```

### 方式 C：ethers v6 代码片段（复制到自己的项目）

```js
const { ethers } = require("ethers");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const TIME_LOCK = "0x你的锁仓合约地址";
const TOKEN = "0x你要锁的代币地址";

const TIME_LOCK_ABI = [
  "function deposit(address token, uint256 amount, uint256 unlockTime) returns (uint256 lockId)",
  "function withdraw(uint256 lockId)",
  "function getLock(uint256 lockId) view returns (tuple(address token, address owner, uint256 amount, uint256 unlockTime))",
  "function getUserLocks(address user) view returns (tuple(uint256 lockId, address token, uint256 amount, uint256 unlockTime, uint256 secondsUntilUnlock)[])",
  "function getUserLockCount(address user) view returns (uint256)",
  "function lockCount() view returns (uint256)",
  "function MAX_LOCK_DURATION() view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// NonceManager 是必须的：一次加锁要连发 approve + deposit 两笔交易，
// 不加它第二笔会撞上 provider 缓存的 nonce。
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const signer = new ethers.NonceManager(new ethers.Wallet(PRIVATE_KEY, provider));

const timeLock = new ethers.Contract(TIME_LOCK, TIME_LOCK_ABI, signer);
const token = new ethers.Contract(TOKEN, ERC20_ABI, signer);
```

**① 加锁**

```js
const amount = ethers.parseUnits("1000", await token.decimals()); // 1000 个代币
const unlockTime = Math.floor(Date.now() / 1000) + 30 * 86400;    // 30 天后

// 先授权，只要精确额度
await (await token.approve(TIME_LOCK, amount)).wait();

// 再存款；返回值拿不到，lockId 从事件里读
const tx = await timeLock.deposit(TOKEN, amount, unlockTime);
const receipt = await tx.wait();

let lockId;
for (const log of receipt.logs) {
  try {
    const parsed = timeLock.interface.parseLog(log);
    if (parsed?.name === "LockCreated") lockId = parsed.args.lockId;
  } catch {}
}
console.log("lock id =", lockId);   // 1
```

**② 查询：锁了哪些代币、各多少、还剩多久解锁**

```js
const owner = await signer.getAddress();

// 只返回"还没取回"的 lock
const locks = await timeLock.getUserLocks(owner);

for (const lock of locks) {
  const meta = new ethers.Contract(lock.token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    meta.symbol().catch(() => "?"),
    meta.decimals().catch(() => 18),
  ]);

  const days = Number(lock.secondsUntilUnlock) / 86400;
  console.log(
    `#${lock.lockId} ${ethers.formatUnits(lock.amount, Number(decimals))} ${symbol}` +
      (lock.secondsUntilUnlock === 0n
        ? " 已到期，可立即取回"
        : ` 还剩 ${days.toFixed(1)} 天解锁`)
  );
}

// 注意：顺序不代表创建顺序（取回时用 swap-and-pop 移除条目），
// 要按解锁时间排序就自己排：
locks.sort((a, b) => Number(a.unlockTime - b.unlockTime));
```

**③ 查单个 lock**

```js
const lock = await timeLock.getLock(1);
if (lock.owner === ethers.ZeroAddress) {
  console.log("不存在");
} else {
  const now = (await provider.getBlock("latest")).timestamp;
  console.log(lock.owner, lock.token, lock.amount.toString());
  console.log("解锁时间", lock.unlockTime.toString());
  console.log("还剩", Number(lock.unlockTime) - now, "秒");
}
```

**④ 到期后取回**

```js
const tx = await timeLock.withdraw(1);   // 只有存入者本人能调用
const receipt = await tx.wait();

for (const log of receipt.logs) {
  try {
    const parsed = timeLock.interface.parseLog(log);
    if (parsed?.name === "Withdrawn") {
      console.log("取回数量", parsed.args.amount.toString());
    }
  } catch {}
}
```

**⑤ 只监听事件（不依赖 getUserLocks 的链下索引）**

```js
// 历史记录
const logs = await timeLock.queryFilter(
  timeLock.filters.LockCreated(null, owner),
  0,               // fromBlock，公网 RPC 可能限制范围，必要时用较近的区块
  "latest"
);

// 实时监听
timeLock.on(timeLock.filters.Withdrawn(null, owner), (lockId, addr, token, amount) => {
  console.log(`lock #${lockId} 取回 ${amount}`);
});
```

### 方式 D：cast 命令行（Foundry）

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
TL=0x你的锁仓合约地址
TOKEN=0x代币地址
PK=0x你的私钥

# 1) 授权
cast send $TOKEN "approve(address,uint256)" $TL 1000000000000000000000 \
  --private-key $PK --rpc-url $RPC

# 2) 加锁：解锁时间 = 30 天后
UNLOCK=$(date -v+30d +%s)     # Linux 用 date -d "+30 days" +%s
cast send $TL "deposit(address,uint256,uint256)" \
  $TOKEN 1000000000000000000000 $UNLOCK \
  --private-key $PK --rpc-url $RPC

# 3) 查询我锁了什么、还剩多久
cast call $TL \
  "getUserLocks(address)((uint256,address,uint256,uint256,uint256)[])" \
  0x你的地址 --rpc-url $RPC

# 4) 查单个 lock
cast call $TL "getLock(uint256)((address,address,uint256,uint256))" 1 --rpc-url $RPC

# 5) 到期后取回
cast send $TL "withdraw(uint256)" 1 --private-key $PK --rpc-url $RPC

# 6) 看看合约上限
cast call $TL "MAX_LOCK_DURATION()(uint256)" --rpc-url $RPC   # 31536000
```

### 方式 E：Blockscout 网页

打开 [主网浏览器](https://robinhoodchain.blockscout.com) → 搜索合约地址 → **Contract** 标签页 → **Write Contract**：

1. 连接钱包
2. `approve` 在**代币**合约上做：spender 填锁仓合约地址，amount 填数量
3. 回到锁仓合约，调 `deposit(token, amount, unlockTime)`
4. 到期后在 **Write Contract** 调 `withdraw(lockId)`
5. 查询用 **Read Contract** → `getUserLocks`，输入你的地址

---

## 10. 本地演练（不需要真链）

终端 A：

```bash
npx hardhat node
```

终端 B：

```bash
npx hardhat run scripts/deploy-timelock.js --network localhost
```

输出里会给出 `TIME_LOCK_ADDRESS` 和本地专用测试代币 `MOCK_TOKEN`（已给部署者 mint 100 万）。然后：

```bash
export PRIVATE_KEY=<本地节点账户私钥>
export ADDR=<输出的 TIME_LOCK_ADDRESS>
export TOKEN=<输出的 MOCK_TOKEN>

node scripts/timelock.js --network local --address $ADDR create $TOKEN 1000 +30d
node scripts/timelock.js --network local --address $ADDR list 0x你的地址
```

快进时间验证解锁：

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"evm_increaseTime","params":[2678400],"id":1}' \
  http://127.0.0.1:8545
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' \
  http://127.0.0.1:8545

node scripts/timelock.js --network local --address $ADDR withdraw 1
```

---

## 11. 测试覆盖

```bash
npx hardhat test test/RobinTimeLock.test.js
```

除正常路径外，专门覆盖：

- **无特权回归测试**：断言 ABI 里**只存在** 7 个函数（`deposit` / `withdraw` / `getLock` / `getUserLocks` / `getUserLockCount` / `lockCount` / `MAX_LOCK_DURATION`），多一个都会失败
- **源码级回归测试**：剥掉注释后断言源码不含 `Ownable`、`AccessControl`、`delegatecall`、`selfdestruct`、`assembly`、`initializer`
- 无 `payable` 函数、无 `receive` / `fallback`、误转 ETH 被拒
- 提前 1 秒提取失败；**恰好等于解锁时间的那一秒提取成功**
- 非本人提取、不存在的 id、重复提取、同一人多 lock 互不影响
- `getUserLocks`：空列表、多代币、同代币多条、不串到别人、剩余时间随时间递减
- **取回后从列表移除**：单条、乱序取回（触发 swap-and-pop 的三种情形）、不同 owner 的列表互不影响
- **过期不清零**：锁仓到期后跳过 800 天仍然可以正常取回
- 手续费代币被拒且整笔回滚；USDT 式无返回值代币可正常存取
- **重入攻击**：恶意代币在 `transfer` 回调里重入 `withdraw`，验证只付一次、合约余额归零
- 余额不足 / 授权不足 / 零金额 / 零地址 / EOA 地址 / 过期时间 / 超长锁定期

## 12. Gas 参考（本地实测）

| 操作 | gas |
|---|---|
| `deposit`（第一个 lock，冷 SSTORE） | ~241,000 |
| `deposit`（后续 lock） | ~190,000 |
| `withdraw`（数组里没有要挪动的元素） | ~58,000 |
| `withdraw`（触发 swap，即列表里还有别的 lock） | ~66,000 |
| `getUserLocks` | 只读，不花 gas |

> 数字含两个记账索引的写入成本：它们让"查询我待领取的 lock"只需一次 `eth_call`，代价是第一个 lock 多花约 66k gas（`174k → 241k`）。在这条链的 gas 价格下大约几美分。
>
> 如果只锁一两个 lock、又很在意这几万 gas，可以把索引去掉换成"扫事件"，但 `getUserLocks()` 就不能用了——需要的话告诉我。
