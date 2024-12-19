import { ethers } from "hardhat";
import { expect } from "chai";
import { DestraStakingPool, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DestraStakingPool", function () {
  let staking: DestraStakingPool;
  let token: MockERC20;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const STAKE_AMOUNT = ethers.parseEther("1000");
  const REWARD_AMOUNT = ethers.parseEther("10");
  const LOCKIN_30_DAYS = 30 * 24 * 3600;
  const LOCKIN_90_DAYS = 90 * 24 * 3600;
  const LOCKIN_180_DAYS = 180 * 24 * 3600;
  const LOCKIN_360_DAYS = 360 * 24 * 3600;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("TestToken", "TT", INITIAL_SUPPLY);
    await token.waitForDeployment();

    const Staking = await ethers.getContractFactory("DestraStakingPool");
    staking = await Staking.deploy(await token.getAddress());
    await staking.waitForDeployment();

    // Give Alice and Bob some tokens
    await token.transfer(await alice.getAddress(), ethers.parseEther("2000"));
    await token.transfer(await bob.getAddress(), ethers.parseEther("2000"));
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
        staking.connect(owner).depositRewards({ value: REWARD_AMOUNT })
      ).to.emit(staking, "RewardDeposited")
       .withArgs(REWARD_AMOUNT);

      const period0 = await staking.rewardPeriods(0);
      expect(period0.ethRewards).to.equal(REWARD_AMOUNT);
    });

    it("should revert if no ETH deposited", async function() {
      await expect(staking.connect(owner).depositRewards({ value: 0 }))
        .to.be.revertedWith("No ETH deposited");
    });

    it("should allow period to transition and deposit in new period", async function() {
      // Increase time to end the first period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);
      
      await expect(staking.connect(owner).depositRewards({ value: REWARD_AMOUNT }))
        .to.emit(staking, "RewardPeriodTransition")
        .and.to.emit(staking, "RewardDeposited");

      const currentIndex = await staking.rewardPeriodIndex();
      expect(currentIndex).to.equal(1);
      const period1 = await staking.rewardPeriods(1);
      expect(period1.ethRewards).to.equal(REWARD_AMOUNT);
    });
  });

  describe("Setting Total Weight", function() {
    beforeEach(async function() {
      // Alice stakes
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);
      // Owner deposits rewards in period 0
      await staking.connect(owner).depositRewards({ value: REWARD_AMOUNT });
    });

    it("should allow owner to set total weight if not already set", async function() {
      await expect(staking.connect(owner).setTotalWeight(0, 1000))
        .to.emit(staking, "TotalWeightUpdated")
        .withArgs(0, 1000);
      const period0 = await staking.rewardPeriods(0);
      expect(period0.totalWeight).to.equal(1000);
    });

    it("should revert if invalid period index", async function() {
      await expect(
        staking.connect(owner).setTotalWeight(5, 1000)
      ).to.be.revertedWith("Invalid reward period");
    });
  });

  describe("Setting Eligibility Threshold", function() {
    it("should allow the owner to set a valid eligibility threshold", async function() {
      const fiveDays = 5 * 24 * 3600;
      const twentyDays = 20 * 24 * 3600;

      await expect(staking.connect(owner).setEligibilityThreshold(fiveDays))
        .to.emit(staking, "EligibilityThresholdUpdated")
        .withArgs(fiveDays);

      expect(await staking.eligibilityThreshold()).to.equal(fiveDays);

      await expect(staking.connect(owner).setEligibilityThreshold(twentyDays))
        .to.emit(staking, "EligibilityThresholdUpdated")
        .withArgs(twentyDays);

      expect(await staking.eligibilityThreshold()).to.equal(twentyDays);
    });

    it("should revert if non-owner tries to set the threshold", async function() {
      const tenDays = 10 * 24 * 3600;
      await expect(
        staking.connect(alice).setEligibilityThreshold(tenDays)
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount")
      .withArgs(await alice.getAddress());
    });

    it("should revert if threshold is below 5 days", async function() {
      const belowFiveDays = 4 * 24 * 3600;
      await expect(
        staking.connect(owner).setEligibilityThreshold(belowFiveDays)
      ).to.be.revertedWith("Threshold must be between 5 and 20 days");
    });

    it("should revert if threshold is above 20 days", async function() {
      const aboveTwentyDays = 21 * 24 * 3600;
      await expect(
        staking.connect(owner).setEligibilityThreshold(aboveTwentyDays)
      ).to.be.revertedWith("Threshold must be between 5 and 20 days");
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
      await staking.connect(owner).depositRewards({ value: REWARD_AMOUNT });
    });

    it("should revert if claiming before period ends", async function() {
      await expect(
        staking.connect(alice).claimRewards(0)
      ).to.be.revertedWith("Reward period not ended");
    });

    it("should revert if invalid reward period is provided", async function() {
      // Increase time to end period 0
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);
      
      await expect(
        staking.connect(alice).claimRewards(5)
      ).to.be.revertedWith("Invalid reward period");
    });

    it("should revert if totalWeight is not set yet", async function() {
      // End current period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);
      
      // Attempt to claim without setting totalWeight
      await expect(
        staking.connect(alice).claimRewards(0)
      ).to.be.revertedWith("Reward distribution not started yet");
    });

    it("should allow user to claim rewards after owner sets total weight", async function() {
      // Fast forward to end the period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      // Suppose owner calculated totalWeight:
      // Alice: lockin 30 days -> multiplier 1, stake=1000 => weight=1000
      // Bob: lockin 90 days -> multiplier 2, stake=1000 => weight=2000
      // total = 3000
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

    it("should apply penalty if unstaked before lockin ends", async function() {
      // Unstake early
      const beforeBalance = await token.balanceOf(await alice.getAddress());
      await staking.connect(alice).unstake(0);
      const afterBalance = await token.balanceOf(await alice.getAddress());

      // Penalty for 180 days is 12%
      const penalty = (STAKE_AMOUNT * 12n) / 100n;
      const expectedReturned = STAKE_AMOUNT - penalty;
      expect(afterBalance - beforeBalance).to.equal(expectedReturned);
    });

    it("should revert if invalid stake index", async function() {
      await expect(
        staking.connect(alice).unstake(5)
      ).to.be.revertedWith("Invalid stake index");
    });

    it("should revert if stake already withdrawn", async function() {
      await staking.connect(alice).unstake(0);
      await expect(
        staking.connect(alice).unstake(0)
      ).to.be.revertedWith("Already withdrawn");
    });
  });

  describe("Edge Cases & Additional Checks", function() {
    it("should handle multiple reward period transitions", async function() {
      // Move through multiple periods
      for (let i = 0; i < 3; i++) {
        await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
        await ethers.provider.send("evm_mine", []);
        await staking.connect(owner).depositRewards({ value: REWARD_AMOUNT });
      }

      const currentIndex = await staking.rewardPeriodIndex();
      expect(currentIndex).to.equal(3);
    });

    it("should revert if owner tries to deposit 0 ETH", async function() {
      await expect(staking.connect(owner).depositRewards())
        .to.be.revertedWith("No ETH deposited");
    });

    it("should revert if user tries to claim non-existing period", async function() {
      await expect(staking.connect(alice).claimRewards(10))
        .to.be.revertedWith("Invalid reward period");
    });

    it("getUserStakes should return empty if user has no stakes", async function() {
      const stakes = await staking.getUserStakes(await bob.getAddress());
      expect(stakes.length).to.equal(0);
    });
  });
});
