const apiKey = process.env.ORBIO_API_KEY;
if (!apiKey) throw new Error("ORBIO_API_KEY is required.");

const endpoint = "https://www.orbio.so/api/v1/chat/completions";
const payload = {
  model: "openai/gpt-4.1-mini",
  messages: [{ role: "user", content: "Reply with exactly five words." }],
  max_tokens: 16,
  temperature: 0
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(45_000),
  redirect: "error"
});
const body = await response.text();

console.log(JSON.stringify({ endpoint, status: response.status, body }));
if (!response.ok) process.exitCode = 1;
