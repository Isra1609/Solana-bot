const fetch = require("node-fetch")
const bs58 = require("bs58")
const {
  Keypair,
  Connection,
  VersionedTransaction
} = require("@solana/web3.js")

// 🔗 SOLANA CONNECTION
const connection = new Connection(
  "https://api.mainnet-beta.solana.com",
  "confirmed"
)

// 🔑 LOAD WALLET
function loadWallet() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("❌ Missing PRIVATE_KEY in Railway variables")
  }

  const decoded = bs58.decode(process.env.PRIVATE_KEY)
  return Keypair.fromSecretKey(decoded)
}

// ⏱ SLEEP
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

// SOL ADDRESS
const SOL = "So11111111111111111111111111111111111111112"

// ✅ GET JUPITER QUOTE (FIXED)
async function getQuote(inputMint, outputMint, amount) {
  const url = "https://quote-api.jup.ag/v6/quote"

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: 100
  })

  const res = await fetch(`${url}?${params}`)

  const text = await res.text()
  console.log("QUOTE RESPONSE:", text)

  if (!res.ok) {
    throw new Error(`Quote failed: ${res.status}`)
  }

  const data = JSON.parse(text)

  if (!data.data || data.data.length === 0) {
    throw new Error("No routes found")
  }

  return data.data[0]
}

// ✅ EXECUTE SWAP
async function executeSwap(wallet, quote) {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true
    })
  })

  const text = await res.text()
  console.log("SWAP RESPONSE:", text)

  if (!res.ok) {
    throw new Error(`Swap failed: ${res.status}`)
  }

  const { swapTransaction } = JSON.parse(text)

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  )

  tx.sign([wallet])

  const sig = await connection.sendTransaction(tx)

  console.log("✅ TRADE SUCCESS:", sig)
}

// ✅ SAFE TEST TOKEN (USDC)
async function getTokenFromDexscreener() {
  return {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
  }
}

// 🚀 MAIN BOT LOOP
async function runBot() {
  const wallet = loadWallet()

  console.log("🚀 Bot running:", wallet.publicKey.toString())

  while (true) {
    try {
      const token = await getTokenFromDexscreener()

      console.log("🔍 Trying token:", token.address)

      const quote = await getQuote(
        SOL,
        token.address,
        1000000 // ✅ 0.001 SOL (SAFE TEST)
      )

      await executeSwap(wallet, quote)

      console.log("⏳ Waiting before next trade...\n")
      await sleep(20000)

    } catch (e) {
      console.log("❌ ERROR:", e.message)
      await sleep(5000)
    }
  }
}

// START BOT
runBot()
