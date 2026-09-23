/**
 * RobinTimeLock 完整调用示例（ethers v6）。
 *
 * 这个文件是"照着改就能用"的模板，每一步都拆成独立函数，方便复制到自己的项目里。
 * 日常操作请用 scripts/timelock.js（那个是工具，这个是教学）。
 *
 * 运行前在 .env 里配好：
 *   PRIVATE_KEY=0x...                                        # 只有发交易时才需要
 *   RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
 *   TIME_LOCK_ADDRESS=0x...                                   # 部署后得到的地址
 *
 * 运行：
 *   node examples/timelock.js                                  # 只读：列出我的全部 lock
 *   node examples/timelock.js locks 0x某个地址                 # 只读：列出指定地址的 lock
 *   node examples/timelock.js lock  <token> <amount> <when>     # 加锁，例如 lock 0xToken 1000 +90d
 *   node examples/timelock.js claim <lockId>                    # 到期后取回
 */
require("dotenv").config();

const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// 1. 只需要这些 ABI 就能用完整功能。注意有两个 view 函数是专门给前端用的：
//    getUserLocks() 一次调用就能回答"我锁了哪些代币、各多少、还剩多久解锁"。
// ---------------------------------------------------------------------------
const TIME_LOCK_ABI = [
  // 写操作
  "function deposit(address token, uint256 amount, uint256 unlockTime) returns (uint256 lockId)",
  "function withdraw(uint256 lockId)",
  // 读操作
  "function getLock(uint256 lockId) view returns (tuple(address token, address owner, uint256 amount, uint256 unlockTime))",
  "function getUserLocks(address user) view returns (tuple(uint256 lockId, address token, uint256 amount, uint256 unlockTime, uint256 secondsUntilUnlock)[])",
  "function getUserLockCount(address user) view returns (uint256)",
  "function lockCount() view returns (uint256)",
  "function MAX_LOCK_DURATION() view returns (uint256)",
  // 事件
  "event LockCreated(uint256 indexed lockId, address indexed owner, address indexed token, uint256 amount, uint256 unlockTime)",
  "event Withdrawn(uint256 indexed lockId, address indexed owner, address indexed token, uint256 amount)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// ---------------------------------------------------------------------------
// 2. 连接
// ---------------------------------------------------------------------------
function getProvider() {
  const rpc =
    process.env.RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
  const chainId = Number(process.env.RH_CHAIN_ID || 46630); // 主网是 4663
  return new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
}

function getTimeLock(provider) {
  const address = process.env.TIME_LOCK_ADDRESS;
  if (!address) throw new Error("请在 .env 里设置 TIME_LOCK_ADDRESS");
  return new ethers.Contract(address, TIME_LOCK_ABI, provider);
}

/**
 * 带私钥的 signer。
 * NonceManager 是必须的：一次 `lock` 要连发 approve + deposit 两笔交易，
 * 不加它第二笔会撞上 provider 缓存的 nonce。
 */
function getSigner(provider) {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("请在 .env 里设置 PRIVATE_KEY");
  }
  return new ethers.NonceManager(new ethers.Wallet(process.env.PRIVATE_KEY, provider));
}

// ---------------------------------------------------------------------------
// 3. 只读：查询某个地址锁了哪些代币、各多少、还剩多久解锁
//    一次 eth_call 全部拿到，不需要私钥。
// ---------------------------------------------------------------------------
async function listLocks(owner) {
  const provider = getProvider();
  const timeLock = getTimeLock(provider);

  // 核心就是这一行：只返回"还没取回"的 lock
  const locks = await timeLock.getUserLocks(owner);

  const count = await timeLock.getUserLockCount(owner);
  console.log(`${owner} 目前有 ${count} 个未取回的 lock\n`);

  if (locks.length === 0) {
    console.log("（没有待领取的 lock）");
    return;
  }

  // token 的 symbol/decimals 各读一次，按地址去重
  const meta = new Map();
  for (const address of [...new Set(locks.map((l) => l.token.toLowerCase()))]) {
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      token.symbol().catch(() => "?"),
      token.decimals().catch(() => 18),
    ]);
    meta.set(address, { symbol, decimals: Number(decimals) });
  }

  for (const lock of locks) {
    const info = meta.get(lock.token.toLowerCase());
    const unlockTime = Number(lock.unlockTime);
    const secondsLeft = Number(lock.secondsUntilUnlock);

    const status =
      secondsLeft === 0
        ? "已到期，可立即取回"
        : `还剩 ${formatDuration(secondsLeft)} 解锁`;

    console.log(`lock #${lock.lockId}`);
    console.log(`  代币:      ${info.symbol} (${lock.token})`);
    console.log(`  数量:      ${ethers.formatUnits(lock.amount, info.decimals)}`);
    console.log(`  解锁时间:  ${new Date(unlockTime * 1000).toISOString()} (${unlockTime})`);
    console.log(`  状态:      ${status}`);
    console.log("");
  }

  const ready = locks.filter((l) => l.secondsUntilUnlock === 0n);
  console.log(`共 ${locks.length} 个待领取，其中可立即取回的: ${ready.length} 个`);
  console.log("（已取回的 lock 不在上面，它们的记录仍可用 getLock(id) 查询）");
}

/** 只查单个 lock，等价于状态更细的 getLock。 */
async function showLock(lockId) {
  const provider = getProvider();
  const timeLock = getTimeLock(provider);

  const lock = await timeLock.getLock(lockId);
  if (lock.owner === ethers.ZeroAddress) {
    console.log(`lock #${lockId} 不存在`);
    return;
  }

  const token = new ethers.Contract(lock.token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "?"),
    token.decimals().catch(() => 18),
  ]);
  const block = await provider.getBlock("latest");
  const secondsLeft = Number(lock.unlockTime) - block.timestamp;

  console.log(`lock #${lockId}`);
  console.log(`  归属人:    ${lock.owner}`);
  console.log(`  代币:      ${symbol} (${lock.token})`);
  console.log(
    `  数量:      ${
      lock.amount === 0n
        ? "0（已取回）"
        : ethers.formatUnits(lock.amount, Number(decimals))
    }`
  );
  console.log(`  解锁时间:  ${Number(lock.unlockTime)}`);
  console.log(
    `  状态:      ${
      lock.amount === 0n
        ? "已取回"
        : secondsLeft <= 0
          ? "已到期，可立即取回"
          : `还剩 ${formatDuration(secondsLeft)} 解锁`
    }`
  );
}

// ---------------------------------------------------------------------------
// 4. 写操作一：加锁
//    两个交易：先 approve 足够额度，再 deposit。
// ---------------------------------------------------------------------------
async function lockTokens(tokenAddress, amountInput, whenInput) {
  const provider = getProvider();
  const signer = getSigner(provider);
  const timeLock = getTimeLock(provider).connect(signer);
  const owner = await signer.getAddress();

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "?"),
    token.decimals(),
  ]);

  const amount = ethers.parseUnits(amountInput, Number(decimals));

  // 以链上时间为基准，而不是本机时钟——两者可能有偏差（本地链尤其明显），
  // 用本机时间算 "+15d" 可能算出已经过去的时间戳。
  const block = await provider.getBlock("latest");
  const nowSeconds = Math.max(block.timestamp, Math.floor(Date.now() / 1000));
  const unlockTime = parseWhen(whenInput, nowSeconds);

  // 先本地检查一遍，避免白付 gas 换一个 revert
  const maxDuration = Number(await timeLock.MAX_LOCK_DURATION());
  if (unlockTime <= block.timestamp) {
    throw new Error(`${unlockTime} 不在未来（当前链上时间 ${block.timestamp}）`);
  }
  if (unlockTime > block.timestamp + maxDuration) {
    throw new Error(
      `超过合约上限 ${maxDuration} 秒（约 ${maxDuration / 86400} 天），` +
        `最晚只能到 ${block.timestamp + maxDuration}`
    );
  }

  const balance = await token.balanceOf(owner);
  if (balance < amount) {
    throw new Error(
      `余额不足：有 ${ethers.formatUnits(balance, Number(decimals))}，` +
        `需要 ${amountInput}`
    );
  }

  // allowance 不够就补，只授权精确额度，不要用 MaxUint256
  const allowance = await token.allowance(owner, await timeLock.getAddress());
  if (allowance < amount) {
    console.log("1/2 approve...");
    const approveTx = await token.approve(await timeLock.getAddress(), amount);
    await approveTx.wait();
    console.log(`    done: ${approveTx.hash}`);
  } else {
    console.log("1/2 approve 已足够，跳过");
  }

  console.log("2/2 deposit...");
  const tx = await timeLock.deposit(tokenAddress, amount, unlockTime);
  const receipt = await tx.wait();
  console.log(`    done: ${tx.hash}  (gas ${receipt.gasUsed})`);

  // 从事件里取回 lockId
  let lockId;
  for (const log of receipt.logs) {
    try {
      const parsed = timeLock.interface.parseLog(log);
      if (parsed?.name === "LockCreated") lockId = parsed.args.lockId;
    } catch {
      /* 其他合约的日志，忽略 */
    }
  }

  console.log(
    `\n已锁定 ${amountInput} ${symbol}，解锁时间 ${unlockTime} ` +
      `(${new Date(unlockTime * 1000).toISOString()})`
  );
  console.log(`lock id = ${lockId}`);
}

// ---------------------------------------------------------------------------
// 5. 写操作二：到期后取回
// ---------------------------------------------------------------------------
async function claim(lockId) {
  const provider = getProvider();
  const signer = getSigner(provider);
  const timeLock = getTimeLock(provider).connect(signer);
  const owner = await signer.getAddress();

  // 先读一遍，把 revert 原因说清楚
  const lock = await timeLock.getLock(lockId);
  const block = await provider.getBlock("latest");

  if (lock.owner === ethers.ZeroAddress) throw new Error(`lock #${lockId} 不存在`);
  if (lock.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`lock #${lockId} 属于 ${lock.owner}，你的地址 ${owner} 取不了`);
  }
  if (lock.amount === 0n) throw new Error(`lock #${lockId} 已经取回过`);
  if (block.timestamp < Number(lock.unlockTime)) {
    throw new Error(
      `lock #${lockId} 还没到期，还剩 ${formatDuration(
        Number(lock.unlockTime) - block.timestamp
      )}`
    );
  }

  const tx = await timeLock.withdraw(lockId);
  const receipt = await tx.wait();

  const token = new ethers.Contract(lock.token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "?"),
    token.decimals().catch(() => 18),
  ]);

  console.log(`已取回 lock #${lockId}：${tx.hash}  (gas ${receipt.gasUsed})`);
  console.log(
    `代币 ${symbol} (${lock.token})，数量 ` +
      `${ethers.formatUnits(lock.amount, Number(decimals))}`
  );

  // 只想拿金额的话，也可以直接监听 Withdrawn 事件：
  for (const log of receipt.logs) {
    try {
      const parsed = timeLock.interface.parseLog(log);
      if (parsed?.name === "Withdrawn") {
        console.log(`Withdrawn: amount=${parsed.args.amount}`);
      }
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 支持 +30d / +12h / +45m / +90s，或一个 unix 秒级时间戳。baseSeconds 是链上时间。 */
function parseWhen(input, baseSeconds) {
  const relative = /^\+(\d+)([smhd])$/.exec(input);
  if (relative) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[relative[2]];
    return baseSeconds + Number(relative[1]) * unit;
  }
  if (/^\d{9,}$/.test(input)) return Number(input);
  throw new Error(`看不懂的时间格式 "${input}"，用 +30d 或 unix 时间戳`);
}

function formatDuration(totalSeconds) {
  if (totalSeconds <= 0) return "0s";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "locks") {
    // 没给地址就查自己（需要 .env 里有 PRIVATE_KEY 才能推出地址）
    const owner =
      args[0] ||
      (process.env.PRIVATE_KEY
        ? new ethers.Wallet(process.env.PRIVATE_KEY).address
        : undefined);
    if (!owner) throw new Error("用法: node examples/timelock.js locks 0x地址");
    await listLocks(owner);
    return;
  }

  if (command === "lock") {
    const [token, amount, when] = args;
    if (!token || !amount || !when) {
      throw new Error("用法: node examples/timelock.js lock <token> <amount> <when>");
    }
    await lockTokens(token, amount, when);
    return;
  }

  if (command === "claim") {
    if (!args[0]) throw new Error("用法: node examples/timelock.js claim <lockId>");
    await claim(BigInt(args[0]));
    return;
  }

  if (command === "info") {
    if (!args[0]) throw new Error("用法: node examples/timelock.js info <lockId>");
    await showLock(BigInt(args[0]));
    return;
  }

  throw new Error(`未知命令 "${command}"，可用: locks | lock | info | claim`);
}

main().catch((error) => {
  console.error(`\n错误: ${error.message}`);
  process.exitCode = 1;
});
