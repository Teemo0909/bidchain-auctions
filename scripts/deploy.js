const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const auction = await hre.ethers.deployContract("BidChainAuction");
  await auction.waitForDeployment();
  const address = await auction.getAddress();
  const { chainId } = await hre.ethers.provider.getNetwork();

  console.log("BidChainAuction deployed to:", address);
  console.log("Tx hash:", auction.deploymentTransaction().hash);

  // อัปเดต address ให้หน้าเว็บอัตโนมัติ
  const cfgPath = path.join(__dirname, "..", "docs", "config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/CONTRACT_ADDRESS:\s*"[^"]*"/, `CONTRACT_ADDRESS: "${address}"`);
  cfg = cfg.replace(/CHAIN_ID:\s*\d+/, `CHAIN_ID: ${chainId}`);
  const receipt = await auction.deploymentTransaction().wait();
  cfg = cfg.replace(/DEPLOY_BLOCK:\s*\d+/, `DEPLOY_BLOCK: ${receipt.blockNumber}`);
  fs.writeFileSync(cfgPath, cfg);
  console.log("Updated docs/config.js");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
