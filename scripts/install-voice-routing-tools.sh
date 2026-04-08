#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${HOME}/.conductor-telegram"
TOOLS_DIR="${STATE_DIR}/tools"
WHISPER_DIR="${TOOLS_DIR}/whisper.cpp"
MODEL_DIR="${WHISPER_DIR}/models-local"
MODEL_NAME="${1:-base}"

mkdir -p "$TOOLS_DIR"

if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

if ! command -v cmake >/dev/null 2>&1; then
  python3 -m pip install --user cmake
  export PATH="$HOME/Library/Python/3.9/bin:$PATH"
fi

cd "$WHISPER_DIR"
make -j4

mkdir -p "$MODEL_DIR"
./models/download-ggml-model.sh "$MODEL_NAME" "$MODEL_DIR"

echo "whisper-cli: $WHISPER_DIR/build/bin/whisper-cli"
echo "model: $MODEL_DIR/ggml-$MODEL_NAME.bin"
