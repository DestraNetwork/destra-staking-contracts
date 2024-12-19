# Destra Staking

## Overview

This repository contains a staking contract (`DestraStakingPool`) that allows users to stake DSync ERC20 tokens and earn periodic(every 30 days) ETH rewards. The ETH rewards are deposited by the contract owner and distributed to stakers based on their contribution weight, calculated using lock-in periods and multipliers. The project includes:

- A mock ERC20 token (`MockERC20.sol`).
- The main staking contract (`DestraStakingPool.sol`).
- Comprehensive Hardhat test scripts in TypeScript.
- Configuration and scripts to compile, test, and run a local Hardhat network.
- Detailed [Technical Description](./TECHNICAL_DESCRIPTION.md) of the contract architecture and implementation.
- Comprehensive [Requirements Documentation](./REQUIREMENTS.md) outlining all functional specifications.


## Features

- **Staking:** Users can stake tokens for specified lock-in periods (30, 90, 180, 360 days).
- **Rewards:** The owner can deposit ETH as rewards for each period. After the period ends, users can claim their proportional share.
- **Lock-in Multiplier:** Longer lock-in periods yield a higher weight, increasing the user's share of rewards.
- **Penalties:** If a user unstakes before the lock-in completes, a penalty is burned.
- **Period Transitions:** The contract automatically transitions to new reward periods based on time.
- **Off-Chain Total Weight Calculation:** When dealing with thousands of users, computing the total staking weight directly on-chain can be prohibitively expensive and may run into block gas limits. To address this, the total weight of stakers in a given reward period is calculated off-chain and then set by the owner. This approach keeps on-chain interactions efficient while maintaining accurate reward distribution.

## Directory Structure

- `contracts/`
  - `DestraStakingPool.sol` - The main staking contract.
  - `mocks/MockERC20.sol` - A custom mock ERC20 token contract that supports transferring to zero address (burn).
- `test/`
  - `DestraStakingPool.test.ts` - Comprehensive test suite.

## Prerequisites

- Node.js v14+ and npm
- Hardhat and dependencies are installed locally

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/DestraNetwork/destra-staking-contracts
   cd destra-staking-contracts
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

## Compilation

Compile the contracts using Hardhat:
```bash
npx hardhat compile
```

## Running Tests

Run the test suite:
```bash
npx hardhat test
```

For a detailed report and gas usage:
```bash
npx hardhat test --verbose
```

To run coverage:
```bash
npx hardhat coverage
```

## Local Development Network

You can start a local Hardhat node:
```bash
npx hardhat node
```

In another terminal, run tests against this node:
```bash
npx hardhat test --network localhost
```

You can observe transaction logs and RPC calls in the terminal where the node is running.

## License

This project is licensed under the [MIT License](./LICENSE).