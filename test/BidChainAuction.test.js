const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const S = { Live: 0, AwaitingPayment: 1, Settled: 2, ReserveNotMet: 3, NoBids: 4, Defaulted: 5, Cancelled: 6 };
const E = (v) => ethers.parseEther(v);
const DAY = 86400;
const input = (title, start, reserve, inc, dep, endTime, win) => ({
  title, description: "Oil on canvas", imageURI: "gen:7",
  startPrice: typeof start === "bigint" ? start : E(start), reservePrice: typeof reserve === "bigint" ? reserve : E(reserve),
  minIncrement: typeof inc === "bigint" ? inc : E(inc), deposit: typeof dep === "bigint" ? dep : E(dep), endTime, paymentWindow: win,
});

describe("BidChainAuction", function () {
  let c, platform, seller, alice, bob, carol;

  // start 1 ETH, reserve 2 ETH, increment 0.1, deposit 0.2, 1 day, pay within 1 day
  async function newAuction(over = {}) {
    const p = { start: "1", reserve: "2", inc: "0.1", dep: "0.2", dur: DAY, win: DAY, ...over };
    const end = (await time.latest()) + p.dur;
    await c.connect(seller).createAuction(input("Golden Hour", p.start, p.reserve, p.inc, p.dep, end, p.win));
    return await c.auctionCount();
  }

  // ยอดเงินทั้งหมดใน contract ต้องเท่ากับ ยอดรอถอน + ค่าธรรมเนียม + มัดจำที่ล็อกอยู่
  async function expectBalanced(actors) {
    let pending = 0n;
    for (const a of actors) pending += await c.pendingWithdrawals(a.address ?? a);
    let held = 0n;
    const n = await c.auctionCount();
    for (let i = 1n; i <= n; i++) {
      const a = await c.getAuction(i);
      if ((a.status == S.Live && a.bidCount > 0n) || a.status == S.AwaitingPayment) held += a.deposit;
    }
    const bal = await ethers.provider.getBalance(await c.getAddress());
    expect(bal).to.equal(pending + (await c.feesAccrued()) + held);
  }

  beforeEach(async () => {
    [platform, seller, alice, bob, carol] = await ethers.getSigners();
    c = await (await ethers.getContractFactory("BidChainAuction")).deploy();
  });

  it("1) สร้างรายการประมูลพร้อมเงื่อนไขครบ และตรวจข้อมูลไม่ถูกต้อง", async () => {
    const id = await newAuction();
    const a = await c.getAuction(id);
    expect(a.seller).to.equal(seller.address);
    expect(a.reservePrice).to.equal(E("2"));
    expect(a.deposit).to.equal(E("0.2"));
    expect(a.status).to.equal(S.Live);
    const now = await time.latest();
    await expect(c.connect(seller).createAuction(input("x", "1", "0.5", 1n, "0.1", now + DAY, DAY))).to.be.revertedWith("Reserve must be >= start price");
    await expect(c.connect(seller).createAuction(input("x", "1", "1", 1n, "2", now + DAY, DAY))).to.be.revertedWith("Deposit must be 0 < deposit <= start price");
    await expect(c.connect(seller).createAuction(input("x", "1", "1", 1n, "0.1", now + 10, DAY))).to.be.revertedWith("Auction must last >= 60s");
  });

  it("2) วางราคาต้องแนบมัดจำพอดี ต้องไม่ต่ำกว่าราคาเริ่ม/ขั้นต่ำ และผู้ขายห้ามประมูลเอง", async () => {
    const id = await newAuction();
    await expect(c.connect(seller).placeBid(id, E("1"), { value: E("0.2") })).to.be.revertedWith("Seller cannot bid");
    await expect(c.connect(alice).placeBid(id, E("0.9"), { value: E("0.2") })).to.be.revertedWith("Bid below start price");
    await expect(c.connect(alice).placeBid(id, E("1"), { value: E("0.1") })).to.be.revertedWith("Must send exact deposit");
    await expect(c.connect(alice).placeBid(id, E("1"), { value: E("0.2") })).to.emit(c, "BidPlaced").withArgs(id, alice.address, E("1"), E("0.2"));
    await expect(c.connect(bob).placeBid(id, E("1.05"), { value: E("0.2") })).to.be.revertedWith("Bid below minimum increment");
    // ผู้นำขึ้นราคาตัวเองได้โดยไม่ต้องวางมัดจำซ้ำ
    await expect(c.connect(alice).placeBid(id, E("1.2"), { value: E("0.2") })).to.be.revertedWith("Deposit already held");
    await c.connect(alice).placeBid(id, E("1.2"));
    expect((await c.getAuction(id)).highestBid).to.equal(E("1.2"));
    expect((await c.getBids(id)).length).to.equal(2);
  });

  it("3-4) ผู้ถูกแซงได้ยอดคืนทันที ถอนได้ตลอดเวลา แต่ผู้นำถอนไม่ได้", async () => {
    const id = await newAuction();
    await c.connect(alice).placeBid(id, E("1"), { value: E("0.2") });
    await expect(c.connect(bob).placeBid(id, E("1.1"), { value: E("0.2") })).to.emit(c, "OutbidCredited").withArgs(id, alice.address, E("0.2"));
    expect(await c.pendingWithdrawals(alice.address)).to.equal(E("0.2"));
    await expect(c.connect(bob).withdraw()).to.be.revertedWith("Nothing to withdraw"); // ผู้นำถอนไม่ได้
    await expect(c.connect(alice).withdraw()).to.changeEtherBalances([alice, c], [E("0.2"), -E("0.2")]); // ถอนได้ระหว่างประมูล
    await expect(c.connect(alice).withdraw()).to.be.revertedWith("Nothing to withdraw"); // ถอนซ้ำไม่ได้
    await expectBalanced([alice, bob, seller]);
  });

  it("5-6) ปิดประมูลถึง Reserve → ผู้ชนะจ่ายส่วนที่เหลือ → หัก 2.5% ผู้ขายได้ส่วนที่เหลือ", async () => {
    const id = await newAuction();
    await c.connect(alice).placeBid(id, E("1"), { value: E("0.2") });
    await c.connect(bob).placeBid(id, E("2.5"), { value: E("0.2") });
    await expect(c.connect(seller).finalize(id)).to.be.revertedWith("Auction not ended");
    await time.increase(DAY);
    await expect(c.connect(bob).placeBid(id, E("3"))).to.be.revertedWith("Auction ended");
    await expect(c.connect(carol).finalize(id)).to.be.revertedWith("Only seller");
    await expect(c.connect(seller).finalize(id)).to.emit(c, "AuctionFinalized"); // เฉพาะผู้ขายปิดได้
    await expect(c.connect(seller).finalize(id)).to.be.revertedWith("Already finalized");
    expect(await c.remainingDue(id)).to.equal(E("2.3"));
    await expect(c.connect(alice).completePayment(id, { value: E("2.3") })).to.be.revertedWith("Only winner");
    await expect(c.connect(bob).completePayment(id, { value: E("2.5") })).to.be.revertedWith("Must pay exact remaining amount");
    await expect(c.connect(bob).completePayment(id, { value: E("2.3") }))
      .to.emit(c, "PaymentSettled").withArgs(id, bob.address, E("2.5"), E("0.0625"), E("2.4375"));
    await expect(c.connect(bob).completePayment(id, { value: E("2.3") })).to.be.revertedWith("Not awaiting payment"); // จ่ายซ้ำไม่ได้
    await expect(c.connect(seller).withdraw()).to.changeEtherBalance(seller, E("2.4375"));
    await expect(c.connect(platform).withdrawFees(platform.address)).to.changeEtherBalance(platform, E("0.0625"));
    await c.connect(alice).withdraw();
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0); // จ่ายออกเท่ากับที่รับเข้าพอดี
  });

  it("5-6) ไม่ถึง Reserve → คืนมัดจำผู้ประมูลสูงสุดเต็มจำนวน ไม่มีค่าธรรมเนียม", async () => {
    const id = await newAuction();
    await c.connect(alice).placeBid(id, E("1.5"), { value: E("0.2") });
    await time.increase(DAY);
    await c.connect(seller).finalize(id);
    expect((await c.getAuction(id)).status).to.equal(S.ReserveNotMet);
    expect(await c.pendingWithdrawals(alice.address)).to.equal(E("0.2"));
    expect(await c.feesAccrued()).to.equal(0);
    await expect(c.connect(seller).withdraw()).to.be.revertedWith("Nothing to withdraw");
    await expectBalanced([alice, seller]);
  });

  it("อัปเดต: ผู้ชนะไม่จ่ายภายในกำหนด → ยึดมัดจำให้ผู้ขาย (หัก 2.5%)", async () => {
    const id = await newAuction({ win: 3600 });
    await c.connect(alice).placeBid(id, E("2"), { value: E("0.2") });
    await time.increase(DAY);
    await c.connect(seller).finalize(id);
    await expect(c.claimForfeit(id)).to.be.revertedWith("Payment window still open");
    await time.increase(3601);
    await expect(c.connect(alice).completePayment(id, { value: E("1.8") })).to.be.revertedWith("Payment deadline passed");
    await expect(c.connect(carol).claimForfeit(id)).to.emit(c, "DepositForfeited").withArgs(id, alice.address, E("0.2"), E("0.005"), E("0.195"));
    expect((await c.getAuction(id)).status).to.equal(S.Defaulted);
    expect(await c.pendingWithdrawals(alice.address)).to.equal(0); // ผู้ชนะที่ผิดนัดไม่ได้มัดจำคืน
    await expect(c.claimForfeit(id)).to.be.revertedWith("Not awaiting payment");
    await expectBalanced([alice, seller]);
  });

  it("ค่าธรรมเนียมปัดเศษลง และ fee + ยอดผู้ขาย = ยอดรวมพอดี (ไม่มีเศษหาย)", async () => {
    for (const amt of [1n, 39n, 40n, 41n, 12345678901234567n, E("1.000000000000000003")]) {
      const [fee, net] = await c.feeOf(amt);
      expect(fee).to.equal((amt * 250n) / 10000n);
      expect(fee + net).to.equal(amt);
    }
  });

  it("wallet ที่ปฏิเสธรับเงินขัดขวางผู้ประมูลคนอื่นไม่ได้ (pull payment)", async () => {
    const id = await newAuction();
    const evil = await (await ethers.getContractFactory("RejectingBidder")).deploy();
    await evil.bid(await c.getAddress(), id, E("1"), { value: E("0.2") });
    // มีคนแซงได้ตามปกติ แม้ผู้ถูกแซงจะรับเงินไม่ได้
    await c.connect(alice).placeBid(id, E("1.1"), { value: E("0.2") });
    expect(await c.pendingWithdrawals(await evil.getAddress())).to.equal(E("0.2"));
    await expect(evil.tryWithdraw(await c.getAddress())).to.be.revertedWith("Transfer failed"); // เสียหายแค่ตัวเอง
    expect(await c.pendingWithdrawals(await evil.getAddress())).to.equal(E("0.2")); // ยอดยังอยู่ ไม่หาย
    await time.increase(DAY);
    await c.connect(seller).finalize(id);
    expect((await c.getAuction(id)).status).to.equal(S.ReserveNotMet);
    await expect(c.connect(alice).withdraw()).to.changeEtherBalance(alice, E("0.2"));
  });

  it("ไม่มีผู้ประมูล → NoBids, ยกเลิกได้เฉพาะก่อนมีผู้ประมูล, ปฏิเสธ ETH ที่โอนตรง", async () => {
    const id1 = await newAuction();
    await time.increase(DAY);
    await expect(c.connect(carol).finalize(id1)).to.be.revertedWith("Only seller");
    await time.increase(DAY); // ผู้ขายไม่ปิดเกิน 1 วัน → คนอื่นปิดแทนได้
    await c.connect(carol).finalize(id1);
    expect((await c.getAuction(id1)).status).to.equal(S.NoBids);
    const id2 = await newAuction();
    await expect(c.connect(alice).cancelAuction(id2)).to.be.revertedWith("Only seller");
    await c.connect(seller).cancelAuction(id2);
    await expect(c.connect(alice).placeBid(id2, E("1"), { value: E("0.2") })).to.be.revertedWith("Auction not live");
    const id3 = await newAuction();
    await c.connect(alice).placeBid(id3, E("1"), { value: E("0.2") });
    await expect(c.connect(seller).cancelAuction(id3)).to.be.revertedWith("Already has bids");
    const id4 = await newAuction();
    await time.increase(DAY * 2); // เลยเวลาปิด + grace ของ finalize แล้ว คนอื่นก็ยังยกเลิกไม่ได้
    await expect(c.connect(alice).cancelAuction(id4)).to.be.revertedWith("Only seller");
    await expect(alice.sendTransaction({ to: await c.getAddress(), value: 1 })).to.be.revertedWith("Use placeBid()");
  });

  it("bid ในนาทีสุดท้ายต่อเวลาให้เหลือ 60 วิ, bid ก่อนหน้านั้นไม่ต่อ", async () => {
    const id = await newAuction();
    const end0 = (await c.getAuction(id)).endTime;
    await c.connect(alice).placeBid(id, E("1"), { value: E("0.2") });
    expect((await c.getAuction(id)).endTime).to.equal(end0); // ยังไม่ถึงนาทีสุดท้าย
    await time.increaseTo(end0 - 10n);
    await c.connect(bob).placeBid(id, E("1.1"), { value: E("0.2") });
    const end1 = (await c.getAuction(id)).endTime;
    expect(end1).to.equal(BigInt(await time.latest()) + 60n);
    await time.increaseTo(end0 + 5n); // เลยเวลาเดิมแล้วแต่ยังประมูลได้
    await c.connect(alice).placeBid(id, E("1.2"), { value: E("0.2") });
    await time.increaseTo((await c.getAuction(id)).endTime);
    await expect(c.connect(bob).placeBid(id, E("1.3"), { value: E("0.2") })).to.be.revertedWith("Auction ended");
  });

  it("ผู้ถอนค่าธรรมเนียมได้เฉพาะ owner", async () => {
    await expect(c.connect(alice).withdrawFees(alice.address)).to.be.revertedWith("Only owner");
    await expect(c.connect(platform).withdrawFees(platform.address)).to.be.revertedWith("No fees");
  });

  it("สถานการณ์จำลองหลายงาน: เงินใน contract ตรงกับยอดที่ควรมีทุกขั้น", async () => {
    const a1 = await newAuction();
    const a2 = await newAuction({ win: 3600 });
    const a3 = await newAuction();
    await c.connect(alice).placeBid(a1, E("1"), { value: E("0.2") });
    await c.connect(bob).placeBid(a1, E("2"), { value: E("0.2") });
    await c.connect(carol).placeBid(a1, E("2.2"), { value: E("0.2") });
    await c.connect(alice).placeBid(a2, E("3"), { value: E("0.2") });
    await c.connect(bob).placeBid(a3, E("1.2"), { value: E("0.2") });
    const actors = [platform, seller, alice, bob, carol];
    await expectBalanced(actors);
    await time.increase(DAY);
    await c.connect(seller).finalize(a1); await c.connect(seller).finalize(a2); await c.connect(seller).finalize(a3);
    await expectBalanced(actors);
    await c.connect(carol).completePayment(a1, { value: E("2") });
    await time.increase(3601);
    await c.claimForfeit(a2);
    await expectBalanced(actors);
    for (const s of [seller, alice, bob]) if ((await c.pendingWithdrawals(s.address)) > 0n) await c.connect(s).withdraw();
    await c.connect(platform).withdrawFees(platform.address);
    // a1 ยังค้างจ่ายครบแล้ว; ทุกคนถอนครบ → contract ต้องเหลือ 0
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0);
  });
});
