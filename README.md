## Déploiement (Cloudflare Builds)
- Le Worker **world-sentinel** est lié à ce dépôt GitHub.
- **Chaque commit sur `main`** déclenche automatiquement un **build + déploiement**.
- La clé admin (`API_KEY`) et autres variables sont gérées dans Cloudflare :
  Workers & Pages → world-sentinel → Settings → Build → Variables and secrets.

## Commandes locales (optionnel)
Requis : `npm i -g wrangler`

1) Aperçu local (lit la D1 distante via database_id du wrangler.toml)
```bash
wrangler dev
