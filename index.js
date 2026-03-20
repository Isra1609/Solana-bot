const fetch = require("node-fetch")
const bs58 = require("bs58")
const {
  Keypair,
  Connection,
  VersionedTransaction
} = require("@solana/web3.js")

const connection = new Connection(
  "https://api.mainnet-beta.solana.com",
  "confirmed"
)

function loadWallet() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY")
  }

  const decoded = bs58.decode(process.env.PRIVATE_KEY)
  return Keypair.fromSecretKey(decoded)
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

const SOL = "So11111111111111111111111111111111111111112"

// ✅ QUOTE (FINAL)
async function getQuote(inputMint, outputMint, amount) {
  const url = "https://quote-api.jup.ag/v6/quote"

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: 100
  })

  const res = await fetch(`${url}?${params}`, {
    headers: {
      "Accept": "application/json"
    }
  })

  const text = await res.text()
  console.log("QUOTE:", text)

  if (!res.ok) {
    throw new Error(`Quote failed: ${res.status}`)
  }

  const data = JSON.parse(text)

  if (!data.data || data.data.length === 0) {
    throw new Error("No routes")
  }

  return data.data[0]
}

// ✅ SWAP (FINAL)
async function executeSwap(wallet, quote) {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true
    })
  })

  const text = await res.text()
  console.log("SWAP:", text)

  if (!res.ok) {
    throw new Error(`Swap failed: ${res.status}`)
  }

  const { swapTransaction } = JSON.parse(text)

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  )

  tx.sign([wallet])

  const sig = await connection.sendTransaction(tx)

  console.log("✅ TRADE:", sig)
}

// TEST TOKEN
async function getTokenFromDexscreener() {
  return {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  }
}

async function runBot() {
  const wallet = loadWallet()

  console.log("🚀 Running:", wallet.publicKey.toString())

  while (true) {
    try {
      const token = await getTokenFromDexscreener()

      console.log("Trying:", token.address)

      const quote = await getQuote(
        SOL,
        token.address,
        1000000
      )

      await executeSwap(wallet, quote)

      await sleep(20000)

    } catch (e) {
      console.log("❌ ERROR:", e.message)
      await sleep(5000)
    }
  }
}

runBot()
