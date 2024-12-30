# Functional Requirements

## Introduction

This document details the functional requirements of the **DestraStakingPool** smart contract. The contract allows users to stake ERC20 tokens, lock them for certain periods, and earn ETH rewards based on their staking weights. It also manages reward periods, ETH distributions, and applies penalties for early unstaking.

## Definitions

- **Staking Token:** The ERC20 token that users deposit into the contract.
- **Lock-In Period:** The predefined duration for which a user’s staked tokens must remain locked.
- **Reward Period:** A fixed time interval during which stakers earn ETH rewards. After it ends, they can claim their proportional share.
- **Multiplier:** A factor based on the chosen lock-in period, used to calculate user’s staking weight.
- **Penalty:** A percentage of staked tokens burned if unstaking before the end of the lock-in period.

## Roles

- **Owner:** The contract’s deployer or assigned owner who can:
  - Deposit ETH rewards.
  - Set total staking weight for a completed reward period.
- **User/Staker:** Any address that stakes tokens to earn rewards.

## Lock-In Periods and Multipliers

The contract supports these lock-in periods and their associated multipliers:

1. 30 days → Multiplier: 1  
2. 90 days → Multiplier: 2  
3. 180 days → Multiplier: 3  
4. 360 days → Multiplier: 4

## Reward Periods

- Each reward period has:
  - A start and end time.
  - A pool of ETH rewards.
  - A total weight (calculated off-chain and set by the owner).
- When one period ends and a new one begins, the contract automatically transitions to the new reward period.
- Users can claim rewards only after a reward period has ended and once its total weight is set.

## Functional Requirements

### Initialization

1. **Initialize Contract:**
   - The contract must be initialized with the address of the ERC20 token used for staking.
   - The initial reward period (index 0) must start at the time of deployment and last for 30 days.

### Staking

2. **Stake Tokens:**
   - Users can call `stake(amount, lockinPeriod)` to deposit tokens.
   - Valid lock-in periods: 30, 90, 180, or 360 days.
   - The staked tokens are transferred from the user to the contract.
   - A `Stake` record is created, storing the amount, chosen lock-in period, and start time.
   - The `Staked` event is emitted.

3. **Multiple Stakes:**
   - Users can create multiple stakes, each with its own lock-in period and start time.

4. **Updating State on Stake:**
   - Total staked amount is updated.
   - Reward periods transition if the previous period ended before the stake call.
   
### Unstaking

5. **Unstake Tokens:**
   - Users can call `unstake(stakeIndex)` to remove their staked tokens.
   - If unstaking before lock-in completion, a penalty percentage of tokens is burned.
     - 30 days: 15%
     - 90 days: 13%
     - 180 days: 12%
     - 360 days: 10%
   - The remaining tokens are returned to the user.
   - The stake record is marked as withdrawn.
   - The `Unstaked` event is emitted.

6. **Penalties:**
   - If the stake’s lock-in is not reached, a portion of the staked tokens is transferred to the burn address.

### Rewards

7. **Reward Deposit (Owner Only):**
   - Owner can deposit ETH into the contract using `depositRewards()`.
   - If the current reward period has ended, it transitions to a new period automatically.
   - The ETH amount is added to the current reward period’s `ethRewards`.
   - `RewardDeposited` event is emitted.

8. **Set Total Weight (Owner Only):**
   - After a reward period ends, the owner must set the `totalWeight` for that period using `setTotalWeight(periodIndex, totalWeight)`.
   - This total weight is computed off-chain.
   - `TotalWeightUpdated` event is emitted.

9. **Claiming Rewards:**
   - Once a reward period ends and its total weight is set, users can call `claimRewards(periodIndex)` to receive their share of ETH.
   - Eligibility for rewards:
     - Stake must not be withdrawn.
     - Stake must have started at least 15 days before the period ended.
     - The stake’s lock-in period + 15 days must cover the period’s end time.
   - Each eligible stake’s weight = `stakeAmount * multiplier`.
   - User’s total weight = sum of all eligible stakes’ weights.
   - User’s reward = `(userWeight / totalWeight) * ethRewards`.
   - ETH is transferred to the user.
   - `RewardClaimed` event is emitted.

### Period Transitions

10. **Period Transition:**
    - If the current reward period has ended, calling `stake`, `claimRewards`, or `depositRewards` triggers automatic creation of a new period.
    - The `RewardPeriodTransition` event is emitted with details of the old and new periods.

### View Functions

11. **Get User Stakes:**
    - `getUserStakes(user)` returns an array of all `Stake` records for the specified user.

### Security and Safety Checks

12. **Reentrancy Protection:**
    - All external state-changing functions use `nonReentrant` to prevent reentrancy attacks.

13. **Validation:**
    - Check for valid lock-in periods on `stake`.
    - Ensure rewards are claimed only after period end.
    - Ensure total weight is set before distributing rewards.
    - Prevent unstake operations on non-existent or already withdrawn stakes.
    - Disallow zero ETH deposit by owner.

### Events

- **Staked:** Emitted when a user stakes tokens.
- **Unstaked:** Emitted when a user unstakes tokens.
- **RewardDeposited:** Emitted when the owner deposits ETH rewards.
- **RewardClaimed:** Emitted when a user successfully claims their reward.
- **TotalWeightUpdated:** Emitted when the owner sets the total weight for a period.
- **RewardPeriodTransition:** Emitted upon automatic transition to a new reward period.

## Summary

The **DestraStakingPool** contract provides a mechanism for users to stake tokens and earn ETH rewards proportional to their staking weight. The owner sets the total weight off-chain to handle large numbers of stakers efficiently and avoid possibility of exhausting block gas limit on-chain for large number of stakers. Early unstaking incurs penalties, ensuring that users committing for longer durations benefit from greater multipliers and fair reward distribution.