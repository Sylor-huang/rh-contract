const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinBatchTransfer", function () {
  async function deploy() {
    const [owner, r1, r2] = await ethers.getSigners();

    const Batch = await ethers.getContractFactory("RobinBatchTransfer");
    const batch = await Batch.deploy();
    await batch.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();

    const MockNoReturnToken =
      await ethers.getContractFactory("MockNoReturnToken");
    const noReturnToken = await MockNoReturnToken.deploy();

    return { owner, r1, r2, batch, token, noReturnToken };
  }

  describe("multiTransferETH", function () {
    it("transfers ETH to each recipient", async function () {
      const { owner, r1, r2, batch } = await deploy();
      const recipients = [r1.address, r2.address];
      const amounts = [ethers.parseEther("0.1"), ethers.parseEther("0.2")];
      const total = amounts[0] + amounts[1];

      const r1Before = await ethers.provider.getBalance(r1.address);
      const r2Before = await ethers.provider.getBalance(r2.address);

      await batch
        .connect(owner)
        .multiTransferETH(recipients, amounts, { value: total });

      expect(
        (await ethers.provider.getBalance(r1.address)) - r1Before
      ).to.equal(amounts[0]);
      expect(
        (await ethers.provider.getBalance(r2.address)) - r2Before
      ).to.equal(amounts[1]);
      expect(
        await ethers.provider.getBalance(await batch.getAddress())
      ).to.equal(0n);
    });

    it("reverts when msg.value != total", async function () {
      const { owner, r1, batch } = await deploy();

      await expect(
        batch
          .connect(owner)
          .multiTransferETH([r1.address], [ethers.parseEther("1")], {
            value: ethers.parseEther("0.5"),
          })
      ).to.be.revertedWith("Incorrect ETH amount");
    });

    it("reverts on length mismatch", async function () {
      const { owner, r1, batch } = await deploy();

      await expect(
        batch.connect(owner).multiTransferETH([r1.address], [1n, 2n], {
          value: 3n,
        })
      ).to.be.revertedWith("Length mismatch");
    });

    it("reverts with more than 50 recipients", async function () {
      const { owner, batch } = await deploy();
      const recipients = Array(51).fill(owner.address);
      const amounts = Array(51).fill(1n);

      await expect(
        batch.connect(owner).multiTransferETH(recipients, amounts, {
          value: 51n,
        })
      ).to.be.revertedWith("Maximum 50 recipients");
    });

    it("reverts on zero address or zero amount", async function () {
      const { owner, r1, batch } = await deploy();

      await expect(
        batch.connect(owner).multiTransferETH(
          [ethers.ZeroAddress],
          [1n],
          { value: 1n }
        )
      ).to.be.revertedWith("Invalid recipient");

      await expect(
        batch.connect(owner).multiTransferETH([r1.address], [0n], {
          value: 0n,
        })
      ).to.be.revertedWith("Invalid amount");
    });
  });

  describe("multiTransferToken", function () {
    it("transfers standard ERC20", async function () {
      const { owner, r1, r2, batch, token } = await deploy();
      const amounts = [100n, 200n];

      await token.mint(owner.address, 1000n);
      await token
        .connect(owner)
        .approve(await batch.getAddress(), amounts[0] + amounts[1]);

      await batch
        .connect(owner)
        .multiTransferToken(
          await token.getAddress(),
          [r1.address, r2.address],
          amounts
        );

      expect(await token.balanceOf(r1.address)).to.equal(amounts[0]);
      expect(await token.balanceOf(r2.address)).to.equal(amounts[1]);
      expect(await token.balanceOf(owner.address)).to.equal(700n);
    });

    it("transfers USDT-style tokens that return no bool", async function () {
      const { owner, r1, batch, noReturnToken } = await deploy();
      const amount = 50n;

      await noReturnToken.mint(owner.address, 100n);
      await noReturnToken
        .connect(owner)
        .approve(await batch.getAddress(), amount);

      await batch
        .connect(owner)
        .multiTransferToken(
          await noReturnToken.getAddress(),
          [r1.address],
          [amount]
        );

      expect(await noReturnToken.balanceOf(r1.address)).to.equal(amount);
    });

    it("reverts on insufficient allowance", async function () {
      const { owner, r1, batch, token } = await deploy();

      await token.mint(owner.address, 100n);

      await expect(
        batch
          .connect(owner)
          .multiTransferToken(await token.getAddress(), [r1.address], [10n])
      ).to.be.revertedWith("Insufficient allowance");
    });
  });
});
