#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${PREFIX:-$HOME/.local}/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install it first: pkg install nodejs" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/freecode" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/bin/freecode" "\$@"
EOF
chmod +x "$BIN_DIR/freecode"

echo "freecode wrapper installed at $BIN_DIR/freecode"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo
echo "No key needed to start: LLM7 and Pollinations are keyless."
echo "Add a provider key for higher limits, for example:"
echo "  export OPENROUTER_API_KEY=..."
echo "  export GROQ_API_KEY=..."
echo "  export GEMINI_API_KEY=..."
echo
echo "Or run local models with Ollama (no key):"
echo "  ollama serve"
echo "  ollama pull qwen2.5-coder:7b"
echo
echo "Then check: freecode doctor"
