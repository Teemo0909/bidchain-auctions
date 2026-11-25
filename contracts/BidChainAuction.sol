// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  BidChainAuction
 * @notice ระบบประมูลสินค้าและคืนเงินผู้แพ้ประมูล (Auction & Bid Refund Platform) — BidChain Gallery
 *
 *  โมเดล "มัดจำ" (Deposit):
 *    - ผู้ประมูลต้องวางมัดจำตามที่ผู้ขายกำหนด (ครั้งเดียวต่อการเป็นผู้นำ) จึงจะเสนอราคาได้
 *    - เมื่อถูกแซง มัดจำของผู้ประมูลคนก่อนถูก "บันทึกเป็นยอดคืน" ทันที และถอนได้ตลอดเวลา (pull payment)
 *    - ปิดประมูลแล้วถ้าถึง Reserve Price ผู้ชนะต้องจ่าย "ส่วนที่เหลือ" (ราคาชนะ - มัดจำ) ภายในเวลาที่กำหนด
 *    - ถ้าผู้ชนะไม่จ่ายภายในกำหนด มัดจำถูกยึด → ผู้ขายได้รับ (หักค่าธรรมเนียม 2.5%)
 *    - ถ้าไม่ถึง Reserve Price ผู้ประมูลสูงสุดได้มัดจำคืนเต็มจำนวน
 *
 *  Flow สถานะ:
 *    Live --finalize--> AwaitingPayment --completePayment--> Settled
 *                                       --claimForfeit-----> Defaulted   (ผู้ชนะไม่จ่าย ยึดมัดจำ)
 *    Live --finalize--> ReserveNotMet  (คืนมัดจำผู้ประมูลสูงสุด)
 *    Live --finalize--> NoBids
 *    Live --cancelAuction (ยังไม่มีคนประมูล)--> Cancelled
 *
 *  กฎทางธุรกิจ:
 *    - ผู้ขายห้ามประมูลสินค้าตนเอง
 *    - ผู้ชนะ (ผู้นำปัจจุบัน) ถอนมัดจำไม่ได้ — มัดจำของผู้นำไม่เคยถูกบันทึกเป็นยอดถอน
 *    - ปิดประมูล / จ่ายเงิน / ยึดมัดจำ ทำได้ครั้งเดียว (ตรวจสถานะทุกครั้ง)
 *    - ทุกการจ่ายเงินออกเป็นแบบ pull (withdraw) → wallet ที่ปฏิเสธรับเงินขัดขวางคนอื่นไม่ได้
 *    - ค่าธรรมเนียมปัดเศษลง ผู้ขายได้ส่วนที่เหลือ → fee + sellerAmount = เงินที่รับเข้ามาพอดี ไม่มีเศษหาย
 */
contract BidChainAuction {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    enum Status {
        Live,            // 0 เปิดรับประมูล (หรือหมดเวลาแล้วแต่ยังไม่มีใครเรียกปิด)
        AwaitingPayment, // 1 ปิดแล้ว ถึง Reserve รอผู้ชนะชำระส่วนที่เหลือ
        Settled,         // 2 ชำระครบ โอนให้ผู้ขาย (หักค่าธรรมเนียม) แล้ว
        ReserveNotMet,   // 3 ไม่ถึง Reserve คืนมัดจำผู้ประมูลสูงสุด
        NoBids,          // 4 ไม่มีผู้ประมูล
        Defaulted,       // 5 ผู้ชนะไม่ชำระ ยึดมัดจำ
        Cancelled        // 6 ผู้ขายยกเลิกก่อนมีผู้ประมูล
    }

    struct Auction {
        uint256 id;
        address seller;
        string title;
        string description;
        string imageURI;        // URL รูป หรือ "gen:<seed>" สำหรับภาพ generative บนหน้าเว็บ
        uint256 startPrice;     // ราคาเริ่มต้น (wei)
        uint256 reservePrice;   // ราคาขั้นต่ำที่ยอมขาย (wei)
        uint256 minIncrement;   // ขั้นต่ำของการเพิ่มราคา (wei)
        uint256 deposit;        // มัดจำที่ต้องวางเพื่อประมูล (wei)
        uint256 endTime;        // เวลาปิดประมูล (unix)
        uint256 paymentWindow;  // ระยะเวลาให้ผู้ชนะชำระหลังปิดประมูล (วินาที)
        uint256 paymentDeadline;
        address highestBidder;
        uint256 highestBid;
        uint256 bidCount;
        Status status;
        uint256 createdAt;
    }

    struct Bid {
        address bidder;
        uint256 amount;
        uint256 time;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------
    uint256 public constant FEE_BPS = 250; // 2.5%
    uint256 public constant BPS = 10_000;

    address public owner;
    uint256 public feesAccrued;
    uint256 public auctionCount;

    mapping(uint256 => Auction) private auctions;
    mapping(uint256 => Bid[]) private bidHistory;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public constant FINALIZE_GRACE = 1 days;
    uint256 public constant EXTEND_WINDOW = 60; // bid ในนาทีสุดท้าย → ต่อเวลาให้เหลือ 60 วิ (กัน sniping)

    uint256 private locked = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event AuctionCreated(uint256 indexed auctionId, address indexed seller, string title, uint256 startPrice, uint256 reservePrice, uint256 deposit, uint256 endTime);
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 depositPaid);
    event OutbidCredited(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionFinalized(uint256 indexed auctionId, Status status, address winner, uint256 highestBid);
    event PaymentSettled(uint256 indexed auctionId, address indexed winner, uint256 total, uint256 fee, uint256 sellerAmount);
    event DepositRefunded(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event DepositForfeited(uint256 indexed auctionId, address indexed winner, uint256 amount, uint256 fee, uint256 sellerAmount);
    event AuctionCancelled(uint256 indexed auctionId);
    event Withdrawn(address indexed account, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier nonReentrant() {
        require(locked == 1, "Reentrant call");
        locked = 2;
        _;
        locked = 1;
    }

    modifier auctionExists(uint256 id) {
        require(id > 0 && id <= auctionCount, "Auction not found");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ------------------------------------------------------------------
    // 1. Create Auction
    // ------------------------------------------------------------------
    /// @notice ข้อมูลที่ผู้ขายกรอกตอนสร้างรายการประมูล
    struct AuctionInput {
        string title;
        string description;
        string imageURI;
        uint256 startPrice;
        uint256 reservePrice;
        uint256 minIncrement;
        uint256 deposit;
        uint256 endTime;
        uint256 paymentWindow;
    }

    function createAuction(AuctionInput calldata p) external returns (uint256 id) {
        require(bytes(p.title).length > 0, "Title required");
        require(p.startPrice > 0, "Start price must be > 0");
        require(p.reservePrice >= p.startPrice, "Reserve must be >= start price");
        require(p.minIncrement > 0, "Increment must be > 0");
        require(p.deposit > 0 && p.deposit <= p.startPrice, "Deposit must be 0 < deposit <= start price");
        require(p.endTime >= block.timestamp + 60, "Auction must last >= 60s");
        require(p.endTime <= block.timestamp + 60 days, "Auction too long");
        require(p.paymentWindow >= 60 && p.paymentWindow <= 30 days, "Payment window 60s - 30 days");

        id = ++auctionCount;
        Auction storage a = auctions[id];
        a.id = id;
        a.seller = msg.sender;
        a.title = p.title;
        a.description = p.description;
        a.imageURI = p.imageURI;
        a.startPrice = p.startPrice;
        a.reservePrice = p.reservePrice;
        a.minIncrement = p.minIncrement;
        a.deposit = p.deposit;
        a.endTime = p.endTime;
        a.paymentWindow = p.paymentWindow;
        a.status = Status.Live;
        a.createdAt = block.timestamp;

        emit AuctionCreated(id, msg.sender, p.title, p.startPrice, p.reservePrice, p.deposit, p.endTime);
    }

    /// @notice ผู้ขายยกเลิกได้เฉพาะเมื่อยังไม่มีผู้ประมูล
    function cancelAuction(uint256 id) external auctionExists(id) {
        Auction storage a = auctions[id];
        require(msg.sender == a.seller, "Only seller");
        require(a.status == Status.Live, "Not live");
        require(a.bidCount == 0, "Already has bids");
        a.status = Status.Cancelled;
        emit AuctionCancelled(id);
    }

    // ------------------------------------------------------------------
    // 2-3. Place Bid (+ credit outbid bidder)
    // ------------------------------------------------------------------
    /**
     * @param amount ราคาที่เสนอ (wei) — ไม่ต้องโอนทั้งก้อน
     * @dev ถ้ายังไม่ใช่ผู้นำ ต้องแนบ msg.value = deposit; ถ้าเป็นผู้นำอยู่แล้ว (ขึ้นราคาตัวเอง) ไม่ต้องแนบเงิน
     */
    function placeBid(uint256 id, uint256 amount) external payable auctionExists(id) {
        Auction storage a = auctions[id];
        require(a.status == Status.Live, "Auction not live");
        require(block.timestamp < a.endTime, "Auction ended");
        require(msg.sender != a.seller, "Seller cannot bid");

        if (a.bidCount == 0) {
            require(amount >= a.startPrice, "Bid below start price");
        } else {
            require(amount >= a.highestBid + a.minIncrement, "Bid below minimum increment");
        }

        address prev = a.highestBidder;
        uint256 depositPaid;
        if (msg.sender == prev) {
            require(msg.value == 0, "Deposit already held");
        } else {
            require(msg.value == a.deposit, "Must send exact deposit");
            depositPaid = msg.value;
            if (prev != address(0)) {
                // 3. บันทึกเงินคืนผู้ถูกแซงทันที (ถอนเองภายหลัง)
                pendingWithdrawals[prev] += a.deposit;
                emit OutbidCredited(id, prev, a.deposit);
            }
        }

        a.highestBidder = msg.sender;
        a.highestBid = amount;
        a.bidCount += 1;
        bidHistory[id].push(Bid(msg.sender, amount, block.timestamp));
        if (a.endTime - block.timestamp < EXTEND_WINDOW) a.endTime = block.timestamp + EXTEND_WINDOW;

        emit BidPlaced(id, msg.sender, amount, depositPaid);
    }

    // ------------------------------------------------------------------
    // 4. Withdraw Refund (pull payment)
    // ------------------------------------------------------------------
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // 5. Finalize Auction
    // ------------------------------------------------------------------
    function finalize(uint256 id) external auctionExists(id) {
        Auction storage a = auctions[id];
        // ผู้ขายปิดได้ทันทีที่หมดเวลา; ถ้าผู้ขายเงียบเกิน 1 วัน ใครก็ปิดได้ กันมัดจำผู้นำค้างตลอดไป
        require(msg.sender == a.seller || block.timestamp >= a.endTime + FINALIZE_GRACE, "Only seller");
        require(a.status == Status.Live, "Already finalized");
        require(block.timestamp >= a.endTime, "Auction not ended");

        if (a.bidCount == 0) {
            a.status = Status.NoBids;
        } else if (a.highestBid < a.reservePrice) {
            a.status = Status.ReserveNotMet;
            pendingWithdrawals[a.highestBidder] += a.deposit;
            emit DepositRefunded(id, a.highestBidder, a.deposit);
        } else {
            a.status = Status.AwaitingPayment;
            a.paymentDeadline = block.timestamp + a.paymentWindow;
        }
        emit AuctionFinalized(id, a.status, a.highestBidder, a.highestBid);
    }

    // ------------------------------------------------------------------
    // 6. Settle Payment
    // ------------------------------------------------------------------
    /// @notice ผู้ชนะชำระส่วนที่เหลือ (highestBid - deposit) → แบ่งค่าธรรมเนียม 2.5% และยอดผู้ขาย
    function completePayment(uint256 id) external payable auctionExists(id) {
        Auction storage a = auctions[id];
        require(a.status == Status.AwaitingPayment, "Not awaiting payment");
        require(msg.sender == a.highestBidder, "Only winner");
        require(block.timestamp <= a.paymentDeadline, "Payment deadline passed");
        require(msg.value == a.highestBid - a.deposit, "Must pay exact remaining amount");

        a.status = Status.Settled;
        uint256 total = a.highestBid; // = deposit ที่ล็อกไว้ + msg.value
        (uint256 fee, uint256 sellerAmount) = _split(total);
        feesAccrued += fee;
        pendingWithdrawals[a.seller] += sellerAmount;

        emit PaymentSettled(id, msg.sender, total, fee, sellerAmount);
    }

    /// @notice เลยกำหนดชำระแล้วผู้ชนะยังไม่จ่าย → ใครก็ได้เรียกเพื่อยึดมัดจำให้ผู้ขาย
    function claimForfeit(uint256 id) external auctionExists(id) {
        Auction storage a = auctions[id];
        require(a.status == Status.AwaitingPayment, "Not awaiting payment");
        require(block.timestamp > a.paymentDeadline, "Payment window still open");

        a.status = Status.Defaulted;
        (uint256 fee, uint256 sellerAmount) = _split(a.deposit);
        feesAccrued += fee;
        pendingWithdrawals[a.seller] += sellerAmount;

        emit DepositForfeited(id, a.highestBidder, a.deposit, fee, sellerAmount);
    }

    function withdrawFees(address to) external nonReentrant {
        require(msg.sender == owner, "Only owner");
        require(to != address(0), "Invalid address");
        uint256 amount = feesAccrued;
        require(amount > 0, "No fees");
        feesAccrued = 0;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Transfer failed");
        emit FeesWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------
    // 7. Dashboard views
    // ------------------------------------------------------------------
    function getAuction(uint256 id) external view auctionExists(id) returns (Auction memory) {
        return auctions[id];
    }

    function getBids(uint256 id) external view auctionExists(id) returns (Bid[] memory) {
        return bidHistory[id];
    }

    /// @notice ยอดที่ต้องจ่ายเพิ่มของผู้ชนะ
    function remainingDue(uint256 id) external view auctionExists(id) returns (uint256) {
        Auction storage a = auctions[id];
        return a.status == Status.AwaitingPayment ? a.highestBid - a.deposit : 0;
    }

    function feeOf(uint256 amount) external pure returns (uint256 fee, uint256 net) {
        return _split(amount);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------
    /// @dev ค่าธรรมเนียมปัดลง ส่วนเศษตกเป็นของผู้ขาย → fee + net == amount เสมอ
    function _split(uint256 amount) private pure returns (uint256 fee, uint256 net) {
        fee = (amount * FEE_BPS) / BPS;
        net = amount - fee;
    }

    receive() external payable {
        revert("Use placeBid()");
    }
}
