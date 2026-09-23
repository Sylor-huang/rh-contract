/**
 * RobinBatchTransfer 完整调用示例（ethers v6）。
 *
 * 这个文件既能直接当工具跑，也是"照着改就能用"的模板：
 * 每一步都拆成独立函数，方便复制到自己的项目里。
 *
 * 运行前在 .env 里配好：
 *   PRIVATE_KEY=0x...
 *   RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
 *   BATCH_TRANSFER_ADDRESS=0x...            # 部署后得到的地址
 *
 * 运行：
 *   node examples/batch-transfer.js eth   0x地址A:0.01 0x地址B:0.02 ...
 *   node examples/batch-transfer.js token 0x代币  0x地址A:100 0x地址B:250 ...
 *   node examples/batch-transfer.js ethgas 0x地址A:0.01            # 预估 gas，不发送
 */
require("dotenv").config();

const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// 1. 整套功能就这两个入口，外加一个只读常量。
// ---------------------------------------------------------------------------
const BATCH_ABI = [
  // 注意：写 address[] 就行，不要写 address payable[]，ethers 的可读 ABI 解析不了后者
  "function multiTransferETH(address[] recipients, uint256[] amounts) payable",
  "function multiTransferToken(address token, address[] recipients, uint256[] amounts)",
  "function MAX_RECIPIENTS() view returns (uint256)",
  "function ETH_TRANSFER_GAS_LIMIT() view returns (uint256)",
  "event BatchETHTransfer(address indexed sender, uint256 recipientCount, uint256 totalAmount)",
  "event BatchTokenTransfer(address indexed sender, address indexed token, uint256 recipientCount, uint256 totalAmount)",
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

function getBatch(provider) {
  const address = process.env.BATCH_TRANSFER_ADDRESS;
  if (!address) throw new Error("请在 .env 里设置 BATCH_TRANSFER_ADDRESS");
  return new ethers.Contract(address, BATCH_ABI, provider);
}

/**
 * 带私钥的 signer。
 * NonceManager 是必须的：`token` 模式要连发 approve + multiTransferToken 两笔，
 * 不加它第二笔会撞上 provider 缓存的 nonce。
 */
function getSigner(provider) {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("请在 .env 里设置 PRIVATE_KEY");
  }
  return new ethers.NonceManager(
    new ethers.Wallet(process.env.PRIVATE_KEY, provider)
  );
}

// ---------------------------------------------------------------------------
// 3. 把 "0x地址:数量" 这种参数解析成两个数组
// ---------------------------------------------------------------------------
function parseRecipients(pairs, decimals) {
  const recipients = [];
  const amounts = [];

  for (const pair of pairs) {
    const separator = pair.lastIndexOf(":");
    if (separator === -1) {
      throw new Error(`参数格式应为 0x地址:数量，收到 "${pair}"`);
    }
    const address = pair.slice(0, separator);
    const amountInput = pair.slice(separator + 1);

    if (!ethers.isAddress(address)) throw new Error(`不是合法地址: ${address}`);

    recipients.push(address);
    amounts.push(ethers.parseUnits(amountInput, Number(decimals)));
  }

  return { recipients, amounts };
}

// ---------------------------------------------------------------------------
// 4. 批量转 ETH
// ---------------------------------------------------------------------------
async function transferETH(pairs, { dryRun = false } = {}) {
  const provider = getProvider();
  const batch = getBatch(provider);
  const { recipients, amounts } = parseRecipients(pairs, 18);

  const maxRecipients = await batch.MAX_RECIPIENTS();
  if (recipients.length > Number(maxRecipients)) {
    throw new Error(
      `一次最多 ${maxRecipients} 个收款地址，收到 ${recipients.length} 个`
    );
  }

  // msg.value 必须精确等于所有金额之和，多一分少一分都会被拒
  const total = amounts.reduce((sum, value) => sum + value, 0n);

  console.log(`收款地址 ${recipients.length} 个，合计 ${ethers.formatEther(total)} ETH`);

  if (dryRun) {
    const signer = getSigner(provider);
    const owner = await signer.getAddress();
    const balance = await provider.getBalance(owner);
    // estimateGas 会用真实逻辑跑一遍，金额不合法这里就会炸
    const gas = await batch
      .connect(signer)
      .multiTransferETH.estimateGas(recipients, amounts, { value: total });
    const fee = await provider.getFeeData();

    console.log(`预估 gas: ${gas}`);
    console.log(`当前 gasPrice: ${fee.gasPrice}`);
    console.log(
      `预估手续费: ${ethers.formatEther(gas * (fee.gasPrice ?? 0n))} ETH`
    );
    console.log(`你的余额:   ${ethers.formatEther(balance)} ETH`);
    console.log(`(dry run，未发送任何交易)`);
    return;
  }

  const signer = getSigner(provider);
  const tx = await batch
    .connect(signer)
    .multiTransferETH(recipients, amounts, { value: total });

  console.log(`已发送: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`已确认，区块 ${receipt.blockNumber}，gas ${receipt.gasUsed}`);

  for (const log of receipt.logs) {
    try {
      const parsed = batch.interface.parseLog(log);
      if (parsed?.name === "BatchETHTransfer") {
        console.log(
          `BatchETHTransfer: ${parsed.args.recipientCount} 个地址，` +
            `${ethers.formatEther(parsed.args.totalAmount)} ETH`
        );
      }
    } catch {
      /* 其他合约的日志，忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 批量转 ERC20（先 approve，再转账）
// ---------------------------------------------------------------------------
async function transferToken(tokenAddress, pairs, { dryRun = false } = {}) {
  const provider = getProvider();
  const signer = getSigner(provider);
  const owner = await signer.getAddress();
  const batch = getBatch(provider).connect(signer);

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "?"),
    token.decimals(),
  ]);

  const { recipients, amounts } = parseRecipients(pairs, decimals);
  const maxRecipients = await batch.MAX_RECIPIENTS();
  if (recipients.length > Number(maxRecipients)) {
    throw new Error(
      `一次最多 ${maxRecipients} 个收款地址，收到 ${recipients.length} 个`
    );
  }

  const total = amounts.reduce((sum, value) => sum + value, 0n);
  console.log(
    `代币 ${symbol}，收款地址 ${recipients.length} 个，` +
      `合计 ${ethers.formatUnits(total, Number(decimals))}`
  );

  if (dryRun) {
    const gas = await batch.multiTransferToken.estimateGas(
      tokenAddress,
      recipients,
      amounts
    );
    const fee = await provider.getFeeData();
    console.log(`预估 gas: ${gas}`);
    console.log(
      `预估手续费: ${ethers.formatEther(gas * (fee.gasPrice ?? 0n))} ETH`
    );
    console.log(`(dry run，未发送任何交易)`);
    return;
  }

  const balance = await token.balanceOf(owner);
  if (balance < total) {
    throw new Error(
      `余额不足：有 ${ethers.formatUnits(balance, Number(decimals))}，需要 ${ethers.formatUnits(total, Number(decimals))}`
    );
  }

  const batchAddress = await batch.getAddress();
  const allowance = await token.allowance(owner, batchAddress);
  if (allowance < total) {
    console.log("1/2 approve...");
    const approveTx = await token.approve(batchAddress, total);
    await approveTx.wait();
    console.log(`    done: ${approveTx.hash}`);
  } else {
    console.log("1/2 approve 已足够，跳过");
  }

  console.log("2/2 multiTransferToken...");
  const tx = await batch.multiTransferToken(tokenAddress, recipients, amounts);
  const receipt = await tx.wait();
  console.log(`    done: ${tx.hash}  (区块 ${receipt.blockNumber}, gas ${receipt.gasUsed})`);

  for (const log of receipt.logs) {
    try {
      const parsed = batch.interface.parseLog(log);
      if (parsed?.name === "BatchTokenTransfer") {
        console.log(
          `BatchTokenTransfer: ${parsed.args.recipientCount} 个地址，` +
            `${parsed.args.totalAmount} base units`
        );
      }
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "eth") {
    if (rest.length === 0) {
      throw new Error("用法: node examples/batch-transfer.js eth 0x地址:0.01 ...");
    }
    await transferETH(rest);
    return;
  }

  if (command === "ethgas") {
    if (rest.length === 0) {
      throw new Error("用法: node examples/batch-transfer.js ethgas 0x地址:0.01 ...");
    }
    await transferETH(rest, { dryRun: true });
    return;
  }

  if (command === "token") {
    const [tokenAddress, ...pairs] = rest;
    if (!tokenAddress || pairs.length === 0) {
      throw new Error(
        "用法: node examples/batch-transfer.js token 0x代币 0x地址:100 ..."
      );
    }
    await transferToken(tokenAddress, pairs);
    return;
  }

  if (command === "tokengas") {
    const [tokenAddress, ...pairs] = rest;
    if (!tokenAddress || pairs.length === 0) {
      throw new Error(
        "用法: node examples/batch-transfer.js tokengas 0x代币 0x地址:100 ..."
      );
    }
    await transferToken(tokenAddress, pairs, { dryRun: true });
    return;
  }

  console.log(
    [
      "RobinBatchTransfer 示例",
      "",
      "  node examples/batch-transfer.js eth      0x地址A:0.01 0x地址B:0.02",
      "  node examples/batch-transfer.js ethgas   0x地址A:0.01          # 只预估不发送",
      "  node examples/batch-transfer.js token    0x代币 0x地址A:100 0x地址B:250",
      "  node examples/batch-transfer.js tokengas 0x代币 0x地址A:100    # 只预估不发送",
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(`\n错误: ${error.message}`);
  process.exitCode = 1;
});
