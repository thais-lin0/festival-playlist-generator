#!/usr/bin/env bash
# Local dev against the deployed back-end: copies the stack's /config.json into public/.
set -euo pipefail
PROFILE="${AWS_PROFILE:?defina AWS_PROFILE, ex.: export AWS_PROFILE=meu-profile}"
STACK="${STACK:-festival-playlist-dev}"
SITE=$(aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)
curl -fsS "$SITE/config.json" -o public/config.json
echo "public/config.json <- $SITE/config.json"
