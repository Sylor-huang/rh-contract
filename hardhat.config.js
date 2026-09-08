require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },

  networks: {
    robinhood: {
      url: process.env.RH_RPC_URL,
      chainId: 4663,
      accounts: [
        process.env.PRIVATE_KEY
      ]
    },

    robinhoodTestnet: {
      url: process.env.RH_TESTNET_RPC_URL,
      chainId: 46630,
      accounts: [
        process.env.PRIVATE_KEY
      ]
    }
  },

  etherscan: {
    enabled: false
  },

  sourcify: {
    enabled: false
  },

  blockscout: {
    enabled: true,
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api/",
          browserURL: "https://robinhoodchain.blockscout.com"
        }
      },
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api/",
          browserURL: "https://explorer.testnet.chain.robinhood.com"
        }
      }
    ]
  }
};