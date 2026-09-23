// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RobinTimeLock
 * @notice Self-custody ERC20 time lock. Deposit tokens, withdraw them once the
 *         unlock time you picked has passed. Every deposit is an independent
 *         lock with its own id, token, amount and unlock time.
 *
 * Trust model -- this is the whole point of the contract, please read it:
 *
 *   - No owner, no admin, no roles, no governance.
 *   - Not upgradeable: no proxy, no delegatecall, no initializer.
 *   - No function can move tokens on behalf of anybody else.
 *   - No function can shorten an unlock time, pause withdrawals, blacklist an
 *     address, or sweep the contract balance.
 *   - No ETH is accepted (there is no receive/fallback) and the contract has no
 *     selfdestruct, so it cannot be destroyed or drained.
 *   - deployer gets zero privileges. The deployment transaction only deploys.
 *
 * The only two state-changing entry points are deposit() and withdraw().
 * withdraw() is callable exclusively by the lock owner (the depositor), and
 * only once block.timestamp >= unlockTime.
 *
 * The flip side of having no rescue function is that anything that could strand
 * funds must be rejected at the entrance. That is why deposit() refuses:
 * tokens that are not contracts, zero amounts, unlock times that are not in the
 * future, unlock times more than MAX_LOCK_DURATION away, and tokens that do not
 * actually deliver the exact transferred amount (fee-on-transfer / rebasing).
 *
 * Known limits that are NOT fixable in this design:
 *   - If the token itself is upgradeable, pausable or blacklists addresses, the
 *     issuer can still freeze your tokens or block this contract. No lock
 *     contract can prevent that; it can only avoid adding a second backdoor.
 *   - block.timestamp on an L2 is produced by the sequencer, which can nudge it
 *     by seconds. Do not treat the unlock time as precise to the second.
 */
contract RobinTimeLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        address token;
        address owner;
        /// @dev Set to 0 on withdrawal; the rest of the record stays readable.
        uint256 amount;
        uint256 unlockTime;
    }

    /**
     * @notice One entry returned by getUserLocks(): a lock that has NOT been
     *         withdrawn yet.
     * @dev `secondsUntilUnlock` is 0 once the unlock time has passed, which is
     *      the signal that it can be withdrawn right now.
     */
    struct LockView {
        uint256 lockId;
        address token;
        uint256 amount;
        uint256 unlockTime;
        uint256 secondsUntilUnlock;
    }

    /// @dev Upper bound on how far in the future an unlock time may be. Guards
    /// against a mistyped unit (milliseconds instead of seconds), which would
    /// otherwise lock funds forever with no way to recover them.
    ///
    /// This bound applies to deposit() only. There is no expiry on the other
    /// side: a lock that matured years ago is still withdrawable forever.
    uint256 public constant MAX_LOCK_DURATION = 365 days;

    /// @dev Number of locks ever created. Lock ids start at 1.
    uint256 public lockCount;

    mapping(uint256 lockId => Lock) private _locks;

    /**
     * @dev Ids of the locks `owner` has not withdrawn yet. A withdrawn lock is
     * removed from this list, so getUserLocks() only ever returns claimable
     * locks. The lock record in _locks is kept forever, so getLock(id) still
     * reads the full history after a withdrawal.
     *
     * Bookkeeping only: it is never consulted by any permission check.
     * withdraw() reads the lock record alone. A wrong entry here can make a
     * lock invisible to the helper view, but it can never let anyone move
     * funds.
     */
    mapping(address owner => uint256[] lockIds) private _activeLockIds;

    /**
     * @dev Position of a lock inside _activeLockIds[owner], stored 1-based so
     * that 0 means "not in the list". Needed to remove an entry on withdrawal.
     */
    mapping(uint256 lockId => uint256 indexPlusOne) private _lockIndex;

    event LockCreated(
        uint256 indexed lockId,
        address indexed owner,
        address indexed token,
        uint256 amount,
        uint256 unlockTime
    );

    event Withdrawn(
        uint256 indexed lockId,
        address indexed owner,
        address indexed token,
        uint256 amount
    );

    error NotAContract(address token);
    error ZeroAmount();
    error ZeroAddress();
    error UnlockTimeNotInFuture(uint256 unlockTime, uint256 currentTime);
    error UnlockTimeTooFar(uint256 unlockTime, uint256 maxUnlockTime);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);
    error LockNotFound(uint256 lockId);
    error NotLockOwner(uint256 lockId, address caller);
    error LockNotMatured(uint256 lockId, uint256 unlockTime, uint256 currentTime);
    error AlreadyWithdrawn(uint256 lockId);

    /**
     * @notice Lock `amount` of `token` until `unlockTime`.
     * @dev Caller must approve this contract for at least `amount` first.
     * @param token      ERC20 token to lock. Must be a deployed contract.
     * @param amount     Amount in the token's smallest unit. Must be > 0.
     * @param unlockTime Unix timestamp (seconds) strictly in the future and at
     *                   most MAX_LOCK_DURATION away.
     * @return lockId    Id of the new lock. Use it to read or withdraw.
     */
    function deposit(
        address token,
        uint256 amount,
        uint256 unlockTime
    ) external nonReentrant returns (uint256 lockId) {
        if (token == address(0)) revert ZeroAddress();
        // A token address with no code would make SafeERC20 call an empty
        // address, which "succeeds" and silently burns the funds.
        if (token.code.length == 0) revert NotAContract(token);
        if (amount == 0) revert ZeroAmount();
        if (unlockTime <= block.timestamp) {
            revert UnlockTimeNotInFuture(unlockTime, block.timestamp);
        }
        uint256 maxUnlockTime = block.timestamp + MAX_LOCK_DURATION;
        if (unlockTime > maxUnlockTime) {
            revert UnlockTimeTooFar(unlockTime, maxUnlockTime);
        }

        lockId = ++lockCount;

        _locks[lockId] = Lock({
            token: token,
            owner: msg.sender,
            amount: amount,
            unlockTime: unlockTime
        });

        uint256[] storage activeIds = _activeLockIds[msg.sender];
        activeIds.push(lockId);
        _lockIndex[lockId] = activeIds.length; // 1-based

        IERC20 erc20 = IERC20(token);
        uint256 balanceBefore = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = erc20.balanceOf(address(this)) - balanceBefore;
        // Reject fee-on-transfer / rebasing tokens: crediting more than was
        // received would leave the last withdrawer short with no way to fix it.
        if (received != amount) revert UnexpectedTransferAmount(amount, received);

        emit LockCreated(lockId, msg.sender, token, amount, unlockTime);
    }

    /**
     * @notice Withdraw a matured lock. Full amount, once, to the depositor.
     * @param lockId Id returned by deposit(). Only its owner can withdraw it.
     */
    function withdraw(uint256 lockId) external nonReentrant {
        Lock storage lockData = _locks[lockId];

        address owner = lockData.owner;
        if (owner == address(0)) revert LockNotFound(lockId);
        if (msg.sender != owner) revert NotLockOwner(lockId, msg.sender);

        uint256 amount = lockData.amount;
        if (amount == 0) revert AlreadyWithdrawn(lockId);

        uint256 unlockTime = lockData.unlockTime;
        if (block.timestamp < unlockTime) {
            revert LockNotMatured(lockId, unlockTime, block.timestamp);
        }

        // Checks-effects-interactions, plus nonReentrant as a second layer.
        lockData.amount = 0;
        _removeActiveLock(owner, lockId);

        emit Withdrawn(lockId, owner, lockData.token, amount);

        IERC20(lockData.token).safeTransfer(owner, amount);
    }

    /**
     * @dev Swap-and-pop the lock out of the owner's active list, so
     * getUserLocks() stops reporting it.
     *
     * Because the entry is replaced by the last one, the order of the list is
     * NOT stable across withdrawals - treat getUserLocks() as an unordered
     * set. The lock record itself is left untouched, so getLock(id) still
     * reads the full history afterwards.
     */
    function _removeActiveLock(address owner, uint256 lockId) private {
        uint256 indexPlusOne = _lockIndex[lockId];
        if (indexPlusOne == 0) return; // never indexed, nothing to do

        uint256[] storage activeIds = _activeLockIds[owner];
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = activeIds.length - 1;

        if (index != lastIndex) {
            uint256 moved = activeIds[lastIndex];
            activeIds[index] = moved;
            // `moved` now sits at `index`, i.e. at position index + 1.
            _lockIndex[moved] = indexPlusOne;
        }

        activeIds.pop();
        delete _lockIndex[lockId];
    }

    /**
     * @notice Read a lock.
     * @dev For a lockId that does not exist this returns an all-zero record.
     *      A lock exists iff lockId != 0 && lockId <= lockCount. For an
     *      existing lock, amount == 0 means it has been withdrawn.
     */
    function getLock(uint256 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    /**
     * @notice Every lock `user` has created and NOT withdrawn yet.
     * @dev One call answers "which tokens do I have locked right now, how much
     *      of each, and how long until each one unlocks".
     *
     *      - A withdrawn lock disappears from this list (the record itself
     *        stays readable through getLock(id)).
     *      - `secondsUntilUnlock == 0` means it is already withdrawable.
     *      - The order is NOT stable: withdrawing swaps the last entry into the
     *        freed slot. Treat the result as an unordered set.
     *
     *      Read-only: touches no state and cannot affect any withdrawal. For an
     *      address holding a very large number of locks this view can become
     *      too expensive to call in one go - read getLock(id) or the
     *      LockCreated events instead in that case.
     */
    function getUserLocks(
        address user
    ) external view returns (LockView[] memory locks) {
        uint256[] storage activeIds = _activeLockIds[user];
        uint256 length = activeIds.length;
        uint256 currentTime = block.timestamp;

        locks = new LockView[](length);

        for (uint256 i = 0; i < length; i++) {
            uint256 lockId = activeIds[i];
            Lock storage lockData = _locks[lockId];
            uint256 unlockTime = lockData.unlockTime;

            locks[i] = LockView({
                lockId: lockId,
                token: lockData.token,
                amount: lockData.amount,
                unlockTime: unlockTime,
                secondsUntilUnlock: currentTime < unlockTime
                    ? unlockTime - currentTime
                    : 0
            });
        }
    }

    /**
     * @notice How many locks `user` still has to withdraw.
     * @dev Same list as getUserLocks(). Locks that were already withdrawn are
     *      not counted. Handy for paginating a long list.
     */
    function getUserLockCount(address user) external view returns (uint256) {
        return _activeLockIds[user].length;
    }
}
