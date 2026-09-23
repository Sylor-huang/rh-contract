const hre = require("hardhat");

/**
 * Deploy target whitelist, keyed by hardhat network *name* rather than chain id.
 * Running without `--network` lands on "hardhat", a throwaway in-memory chain,
 * so a forgotten flag is rejected here instead of silently deploying to a place
 * that will not survive the run.
 *
 * The chain id is checked as well, so a misconfigured RPC URL cannot make the
 * mainnet deploy look like the testnet one.
 */
const SUPPORTED_NETWORKS = {
  robinhood: { chainId: 4663, label: "robinhood (mainnet)" },
  robinhoodTestnet: { chainId: 46630, label: "robinhoodTestnet" },
  localhost: { chainId: 31337, label: "localhost (local hardhat node)" },
};

async function main() {
  const networkName = hre.network.name;
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const target = SUPPORTED_NETWORKS[networkName];

  if (!target) {
    throw new Error(
      `Refusing to deploy on network "${networkName}" (chainId ${chainId}). ` +
        "Use --network robinhood, --network robinhoodTestnet or --network localhost."
    );
  }

  if (target.chainId !== chainId) {
    throw new Error(
      `Network "${networkName}" expects chainId ${target.chainId} but the RPC ` +
        `reports ${chainId}. Check the RPC URL in .env before deploying.`
    );
  }

  const [deployer] = await hre.ethers.getSigners();

  console.log(`Deploying RobinTimeLock to ${target.label} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log("");

  const RobinTimeLock = await hre.ethers.getContractFactory("RobinTimeLock");
  const timeLock = await RobinTimeLock.deploy();
  await timeLock.waitForDeployment();

  const address = await timeLock.getAddress();

  console.log(`RobinTimeLock deployed to: ${address}`);
  console.log(`lockCount:                 ${await timeLock.lockCount()}`);
  console.log(
    `MAX_LOCK_DURATION:         ${await timeLock.MAX_LOCK_DURATION()} seconds`
  );
  console.log("");
  console.log("There is no ownership handover and no initializer to call -");
  console.log("the contract is fully usable at this address right away.");
  console.log("");
  console.log("Add this line to .env so the helper script can find it:");
  console.log(`TIME_LOCK_ADDRESS=${address}`);

  if (networkName === "localhost") {
    // Local convenience only: a mintable token so the helper script can be
    // exercised end to end without touching a real chain.
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();
    await token.waitForDeployment();
    await (
      await token.mint(deployer.address, hre.ethers.parseEther("1000000"))
    ).wait();

    console.log("");
    console.log("Local test token (1,000,000 minted to the deployer):");
    console.log(`MOCK_TOKEN=${await token.getAddress()}`);
  } else {
    console.log("");
    console.log("Verify the source:");
    console.log(`npx hardhat verify --network ${networkName} ${address}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
