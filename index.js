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
  const decoded = bs58.decode(process.env.PRIVATE_KEY)
  return Keypair.fromSecretKey(decoded)
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

const SOL = "So11111111111111111111111111111111111111112"

async function getQuote(inputMint, outputMint, amount) {
  const url = "https://quote-api.jup.ag/v6/quote"

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: 100
  })

  const res = await fetch(`${url}?${params}`)
  const data = await res.json()

  if (!data.data || data.data.length === 0) {
    throw new Error("No routes")
  }

  return data.data[0]
}

async function executeSwap(wallet, quote) {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true
    })
  })

  const { swapTransaction } = await res.json()

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  )

  tx.sign([wallet])

  const sig = await connection.sendTransaction(tx)

  console.log("TRADE:", sig)
}

// SIMPLE TOKEN (TEMP)
async function getTokenFromDexscreener() {
  return {
    address: "DezXAZ8z7PnrnRJjz3vGd8c7YxXzvZ6p5VZ1Zy9pump" // example
  }
}

async function runBot() {
  const wallet = loadWallet()

  console.log("🚀 Bot running:", wallet.publicKey.toString())

  while (true) {
    try {
      const token = await getTokenFromDexscreener()

      console.log("Trying:", token.address)

      const quote = await getQuote(
        SOL,
        token.address,
        10000000
      )

      await executeSwap(wallet, quote)

      await sleep(15000)

    } catch (e) {
      console.log("ERROR:", e.message)
      await sleep(5000)
    }
  }
}

runBot()
