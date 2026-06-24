// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IInstaFlashAggregator {
    function flashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 route,
        bytes calldata data,
        bytes calldata instaData
    ) external;
}

/// @notice Instadapp flash-loan receiver for Avocado Transaction Builder workflows.
/// @dev Implements InstaFlashReceiverInterface and repays via IERC20.approve to the aggregator.
contract FlashLoanReceiver {
    address public owner;
    address public immutable aggregator;

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event FlashLoanRequested(address indexed token, uint256 amount, uint256 route);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address aggregator_, address owner_) {
        require(aggregator_ != address(0), "aggregator required");
        require(owner_ != address(0), "owner required");
        aggregator = aggregator_;
        owner = owner_;
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner required");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function requestFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256 route,
        bytes calldata data
    ) external onlyOwner {
        IInstaFlashAggregator(aggregator).flashLoan(tokens, amounts, route, data, "");
        emit FlashLoanRequested(tokens[0], amounts[0], route);
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata data
    ) external returns (bool) {
        require(msg.sender == aggregator, "unauthorized aggregator");
        require(initiator == address(this) || initiator == owner, "bad initiator");

        if (data.length > 0) {
            (address target, bytes memory callData) = abi.decode(data, (address, bytes));
            if (target != address(0) && callData.length > 0) {
                (bool ok, ) = target.call(callData);
                require(ok, "callback failed");
            }
        }

        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 owed = amounts[i] + premiums[i];
            require(IERC20(assets[i]).approve(aggregator, owed), "approve failed");
        }

        return true;
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "transfer failed");
    }
}
