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

    // Give Alice, Bob, and Charlie some tokens
    await token.transfer(await alice.getAddress(), ethers.parseEther("2000"));
    await token.transfer(await bob.getAddress(), ethers.parseEther("2000"));
    await token.transfer(await charlie.getAddress(), ethers.parseEther("2000"));
  });

  describe("Initialization", function() {
    it("should initialize correctly", async function() {
      const period0 = await staking.rewardPeriods(0);
      expect(period0.ethRewards).to.equal(0);
      expect(period0.startTime).to.be.gt(0);
      expect(period0.endTime).to.be.gt(period0.startTime);
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

    it("should revert if transfer fails (no approve)", async function() {
      // Alice has tokens but hasn't approved => revert
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
      ).to.be.revertedWith("Threshold out of range");
    });

    it("should revert if threshold is above 20 days", async function() {
      const aboveTwentyDays = 21 * 24 * 3600;
      await expect(
        staking.connect(owner).setEligibilityThreshold(aboveTwentyDays)
      ).to.be.revertedWith("Threshold out of range");
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

    it("should revert if invalid reward period is provided", async function() {
      // Increase time to end period 0
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        staking.connect(alice).claimRewards(5)
      ).to.be.revertedWith("Invalid reward period");
    });

    it("should revert if no eligible stakes", async function() {
      // Bob unstakes early -> won't have an eligible stake for period 0
      await ethers.provider.send("evm_increaseTime", [15 * 24 * 3600 + 1]); // 15 days passes
      await ethers.provider.send("evm_mine", []);
      await staking.connect(bob).unstake(0);

      // Fast forward to end
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        staking.connect(bob).claimRewards(0)
      ).to.be.revertedWith("No eligible stakes for rewards");
    });

    it("should allow user to claim rewards only once", async function() {
      // Fast forward to end the period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      // totalWeights is automatically updated:
      // Alice => 1000 tokens * multiplier=1 => weight=1000
      // Bob   => 1000 tokens * multiplier=2 => weight=2000 => total=3000

      // Claim once
      await staking.connect(alice).claimRewards(0);

      // Claim again
      await expect(
        staking.connect(alice).claimRewards(0)
      ).to.be.revertedWith("Rewards claimed for this period");
    });

    it("should allow user to claim rewards in the next cycle when eligibility threshold exceeds current reward period end time", async function () {
      // Move close to the end of the first reward period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS - 9 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);
    
      // Charlie stakes for 30 days
      await token.connect(charlie).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(charlie).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);
    
      // 10 more days pass (now total 30 days)
      await ethers.provider.send("evm_increaseTime", [10 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);
    
      // Claiming for period 0:
      // Charlie started ~9 days before period end => threshold=15 days => not eligible
      await expect(staking.connect(charlie).claimRewards(0)).to.be.revertedWith("No eligible stakes for rewards");
    
      // deposit some ETH in period 1
      await staking.connect(owner).depositRewards(1, { value: REWARD_AMOUNT });
    
      // Fast forward entire 30 days of period 1
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS]);
      await ethers.provider.send("evm_mine", []);
    
      // Now Charlie can claim for period 1
      const beforeBalance = await ethers.provider.getBalance(await charlie.getAddress());
      const tx = await staking.connect(charlie).claimRewards(1);
      const receipt = await tx.wait();

      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
      const afterBalance = await ethers.provider.getBalance(await charlie.getAddress());
      const actualReward = afterBalance - beforeBalance + gasUsed;
      // Alice's stakes in period 1 = 0 
      // Bob's weight in period 1 = 1000 * 2(muliplier for 90 days) = 2000
      // Charlie's weight in period 1 = 1000 * 1 = 1000
      // Total Weight in period 1 = 3000
      // Charlie's rewards = 1000 / 3000 = 1/3 * REWARD_AMOUNT
      const expectedReward = REWARD_AMOUNT * 1n / 3n;


      expect(actualReward).to.be.closeTo(expectedReward, ethers.parseEther("0.0001"));
    });

    it("should correctly calculate rewards for users with different lock-in periods", async function () {
      // End the current period
      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);
    
      // Alice: 1000 tokens * multiplier 1 = 1000 weight
      // Bob: 1000 tokens * multiplier 2 = 2000 weight
      // Total weight = 3000

      // Alice claims first
      const aliceBefore = await ethers.provider.getBalance(await alice.getAddress());
      const txA = await staking.connect(alice).claimRewards(0);
      const receiptA = await txA.wait();

      const gasUsedA = receiptA!.gasUsed * receiptA!.gasPrice!;
      const aliceAfter = await ethers.provider.getBalance(await alice.getAddress());
      const aliceActual = aliceAfter - aliceBefore + gasUsedA;
      const aliceExpected = REWARD_AMOUNT * 1n / 3n; // ~3.3333

      expect(aliceActual).to.be.closeTo(aliceExpected, ethers.parseEther("0.0001"));

      // Now Bob claims. The contract subtracts 1000 weight from totalWeight => left=2000
      // So Bob gets full remainder => 6.666...
      const bobBefore = await ethers.provider.getBalance(await bob.getAddress());
      const txB = await staking.connect(bob).claimRewards(0);
      const receiptB = await txB.wait();

      const gasUsedB = receiptB!.gasUsed * receiptB!.gasPrice!;
      const bobAfter = await ethers.provider.getBalance(await bob.getAddress());
      const bobActual = bobAfter - bobBefore + gasUsedB;
      const bobExpected = REWARD_AMOUNT - aliceExpected;

      expect(bobActual).to.be.closeTo(bobExpected, ethers.parseEther("0.0001"));
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
        // deposit in the newly created period
        await staking.connect(owner).depositRewards(i + 1, { value: REWARD_AMOUNT });
      }

      const currentIndex = await staking.rewardPeriodIndex();
      expect(currentIndex).to.equal(3);
    });

    it("should revert if owner tries to deposit 0 ETH", async function() {
      await expect(staking.connect(owner).depositRewards(0))
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
  
    it("should correctly calculate weights for overlapping stakes", async function () {
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT * 2n);

      // Alice stakes twice
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_90_DAYS);

      const totalWeight = await staking.totalWeights(0);
      // Weight: 1000 (30 days) + 2000 (90 days multiplier)
      expect(totalWeight).to.equal(STAKE_AMOUNT + STAKE_AMOUNT * 2n); // 1000n + 2000n
    });

    it("should revert unstaking with invalid index", async function () {
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);

      await expect(staking.connect(alice).unstake(1)).to.be.revertedWith("Invalid stake index");
    });

    it("should calculate total weights correctly after multiple reward periods", async function () {
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_90_DAYS);

      await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      // Transition to a new period
      await staking.connect(owner).depositRewards(1, { value: REWARD_AMOUNT });

      const totalWeightPeriod0 = await staking.totalWeights(0);
      const totalWeightPeriod1 = await staking.totalWeights(1);

      // Weight in period 1 should match as the stake spans through it
      expect(totalWeightPeriod1).to.equal(totalWeightPeriod0);
    });

    it("should allow smallest valid stake amount", async function () {
      const smallAmount = ethers.parseEther("0.0001");

      await token.connect(alice).approve(await staking.getAddress(), smallAmount);
      await expect(staking.connect(alice).stake(smallAmount, LOCKIN_30_DAYS)).to.emit(staking, "Staked");

      const userStakes = await staking.getUserStakes(await alice.getAddress());
      expect(userStakes[0].amount).to.equal(smallAmount);
    });

    it("should correctly transition reward periods multiple times", async function () {
      // Advance through 3 reward periods
      for (let i = 0; i < 3; i++) {
        await ethers.provider.send("evm_increaseTime", [LOCKIN_30_DAYS + 1]);
        await ethers.provider.send("evm_mine", []);
        await staking.connect(owner).depositRewards(i + 1, { value: REWARD_AMOUNT });
      }

      const currentPeriodIndex = await staking.rewardPeriodIndex();
      expect(currentPeriodIndex).to.equal(3);
    });

    it("should handle eligibility threshold correctly during staking", async function () {
      const newThreshold = 10 * 24 * 3600; // 10 days
      await staking.connect(owner).setEligibilityThreshold(newThreshold);

      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);

      const stakeData = await staking.getUserStakes(await alice.getAddress());
      expect(stakeData[0].eligibilityThresholdAtStake).to.equal(newThreshold);
    });

    it("should revert if unstaking already withdrawn stake", async function () {
      await token.connect(alice).approve(await staking.getAddress(), STAKE_AMOUNT);
      await staking.connect(alice).stake(STAKE_AMOUNT, LOCKIN_30_DAYS);

      await staking.connect(alice).unstake(0);

      await expect(staking.connect(alice).unstake(0)).to.be.revertedWith("Already withdrawn");
    });
  });

});
