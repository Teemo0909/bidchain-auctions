// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBidChainAuction {
    function placeBid(uint256 id, uint256 amount) external payable;
    function withdraw() external;
}

/// @dev ใช้ในการทดสอบเท่านั้น: wallet ที่ "ปฏิเสธรับเงิน" เพื่อพิสูจน์ว่าขัดขวางผู้ประมูลคนอื่นไม่ได้
contract RejectingBidder {
    function bid(address auction, uint256 id, uint256 amount) external payable {
        IBidChainAuction(auction).placeBid{value: msg.value}(id, amount);
    }

    function tryWithdraw(address auction) external {
        IBidChainAuction(auction).withdraw();
    }

    receive() external payable {
        revert("I reject ETH");
    }
}
