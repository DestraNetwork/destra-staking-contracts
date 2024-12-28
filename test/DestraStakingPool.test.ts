import { ethers } from "hardhat";
import { expect } from "chai";
import { DestraStakingPool, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DestraStakingPool", function() {
  let staking: DestraStakingPool;
  let token: MockERC20;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const STAKE_AMOUNT = ethers.parseEther("1000");
  const REWARD_AMOUNT = ethers.parseEther("10");
  const LOCKIN_30_DAYS = 30 * 24 * 3600;
  const LOCKIN_90_DAYS = 90 * 24 * 3600;
  const LOCKIN_180_DAYS = 180 * 24 * 3600;
  const LOCKIN_360_DAYS = 360 * 24 * 3600;

  beforeEach(async function() {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("TestToken", "TT", INITIAL_SUPPLY);
    await token.waitForDeployment();

    const Staking = await ethers.getContractFactory("DestraStakingPool");
    staking = await Staking.deploy(await token.getAddress());
    await staking.waitForDeployment();

    // Give Alice and Bob some tokens
    await token.transfer(await alice.getAddress(), ethers.parseEther("2000"));
    await token.transfer(await bob.getAddress(), ethers.parseEther("2000"));
    await token.transfer(await charlie.getAddress(), ethers.parseEther("2000"));
  });

  describe("Initialization", function() {
    it("should initialize correctly", async function() {
      const period0 = await staking.rewardPeriods(0);
      expect(period0.totalWeight).to.equal(0);
      expect(period0.ethRewards).to.equal(0);
      expect(await staking.rewardPeriodIndex()).to.equal(0);
    });
  });

  describe("Staking", function() {
    it("should allow a user to stake tokens", async function() {
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await expect(staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS))
        .to.emit(staking, "Staked")
        .withArgs(await alice.getAddress(), STAKE_AMOUNT, LOCKIN_30_DAYS);

      const userStakes = await staking.getUserStakes(await alice.getAddress());
      expect(userStakes.length).to.equal(1);
      expect(userStakes[0].amount).to.equal(STAKE_AMOUNT);
    });

    it("should revert if invalid lockin period is given", async function() {
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await expect(
        staking.connect(alice).stake(STAKE_AMOUNT, 1234)
      ).to.be.revertedWith("Invalid lock-in period");
    });

    it("should revert if transfer fails", async function() {
      await expect(
        staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS)
      ).to.be.reverted;
    });
  });

  describe("Depositing Rewards", function() {
    it("should allow owner to deposit ETH rewards and emit event", async function() {
      await expect(
        staking.connect(owner).depositRewards(0, { value: REWARD_AMOUNT })
      )
        .to.emit(staking, "RewardDeposited")
        .withArgs(0, REWARD_AMOUNT);

      const period0 = await staking.rewardPeriods(0);
      expect(period0.ethRewards).to.equal(REWARD_AMOUNT);
    });

    it("should revert if no ETH deposited", async function() {
      await expect(staking.connect(owner).depositRewards(0, { value: 0 }))
        .to.be.revertedWith("No ETH deposited");
    });

    it("should allow period to transition and deposit in new period", async function() {
      // Increase time to end the first period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(staking.connect(owner).depositRewards(1, { value: REWARD_AMOUNT }))
        .to.emit(staking, "RewardPeriodTransition")
        .and.to.emit(staking, "RewardDeposited")
        .withArgs(1, REWARD_AMOUNT);

      const currentIndex = await staking.rewardPeriodIndex();
      expect(currentIndex).to.equal(1);
      const period1 = await staking.rewardPeriods(1);
      expect(period1.ethRewards).to.equal(REWARD_AMOUNT);
    });
  });

  describe("Claiming Rewards", function() {
    beforeEach(async function() {
      // Alice stakes for 30 days
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);

      // Bob stakes for 90 days
      await token.connect(bob).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(bob).stake(STAKE_AMOUNT, LOCKIN_90_DAYS);

      // Owner deposits rewards
      await staking.connect(owner).depositRewards(0, { value: REWARD_AMOUNT });
    });

    it("should revert if claiming before period ends", async function() {
      await expect(
        staking.connect(alice).claimRewards(0)
      ).to.be.revertedWith("Reward period not ended");
    });

    it("should allow user to claim rewards after owner sets total weight", async function() {
      // Fast forward to end the period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      // Suppose owner calculated totalWeight:
      await staking.connect(owner).setTotalWeight(0, ethers.parseEther("3000"));

      const beforeBalance = await ethers.provider.getBalance(await alice.getAddress());
      const tx = await staking.connect(alice).claimRewards(0);
      const receipt = await tx.wait();
      
      // Calculate gas used
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
      
      const afterBalance = await ethers.provider.getBalance(await alice.getAddress());
      // Alice weight = 1000/3000 = 1/3 * REWARD_AMOUNT = ~3.3333 ETH
      // Add back gas costs to get actual reward amount
      const actualReward = (afterBalance - beforeBalance) + gasUsed;
      expect(actualReward).to.be.closeTo(REWARD_AMOUNT * 1n / 3n, ethers.parseEther("0.0001"));
    });

    it("should revert if no eligible stakes", async function() {
      // Bob unstakes before the period ends so he has no eligible stakes
      await ethers.provider.send("evm_increaseTime", [15 * 24 * 3600 + 1]); // Past 15 days check
      await ethers.provider.send("evm_mine", []);

      // Bob unstakes early from his 90 days stake
      await staking.connect(bob).unstake(0);

      // End period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS]); 
      await ethers.provider.send("evm_mine", []);

      await staking.connect(owner).setTotalWeight(0, 1000); // Only alice has weight now

      await expect(
        staking.connect(bob).claimRewards(0)
      ).to.be.revertedWith("No eligible stakes for rewards");
    });

    it("should allow user to claim rewards only once", async function() {
      // Fast forward to end the period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      // Suppose owner calculated totalWeight:
      await staking.connect(owner).setTotalWeight(0, ethers.parseEther("3000"));

      const beforeBalance = await ethers.provider.getBalance(await alice.getAddress());
      const tx = await staking.connect(alice).claimRewards(0);
      const receipt = await tx.wait();
      
      // Calculate gas used
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
      
      const afterBalance = await ethers.provider.getBalance(await alice.getAddress());
      // Alice weight = 1000/3000 = 1/3 * REWARD_AMOUNT = ~3.3333 ETH
      // Add back gas costs to get actual reward amount
      const actualReward = (afterBalance - beforeBalance) + gasUsed;
      expect(actualReward).to.be.closeTo(REWARD_AMOUNT * 1n / 3n, ethers.parseEther("0.0001"));
      await expect(
        staking.connect(alice).claimRewards(0)
      ).to.be.revertedWith("Rewards claimed for this period");
    });

    it("should allow user to claim rewards in the next cycle when eligibility threshold exceeds current reward period end time", async function () {
      // Fast forward close to the end of the first reward period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS - 9 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);
    
      // Charlie stakes for 30 days
      await token.connect(charlie).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(charlie).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);
    
      await ethers.provider.send("evm_increaseTime", [10 * 24 * 3600]); // 10 more days passed
      await ethers.provider.send("evm_mine", []);
      
      // Suppose owner calculates totalWeight for first reward period
      await staking.connect(owner).setTotalWeight(0, ethers.parseEther("3000"));
    
      // Ensure Charlie cannot claim rewards for period 0 because eligibility threshold is not met
      await expect(staking.connect(charlie).claimRewards(0)).to.be.revertedWith("No eligible stakes for rewards");
    
      // Transition to the next reward period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS]);
      await ethers.provider.send("evm_mine", []);
    
      await staking.connect(owner).depositRewards(1, { value: REWARD_AMOUNT });
      // Suppose owner calculates totalWeight for period 1
      await staking.connect(owner).setTotalWeight(1, ethers.parseEther("3000"));
    
      // Charlie claims rewards for period 1
      const beforeBalance = await ethers.provider.getBalance(await charlie.getAddress());
      const tx = await staking.connect(charlie).claimRewards(1);
      const receipt = await tx.wait();
    
      // Calculate gas used
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
    
      const afterBalance = await ethers.provider.getBalance(await charlie.getAddress());
      // Charlie's weight = 1000 / 3000 = 1/3 * REWARD_AMOUNT
      const expectedReward = REWARD_AMOUNT * 1n / 3n;
    
      // Check that Charlie's balance increased by the expected reward minus gas
      const actualReward = (afterBalance - beforeBalance) + gasUsed;
      expect(actualReward).to.be.closeTo(expectedReward, ethers.parseEther("0.0001"));
    });
    
    it("should correctly calculate rewards for users with different lock-in periods", async function () {
      // Fast forward to the end of the reward period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);
    
      // Suppose owner calculates totalWeight for period 0:
      // Alice: 1000 tokens * multiplier 1 = 1000 weight
      // Bob: 1000 tokens * multiplier 2 = 2000 weight
      // Total weight = 3000
      await staking.connect(owner).setTotalWeight(0, ethers.parseEther("3000"));
    
      // Alice claims rewards first
      const aliceInitialBalance = await ethers.provider.getBalance(await alice.getAddress());
      const aliceTx = await staking.connect(alice).claimRewards(0);
      const aliceReceipt = await aliceTx.wait();
    
      // Alice's reward = (1000 / 3000) * REWARD_AMOUNT
      const aliceExpectedReward = (REWARD_AMOUNT * 1000n) / 3000n;
    
      // Calculate gas used
      const aliceGasUsed = aliceReceipt!.gasUsed * aliceReceipt!.gasPrice;
      const aliceFinalBalance = await ethers.provider.getBalance(await alice.getAddress());
      const aliceActualReward = aliceFinalBalance - aliceInitialBalance + aliceGasUsed;
    
      expect(aliceActualReward).to.be.closeTo(aliceExpectedReward, ethers.parseEther("0.0001"));
    
      // Bob claims rewards after Alice
      const bobInitialBalance = await ethers.provider.getBalance(await bob.getAddress());
      const bobTx = await staking.connect(bob).claimRewards(0);
      const bobReceipt = await bobTx.wait();
    
      // After Alice's claim, remaining totalWeight = 2000 (Bob's weight)
      // Bob's reward = (2000 / 2000) * remaining rewards = remaining rewards
      const bobExpectedReward = REWARD_AMOUNT - aliceExpectedReward;
    
      // Calculate gas used
      const bobGasUsed = bobReceipt!.gasUsed * bobReceipt!.gasPrice;
      const bobFinalBalance = await ethers.provider.getBalance(await bob.getAddress());
      const bobActualReward = bobFinalBalance - bobInitialBalance + bobGasUsed;
    
      expect(bobActualReward).to.be.closeTo(bobExpectedReward, ethers.parseEther("0.0001"));
    });
    
  });

  describe("Unstaking", function() {
    beforeEach(async function() {
      // Alice stakes for 180 days
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_180_DAYS);
    });

    it("should allow user to unstake after lockin without penalty", async function() {
      // Fast forward 180 days
      await ethers.provider.send("evm_increaseTime", [LOCKIN_180_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const beforeBalance = await token.balanceOf(await alice.getAddress());
      await expect(staking.connect(alice).unstake(0))
        .to.emit(staking, "Unstaked")
        .withArgs(await alice.getAddress(), STAKE_AMOUNT, 0);

      const afterBalance = await token.balanceOf(await alice.getAddress());
      expect(afterBalance - beforeBalance).to.equal(STAKE_AMOUNT);
    });
  });
});
