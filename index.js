const { Connection, Keypair, PublicKey } = require("@solana/web3.js")
const bs58 = require("bs58")
const axios = require("axios")

// ENV
const PRIVATE_KEY = process.env.PRIVATE_KEY
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
const AMOUNT_SOL = parseFloat(process.env.AMOUNT_SOL || "0.01")

const connection = new Connection(RPC_URL)

// WALLET
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))

console.log("✅ Wallet loaded:", wallet.publicKey.toBase58())

// 🔍 GET TOKENS FROM DEXSCREENER
async function getTrending() {
  const res = await axios.get("https://api.dexscreener.com/latest/dex/search?q=solana")
  return res.data.pairs.slice(0, 5)
}

// 🚀 JUPITER SWAP
async function swap(tokenAddress) {
  try {
    console.log("🔄 Attempting trade:", tokenAddress)

    const quote = await axios.get(`https://quote-api.jup.ag/v6/quote`, {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: tokenAddress,
        amount: AMOUNT_SOL * 1e9,
        slippageBps: 500
      }
    })

    if (!quote.data.data || quote.data.data.length === 0) {
      console.log("❌ No route")
      return
    }

    console.log("✅ Found route")

    // NOTE: this just logs for now
    // real execution needs signed tx (next step)
  } catch (e) {
    console.log("❌ Trade error:", e.message)
  }
}

// 🔁 LOOP
async function runBot() {
  while (true) {
    console.log("🔍 Scanning...")

    const tokens = await getTrending()

    for (let t of tokens) {
      await swap(t.baseToken.address)
    }

    await new Promise(r => setTimeout(r, 15000))
  }
}

runBot()
