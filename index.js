const { Connection, Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const axios = require("axios");

// ENV VARIABLES
const RPC = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AMOUNT_SOL = parseFloat(process.env.SWAP_AMOUNT || "0.01");

// CONNECT
const connection = new Connection(RPC, "confirmed");

// LOAD WALLET
let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log("✅ Wallet loaded:", wallet.publicKey.toBase58());
} catch (err) {
  console.error("❌ Invalid private key");
  process.exit(1);
}

// CHECK BALANCE
async function checkBalance() {
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("💰 Balance:", balance / 1e9, "SOL");
}

// 🔍 GET TRENDING TOKENS (DEXSCREENER)
async function getTrending() {
  try {
    const res = await axios.get("https://api.dexscreener.com/latest/dex/pairs/solana");
    return res.data.pairs.slice(0, 20);
  } catch (err) {
    console.log("❌ Error fetching tokens");
    return [];
  }
}

// 🛡️ FILTER BAD TOKENS (ANTI-RUG BASIC)
function isSafe(pair) {
  return (
    pair.liquidity?.usd > 20000 &&      // enough liquidity
    pair.volume?.h24 > 10000 &&         // real activity
    pair.priceChange?.h1 > 0 &&         // upward momentum
    pair.txns?.h24?.buys > pair.txns?.h24?.sells // more buyers
  );
}

// 🧠 PICK BEST TOKEN
async function pickToken() {
  const pairs = await getTrending();
  const safe = pairs.filter(isSafe);

  if (safe.length === 0) return null;

  safe.sort((a, b) => b.volume.h24 - a.volume.h24);

  return safe[0];
}

// 💰 TRADE LOGIC (SIMULATION FOR NOW)
async function trade() {
  console.log("🔍 Scanning market...");

  const token = await pickToken();

  if (!token) {
    console.log("⚠️ No safe tokens found");
    return;
  }

  console.log("🚀 Trade Opportunity Found:");
  console.log("Token:", token.baseToken.symbol);
  console.log("Price:", token.priceUsd);
  console.log("Liquidity:", token.liquidity.usd);
  console.log("Volume:", token.volume.h24);

  // 🚨 SIMULATION ONLY
  console.log(`💡 Would buy ${AMOUNT_SOL} SOL worth of ${token.baseToken.symbol}`);
}

// 🔁 LOOP EVERY 30 SECONDS
async function startBot() {
  await checkBalance();

  setInterval(async () => {
    try {
      await trade();
    } catch (err) {
      console.log("❌ Error in loop:", err.message);
    }
  }, 30000);
}

startBot();
