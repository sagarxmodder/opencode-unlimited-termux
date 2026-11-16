export default {
  name: "hello-world",
  description: "Example plugin: adds a small runtime note and logs completed replies.",
  beforeChat({ messages }) {
    const last = messages[messages.length - 1]
    if (last?.role === "user") {
      last.content = `${last.content}\n\n[plugin: hello-world active]`
    }
  },
  afterResponse({ conversation, usage }) {
    if (usage) {
      process.stderr.write(`[hello-world] ${conversation.id.slice(0, 8)} used ${usage.total || 0} tokens\n`)
    }
  }
}
