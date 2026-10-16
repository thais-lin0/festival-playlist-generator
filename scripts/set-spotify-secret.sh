#!/usr/bin/env bash
# Stores the Spotify app credentials in Secrets Manager, keeping the generated tokenKey.
set -euo pipefail
PROFILE="${AWS_PROFILE:?defina AWS_PROFILE, ex.: export AWS_PROFILE=meu-profile}"
SECRET="${SECRET:-festival-playlist/dev/spotify}"
if ! aws secretsmanager describe-secret --secret-id "$SECRET" --profile "$PROFILE" --region us-east-1 >/dev/null 2>&1; then
  echo "O secret $SECRET ainda não existe. Ele é criado pelo deploy: rode 'npm run deploy' primeiro." >&2
  exit 1
fi
read -rp "Spotify Client ID: " CLIENT_ID
read -rsp "Spotify Client Secret: " CLIENT_SECRET; echo
CURRENT=$(aws secretsmanager get-secret-value --secret-id "$SECRET" --profile "$PROFILE" --region us-east-1 --query SecretString --output text)
NEW=$(CURRENT="$CURRENT" CLIENT_ID="$CLIENT_ID" CLIENT_SECRET="$CLIENT_SECRET" python3 -c '
import json, os
s = json.loads(os.environ["CURRENT"])
s["clientId"] = os.environ["CLIENT_ID"].strip()
s["clientSecret"] = os.environ["CLIENT_SECRET"].strip()
print(json.dumps(s))')
aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "$NEW" --profile "$PROFILE" --region us-east-1 >/dev/null
echo "Secret $SECRET atualizado (pode levar até 5 min para as Lambdas lerem o novo valor)."
