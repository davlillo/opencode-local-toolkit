process.stdout.write('{"type":"ready"}\n')
let bytes = 0
process.stdin.on("data", (chunk: Buffer) => {
  bytes += chunk.length
  process.stdout.write(JSON.stringify({ type: "partial", text: `bytes:${bytes}` }) + "\n")
})
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "final", text: `bytes:${bytes}` }) + "\n")
  process.stdout.end()
})
