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
const BASE = "https://api.jup.ag"
let TRADE_AMOUNT = 20000000

async function getQuote(inputMint, outputMint, amount) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: 150
  })
  const res = await fetch(`${BASE}/v6/quote?${params}`, {
    headers: { "x-api-key": process.env.JUP_API_KEY }
  })
  const text = await res.text()
  console.log("QUOTE:", text)
  if (!res.ok) throw new Error(`Quote failed: ${res.status}`)
  const data = JSON.parse(text)
  if (!data || !data.outAmount) {
    const biggerAmount = amount * 2
    const retryParams = new URLSearchParams({
      inputMint,
      outputMint,
      amount: biggerAmount,
      slippageBps: 150
    })
    const retryRes = await fetch(`${BASE}/v6/quote?${retryParams}`, {
      headers: { "x-api-key": process.env.JUP_API_KEY }
    })
    const retryData = await retryRes.json()
    if (!retryData || !retryData.outAmount) throw new Error("No routes even after retry")
    return retryData
  }
  return data
}

async function executeSwap(wallet, quote) {
  const res = await fetch(`${BASE}/v6/swap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.JUP_API_KEY
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true
    })
  })
  const text = await res.text()
  console.log("SWAP:", text)
  if (!res.ok) throw new Error(`Swap failed: ${res.status}`)
  const { swapTransaction } = JSON.parse(text)
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"))
  tx.sign([wallet])
  const sig = await connection.sendTransaction(tx)
  console.log("✅ TRADE SUCCESS:", sig)
}

async function getTokenFromDexscreener() {
  return { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
}

async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Running:", wallet.publicKey.toString())
  while (true) {
    try {
      const token = await getTokenFromDexscreener()
      console.log("Trying:", token.address)
      const quote = await getQuote(SOL, token.address, TRADE_AMOUNT)
      await executeSwap(wallet, quote)
      console.log("⏳ Waiting...\n")
      await sleep(25000)
    } catch (e) {
      console.log("❌ ERROR:", e.message)
      await sleep(7000)
    }
  }
}

runBot()
