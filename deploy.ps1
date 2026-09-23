# Deploy the Grand Elephants / Sell On App website + API.
# Requires: Cloudflare login (`npx wrangler login`) OR CLOUDFLARE_API_TOKEN set.
# Secrets must be set first (see .dev.vars.example). Run from this directory.

Write-Host "==> Building Flutter web app..."
Push-Location ..\grand-elephants-flutter
flutter build web --release
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

Write-Host "==> Deploying Worker (API + website) to Cloudflare..."
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "Done. Website + API live at:"
Write-Host "  https://grand-elephants-api.godfreymoseskalambo.workers.dev"