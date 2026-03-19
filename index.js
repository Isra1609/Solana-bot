import fetch from "node-fetch"
import bs58 from "bs58"
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js"

const connection = new Connection(process.env.RPC_URL)
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))

let lastTrade = 0

async function runBot() {
  try {
    console.log("🔎 Scanning...")

    const res = await fetch("https://api.dexscreener.com/latest/dex/pairs/solana")
    const data = await res.json()

    const tokens = data.pairs || []

    const filtered = tokens.filter(t =>
      t.liquidity?.usd > 20000 &&
      t.volume?.h24 > 30000
    )

    let bestToken = filtered[0] || tokens[0]

    console.log("Selected:", bestToken?.baseToken?.symbol)

    if (Date.now() - lastTrade < 60000) return

    await trade(bestToken.baseToken.address, 0.01)
    lastTrade = Date.now()

  } catch (err) {
    console.error(err.message)
  }
}

async function trade(token, amount) {
  try {
    console.log("🚀 Trading:", token)

    const quoteRes = await fetch(
      `https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${token}&amount=${Math.floor(amount * 1e9)}&slippageBps=100`
    )

    const quote = await quoteRes.json()

    if (!quote?.routes?.length) {
      console.log("No route")
      return
    }

    const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true
      })
    })

    const swapData = await swapRes.json()

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapData.swapTransaction, "base64")
    )

    tx.sign([wallet])

    const txid = await connection.sendTransaction(tx)

    console.log("✅ TX:", txid)

  } catch (err) {
    console.error("Trade error:", err.message)
  }
}

setInterval(runBot, 30000)

console.log("🤖 Bot running...")
