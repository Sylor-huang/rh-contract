const hre = require("hardhat");

const SUPPORTED_NETWORKS = {
  4663: "robinhood (mainnet)",
  46630: "robinhoodTestnet",
};

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (!SUPPORTED_NETWORKS[chainId]) {
    throw new Error(
      `Unexpected network (chainId ${chainId}). ` +
        `Run with --network robinhoodTestnet or --network robinhood.`
    );
  }

  console.log(
    `Deploying RobinBatchTransfer to ${SUPPORTED_NETWORKS[chainId]} ` +
      `(chainId ${chainId})...`
  );

  const RobinBatchTransfer =
    await hre.ethers.getContractFactory("RobinBatchTransfer");

  const contract = await RobinBatchTransfer.deploy();

  await contract.waitForDeployment();

  const address = await contract.getAddress();

  console.log("RobinBatchTransfer deployed to:");
  console.log(address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
