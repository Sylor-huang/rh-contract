const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const MAX_LOCK_DURATION = 365 * DAY;
const AMOUNT = ethers.parseEther("100");

describe("RobinTimeLock", function () {
  async function deploy() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();

    const TimeLock = await ethers.getContractFactory("RobinTimeLock");
    const timeLock = await TimeLock.deploy();
    await timeLock.waitForDeployment();
    const timeLockAddress = await timeLock.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    const MockERC20B = await ethers.getContractFactory("MockERC20");
    const tokenB = await MockERC20B.deploy();
    await tokenB.waitForDeployment();

    const MockNoReturnToken =
      await ethers.getContractFactory("MockNoReturnToken");
    const noReturnToken = await MockNoReturnToken.deploy();
    await noReturnToken.waitForDeployment();

    const MockFeeOnTransferToken = await ethers.getContractFactory(
      "MockFeeOnTransferToken"
    );
    const feeToken = await MockFeeOnTransferToken.deploy();
    await feeToken.waitForDeployment();

    const MockReentrantToken =
      await ethers.getContractFactory("MockReentrantToken");
    const reentrantToken = await MockReentrantToken.deploy();
    await reentrantToken.waitForDeployment();

    // Fund the actors and pre-approve the time lock.
    for (const actor of [alice, bob, carol]) {
      await token.mint(actor.address, AMOUNT * 10n);
      await tokenB.mint(actor.address, AMOUNT * 10n);
      await token
        .connect(actor)
        .approve(timeLockAddress, ethers.MaxUint256);
      await tokenB
        .connect(actor)
        .approve(timeLockAddress, ethers.MaxUint256);
    }

    return {
      deployer,
      alice,
      bob,
      carol,
      timeLock,
      timeLockAddress,
      token,
      tokenAddress,
      tokenB,
      noReturnToken,
      feeToken,
      reentrantToken,
    };
  }

  /** @returns a timestamp safely in the future, whatever the block time is. */
  async function futureTime(secondsFromNow = DAY) {
    return (await time.latest()) + secondsFromNow;
  }

  describe("no-privilege guarantees", function () {
    it("exposes exactly 7 functions: no owner, admin, pause, upgrade or rescue entry point", async function () {
      const artifact = await artifacts.readArtifact("RobinTimeLock");

      const functions = artifact.abi
        .filter((entry) => entry.type === "function")
        .map((entry) => entry.name)
        .sort();

      // If this assertion ever fails, someone added an entry point. There must
      // be a very good reason, because it is the entire security model.
      expect(functions).to.deep.equal([
        "MAX_LOCK_DURATION",
        "deposit",
        "getLock",
        "getUserLockCount",
        "getUserLocks",
        "lockCount",
        "withdraw",
      ]);
    });

    it("has no payable function, so it can never hold ETH", async function () {
      const artifact = await artifacts.readArtifact("RobinTimeLock");

      for (const entry of artifact.abi.filter((e) => e.type === "function")) {
        expect(entry.stateMutability).to.not.equal("payable");
      }
      expect(artifact.abi.filter((e) => e.type === "receive")).to.have.lengthOf(
        0
      );
      expect(artifact.abi.filter((e) => e.type === "fallback")).to.have.lengthOf(
        0
      );
    });

    it("source contains no ownership, proxy or self-destruct primitive", async function () {
      const source = fs.readFileSync(
        path.join(__dirname, "..", "contracts", "RobinTimeLock.sol"),
        "utf8"
      );
      // Strip comments so the trust-model documentation cannot mask a match.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      const forbidden = [
        "Ownable",
        "AccessControl",
        "delegatecall",
        "selfdestruct",
        "assembly",
        "initializer",
        "onlyOwner",
      ];

      for (const word of forbidden) {
        expect(code).to.not.include(word);
      }
    });

    it("rejects plain ETH sent to the contract", async function () {
      const { timeLockAddress, alice } = await deploy();

      await expect(
        alice.sendTransaction({ to: timeLockAddress, value: 1n })
      ).to.be.reverted;
    });

    it("starts with no locks and the documented lock id range", async function () {
      const { timeLock } = await deploy();

      expect(await timeLock.lockCount()).to.equal(0n);
      expect(await timeLock.MAX_LOCK_DURATION()).to.equal(
        BigInt(MAX_LOCK_DURATION)
      );
    });
  });

  describe("deposit", function () {
    it("locks tokens, records the lock and emits LockCreated", async function () {
      const { timeLock, token, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await expect(
        timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime)
      )
        .to.emit(timeLock, "LockCreated")
        .withArgs(1n, alice.address, tokenAddress, AMOUNT, unlockTime);

      const lock = await timeLock.getLock(1);
      expect(lock.token).to.equal(tokenAddress);
      expect(lock.owner).to.equal(alice.address);
      expect(lock.amount).to.equal(AMOUNT);
      expect(lock.unlockTime).to.equal(unlockTime);

      expect(await timeLock.lockCount()).to.equal(1n);
      expect(await token.balanceOf(alice.address)).to.equal(AMOUNT * 9n);
      expect(await token.balanceOf(await timeLock.getAddress())).to.equal(
        AMOUNT
      );
    });

    it("supports tokens that return no value (USDT style)", async function () {
      const { timeLock, noReturnToken, alice } = await deploy();
      const address = await noReturnToken.getAddress();
      const unlockTime = await futureTime();

      await noReturnToken.mint(alice.address, AMOUNT);
      await noReturnToken.connect(alice).approve(await timeLock.getAddress(), AMOUNT);

      await expect(
        timeLock.connect(alice).deposit(address, AMOUNT, unlockTime)
      ).to.emit(timeLock, "LockCreated");

      await time.increaseTo(unlockTime);

      await expect(timeLock.connect(alice).withdraw(1))
        .to.emit(timeLock, "Withdrawn")
        .withArgs(1n, alice.address, address, AMOUNT);

      expect(await noReturnToken.balanceOf(alice.address)).to.equal(AMOUNT);
    });

    it("keeps every lock independent: different owners, tokens and times", async function () {
      const { timeLock, tokenAddress, tokenB, alice, bob, carol } =
        await deploy();
      const tokenBAddress = await tokenB.getAddress();
      const aliceTime = await futureTime(DAY);
      const bobTime = await futureTime(2 * DAY);
      const carolTime = await futureTime(3 * DAY);

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, aliceTime);
      await timeLock.connect(bob).deposit(tokenBAddress, AMOUNT * 2n, bobTime);
      await timeLock.connect(carol).deposit(tokenAddress, AMOUNT * 3n, carolTime);

      const lock1 = await timeLock.getLock(1);
      const lock2 = await timeLock.getLock(2);
      const lock3 = await timeLock.getLock(3);

      expect([lock1.owner, lock2.owner, lock3.owner]).to.deep.equal([
        alice.address,
        bob.address,
        carol.address,
      ]);
      expect([lock1.token, lock2.token, lock3.token]).to.deep.equal([
        tokenAddress,
        tokenBAddress,
        tokenAddress,
      ]);
      expect([lock1.amount, lock2.amount, lock3.amount]).to.deep.equal([
        AMOUNT,
        AMOUNT * 2n,
        AMOUNT * 3n,
      ]);
      expect([lock1.unlockTime, lock2.unlockTime, lock3.unlockTime]).to.deep.equal([
        aliceTime,
        bobTime,
        carolTime,
      ]);
    });

    it("rejects a zero amount", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();

      await expect(
        timeLock
          .connect(alice)
          .deposit(tokenAddress, 0n, await futureTime())
      ).to.be.revertedWithCustomError(timeLock, "ZeroAmount");
    });

    it("rejects the zero address as token", async function () {
      const { timeLock, alice } = await deploy();

      await expect(
        timeLock
          .connect(alice)
          .deposit(ethers.ZeroAddress, AMOUNT, await futureTime())
      ).to.be.revertedWithCustomError(timeLock, "ZeroAddress");
    });

    it("rejects a token address that is not a contract", async function () {
      const { timeLock, bob, alice } = await deploy();

      await expect(
        timeLock.connect(alice).deposit(bob.address, AMOUNT, await futureTime())
      )
        .to.be.revertedWithCustomError(timeLock, "NotAContract")
        .withArgs(bob.address);
    });

    it("rejects an unlock time in the past", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const past = (await time.latest()) - 1;

      await expect(
        timeLock.connect(alice).deposit(tokenAddress, AMOUNT, past)
      ).to.be.revertedWithCustomError(timeLock, "UnlockTimeNotInFuture");
    });

    it("rejects an unlock time equal to the current block time", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const now = await time.latest();

      await expect(
        timeLock.connect(alice).deposit(tokenAddress, AMOUNT, now)
      ).to.be.revertedWithCustomError(timeLock, "UnlockTimeNotInFuture");
    });

    it("rejects an unlock time beyond the maximum duration", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const tooFar =
        (await time.latest()) + MAX_LOCK_DURATION + DAY;

      await expect(
        timeLock.connect(alice).deposit(tokenAddress, AMOUNT, tooFar)
      ).to.be.revertedWithCustomError(timeLock, "UnlockTimeTooFar");
    });

    it("accepts an unlock time just inside the maximum duration", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const maxOk = (await time.latest()) + MAX_LOCK_DURATION - DAY;

      await expect(
        timeLock.connect(alice).deposit(tokenAddress, AMOUNT, maxOk)
      ).to.emit(timeLock, "LockCreated");
    });

    it("rejects fee-on-transfer tokens instead of crediting more than it received", async function () {
      const { timeLock, feeToken, alice } = await deploy();
      const feeTokenAddress = await feeToken.getAddress();

      await feeToken.mint(alice.address, AMOUNT);
      await feeToken
        .connect(alice)
        .approve(await timeLock.getAddress(), AMOUNT);

      await expect(
        timeLock.connect(alice).deposit(feeTokenAddress, AMOUNT, await futureTime())
      )
        .to.be.revertedWithCustomError(timeLock, "UnexpectedTransferAmount")
        .withArgs(AMOUNT, (AMOUNT * 99n) / 100n);

      // The whole deposit is rolled back: no lock, no funds taken.
      expect(await timeLock.lockCount()).to.equal(0n);
      expect(await feeToken.balanceOf(alice.address)).to.equal(AMOUNT);
    });

    it("reverts when the allowance is missing", async function () {
      const { timeLock, token, tokenAddress, alice } = await deploy();
      await token.connect(alice).approve(await timeLock.getAddress(), 0n);

      await expect(
        timeLock.connect(alice).deposit(tokenAddress, AMOUNT, await futureTime())
      ).to.be.reverted;
      expect(await timeLock.lockCount()).to.equal(0n);
    });

    it("reverts when the balance is insufficient", async function () {
      const { timeLock, tokenAddress, bob } = await deploy();

      await expect(
        timeLock
          .connect(bob)
          .deposit(tokenAddress, AMOUNT * 1_000n, await futureTime())
      ).to.be.reverted;
    });

    it("assigns increasing lock ids starting at 1", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const future = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, future);
      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, future);

      expect(await timeLock.lockCount()).to.equal(2n);
      expect((await timeLock.getLock(1)).amount).to.equal(AMOUNT);
      expect((await timeLock.getLock(2)).amount).to.equal(AMOUNT);
    });
  });

  describe("withdraw", function () {
    it("returns the exact amount to the depositor after the unlock time", async function () {
      const { timeLock, token, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.increaseTo(unlockTime);

      const before = await token.balanceOf(alice.address);

      await expect(timeLock.connect(alice).withdraw(1))
        .to.emit(timeLock, "Withdrawn")
        .withArgs(1n, alice.address, tokenAddress, AMOUNT);

      expect((await token.balanceOf(alice.address)) - before).to.equal(AMOUNT);
      expect(await token.balanceOf(await timeLock.getAddress())).to.equal(0n);
      expect((await timeLock.getLock(1)).amount).to.equal(0n);
    });

    it("allows withdrawal exactly at the unlock time", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      // Execute on the first block whose timestamp is exactly unlockTime.
      await time.setNextBlockTimestamp(unlockTime);

      const tx = await timeLock.connect(alice).withdraw(1);
      await expect(tx).to.emit(timeLock, "Withdrawn");

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(block.timestamp).to.equal(unlockTime);
    });

    it("rejects withdrawal one second too early", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.setNextBlockTimestamp(unlockTime - 1);

      await expect(timeLock.connect(alice).withdraw(1))
        .to.be.revertedWithCustomError(timeLock, "LockNotMatured")
        .withArgs(1n, unlockTime, unlockTime - 1);
    });

    it("still allows withdrawal years after the unlock time", async function () {
      // There is no expiry anywhere in the contract: withdraw() only checks
      // block.timestamp >= unlockTime and never an upper bound. A lock you
      // forgot about stays claimable forever.
      const { timeLock, token, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime(DAY);

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);

      // Forget about it for a bit over two years.
      await time.increaseTo(unlockTime + 800 * DAY);

      const before = await token.balanceOf(alice.address);
      await expect(timeLock.connect(alice).withdraw(1)).to.emit(
        timeLock,
        "Withdrawn"
      );
      expect((await token.balanceOf(alice.address)) - before).to.equal(AMOUNT);
    });

    it("only lets the lock owner withdraw", async function () {
      const { timeLock, tokenAddress, alice, bob } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.increaseTo(unlockTime);

      await expect(timeLock.connect(bob).withdraw(1))
        .to.be.revertedWithCustomError(timeLock, "NotLockOwner")
        .withArgs(1n, bob.address);

      // Still intact for the real owner.
      expect((await timeLock.getLock(1)).amount).to.equal(AMOUNT);
    });

    it("rejects an unknown lock id", async function () {
      const { timeLock, alice } = await deploy();

      await expect(timeLock.connect(alice).withdraw(1))
        .to.be.revertedWithCustomError(timeLock, "LockNotFound")
        .withArgs(1n);
    });

    it("rejects a second withdrawal of the same lock", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.increaseTo(unlockTime);
      await timeLock.connect(alice).withdraw(1);

      await expect(timeLock.connect(alice).withdraw(1))
        .to.be.revertedWithCustomError(timeLock, "AlreadyWithdrawn")
        .withArgs(1n);
    });

    it("keeps sibling locks of the same owner untouched", async function () {
      const { timeLock, token, tokenAddress, alice } = await deploy();
      const early = await futureTime(DAY);
      const late = await futureTime(30 * DAY);

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, early);
      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT * 2n, late);

      await time.increaseTo(early);
      await timeLock.connect(alice).withdraw(1);

      expect((await timeLock.getLock(1)).amount).to.equal(0n);
      expect((await timeLock.getLock(2)).amount).to.equal(AMOUNT * 2n);
      expect(await token.balanceOf(await timeLock.getAddress())).to.equal(
        AMOUNT * 2n
      );

      await expect(timeLock.connect(alice).withdraw(2)).to.be.revertedWithCustomError(
        timeLock,
        "LockNotMatured"
      );
    });

    it("cannot be drained by a reentrant token", async function () {
      const { timeLock, reentrantToken, alice } = await deploy();
      const reentrantAddress = await reentrantToken.getAddress();
      const timeLockAddress = await timeLock.getAddress();
      const unlockTime = await futureTime();

      await reentrantToken.mint(alice.address, AMOUNT);
      await reentrantToken.connect(alice).approve(timeLockAddress, AMOUNT);
      await timeLock.connect(alice).deposit(reentrantAddress, AMOUNT, unlockTime);

      await time.increaseTo(unlockTime);
      await reentrantToken.arm(timeLockAddress, 1);

      const before = await reentrantToken.balanceOf(alice.address);
      await timeLock.connect(alice).withdraw(1);

      // The nested withdraw() call was attempted and reverted.
      expect(await reentrantToken.reentryAttempted()).to.equal(true);
      expect(await reentrantToken.reentrySucceeded()).to.equal(false);

      // Exactly one payout happened and the contract holds nothing.
      expect((await reentrantToken.balanceOf(alice.address)) - before).to.equal(
        AMOUNT
      );
      expect(await reentrantToken.balanceOf(timeLockAddress)).to.equal(0n);
    });

    it("returns funds to the depositor even if someone else deposited for them", async function () {
      // Sanity check on the ownership rule: a lock always belongs to the
      // account that called deposit(), never to a beneficiary parameter.
      const { timeLock, token, tokenAddress, alice, bob } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(bob).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.increaseTo(unlockTime);

      await expect(timeLock.connect(alice).withdraw(1)).to.be.revertedWithCustomError(
        timeLock,
        "NotLockOwner"
      );

      const before = await token.balanceOf(bob.address);
      await timeLock.connect(bob).withdraw(1);
      expect((await token.balanceOf(bob.address)) - before).to.equal(AMOUNT);
    });
  });

  describe("getLock", function () {
    it("returns an all-zero record for an unknown id", async function () {
      const { timeLock } = await deploy();
      const lock = await timeLock.getLock(999);

      expect(lock.token).to.equal(ethers.ZeroAddress);
      expect(lock.owner).to.equal(ethers.ZeroAddress);
      expect(lock.amount).to.equal(0n);
      expect(lock.unlockTime).to.equal(0n);
    });

    it("keeps the record readable after withdrawal", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.increaseTo(unlockTime);
      await timeLock.connect(alice).withdraw(1);

      const lock = await timeLock.getLock(1);
      expect(lock.owner).to.equal(alice.address);
      expect(lock.token).to.equal(tokenAddress);
      expect(lock.unlockTime).to.equal(unlockTime);
      expect(lock.amount).to.equal(0n);
    });
  });

  describe("getUserLocks", function () {
    it("returns an empty list for an address that never locked anything", async function () {
      const { timeLock, carol } = await deploy();

      expect(await timeLock.getUserLocks(carol.address)).to.have.lengthOf(0);
      expect(await timeLock.getUserLockCount(carol.address)).to.equal(0n);
    });

    it("answers which tokens, how much, and how long until unlock", async function () {
      const { timeLock, tokenAddress, tokenB, alice } = await deploy();
      const tokenBAddress = await tokenB.getAddress();
      const inThirtyDays = await futureTime(30 * DAY);
      const inNinetyDays = await futureTime(90 * DAY);

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, inThirtyDays);
      await timeLock
        .connect(alice)
        .deposit(tokenBAddress, AMOUNT * 5n, inNinetyDays);

      const latest = await time.latest();
      const locks = await timeLock.getUserLocks(alice.address);

      expect(locks).to.have.lengthOf(2);
      expect(await timeLock.getUserLockCount(alice.address)).to.equal(2n);

      expect(locks[0].lockId).to.equal(1n);
      expect(locks[0].token).to.equal(tokenAddress);
      expect(locks[0].amount).to.equal(AMOUNT);
      expect(locks[0].unlockTime).to.equal(inThirtyDays);

      expect(locks[1].lockId).to.equal(2n);
      expect(locks[1].token).to.equal(tokenBAddress);
      expect(locks[1].amount).to.equal(AMOUNT * 5n);
      expect(locks[1].unlockTime).to.equal(inNinetyDays);

      // Time left is measured against block time, so allow a small window.
      const expectedFirst = BigInt(inThirtyDays - latest);
      expect(locks[0].secondsUntilUnlock).to.be.greaterThan(
        expectedFirst - 10n
      );
      expect(locks[0].secondsUntilUnlock).to.be.lessThan(expectedFirst + 10n);
      // The 90 day lock must report more time left than the 30 day one.
      expect(locks[1].secondsUntilUnlock).to.be.greaterThan(
        locks[0].secondsUntilUnlock
      );
    });

    it("keeps same-token locks as separate entries", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const first = await futureTime(10 * DAY);
      const second = await futureTime(20 * DAY);

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, first);
      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT * 3n, second);

      const locks = await timeLock.getUserLocks(alice.address);

      expect(locks).to.have.lengthOf(2);
      expect(locks[0].token).to.equal(tokenAddress);
      expect(locks[1].token).to.equal(tokenAddress);
      expect(locks[0].amount).to.equal(AMOUNT);
      expect(locks[1].amount).to.equal(AMOUNT * 3n);
      expect(locks[0].unlockTime).to.not.equal(locks[1].unlockTime);
    });

    it("never returns another account's locks", async function () {
      const { timeLock, tokenAddress, alice, bob } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await timeLock
        .connect(bob)
        .deposit(tokenAddress, AMOUNT * 2n, unlockTime);

      const aliceLocks = await timeLock.getUserLocks(alice.address);
      const bobLocks = await timeLock.getUserLocks(bob.address);

      expect(aliceLocks).to.have.lengthOf(1);
      expect(bobLocks).to.have.lengthOf(1);
      expect(aliceLocks[0].lockId).to.equal(1n);
      expect(aliceLocks[0].amount).to.equal(AMOUNT);
      expect(bobLocks[0].lockId).to.equal(2n);
      expect(bobLocks[0].amount).to.equal(AMOUNT * 2n);
    });

    it("reports zero seconds left once the unlock time has passed", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await time.increaseTo(unlockTime);

      const locks = await timeLock.getUserLocks(alice.address);

      expect(locks).to.have.lengthOf(1);
      expect(locks[0].amount).to.equal(AMOUNT);
      expect(locks[0].secondsUntilUnlock).to.equal(0n);
    });

    it("drops a lock from the list once it is withdrawn", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      expect(await timeLock.getUserLockCount(alice.address)).to.equal(1n);

      await time.increaseTo(unlockTime);
      await timeLock.connect(alice).withdraw(1);

      expect(await timeLock.getUserLocks(alice.address)).to.have.lengthOf(0);
      expect(await timeLock.getUserLockCount(alice.address)).to.equal(0n);

      // The record itself is kept, so the history is still readable.
      const lock = await timeLock.getLock(1);
      expect(lock.owner).to.equal(alice.address);
      expect(lock.token).to.equal(tokenAddress);
      expect(lock.amount).to.equal(0n);
      expect(lock.unlockTime).to.equal(unlockTime);
    });

    it("keeps the list consistent when locks are withdrawn out of order", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const times = [];

      // Four locks, unlocking one day apart.
      for (let i = 0; i < 4; i++) {
        const unlockTime = await futureTime((i + 1) * DAY);
        times.push(unlockTime);
        await timeLock
          .connect(alice)
          .deposit(tokenAddress, AMOUNT * BigInt(i + 1), unlockTime);
      }

      const idsOf = async () =>
        (await timeLock.getUserLocks(alice.address))
          .map((lock) => lock.lockId)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      // Withdraw the first one: the last entry is swapped into its slot.
      await time.increaseTo(times[0]);
      await timeLock.connect(alice).withdraw(1);
      expect(await idsOf()).to.deep.equal([2n, 3n, 4n]);

      // Withdraw the one that got swapped to the front.
      await time.increaseTo(times[1]);
      await timeLock.connect(alice).withdraw(2);
      expect(await idsOf()).to.deep.equal([3n, 4n]);

      // Withdraw the one that is last in the list.
      await time.increaseTo(times[3]);
      await timeLock.connect(alice).withdraw(4);
      expect(await idsOf()).to.deep.equal([3n]);
      expect(await timeLock.getUserLockCount(alice.address)).to.equal(1n);

      // The survivor is still fully functional.
      await timeLock.connect(alice).withdraw(3);
      expect(await timeLock.getUserLocks(alice.address)).to.have.lengthOf(0);
      expect(await timeLock.getUserLockCount(alice.address)).to.equal(0n);
    });

    it("keeps each owner's list independent across withdrawals", async function () {
      const { timeLock, tokenAddress, alice, bob } = await deploy();
      const unlockTime = await futureTime();

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);
      await timeLock.connect(bob).deposit(tokenAddress, AMOUNT * 2n, unlockTime);

      await time.increaseTo(unlockTime);
      await timeLock.connect(alice).withdraw(1);

      expect(await timeLock.getUserLocks(alice.address)).to.have.lengthOf(0);
      const bobLocks = await timeLock.getUserLocks(bob.address);
      expect(bobLocks).to.have.lengthOf(1);
      expect(bobLocks[0].lockId).to.equal(2n);
      expect(bobLocks[0].amount).to.equal(AMOUNT * 2n);
    });

    it("counts the remaining time down as blocks pass", async function () {
      const { timeLock, tokenAddress, alice } = await deploy();
      const unlockTime = await futureTime(10 * DAY);

      await timeLock.connect(alice).deposit(tokenAddress, AMOUNT, unlockTime);

      const before = (await timeLock.getUserLocks(alice.address))[0]
        .secondsUntilUnlock;
      await time.increase(5 * DAY);
      const after = (await timeLock.getUserLocks(alice.address))[0]
        .secondsUntilUnlock;

      const elapsed = before - after;
      expect(elapsed).to.be.greaterThan(BigInt(5 * DAY - 10));
      expect(elapsed).to.be.lessThan(BigInt(5 * DAY + 10));
    });
  });
});
