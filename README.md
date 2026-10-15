# kie.ai connector for Claude

A small remote MCP server that puts kie.ai inside Claude as a custom connector. Your kie API key stays on the server; Claude only ever sees the connector URL.

## Tools

| Tool | What it does |
|---|---|
| `seedance_2_5_generate` | Seedance 2.5 video with every documented parameter typed out (draft mode, references, web search, mov output) |
| `kie_create_task` | Any kie.ai Market model by model id and input object |
| `kie_wait_for_task` | Polls a task up to about 50 seconds; call again if still running |
| `kie_get_task` | One status check |
| `kie_upload_base64` / `kie_upload_from_url` | Puts a file on kie storage and returns a URL to use as an input |
| `kie_get_credits` | Remaining credit balance |
| `kie_get_download_url` | 20-minute download link for a result |

Not covered: older models that use their own endpoints instead of `jobs/createTask` (Veo3.1, Suno, Runway, 4o Image, Flux Kontext). They can be added as separate tools later.

## Deploy to Fly (about 10 minutes)

1. Get a key at https://kie.ai/api-key.
2. Clone this repo, then in its folder:
   ```
   fly launch --copy-config --no-deploy      # keep the name in fly.toml or pick your own
   fly secrets set KIE_API_KEY=your_kie_key MCP_PATH_SECRET=$(openssl rand -hex 24)
   fly deploy
   ```
3. Read your secret back so you can build the URL (`fly ssh console -C 'printenv MCP_PATH_SECRET'`), or set your own 24+ character value in step 2 and save it in your password manager.
4. Your connector URL is `https://<app-name>.fly.dev/mcp/<MCP_PATH_SECRET>`.
5. In Claude: Settings, Connectors, Add custom connector, paste that URL. No OAuth fields needed.

## Security model

claude.ai custom connectors don't accept a static API header, so the long random path segment is the password. Anyone with the full URL can spend your kie credits. Don't paste it into shared docs; rotate by changing `MCP_PATH_SECRET` and updating the connector. As a second fence, set per-key spending caps on the kie.ai API key page.

## Data retention (from docs.kie.ai)

- Generated media: deleted after 14 days
- Uploaded input files: deleted after 24 hours
- Errors come back as HTTP 200 with an error code in the body; the server already checks for this.

## Local test

```
npm install
KIE_API_KEY=... MCP_PATH_SECRET=some-long-random-string node index.js
```
