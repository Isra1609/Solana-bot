async function runBot() {
  const wallet = loadWallet()
  console.log("🚀 Bot started:", wallet.publicKey.toString())

  while (true) {
    try {
      console.log("🔄 Scanning market...")

      await monitor(wallet)

      const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1")
      const tokens = await res.json()

      console.log(`📊 Found ${tokens.length} tokens`)

      for (const t of tokens.slice(0, 5)) {
        if (t.chainId === "solana") {
          console.log("👀 Checking:", t.tokenAddress)
          await buyToken(wallet, t.tokenAddress)
        }
      }

    } catch (e) {
      console.log("❌ LOOP ERROR:", e.message)
    }

    await sleep(5000)
  }
}
