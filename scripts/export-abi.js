// คัดลอก ABI ล่าสุดไปให้หน้าเว็บ (รันหลัง npx hardhat compile)
const fs = require("fs");
const a = require("../artifacts/contracts/BidChainAuction.sol/BidChainAuction.json");
fs.writeFileSync(
  __dirname + "/../docs/abi.js",
  "// สร้างจาก artifacts/contracts/BidChainAuction.sol/BidChainAuction.json (npm run abi)\nwindow.AUCTION_ABI = " + JSON.stringify(a.abi) + ";\n"
);
console.log("docs/abi.js updated");
