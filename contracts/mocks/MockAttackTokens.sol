// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev ERC20 that keeps `value / 100` (1%) on every transfer. Used to prove the
 * time lock rejects tokens that do not deliver the exact amount, because such a
 * token would leave the contract short of what it credited to the lock owner.
 */
contract MockFeeOnTransferToken is ERC20 {
    address internal constant FEE_SINK =
        0x000000000000000000000000000000000000dEaD;

    constructor() ERC20("Fee On Transfer Mock", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        // Minting and burning take no fee.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = value / 100;
        if (fee > 0) {
            super._update(from, FEE_SINK, fee);
        }
        super._update(from, to, value - fee);
    }
}

/**
 * @dev ERC20 that re-enters a target contract whenever it moves tokens out of
 * it. Used to prove the time lock cannot be drained by a reentrant token: the
 * reentrancy guard reverts the nested call, and the effects-before-interactions
 * ordering means a second withdrawal has nothing left to pay out.
 */
contract MockReentrantToken is ERC20 {
    address public attackTarget;
    uint256 public attackLockId;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor() ERC20("Reentrant Mock", "REENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the hook: next time tokens leave `target`, call target.withdraw(lockId).
    function arm(address target, uint256 lockId) external {
        attackTarget = target;
        attackLockId = lockId;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (
            attackTarget != address(0) &&
            !reentryAttempted &&
            from == attackTarget
        ) {
            reentryAttempted = true;
            (bool ok, ) = attackTarget.call(
                abi.encodeWithSignature("withdraw(uint256)", attackLockId)
            );
            reentrySucceeded = ok;
        }

        super._update(from, to, value);
    }
}
