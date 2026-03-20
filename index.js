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

  if (!res.ok) {
    throw new Error(`Quote failed: ${res.status}`)
  }

  const data = JSON.parse(text)

  // ✅ v6 returns quote directly, check outAmount
  if (!data || !data.outAmount) {
    console.log("⚠️ No route, increasing amount...")
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
    if (!retryData || !retryData.outAmount) {
      throw new Error("No routes even after retry")
    }
    return retryData // ✅ return whole object
  }

  return data // ✅ return whole object, not data.data[0]
}
