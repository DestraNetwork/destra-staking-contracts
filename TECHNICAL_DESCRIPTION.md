# Technical Description

This technical description provides a detailed view of how the **DestraStakingPool** contract manages staking, rewards, periods, and eligibility criteria.

## Data Structures

### State Variables

- `IERC20 public dsyncToken;`  
  The ERC20 token users stake in the pool.

- `uint256 public rewardPeriodIndex;`  
  Index of the current active reward period.

- `uint256 public totalStaked;`  
  Total number of tokens staked across all users.

- `mapping(address => Stake[]) public userStakes;`  
  Keeps an array of `Stake` structs per user, containing their staking records.

- `mapping(uint256 => RewardPeriod) public rewardPeriods;`  
  Stores data for each reward period keyed by `rewardPeriodIndex`.

- `uint256 public eligibilityThreshold;`  
  A configurable time threshold (in seconds) that determines how far before the end of a reward period a stake must have started to qualify for rewards. Can be set between 5 days and 20 days.

### Structs

1. **Stake**:
   - `uint256 amount`: The number of tokens staked.
   - `uint256 lockinPeriod`: Duration of the lock-in (30, 90, 180, or 360 days).
   - `uint256 startTime`: Timestamp when this stake was initiated.
   - `bool withdrawn`: Indicates if the stake has been unstaked.
   - `uint256 rewardPeriodIndex`: The reward period index when this stake was made.

2. **RewardPeriod**:
   - `uint256 ethRewards`: The total ETH allocated to this period.
   - `uint256 startTime`: When the reward period starts.
   - `uint256 endTime`: When the reward period ends.
   - `uint256 totalWeight`: The combined staking weight of all eligible stakers in this period, set off-chain by the owner.

## Constants

- Four predefined lock-in periods with associated multipliers:
  - 30 days: multiplier = 1
  - 90 days: multiplier = 2
  - 180 days: multiplier = 3
  - 360 days: multiplier = 4

- Early unstake penalties based on chosen lock-in:
  - 30 days: 15%
  - 90 days: 13%
  - 180 days: 12%
  - 360 days: 10%

## Initialization

The constructor:
- Sets `dsyncToken` as the staking token.
- Initializes the first reward period (index 0) starting at `block.timestamp` and ending after 30 days with zero initial rewards.
- Sets a default `eligibilityThreshold` (initially 15 days).

## Reward Periods and Transition

- The contract tracks reward periods sequentially. Once the current period expires, any call to `stake`, `depositRewards`, or `claimRewards` checks and possibly transitions to a new reward period.
- A `RewardPeriodTransition` event is emitted when a new period begins.

## Eligibility Threshold

- `eligibilityThreshold` determines how soon before a period's end a stake must have started to be eligible for rewards.
- By default, it might be 15 days but can be changed by the owner (between 5 and 20 days) using `setEligibilityThreshold`.
- This parameter allows dynamic tuning of the reward eligibility window without redeploying the contract.

## Key Functions

### Owner-Only Functions

1. **`setTotalWeight(uint256 periodIndex, uint256 totalWeight)`**:  
   The owner sets the total weight of stakes for a completed period. Because computing the total weight for thousands of users on-chain could exceed the block gas limit, this calculation is performed off-chain, and the resulting total is then set on-chain. This approach ensures that the contract remains efficient and can scale to a large number of stakers without encountering gas limit issues.

2. **`depositRewards(uint256 periodIndex)`**:  
   The owner can deposit ETH into the contract. If the current period ended, it transitions to a new period first. Increases `ethRewards` for the active period.

3. **`setEligibilityThreshold(uint256 newThreshold)`**:  
   Allows the owner to adjust the `eligibilityThreshold` between 5 and 20 days. This impacts reward claim conditions.

### User Functions

1. **`stake(uint256 amount, uint256 lockinPeriod)`**:  
   Users stake tokens for a chosen lock-in period.  
   - Tokens are transferred from the user to the contract.
   - If the reward period ended, the contract transitions to a new period.
   - A new `Stake` record is created, and `totalStaked` updates accordingly.

2. **`unstake(uint256 stakeIndex)`**:  
   Users can withdraw staked tokens.  
   - If lock-in is not complete, a penalty is burned.
   - Remaining tokens are returned to the user.
   - Marks the stake as withdrawn and updates `totalStaked`.

3. **`claimRewards(uint256 periodIndex)`**:  
   After a reward period ends, users may claim ETH:  
   - Checks that `periodIndex` is valid and the period ended.
   - Ensures `totalWeight` for that period is set.
   - Evaluates each stake:
     - It must not be withdrawn.
     - It must have started at least `eligibilityThreshold` seconds before the period ended.
     - The stake’s lock-in period must cover the period's end.
   - Calculates `userWeight` by summing `amount * multiplier` for eligible stakes.
   - Computes `reward = (userWeight / totalWeight) * ethRewards`.
   - Transfers `reward` to the user in ETH, reduces `ethRewards` by `reward`.

4. **`getUserStakes(address user)`**:  
   Returns an array of `Stake` records for that user.

## Control Flow

1. **Staking**:  
   User calls `stake`. If needed, a period transition occurs. The stake is recorded, and events are emitted.

2. **Setting Total Weight**:  
   After a period ends, the owner calls `setTotalWeight`. This finalizes the distribution parameters for that period.

3. **Claiming Rewards**:  
   Users call `claimRewards`. The contract calculates eligibility based on `eligibilityThreshold`, lock-in completion, and staking duration. Rewards are distributed proportionally to their weight.

4. **Unstaking**:  
   Users can `unstake` at any time. Early unstaking incurs a penalty. No penalty if done after completing the lock-in period.

5. **Adjusting Threshold**:  
   Owner can call `setEligibilityThreshold` to modify the eligibility window without impacting the core logic of stake or reward distribution.
