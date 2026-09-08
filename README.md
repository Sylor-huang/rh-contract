# RobinBatchTransfer

在 Robinhood Chain 上批量转账 ETH / ERC20 的合约。

- 语言：Solidity `^0.8.24`
- 工具链：Hardhat 2 + ethers v6
- 主网 chainId：`4663`
- 测试网 chainId：`46630`

## 功能

| 函数 | 说明 |
|---|---|
| `multiTransferETH(address payable[] recipients, uint256[] amounts)` | 批量转原生 ETH，单笔最多 50 个收款地址 |
| `multiTransferToken(address token, address[] recipients, uint256[] amounts)` | 批量转 ERC20，单笔最多 50 个收款地址 |

规则：

- `recipients.length` 必须等于 `amounts.length`，且 `1 <= length <= 50`
- 每个 `amounts[i]` 必须大于 0，`recipients[i]` 不能是零地址
- ETH 转账要求 `msg.value` 精确等于所有 `amounts` 之和
- ERC20 转账前需要先 `approve` 本合约额度；使用 `SafeERC20`，兼容 USDT 这类不返回 `bool` 的 token
- 两个入口都有 `nonReentrant` 保护
- ETH 每笔 `call` 限 `100_000` gas（`ETH_TRANSFER_GAS_LIMIT`），普通 EOA / 交易所地址足够；如需转给复杂合约收款方，可调大或去掉该常量

## 安装

```bash
npm install
```

## 配置 .env

复制并填写 `.env`（已加入 `.gitignore`）：

```bash
PRIVATE_KEY=部署钱包私钥
RH_RPC_URL=主网 RPC
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
```

> 安全提示：`.env` 里是明文私钥，部署完建议删除；不要提交到任何公开仓库。建议使用只放少量 gas 的专用部署钱包。

## 编译

```bash
npx hardhat compile
```

## 测试

```bash
npx hardhat test
```

覆盖用例：ETH 批量转账、金额不匹配、长度不匹配、超过 50 个、零地址/零金额、标准 ERC20、USDT 式无返回值 token、allowance 不足。

## 部署

先测试网，再主网：

```bash
npx hardhat run scripts/deploy.js --network robinhoodTestnet
npx hardhat run scripts/deploy.js --network robinhood
```

部署脚本带网络白名单校验，只允许部署到 `4663`（主网）和 `46630`（测试网），不带 `--network` 会直接报错退出，防止误部署到本地网络。

## 合约验证（官方 Blockscout）

部署后会打印合约地址，例如 `0x...`。执行：

```bash
npx hardhat verify --network robinhoodTestnet <测试网合约地址>
npx hardhat verify --network robinhood <主网合约地址>
```

验证成功后，可在官方浏览器查看：

- 主网：https://robinhoodchain.blockscout.com
- 测试网：https://explorer.testnet.chain.robinhood.com

> 注：`rh-scan.com` 的 API 不是标准 Blockscout/Etherscan 接口，hardhat-verify 无法直接提交验证；如它后续提供网页 Verify 入口或标准 API，可再补。

## Gas 参考（50 个地址批量，按 0.297 Gwei 估算）

| 场景 | gas | 手续费 |
|---|---|---|
| ETH 批量，收款地址已存在 | ~572,000 | ~0.00017 ETH |
| ETH 批量，收款地址为全新地址 | ~1,824,000 | ~0.00054 ETH |
| ERC20 批量 | ~1,440,000 | ~0.00043 ETH |

> 全新地址（链上首次出现）会额外产生每地址 25,000 gas 的账户创建成本。

## 调用示例（ethers v6）

```js
const { ethers } = require("ethers");

const CONTRACT = "0x...";           // 部署后的合约地址
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const abi = [
  "function multiTransferETH(address payable[] calldata recipients, uint256[] calldata amounts) external payable",
  "function multiTransferToken(address token, address[] calldata recipients, uint256[] calldata amounts) external",
];
const contract = new ethers.Contract(CONTRACT, abi, wallet);

// 批量转 ETH：给 3 个地址各转 0.01 ETH
const recipients = ["0x1111...", "0x2222...", "0x3333..."];
const amounts = [ethers.parseEther("0.01"), ethers.parseEther("0.01"), ethers.parseEther("0.01")];
const total = amounts.reduce((a, b) => a + b, 0n);

const tx = await contract.multiTransferETH(recipients, amounts, { value: total });
await tx.wait();
```

ERC20 调用前先给合约 `approve` 足额额度，再调用 `multiTransferToken(token, recipients, amounts)`。

## 常见问题

- **提示 `Contract source code not verified`**：部署和验证是两个独立步骤，运行上面的 `npx hardhat verify` 即可。
- **验证报 `<!DOCTYPE ... is not valid JSON`**：检查是否使用了 `blockscout` 配置（本仓库已配好）；不要用 Etherscan 通道请求 Blockscout。
- **ERC20 转账失败**：检查是否已 `approve` 本合约、余额是否足够。
- **某笔 ETH 批量整体回滚**：确认没有收款地址是拒绝接收 ETH 的合约，或该合约接收逻辑需要超过 100k gas。
