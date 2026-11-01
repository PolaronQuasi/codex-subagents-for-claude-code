#!/bin/sh
set -eu

EXIT_SUCCESS=0
EXIT_FAILURE=1
readonly EXIT_SUCCESS EXIT_FAILURE

if [ "${1:-daemon}" = register ]; then
  if [ -s /data/.runner ]; then
    echo 'Runner is already registered; preserving its identity.'
    exit "$EXIT_SUCCESS"
  fi
  : "${GITEA_RUNNER_REGISTRATION_TOKEN:?Registration token is required}"
  exec gitea-runner register --no-interactive \
    --instance "$GITEA_INSTANCE_URL" --name "$GITEA_RUNNER_NAME" \
    --labels codex-subagents-for-claude-code-linux:host --config /etc/gitea-runner/config.yaml
fi

if [ "${1:-daemon}" != daemon ]; then
  echo 'Supported commands: register, daemon' >&2
  exit "$EXIT_FAILURE"
fi
if [ ! -s /data/.runner ]; then
  echo 'Register the runner with setup-runner.ps1 before starting it.' >&2
  exit "$EXIT_FAILURE"
fi
unset GITEA_RUNNER_REGISTRATION_TOKEN
exec gitea-runner daemon --config /etc/gitea-runner/config.yaml
