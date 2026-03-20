const fetch = require("node-fetch")
const bs58 = require("bs58")
const { Keypair, Connection, VersionedTransaction } = require("@solana/web3.js")

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed")

function loadWallet() {
  if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY")
  const decoded = bs58.decode(process.env.PRIVATE_KEY)
  return Keypair.fromSecretKey(decoded)
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

const SOL = "So11111111111111111111111111111111111111112"
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const BASE = "https://api.jup.ag"
let TRADE_AMOUNT = 20000000

async function getOrderAndExecute(wallet) {
  // GET request with query params
  const params = new URLSearchParams({
    inputMint: SOL,
    outputMint: USDC,
    amount: TRADE_AMOUNT,
    taker: wallet.publicKey.toString()
  })

  const orderRes = await fetch(`${BASE}/ultra/v1/order?${params}`, {
    headers: { "x-api-key": process.env.JUP_API_KEY }
  })
  const orderText = await orderRes.text()
  console.log("ORDER:", orderText)
  if (!orderRes.ok) throw new Error(`Order failed: ${orderRes.status}`)
  const order = JSON.parse(orderText)

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"))
  tx.sign([wallet])
  const signedTx = Buffer.from(tx.serialize()).toString("base64")

  const execRes = await fetch(`${BASE}/ultra/v1/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.JUP_API_KEY
    },
    body: JSON.stringify({
      signedTransaction: signedTx,
      requestId: order.requestId
    })
  })
  const execText = await execRes.text()
  console.log("EXECUTE:", execText)
  if (!execRes.ok) throw new Error(`Execute failed: ${execRes.status}`)
  const result = JSON.parse(execText)
  console.log("✅ TRADE SUCCESS:", result.signature)
}

async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Running:", wallet.publicKey.toString())
  while (true) {
    try {
      await getOrderAndExecute(wallet)
      console.log("⏳ Waiting...\n")
      await sleep(25000)
    } catch (e) {
      console.log("❌ ERROR:", e.message)
      await sleep(7000)
    }
  }
}

runBot()
