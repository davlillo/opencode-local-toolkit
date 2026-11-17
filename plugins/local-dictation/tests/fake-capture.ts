const timer = setInterval(() => { process.stdout.write(Buffer.alloc(320, 7)) }, 10)
process.stderr.write("Output #0, s16le, to 'pipe:1':\n")
process.stdin.on("data", () => {
  clearInterval(timer)
  process.stdout.end(() => process.exit(0))
})
