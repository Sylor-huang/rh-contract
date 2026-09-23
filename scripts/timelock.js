#!/usr/bin/env node
/**
 * RobinTimeLock helper CLI.
 *
 * Read-only commands need nothing but an RPC URL. Commands that send a
 * transaction need PRIVATE_KEY in .env.
 *
 *   node scripts/timelock.js create <token> <amount> <when>
 *   node scripts/timelock.js info <lockId>
 *   node scripts/timelock.js withdraw <lockId>
 *   node scripts/timelock.js list [ownerAddress]
 *
 * Options:
 *   --mainnet | --testnet | --network <name>   which chain to talk to (default: testnet)
 *   --address <0x...>                          time lock address (default: TIME_LOCK_ADDRESS from .env)
 *   --from <block>                             first block to scan for `list` (default: 0)
 *
 * <when> accepts:
 *   +30d  +12h  +90m  +45s  +2w  +1y   relative to now
 *   1790000000                          an absolute unix timestamp in seconds
 *   2026-12-31T00:00:00Z                an ISO 8601 date
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const NETWORKS = {
  local: {
    chainId: 31337,
    label: "localhost (hardhat node)",
    envKey: "LOCAL_RPC_URL",
    fallbackRpc: "http://127.0.0.1:8545",
  },
  testnet: {
    chainId: 46630,
    label: "robinhoodTestnet",
    envKey: "RH_TESTNET_RPC_URL",
    fallbackRpc: "https://rpc.testnet.chain.robinhood.com",
  },
  mainnet: {
    chainId: 4663,
    label: "robinhood",
    envKey: "RH_RPC_URL",
    fallbackRpc: "https://rpc.mainnet.chain.robinhood.com",
  },
};

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
  y: 365 * 24 * 60 * 60,
};

function loadAbi() {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "RobinTimeLock.sol",
    "RobinTimeLock.json"
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      "Artifact not found. Run `npx hardhat compile` first, then retry."
    );
  }

  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = ["--network", "--address", "--from", "--rpc"];

    if (arg === "--mainnet") flags.network = "mainnet";
    else if (arg === "--testnet") flags.network = "testnet";
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else if (needsValue.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }

  return { flags, positional };
}

function parseWhen(input, nowSeconds) {
  const relative = /^\+(\d+)([smhdwy])$/.exec(input);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_SECONDS[relative[2]];
    return nowSeconds + amount * unit;
  }

  if (/^\d+$/.test(input)) {
    const absolute = Number(input);
    if (absolute < 1_000_000_000) {
      throw new Error(
        `${input} looks too small for a unix timestamp in seconds. ` +
          "Did you mean milliseconds, or a relative value like +30d?"
      );
    }
    return absolute;
  }

  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Cannot read "${input}" as a time. Use +30d, a unix timestamp, or an ISO date.`
    );
  }
  return Math.floor(parsed / 1000);
}

function formatDuration(totalSeconds) {
  if (totalSeconds <= 0) return "now";

  const parts = [];
  let rest = totalSeconds;
  for (const [label, size] of [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ]) {
    const value = Math.floor(rest / size);
    if (value > 0) {
      parts.push(`${value}${label}`);
      rest -= value * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

function formatTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

function buildContext(flags) {
  const networkName = flags.network || "testnet";
  const network = NETWORKS[networkName];
  if (!network) {
    throw new Error(
      `Unknown network "${networkName}". Use testnet or mainnet.`
    );
  }

  const rpc = flags.rpc || process.env[network.envKey] || network.fallbackRpc;
  const provider = new ethers.JsonRpcProvider(rpc, network.chainId, {
    staticNetwork: true,
  });

  const timeLockAddress = flags.address || process.env.TIME_LOCK_ADDRESS;
  if (!timeLockAddress) {
    throw new Error(
      "No time lock address. Pass --address 0x... or set TIME_LOCK_ADDRESS in .env."
    );
  }

  const timeLock = new ethers.Contract(timeLockAddress, loadAbi(), provider);

  return { network, rpc, provider, timeLock, timeLockAddress };
}

function connectWallet(provider) {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is missing from .env - needed to send transactions.");
  }
  // NonceManager because some commands send two transactions back to back
  // (approve + deposit). Without it the second one reuses the nonce cached by
  // the provider for the first one and gets rejected as "nonce too low".
  return new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
}

function findLockId(timeLock, receipt) {
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = timeLock.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === "LockCreated") {
      return parsed.args.lockId;
    }
  }
  return undefined;
}

async function commandCreate({ positional, flags, ctx }) {
  const [, tokenAddress, amountInput, whenInput] = positional;
  if (!tokenAddress || !amountInput || !whenInput) {
    throw new Error("Usage: create <token> <amount> <when>");
  }

  const wallet = connectWallet(ctx.provider);
  const signerAddress = await wallet.getAddress();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  const tokenCode = await ctx.provider.getCode(tokenAddress);
  if (tokenCode === "0x") {
    throw new Error(`No ERC20 contract at ${tokenAddress} on this chain.`);
  }

  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "?"),
    token.decimals(),
  ]);

  const amount = ethers.parseUnits(amountInput, decimals);
  if (amount === 0n) throw new Error("Amount rounds down to zero.");

  const latest = await ctx.provider.getBlock("latest");
  // Use whichever clock is ahead, so a lagging testnet node cannot make a
  // relative time like +45s land in the past by the time the tx is mined.
  const nowSeconds = Math.max(
    latest.timestamp,
    Math.floor(Date.now() / 1000)
  );
  const unlockTime = parseWhen(whenInput, nowSeconds);
  const maxUnlockTime =
    Number(await ctx.timeLock.MAX_LOCK_DURATION()) + nowSeconds;

  if (unlockTime <= nowSeconds) {
    throw new Error(`${formatTime(unlockTime)} is not in the future.`);
  }
  if (unlockTime > maxUnlockTime) {
    throw new Error(
      `${formatTime(unlockTime)} is beyond the contract maximum ` +
        `(${formatTime(maxUnlockTime)}).`
    );
  }

  console.log(`Network:  ${ctx.network.label} (chainId ${ctx.network.chainId})`);
  console.log(`Lock:     ${ctx.timeLockAddress}`);
  console.log(`Signer:   ${signerAddress}`);
  console.log(`Token:    ${symbol} @ ${tokenAddress}`);
  console.log(`Amount:   ${amountInput} (${amount} base units)`);
  console.log(
    `Unlocks:  ${formatTime(unlockTime)} (in ${formatDuration(
      unlockTime - latest.timestamp
    )})`
  );
  console.log("");

  const [balance, allowance] = await Promise.all([
    token.balanceOf(signerAddress),
    token.allowance(signerAddress, ctx.timeLockAddress),
  ]);

  if (balance < amount) {
    throw new Error(
      `Balance too low: have ${balance} base units, need ${amount}.`
    );
  }

  if (allowance < amount) {
    console.log(`Approving exactly ${amount} base units (not unlimited)...`);
    const approveTx = await token.approve(ctx.timeLockAddress, amount);
    await approveTx.wait();
    console.log(`Approved in ${approveTx.hash}`);
  }

  const tx = await ctx.timeLock.connect(wallet).deposit(tokenAddress, amount, unlockTime);
  console.log(`deposit() sent: ${tx.hash}`);

  const receipt = await tx.wait();
  const lockId = findLockId(ctx.timeLock, receipt);

  console.log(`Confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  console.log("");
  console.log(`Lock created: id ${lockId ?? "(see LockCreated event)"}`);
  console.log(`Withdraw with: node scripts/timelock.js withdraw ${lockId ?? "<id>"}`);
}

async function describeLock(ctx, lockId) {
  const lockCount = await ctx.timeLock.lockCount();
  if (lockId === 0n || lockId > lockCount) {
    return `lock ${lockId} does not exist (there are ${lockCount} locks)`;
  }

  const lock = await ctx.timeLock.getLock(lockId);
  const block = await ctx.provider.getBlock("latest");
  const unlockTime = Number(lock.unlockTime);
  const withdrawn = lock.amount === 0n;
  const meta = (await describeTokens(ctx.provider, [lock.token])).get(
    lock.token.toLowerCase()
  );

  const lines = [
    `lock ${lockId}`,
    `  owner:      ${lock.owner}`,
    `  token:      ${lock.token}${meta ? ` (${meta.symbol})` : ""}`,
    `  amount:     ${
      withdrawn ? "0 (already withdrawn)" : formatAmount(lock.amount, meta)
    }`,
    `  unlockTime: ${unlockTime} (${formatTime(unlockTime)})`,
  ];

  if (withdrawn) {
    lines.push("  status:     withdrawn - nothing left to claim");
  } else if (block.timestamp >= unlockTime) {
    lines.push("  status:     unlocked - withdrawable now");
  } else {
    lines.push(
      `  status:     locked for another ${formatDuration(
        unlockTime - block.timestamp
      )}`
    );
  }

  return lines.join("\n");
}

async function commandInfo({ positional, ctx }) {
  const lockIdInput = positional[1];
  if (!lockIdInput) throw new Error("Usage: info <lockId>");

  console.log(await describeLock(ctx, BigInt(lockIdInput)));
}

async function commandWithdraw({ positional, ctx }) {
  const lockIdInput = positional[1];
  if (!lockIdInput) throw new Error("Usage: withdraw <lockId>");

  const lockId = BigInt(lockIdInput);
  const wallet = connectWallet(ctx.provider);
  const signerAddress = await wallet.getAddress();
  const block = await ctx.provider.getBlock("latest");
  const lock = await ctx.timeLock.getLock(lockId);

  if (lock.owner === ethers.ZeroAddress) {
    throw new Error(`Lock ${lockId} does not exist.`);
  }
  if (lock.owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Lock ${lockId} belongs to ${lock.owner}, not to your signer ${signerAddress}. ` +
        "Only the depositor can withdraw it."
    );
  }
  if (lock.amount === 0n) {
    throw new Error(`Lock ${lockId} has already been withdrawn.`);
  }
  if (block.timestamp < Number(lock.unlockTime)) {
    throw new Error(
      `Lock ${lockId} unlocks at ${formatTime(Number(lock.unlockTime))}, ` +
        `in ${formatDuration(Number(lock.unlockTime) - block.timestamp)}. ` +
        "The contract will reject an early withdrawal."
    );
  }

  const tx = await ctx.timeLock.connect(wallet).withdraw(lockId);
  console.log(`withdraw() sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  console.log(`Lock ${lockId} withdrawn: ${lock.amount} base units of ${lock.token}`);
}

/** Human readable metadata (symbol, decimals) for a set of token addresses. */
async function describeTokens(provider, addresses) {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];

  const entries = await Promise.all(
    unique.map(async (address) => {
      const token = new ethers.Contract(address, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([
        token.symbol().catch(() => "?"),
        token.decimals().catch(() => 18),
      ]);
      return [address, { symbol, decimals: Number(decimals) }];
    })
  );

  return new Map(entries);
}

function formatAmount(amount, meta) {
  if (!meta) return amount.toString();
  try {
    return `${ethers.formatUnits(amount, meta.decimals)} ${meta.symbol}`;
  } catch {
    return amount.toString();
  }
}

/** `list <owner>` - answered by a single getUserLocks() call. */
async function listForOwner(ctx, owner) {
  const locks = await ctx.timeLock.getUserLocks(owner);

  if (locks.length === 0) {
    console.log(`${owner} has no locks waiting to be withdrawn.`);
    return;
  }

  const tokens = await describeTokens(
    ctx.provider,
    locks.map((lock) => lock.token)
  );

  console.log(`Locks of ${owner} (${locks.length}) - not withdrawn yet:`);

  for (const lock of locks) {
    const meta = tokens.get(lock.token.toLowerCase());
    const unlockTime = Number(lock.unlockTime);
    const remaining = Number(lock.secondsUntilUnlock);

    const status =
      remaining === 0
        ? "unlocked - withdrawable now"
        : `locked for ${formatDuration(remaining)}`;

    console.log("");
    console.log(`lock ${lock.lockId}  [${status}]`);
    console.log(`  token:      ${lock.token}${meta ? ` (${meta.symbol})` : ""}`);
    console.log(`  amount:     ${formatAmount(lock.amount, meta)}`);
    console.log(`  unlockTime: ${unlockTime} (${formatTime(unlockTime)})`);
    console.log(`  time left:  ${formatDuration(remaining)}`);
  }

  console.log("");
  console.log(`${locks.length} lock(s) still to claim.`);
}

/** `list` with no owner - scan LockCreated logs, then read each lock. */
async function listEveryLock(ctx, fromBlock) {
  console.log(
    `Scanning LockCreated logs from block ${fromBlock} on ${ctx.network.label}...`
  );

  let logs;
  try {
    logs = await ctx.timeLock.queryFilter(
      ctx.timeLock.filters.LockCreated(),
      fromBlock
    );
  } catch (error) {
    throw new Error(
      `Log query failed (${error.message}). ` +
        "The public RPC may cap the block range - retry with --from <recent block>, " +
        "or pass an owner address to use getUserLocks() instead."
    );
  }

  if (logs.length === 0) {
    console.log("No locks found.");
    return;
  }

  const locks = await Promise.all(
    logs.map(async (log) => {
      const lockId = log.args.lockId;
      const lock = await ctx.timeLock.getLock(lockId);
      return { log, lockId, lock };
    })
  );

  const tokens = await describeTokens(
    ctx.provider,
    locks.map(({ lock }) => lock.token)
  );
  const latest = await ctx.provider.getBlock("latest");

  for (const { log, lockId, lock } of locks) {
    const meta = tokens.get(lock.token.toLowerCase());
    const unlockTime = Number(lock.unlockTime);
    let status;
    if (lock.amount === 0n) status = "withdrawn";
    else if (latest.timestamp >= unlockTime) status = "unlocked";
    else status = `locked ${formatDuration(unlockTime - latest.timestamp)}`;

    console.log("");
    console.log(`lock ${lockId}  [${status}]`);
    console.log(`  created in block ${log.blockNumber}`);
    console.log(`  owner:      ${lock.owner}`);
    console.log(`  token:      ${lock.token}${meta ? ` (${meta.symbol})` : ""}`);
    console.log(
      `  amount:     ${formatAmount(lock.amount, meta)}${
        lock.amount === 0n ? " (withdrawn, original amount in the event)" : ""
      }`
    );
    console.log(`  unlockTime: ${unlockTime} (${formatTime(unlockTime)})`);
  }

  console.log("");
  console.log(`${locks.length} lock(s).`);
}

async function commandList({ positional, flags, ctx }) {
  const owner = positional[1];

  if (owner) {
    if (!ethers.isAddress(owner)) {
      throw new Error(`"${owner}" is not an address.`);
    }
    await listForOwner(ctx, owner);
    return;
  }

  await listEveryLock(ctx, flags.from ? Number(flags.from) : 0);
}

const COMMANDS = {
  create: commandCreate,
  info: commandInfo,
  withdraw: commandWithdraw,
  list: commandList,
};

function printHelp() {
  console.log(
    [
      "RobinTimeLock helper",
      "",
      "Commands:",
      "  create <token> <amount> <when>   lock tokens until <when>",
      "  info <lockId>                    show one lock",
      "  withdraw <lockId>                claim a matured lock",
      "  list [owner]                     locks of one owner (getUserLocks), or all locks",
      "",
      "Options:",
      "  --network local|testnet|mainnet   (default: testnet)",
      "  --address 0x...             time lock address (default: TIME_LOCK_ADDRESS)",
      "  --from <block>              first block for `list` without an owner (default: 0)",
      "",
      "<when> examples: +30d, +12h, +90m, 1790000000, 2026-12-31T00:00:00Z",
      "The contract caps a lock at 365 days, so +365d is the longest accepted value.",
      "",
      "Examples:",
      "  node scripts/timelock.js create 0xToken 1000 +90d",
      "  node scripts/timelock.js --mainnet info 1",
      "  node scripts/timelock.js list 0xYourAddress",
    ].join("\n")
  );
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (flags.help || !command) {
    printHelp();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    printHelp();
    throw new Error(`Unknown command "${command}"`);
  }

  const ctx = buildContext(flags);

  // Fail early and clearly when pointed at the wrong chain.
  const actualChainId = Number((await ctx.provider.getNetwork()).chainId);
  if (actualChainId !== ctx.network.chainId) {
    throw new Error(
      `RPC reports chainId ${actualChainId} but ${ctx.network.label} expects ` +
        `${ctx.network.chainId}. Check the RPC URL.`
    );
  }

  const code = await ctx.provider.getCode(ctx.timeLockAddress);
  if (code === "0x") {
    throw new Error(
      `No contract at ${ctx.timeLockAddress} on ${ctx.network.label}.`
    );
  }

  await handler({ positional, flags, ctx });
}

main().catch((error) => {
  console.error("");
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
