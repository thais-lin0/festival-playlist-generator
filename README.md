# Line-up → Playlist

Envie o cartaz de um festival, escolha os artistas e gere uma playlist na sua conta do Spotify.

## Arquitetura (AWS, us-east-1)

```
Navegador ──HTTPS──▶ CloudFront ──▶ S3 (site estático Next.js)
    │
    ├──▶ Cognito (managed login: cadastro / login, PKCE)
    │
    ├──▶ API Gateway (HTTP API, autorizador JWT do Cognito) ──▶ Lambda api
    │                                                              ├─ DynamoDB (line-ups, seleções, jobs, tokens do Spotify cifrados)
    │                                                              ├─ Secrets Manager (credenciais do app Spotify)
    │                                                              └─ invoca Lambda playlist-worker (assíncrona) ──▶ Spotify Web API
    │
    └──POST pré-assinado──▶ S3 uploads/ ──evento──▶ Lambda lineup-processor
                                                     ├─ Textract (OCR)
                                                     ├─ Bedrock (Amazon Nova: interpreta o cartaz)
                                                     └─ Spotify (casa artistas) ──▶ DynamoDB

CloudWatch: logs JSON de tudo, métricas customizadas (EMF), alarmes → SNS e um dashboard.
```

Todos os recursos começam com **`festival-playlist-dev-`** (o secret é `festival-playlist/dev/spotify`) e levam as tags
`Project=festival-playlist-generator`, `Application=FestivalPlaylist`, `Environment=dev`, `Owner=<seu-nome>`, `ManagedBy=aws-cdk`, `CostCenter=festival-playlist`.

| Pasta | Conteúdo |
|---|---|
| `app/`, `components/`, `lib/` | Front-end Next.js (export estático) |
| `lib/types.ts` | Tipos compartilhados entre front e back |
| `backend/src/handlers/` | Lambdas: `api`, `lineup-processor`, `playlist-worker` |
| `backend/infra/` | Stack AWS CDK |

## Deploy

Pré-requisitos: Node 22 e AWS CLI com um profile configurado (`aws configure --profile meu-profile`). Docker não é necessário.

```bash
npm install && npm --prefix backend install
export AWS_PROFILE=meu-profile

# suas configurações locais (arquivo ignorado pelo git)
cp backend/cdk.context.example.json backend/cdk.context.json   # edite owner e alarmEmail

# uma vez por conta/região
npx --prefix backend cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

npm run deploy          # build do front + cdk deploy
```

`owner` vira a tag `Owner` de todos os recursos. Com `alarmEmail` preenchido, os alarmes chegam por e-mail (confirme a inscrição no e-mail da AWS).

> **Nada secreto vai para o repositório.** As credenciais do Spotify ficam só no AWS Secrets Manager; `backend/cdk.context.json`, `public/config.json` e arquivos `.env*` são ignorados pelo git.

### Modelo de IA (Bedrock)
Por padrão o cartaz é lido pelo **Amazon Nova Pro** (`us.amazon.nova-pro-v1:0`), que já vem liberado na conta, pela API Converse com saída estruturada (tool com JSON Schema). Para trocar, edite `backend/cdk.json` e faça o deploy de novo:

| Modelo | `bedrockProvider` | `bedrockModelId` | `bedrockApi` |
|---|---|---|---|
| Amazon Nova Pro (padrão) | `nova` | `us.amazon.nova-pro-v1:0` | — |
| Amazon Nova 2 Lite (mais barato) | `nova` | `global.amazon.nova-2-lite-v1:0` | — |
| Claude Opus 5.5 | `claude` | `anthropic.claude-opus-5-5` | `mantle` |
| Claude Opus 4.6 | `claude` | `global.anthropic.claude-opus-4-6-v1` | `invoke` |

Para usar o Claude, antes envie o formulário **“Anthropic use case details”** em Bedrock → Model catalog (uma vez por conta).

### Configurar o Spotify
1. Crie um app em <https://developer.spotify.com/dashboard> (Web API).
2. Em *Redirect URIs*, adicione o output **`SpotifyRedirectUri`** do deploy (`https://<api>.execute-api.us-east-1.amazonaws.com/spotify/callback`).
3. Grave as credenciais no Secrets Manager: `bash scripts/set-spotify-secret.sh` (usa o `AWS_PROFILE`).
4. Modo de desenvolvimento do Spotify: o dono do app precisa de Premium e cada conta que for usar (até 5) precisa ser adicionada em *User Management*.

### Rodar o front localmente contra o back-end na AWS
```bash
npm run config:pull   # baixa /config.json do CloudFront para public/
npm run dev           # http://127.0.0.1:3000 (já autorizado no Cognito e no CORS)
```

## Detalhes

- **Upload**: o navegador converte para JPEG (≤2000 px) e envia direto ao S3 com POST pré-assinado (limite de 5 MB, só `image/jpeg`). O cartaz é apagado após o processamento; uma regra de ciclo de vida remove sobras em 1 dia.
- **Leitura**: Textract extrai as linhas de texto; o modelo do Bedrock recebe a imagem + o OCR e devolve JSON estruturado (festival, dias, artistas, destaque, gênero estimado).
- **Playlist**: job assíncrono (pode passar dos 30 s do API Gateway). Para cada artista busca faixas onde ele é o artista **principal**, descarta remix/ao vivo/sped up e títulos repetidos, cria a playlist em `POST /me/playlists` e adiciona em `POST /playlists/{id}/items`.
- **Tokens do Spotify**: ficam no DynamoDB cifrados com AES-256-GCM (chave `tokenKey` no Secrets Manager); nunca vão para o navegador nem para os logs.
- **Limites do Spotify em modo de desenvolvimento** (fev/2026): sem `top-tracks` e sem `popularity`, busca com no máximo 10 itens por página — por isso a ordenação se chama “destaques primeiro”.

## Remover tudo
```bash
npm --prefix backend run destroy
```

## Licença

[MIT](LICENSE)
