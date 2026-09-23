# rh-contract

Robinhood Chain 上的两个**互相独立**的自用合约。两者没有共用代码、没有共用权限模型，使用方法各写一份文档。

| 合约 | 用途 | 权限 | 文档 |
|---|---|---|---|
| `RobinTimeLock` | ERC20 时间锁仓：锁到指定时间才能取回 | 无 owner / 无代理 / 无管理员 | **[docs/RobinTimeLock.md](docs/RobinTimeLock.md)** |
| `RobinBatchTransfer` | 批量转账 ETH / ERC20（单笔最多 50 个地址） | 无 owner / 无代理 / 无管理员 | **[docs/RobinBatchTransfer.md](docs/RobinBatchTransfer.md)** |

- 语言：Solidity `^0.8.24`，OpenZeppelin Contracts 5.1
- 工具链：Hardhat 2 + ethers v6
- 主网 chainId：`4663`，测试网 chainId：`46630`

> 时间锁仓合约的风险边界（尤其是"锁 Robinhood 股票代币会怎样"）写在
> [docs/RobinTimeLock.md 第 7 节](docs/RobinTimeLock.md)，
> 动手之前请务必读一遍。

## 目录结构

```
contracts/
  RobinTimeLock.sol            # 时间锁仓合约
  RobinBatchTransfer.sol       # 批量转账合约
  mocks/
    MockTokens.sol             # 测试用：标准 ERC20、USDT 式无返回值代币
    MockAttackTokens.sol       # 测试用：手续费代币、重入攻击代币
test/
  RobinTimeLock.test.js
  RobinBatchTransfer.test.js
scripts/
  deploy-timelock.js           # 部署 RobinTimeLock
  deploy.js                    # 部署 RobinBatchTransfer
  timelock.js                  # RobinTimeLock 命令行工具
examples/
  timelock.js                  # RobinTimeLock 完整调用示例（含中文注释）
  batch-transfer.js            # RobinBatchTransfer 完整调用示例
docs/
  RobinTimeLock.md
  RobinBatchTransfer.md
```

## 安装与配置

```bash
npm install
```

`.env`（已在 `.gitignore` 里）：

```bash
PRIVATE_KEY=你的钱包私钥
RH_RPC_URL=主网 RPC
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com

TIME_LOCK_ADDRESS=            # 部署 RobinTimeLock 后填
BATCH_TRANSFER_ADDRESS=       # 部署 RobinBatchTransfer 后填
```

> **安全提示**：`.env` 里是明文私钥，建议用只放少量 gas 的专用钱包，且永远不要提交到公开仓库。大额资产建议用硬件钱包通过浏览器交互。

## 常用命令

```bash
npx hardhat compile
npx hardhat test        # 两个合约的完整测试
```

部署（务必先测试网，再主网）：

```bash
npx hardhat run scripts/deploy-timelock.js --network robinhoodTestnet
npx hardhat run scripts/deploy.js --network robinhoodTestnet
```

两个部署脚本都按 hardhat 网络名做白名单（`robinhood` / `robinhoodTestnet` / `localhost`），并核对 chainId 与 RPC 是否一致；忘了带 `--network` 会落到一次性的内存链上，脚本会直接拒绝。

## 浏览器

- 主网：https://robinhoodchain.blockscout.com
- 测试网：https://explorer.testnet.chain.robinhood.com

两个合约的源码验证都用官方 Blockscout（`hardhat.config.js` 里已配好通道）：

```bash
npx hardhat verify --network robinhood <合约地址>
```

## 常见问题

- **提示 `Contract source code not verified`**：部署和验证是两个独立步骤，运行 `npx hardhat verify` 即可。
- **验证报 `<!DOCTYPE ... is not valid JSON`**：本仓库已配好 `blockscout` 通道，不要用 Etherscan 通道请求 Blockscout。
- **脚本报 `nonce has already been used`**：如果你在改脚本，记得用 `ethers.NonceManager` 包装 wallet——连续发两笔交易（approve + deposit）时，provider 缓存的 nonce 会让第二笔撞车。仓库里的脚本和示例都已经处理过。
- **本地怎么演练**：两个合约的文档里都有"本地演练"一节，`npx hardhat node` + `--network localhost` 即可，部署脚本在本地会额外送一个可 mint 的测试代币。
