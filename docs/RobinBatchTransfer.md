# RobinBatchTransfer — 批量转账

一次性把 ETH 或 ERC20 转给最多 50 个地址。自用工具，不是收款合约：没有 owner、没有代理、不托管任何资金。

- 合约源码：`contracts/RobinBatchTransfer.sol`
- 可运行示例：`examples/batch-transfer.js`
- 测试：`test/RobinBatchTransfer.test.js`
- 网络：Robinhood Chain 主网 `4663` / 测试网 `46630`

---

## 1. 它做什么、不做什么

**做**：在一次交易里，把相同或不同数量的 ETH / 同一种 ERC20 分发给一批地址。

**不做**：

- 不持有资金。ETH 当场转走，ERC20 从你的地址直接转给收款方（合约只是搬运工，不是托管方）
- 没有 owner、没有管理员、没有暂停、没有升级代理
- 没有任何函数能取走合约里的余额
- 不支持 ETH 退款逻辑：一笔失败整笔回滚

---

## 2. 接口速查

```solidity
function multiTransferETH(address[] recipients, uint256[] amounts) payable;
function multiTransferToken(address token, address[] recipients, uint256[] amounts);

function MAX_RECIPIENTS() view returns (uint256);          // 50
function ETH_TRANSFER_GAS_LIMIT() view returns (uint256);  // 100000
```

| 参数 | 说明 |
|---|---|
| `recipients` | 收款地址数组，长度 1 ~ 50 |
| `amounts` | 对应每个地址的金额数组，长度必须与 `recipients` 完全一致，每项必须 > 0 |
| `token` | ERC20 合约地址（`multiTransferToken` 用） |
| `msg.value` | 仅 `multiTransferETH`：必须**精确等于**所有 `amounts` 之和 |

### 规则与限制

- `recipients.length == amounts.length`，否则 revert
- `1 <= recipients.length <= 50`，超过 50 个 revert
- 每个 `amounts[i] > 0`，`recipients[i] != address(0)`
- `multiTransferETH` 要求 `msg.value == sum(amounts)`，多一分少一分都会被拒
- `multiTransferToken` 需要先 `approve` 本合约足够的额度，且用 `SafeERC20`（兼容 USDT 这类不返回 `bool` 的代币）
- 两个入口都有 `nonReentrant` 保护
- **一笔失败整笔回滚**：只要有一个收款地址拒收 ETH，全部转账都不会发生

### ETH 转账的 gas 限制

`multiTransferETH` 给每个收款地址的 `call` 限制 `100_000` gas（`ETH_TRANSFER_GAS_LIMIT`）。这个限制有两个作用：

- 防止某个收款方用巨大的 `receive()` 逻辑烧掉你剩下的全部 gas
- 普通 EOA 地址 / 交易所充值地址大约只需要 2,300 gas，100k 绰绰有余

如果你的收款方是需要更多 gas 才能收款的智能合约，需要改这个常量（它写死在合约里，改要重新部署）。

### 收款地址是「全新地址」会更贵

一个链上从未出现过的地址，第一次接收资产会产生 **25,000 gas** 的账户创建成本。50 个全新地址大约会多花 125 万 gas。

---

## 3. 事件

```solidity
event BatchETHTransfer(
    address indexed sender,
    uint256 recipientCount,
    uint256 totalAmount
);

event BatchTokenTransfer(
    address indexed sender,
    address indexed token,
    uint256 recipientCount,
    uint256 totalAmount
);
```

注意事件只记录**汇总**（笔数 + 总额），不记录每个收款人的明细。如果需要逐笔明细，请用 ERC20 各自的 `Transfer` 事件，或改用直接转账。

---

## 4. 完整调用示例

### 方式 A：跑 examples/batch-transfer.js

`examples/batch-transfer.js` 既是可直接运行的工具，也是带中文注释的模板。参数格式是 `0x地址:数量`。

```bash
# 批量转 ETH
node examples/batch-transfer.js eth 0x地址A:0.01 0x地址B:0.02

# 只预估 gas 和手续费，不发送交易（强烈建议先跑这个）
node examples/batch-transfer.js ethgas 0x地址A:0.01 0x地址B:0.02

# 批量转 ERC20（会自动先 approve 精确额度）
node examples/batch-transfer.js token 0x代币 0x地址A:100 0x地址B:250

# ERC20 的 dry run
node examples/batch-transfer.js tokengas 0x代币 0x地址A:100 0x地址B:250
```

运行前在 `.env` 里配好（示例里用 `RH_TESTNET_RPC_URL` / `RH_CHAIN_ID` / `BATCH_TRANSFER_ADDRESS`）：

```bash
PRIVATE_KEY=0x...
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
RH_CHAIN_ID=46630
BATCH_TRANSFER_ADDRESS=0x部署后的地址
```

实际输出长这样：

```bash
$ node examples/batch-transfer.js ethgas 0x7099...79C8:0.01 0x3C44...93BC:0.02
收款地址 2 个，合计 0.03 ETH
预估 gas: 53557
当前 gasPrice: 1137053026
预估手续费: 0.000060897148913482 ETH
你的余额:   9999.996876473720195127 ETH
(dry run，未发送任何交易)

$ node examples/batch-transfer.js eth 0x7099...79C8:0.01 0x3C44...93BC:0.02
收款地址 2 个，合计 0.03 ETH
已发送: 0x85aab2df...51b8c3
已确认，区块 15，gas 48277
BatchETHTransfer: 2 个地址，0.03 ETH
```

### 方式 B：ethers v6 代码片段

```js
const { ethers } = require("ethers");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const BATCH = "0x你的批量转账合约地址";

const BATCH_ABI = [
  // 注意：写 address[] 就行，不要写 address payable[]，ethers 的可读 ABI 解析不了后者
  "function multiTransferETH(address[] recipients, uint256[] amounts) payable",
  "function multiTransferToken(address token, address[] recipients, uint256[] amounts)",
  "function MAX_RECIPIENTS() view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// NonceManager 是必须的：ERC20 模式要连发 approve + 转账两笔，
// 不加它第二笔会撞上 provider 缓存的 nonce。
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const wallet = new ethers.NonceManager(new ethers.Wallet(PRIVATE_KEY, provider));
const batch = new ethers.Contract(BATCH, BATCH_ABI, wallet);
```

**① 批量转 ETH**

```js
const recipients = ["0x地址A", "0x地址B", "0x地址C"];
const amounts = [
  ethers.parseEther("0.01"),
  ethers.parseEther("0.02"),
  ethers.parseEther("0.03"),
];

// msg.value 必须精确等于总和
const total = amounts.reduce((sum, v) => sum + v, 0n);

// 先估算一遍，确认不会 revert，也顺便看看手续费
const gas = await batch.multiTransferETH.estimateGas(recipients, amounts, {
  value: total,
});
console.log("预计 gas:", gas.toString());

const tx = await batch.multiTransferETH(recipients, amounts, { value: total });
const receipt = await tx.wait();
console.log("已确认，实际 gas:", receipt.gasUsed.toString());
```

**② 批量转 ERC20**

```js
const tokenAddress = "0x代币地址";
const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

const recipients = ["0x地址A", "0x地址B"];
const decimals = await token.decimals();
const amounts = [
  ethers.parseUnits("100", decimals),
  ethers.parseUnits("250", decimals),
];
const total = amounts.reduce((sum, v) => sum + v, 0n);

// 授权：只给精确额度，不用 MaxUint256
const allowance = await token.allowance(await wallet.getAddress(), BATCH);
if (allowance < total) {
  await (await token.approve(BATCH, total)).wait();
}

const tx = await batch.multiTransferToken(tokenAddress, recipients, amounts);
const receipt = await tx.wait();
console.log("已确认，实际 gas:", receipt.gasUsed.toString());
```

**③ 处理"某个地址拒收 ETH"**

一笔失败整笔回滚。如果某个收款方可能是合约，建议先估算：

```js
try {
  await batch.multiTransferETH.estimateGas(recipients, amounts, { value: total });
  console.log("可以发送");
} catch (e) {
  console.log("会失败，可能有人拒收 ETH：", e.shortMessage ?? e.message);
}
```

真要发不进去的那一个，就单独拆出来用普通转账处理。

### 方式 C：cast 命令行（Foundry）

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
BATCH=0x批量转账合约地址
PK=0x你的私钥

# 批量转 ETH：地址数组用方括号，金额用最小单位（wei）
cast send $BATCH "multiTransferETH(address[],uint256[])" \
  "[0x地址A,0x地址B]" "[10000000000000000,20000000000000000]" \
  --value 30000000000000000 \
  --private-key $PK --rpc-url $RPC

# 批量转 ERC20：先授权
cast send 0x代币 "approve(address,uint256)" $BATCH 350000000000000000000 \
  --private-key $PK --rpc-url $RPC
cast send $BATCH "multiTransferToken(address,address[],uint256[])" \
  0x代币 "[0x地址A,0x地址B]" "[100000000000000000000,250000000000000000000]" \
  --private-key $PK --rpc-url $RPC

# 看看上限
cast call $BATCH "MAX_RECIPIENTS()(uint256)" --rpc-url $RPC   # 50
```

### 方式 D：Blockscout 网页

打开 [主网浏览器](https://robinhoodchain.blockscout.com) → 搜索合约地址 → **Contract** → **Write Contract**：

- ETH：调 `multiTransferETH`，在 "Value" 里填总额（单位 ETH，注意浏览器会用 ETH 而不是 wei），数组用 JSON 格式填
- ERC20：先在**代币合约**上调 `approve`，再回来调 `multiTransferToken`

网页填写数组比较别扭，超过 3 个地址建议还是用脚本。

---

## 5. 部署

```bash
# 测试网
npx hardhat run scripts/deploy.js --network robinhoodTestnet

# 主网
npx hardhat run scripts/deploy.js --network robinhood
```

脚本按 hardhat 网络名做白名单（`robinhood` / `robinhoodTestnet` / `localhost`），并核对 chainId，忘了带 `--network` 会直接拒绝。

部署后把地址写进 `.env`：`BATCH_TRANSFER_ADDRESS=0x...`

验证源码：

```bash
npx hardhat verify --network robinhood <地址>
```

## 6. 本地演练

终端 A：

```bash
npx hardhat node
```

终端 B：

```bash
npx hardhat run scripts/deploy.js --network localhost
```

输出会给出 `BATCH_TRANSFER_ADDRESS` 和本地测试代币 `MOCK_TOKEN`。然后：

```bash
export PRIVATE_KEY=<本地节点账户私钥>
export RH_TESTNET_RPC_URL=http://127.0.0.1:8545
export RH_CHAIN_ID=31337
export BATCH_TRANSFER_ADDRESS=<输出的地址>

# 先 dry run
node examples/batch-transfer.js ethgas 0x70997970C51812dc3A010C7d01b50e0d17dc79C8:0.01

# 再真的发
node examples/batch-transfer.js eth 0x70997970C51812dc3A010C7d01b50e0d17dc79C8:0.01

# ERC20
node examples/batch-transfer.js token <MOCK_TOKEN> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8:100
```

## 7. 测试覆盖

```bash
npx hardhat test test/RobinBatchTransfer.test.js
```

覆盖：ETH 批量转账、金额不匹配、长度不匹配、超过 50 个、零地址 / 零金额、`msg.value` 不等于总和、标准 ERC20、USDT 式无返回值 token、allowance 不足、余额不足。

## 8. Gas 参考（50 个地址批量，按 0.297 Gwei 估算）

| 场景 | gas | 手续费 |
|---|---|---|
| ETH 批量，收款地址已存在 | ~572,000 | ~0.00017 ETH |
| ETH 批量，收款地址为全新地址 | ~1,824,000 | ~0.00054 ETH |
| ERC20 批量 | ~1,440,000 | ~0.00043 ETH |

> 全新地址（链上首次出现）会额外产生每地址 25,000 gas 的账户创建成本。

## 9. 常见问题

- **`Incorrect ETH amount`**：`msg.value` 必须精确等于所有金额之和，不能多给。多给了也会 revert。
- **`Maximum 50 recipients`**：分批发，每批不超过 50 个。
- **`ETH transfer failed`**：某个收款方拒收 ETH（通常是需要更多 gas 的合约，或明确拒绝收款的合约）。用 `estimateGas` 定位。
- **`Insufficient allowance`**：`multiTransferToken` 之前要先 `approve` 本合约。
- **`insufficient funds for gas`**：ETH 批量时账户余额要 ≥ 转账总额 + 手续费。
