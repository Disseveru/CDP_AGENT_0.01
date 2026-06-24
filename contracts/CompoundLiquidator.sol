// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
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

interface ICompoundV3 {
    function buyCollateral(
        address asset,
        uint256 minAmount,
        uint256 baseAmount,
        address recipient
    ) external;
}

/// @notice Flash-loan powered Compound V3 collateral buyer with optional swap callback.
/// @dev Repays Instadapp flash loans via IERC20.approve. Swap step is optional encoded callback.
contract CompoundLiquidator {
    address public owner;
    address public immutable aggregator;

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event LiquidationAttempted(address indexed market, address indexed base, uint256 baseAmount);

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

    struct LiquidationParams {
        address market;
        address baseToken;
        address collateralToken;
        uint256 baseAmount;
        uint256 minCollateral;
        address swapTarget;
        bytes swapData;
        uint256 flashRoute;
    }

    function liquidateWithFlashLoan(LiquidationParams calldata params) external onlyOwner {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = params.baseToken;
        amounts[0] = params.baseAmount;

        bytes memory data = abi.encode(params);
        IInstaFlashAggregator(aggregator).flashLoan(tokens, amounts, params.flashRoute, data, "");
        emit LiquidationAttempted(params.market, params.baseToken, params.baseAmount);
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

        LiquidationParams memory params = abi.decode(data, (LiquidationParams));

        require(assets[0] == params.baseToken, "token mismatch");
        require(amounts[0] == params.baseAmount, "amount mismatch");

        require(
            IERC20(params.baseToken).approve(params.market, params.baseAmount),
            "market approve failed"
        );

        ICompoundV3(params.market).buyCollateral(
            params.collateralToken,
            params.minCollateral,
            params.baseAmount,
            address(this)
        );

        if (params.swapTarget != address(0) && params.swapData.length > 0) {
            require(
                IERC20(params.collateralToken).approve(params.swapTarget, type(uint256).max),
                "swap approve failed"
            );
            (bool ok, ) = params.swapTarget.call(params.swapData);
            require(ok, "swap failed");
        }

        uint256 owed = amounts[0] + premiums[0];
        uint256 balance = IERC20(params.baseToken).balanceOf(address(this));
        require(balance >= owed, "insufficient repay balance");

        require(IERC20(params.baseToken).approve(aggregator, owed), "repay approve failed");

        uint256 profit = balance - owed;
        if (profit > 0) {
            require(IERC20(params.baseToken).transfer(owner, profit), "profit transfer failed");
        }

        return true;
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "transfer failed");
    }
}
