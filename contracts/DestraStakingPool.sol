// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract DestraStakingPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable dsyncToken;
    struct Stake {
        uint256 amount;            // Amount of tokens staked
        uint256 lockinPeriod;      // Lock-in duration in seconds
        uint256 startTime;         // Timestamp when staking started
        uint256 eligibilityThresholdAtStake; // Snapshot of eligibility threshold at the time of staking
        bool withdrawn;            // Flag indicating if stake has been withdrawn
        uint256 rewardPeriodIndex; // The reward period in which this stake was made
    }

    struct RewardPeriod {
        uint256 ethRewards;    // Total ETH rewards deposited for this period
        uint256 startTime;     // Start time of the reward period
        uint256 endTime;       // End time of the reward period
        uint256 totalWeight;   // Total weight of all stakes in this period
    }

    mapping(address => Stake[]) public userStakes;
    mapping(uint256 => RewardPeriod) public rewardPeriods;
    mapping(address => mapping(uint256 => bool)) public hasClaimed; // Tracks if a user claimed rewards for a specific period

    uint256 public rewardPeriodIndex; // Current reward period index

    uint256 constant LOCKIN_30_DAYS = 30 days;
    uint256 constant LOCKIN_90_DAYS = 90 days;
    uint256 constant LOCKIN_180_DAYS = 180 days;
    uint256 constant LOCKIN_360_DAYS = 360 days;

    uint256 public totalStaked;

    // The number of days before the period end that a stake must have started to be eligible.
    // This is configurable and must be between 5 days and 20 days.
    uint256 public eligibilityThreshold = 15 days; 

    // Events
    event Staked(address indexed user, uint256 amount, uint256 lockinPeriod);
    event Unstaked(address indexed user, uint256 amount, uint256 penalty);
    event RewardDeposited(uint256 periodIndex, uint256 amount);
    event RewardClaimed(address indexed user, uint256 periodIndex, uint256 reward);
    event TotalWeightUpdated(uint256 rewardPeriodIndex, uint256 totalWeight);
    event RewardPeriodTransition(
        uint256 oldPeriodIndex,
        uint256 newPeriodIndex,
        uint256 newPeriodStartTime,
        uint256 newPeriodEndTime
    );
    event EligibilityThresholdUpdated(uint256 newThreshold);

    constructor(address _dsyncToken) Ownable(msg.sender) {
        require(_dsyncToken != address(0), "Invalid token address");
        dsyncToken = IERC20(_dsyncToken);
        rewardPeriods[0] = RewardPeriod({
            ethRewards: 0,
            startTime: block.timestamp,
            endTime: block.timestamp + LOCKIN_30_DAYS,
            totalWeight: 0
        });
        rewardPeriodIndex = 0;
    }

    /// @dev Internal function to check and transition reward period
    ///      If the current period is ended, start a new one and emit an event.
    function _checkAndTransitionRewardPeriod() internal {
        if (block.timestamp >= rewardPeriods[rewardPeriodIndex].endTime) {
            uint256 oldPeriod = rewardPeriodIndex;
            rewardPeriodIndex++;
            rewardPeriods[rewardPeriodIndex] = RewardPeriod({
                ethRewards: 0,
                startTime: rewardPeriods[rewardPeriodIndex - 1].endTime,
                endTime: rewardPeriods[rewardPeriodIndex - 1].endTime + LOCKIN_30_DAYS,
                totalWeight: 0
            });

            emit RewardPeriodTransition(
                oldPeriod,
                rewardPeriodIndex,
                rewardPeriods[rewardPeriodIndex].startTime,
                rewardPeriods[rewardPeriodIndex].endTime
            );
        }
    }

    /// @dev Allows the owner to set the total weight for a reward period.
    /// @param periodIndex The index of the reward period to update.
    /// @param totalWeight The calculated total weight for the specified reward period.
    /// @notice Calculating total weight manually is necessary because iterating over all stakes 
    ///         to compute the total weight within this function could exceed the block gas limit. 
    ///         As the number of stakes grows, gas costs for looping over all stakes would become 
    ///         prohibitively high, making the operation infeasible to execute on-chain. 
    ///         By calculating this off-chain and setting it here, the contract remains scalable.
    function setTotalWeight(uint256 periodIndex, uint256 totalWeight) external onlyOwner {
        require(periodIndex <= rewardPeriodIndex, "Invalid reward period");
        require(rewardPeriods[periodIndex].totalWeight == 0, "Total weight already set");
        require(rewardPeriods[periodIndex].ethRewards > 0, "No ETH for period");
        _checkAndTransitionRewardPeriod();
        rewardPeriods[periodIndex].totalWeight = totalWeight;
        emit TotalWeightUpdated(periodIndex, totalWeight);
    }

    /// @dev Allows the owner to deposit ETH rewards for a specific reward period.
    /// @param periodIndex The index of the reward period to deposit rewards to.
    function depositRewards(uint256 periodIndex) external payable onlyOwner {
        require(msg.value > 0, "No ETH deposited");
        // Allow deposits for past periods if totalWeight is not set
        require(
            periodIndex <= rewardPeriodIndex || rewardPeriods[periodIndex].totalWeight == 0,
            "Invalid reward period"
        );
        _checkAndTransitionRewardPeriod(); // Automatically transition to new period
        rewardPeriods[periodIndex].ethRewards += msg.value;
        emit RewardDeposited(periodIndex, msg.value);
    }

    /// @dev Allows a user to stake tokens for a specified lock-in period.
    /// @param amount Amount of tokens to stake.
    /// @param lockinPeriod Lock-in period (30, 90, 180, or 360 days).
    function stake(uint256 amount, uint256 lockinPeriod) external nonReentrant {
        require(
            lockinPeriod == LOCKIN_30_DAYS || 
            lockinPeriod == LOCKIN_90_DAYS || 
            lockinPeriod == LOCKIN_180_DAYS || 
            lockinPeriod == LOCKIN_360_DAYS,
            "Invalid lock-in period"
        );

        dsyncToken.safeTransferFrom(msg.sender, address(this), amount);

        _checkAndTransitionRewardPeriod(); // Automatically transition to new period

        userStakes[msg.sender].push(Stake({
            amount: amount,
            lockinPeriod: lockinPeriod,
            startTime: block.timestamp,
            eligibilityThresholdAtStake: eligibilityThreshold,
            withdrawn: false,
            rewardPeriodIndex: rewardPeriodIndex // Assign current reward period index
        }));

        totalStaked += amount;

        emit Staked(msg.sender, amount, lockinPeriod);
    }

    /// @dev Allows a user to claim their rewards after the reward period.
    ///      Rewards Calculation Logic:
    ///      1. Users can claim rewards for a completed reward period (periodIndex).
    ///      2. The user's stake must have:
    ///          - Not been withdrawn.
    ///          - Started at least `stakeData.eligibilityThresholdAtStake` days before the period ended 
    ///            (stakeData.startTime + stakeData.eligibilityThresholdAtStake <= rewardPeriods[periodIndex].endTime).
    ///          - The stake must also span through the end of the reward period 
    ///            (stakeData.startTime + stakeData.lockinPeriod + stakeData.eligibilityThresholdAtStake >= rewardPeriods[periodIndex].endTime).
    ///      3. Based on the stake’s lock-in period, a multiplier is applied:
    ///         - 30 days: multiplier = 1
    ///         - 90 days: multiplier = 2
    ///         - 180 days: multiplier = 3
    ///         - 360 days: multiplier = 4
    ///      4. The user’s weight = sum of (amount * multiplier) for all eligible stakes.
    ///      5. The user’s reward = (userWeight / totalWeight) * ethRewards for that period.
    function claimRewards(uint256 periodIndex) external nonReentrant {
        _checkAndTransitionRewardPeriod();

        require(periodIndex <= rewardPeriodIndex, "Invalid reward period");
        require(block.timestamp >= rewardPeriods[periodIndex].endTime, "Reward period not ended");
        require(!hasClaimed[msg.sender][periodIndex], "Rewards claimed for this period");

        uint256 userWeight = 0;
        uint256 reward;

        uint256 stakesLength = userStakes[msg.sender].length;
        for (uint256 i = 0; i < stakesLength; i++) {
            Stake storage stakeData = userStakes[msg.sender][i];
            if (
                !stakeData.withdrawn &&
                stakeData.startTime + stakeData.eligibilityThresholdAtStake <= rewardPeriods[periodIndex].endTime &&
                stakeData.startTime + stakeData.lockinPeriod + stakeData.eligibilityThresholdAtStake > rewardPeriods[periodIndex].endTime
            ) {
                uint256 multiplier = stakeData.lockinPeriod == LOCKIN_30_DAYS ? 1 :
                                     stakeData.lockinPeriod == LOCKIN_90_DAYS ? 2 :
                                     stakeData.lockinPeriod == LOCKIN_180_DAYS ? 3 : 4;

                userWeight += stakeData.amount * multiplier;
            }
        }

        require(userWeight > 0, "No eligible stakes for rewards");

        uint256 totalWeight = rewardPeriods[periodIndex].totalWeight;
        require(totalWeight > 0, "Reward distribution not started yet");

        reward = (rewardPeriods[periodIndex].ethRewards * userWeight) / totalWeight;
        require(reward > 0, "No rewards to claim");

        // Update the reward period data
        rewardPeriods[periodIndex].ethRewards -= reward; // Deduct the claimed reward
        rewardPeriods[periodIndex].totalWeight -= userWeight; // Deduct the user's weight from total weight

        // Mark rewards as claimed
        hasClaimed[msg.sender][periodIndex] = true;

        (bool success, ) = msg.sender.call{value: reward}("");
        require(success, "ETH transfer failed");

        emit RewardClaimed(msg.sender, periodIndex, reward);
    }

    /// @dev Allows a user to unstake tokens with a penalty if unstaked before completion.
    /// @param stakeIndex Index of the stake to unstake.
    function unstake(uint256 stakeIndex) external nonReentrant {
        require(stakeIndex < userStakes[msg.sender].length, "Invalid stake index");

        Stake storage stakeData = userStakes[msg.sender][stakeIndex];
        require(!stakeData.withdrawn, "Already withdrawn");

        uint256 penalty;
        uint256 stakedAmount = stakeData.amount;
        if (block.timestamp < stakeData.startTime + stakeData.lockinPeriod) {
            penalty = (stakeData.lockinPeriod == LOCKIN_30_DAYS) ? 15 :
                      (stakeData.lockinPeriod == LOCKIN_90_DAYS) ? 13 :
                      (stakeData.lockinPeriod == LOCKIN_180_DAYS) ? 12 : 10;
            penalty = (stakedAmount * penalty) / 100;
        }

        uint256 amountToTransfer = stakedAmount - penalty;
        totalStaked -= stakedAmount;
        stakeData.withdrawn = true;

        if (penalty > 0) {
            dsyncToken.safeTransfer(0x000000000000000000000000000000000000dEaD, penalty);
        }

        dsyncToken.safeTransfer(msg.sender, amountToTransfer);

        emit Unstaked(msg.sender, stakedAmount, penalty);
    }

    /// @dev Returns all stakes for a user.
    function getUserStakes(address user) external view returns (Stake[] memory) {
        return userStakes[user];
    }

    /// @dev Owner can set a new eligibility threshold (in seconds) for reward claiming.
    ///      This threshold must be between 5 days and 20 days.
    /// @param newThreshold The new threshold in seconds.
    function setEligibilityThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold >= 5 days && newThreshold <= 20 days, "Threshold out of range");
        eligibilityThreshold = newThreshold;
        emit EligibilityThresholdUpdated(newThreshold);
    }
}
