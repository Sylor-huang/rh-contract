// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RobinBatchTransfer
 * @notice Batch transfer native ETH and ERC20 tokens
 * @dev Maximum 50 recipients per transaction
 */
contract RobinBatchTransfer is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_RECIPIENTS = 50;

    /**
     * @dev Gas limit for each ETH call. Prevents a malicious receiver from
     * burning all remaining gas. Increase or remove if receivers are smart
     * contracts that need more gas to accept plain ETH.
     */
    uint256 public constant ETH_TRANSFER_GAS_LIMIT = 100_000;

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

    /**
     * @notice Batch transfer native ETH
     */
    function multiTransferETH(
        address payable[] calldata recipients,
        uint256[] calldata amounts
    ) external payable nonReentrant {
        uint256 length = recipients.length;

        require(length > 0, "No recipients");
        require(length == amounts.length, "Length mismatch");
        require(length <= MAX_RECIPIENTS, "Maximum 50 recipients");

        uint256 totalAmount = 0;

        // Validate and calculate total
        for (uint256 i = 0; i < length; i++) {
            require(recipients[i] != address(0), "Invalid recipient");
            require(amounts[i] > 0, "Invalid amount");

            totalAmount += amounts[i];
        }

        require(msg.value == totalAmount, "Incorrect ETH amount");

        // Transfer ETH
        for (uint256 i = 0; i < length; i++) {
            (bool success, ) = recipients[i].call{
                value: amounts[i],
                gas: ETH_TRANSFER_GAS_LIMIT
            }("");

            require(success, "ETH transfer failed");
        }

        emit BatchETHTransfer(msg.sender, length, totalAmount);
    }

    /**
     * @notice Batch transfer ERC20 tokens
     * @dev User must approve this contract first. Uses SafeERC20 so tokens
     * that do not return a bool (e.g. USDT) are also supported.
     */
    function multiTransferToken(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant {
        uint256 length = recipients.length;

        require(token != address(0), "Invalid token");
        require(length > 0, "No recipients");
        require(length == amounts.length, "Length mismatch");
        require(length <= MAX_RECIPIENTS, "Maximum 50 recipients");

        uint256 totalAmount = 0;

        // Validate and calculate total
        for (uint256 i = 0; i < length; i++) {
            require(recipients[i] != address(0), "Invalid recipient");
            require(amounts[i] > 0, "Invalid amount");

            totalAmount += amounts[i];
        }

        IERC20 erc20 = IERC20(token);

        require(
            erc20.balanceOf(msg.sender) >= totalAmount,
            "Insufficient balance"
        );

        require(
            erc20.allowance(msg.sender, address(this)) >= totalAmount,
            "Insufficient allowance"
        );

        // Transfer tokens
        for (uint256 i = 0; i < length; i++) {
            erc20.safeTransferFrom(msg.sender, recipients[i], amounts[i]);
        }

        emit BatchTokenTransfer(msg.sender, token, length, totalAmount);
    }
}
