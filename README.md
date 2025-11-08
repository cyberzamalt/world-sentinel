# World Sentinel — Pack final

Interface FR + Worker Cloudflare + D1.

## Déploiement rapide (Wrangler)

1. **Créer la base D1** (si besoin) :  
   ```bash
   wrangler d1 create ws-db
   ```
   Notez l'`database_id` et collez-le dans `wrangler.toml`.

2. **Lier la base au projet** (si vous l'avez déjà) :  
   ```bash
   wrangler d1 list
   wrangler d1 info ws-db
   ```

3. **Secret API** (pour `/admin/run`) :  
   ```bash
   wrangler secret put API_KEY
   ```

4. **Publication** :  
   ```bash
   wrangler deploy
   ```

5. **Cron (optionnel)** — Dashboard Cloudflare → Worker → **Triggers** → **Cron** : `5 * * * *`.

## Routes utiles
- `/` : page d'accueil technique
- `/app` : **interface graphique FR**
- `/api/health`, `/api/last-run`, `/api/news`, `/api/indices`, `/api/signals`
- `/admin/run?key=VOTRE_CLE` (protégé)

### Notes
- Le Worker **embarque l'UI** `/app` (pas de fichiers statiques séparés).
- D1 : le schéma se crée automatiquement.

