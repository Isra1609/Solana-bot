const { Connection, Keypair } = require("@solana/web3.js")
const bs58 = require("bs58")
const axios = require("axios")

// ===== ENV VARIABLES =====
const PRIVATE_KEY = process.env.PRIVATE_KEY
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
const AMOUNT_SOL = parseFloat(process.env.AMOUNT_SOL || "0.01")

// ===== CONNECTION =====
const connection = new Connection(RPC_URL)

// ===== WALLET =====
let wallet

try {
  if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY")

  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))
  console.log("✅ Wallet loaded:", wallet.publicKey.toBase58())

} catch (err) {
  console.log("❌ Wallet error:", err.message)
  process.exit(1)
}

// ===== GET TRENDING TOKENS =====
async function getTrending() {
  try {
    const res = await axios.get(
      "https://api.dexscreener.com/latest/dex/search?q=solana"
    )

    return res.data.pairs.slice(0, 5)

  } catch (err) {
    console.log("❌ Dexscreener error:", err.message)
    return []
  }
}

// ===== JUPITER QUOTE =====
async function getQuote(tokenAddress) {
  try {
    console.log("🔄 Attempting trade:", tokenAddress)

    const res = await axios.get("https://api.jup.ag/v6/quote", {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: tokenAddress,
        amount: AMOUNT_SOL * 1e9,
        slippageBps: 500
      }
    })

    if (!res.data.data || res.data.data.length === 0) {
      console.log("❌ No route found")
      return null
    }

    console.log("✅ Found route")
    return res.data.data[0]

  } catch (err) {
    console.log("❌ Quote error:", err.message)
    return null
  }
}

// ===== MAIN LOOP =====
async function runBot() {
  while (true) {
    try {
      console.log("🔍 Scanning...")

      const tokens = await getTrending()

      for (let t of tokens) {
        if (!t?.baseToken?.address) continue

        await getQuote(t.baseToken.address)
      }

      await new Promise(r => setTimeout(r, 15000))

    } catch (err) {
      console.log("❌ Loop error:", err.message)
    }
  }
}

// ===== START =====
runBot()
